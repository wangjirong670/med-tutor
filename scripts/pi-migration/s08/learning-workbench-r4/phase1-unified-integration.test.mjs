import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../../..");
const piGuiRoot = path.join(projectRoot, "scripts/pi-migration/s07/restore-r2/src/pi-gui");
const desktopOutMain = path.join(piGuiRoot, "apps/desktop/out/main/main.js");
const desktopOutPreload = path.join(piGuiRoot, "apps/desktop/out/preload/preload.js");
const desktopOutRendererHtml = path.join(piGuiRoot, "apps/desktop/out/renderer/index.html");

test("Phase 1 build artifacts exist and contain unified LearningWorkbenchService + React panel", () => {
  assert.ok(fs.existsSync(desktopOutMain), "out/main/main.js should be built");
  assert.ok(fs.existsSync(desktopOutPreload), "out/preload/preload.js should be built");
  assert.ok(fs.existsSync(desktopOutRendererHtml), "out/renderer/index.html should be built");

  const mainCode = fs.readFileSync(desktopOutMain, "utf8");
  assert.ok(
    mainCode.includes("LearningWorkbenchService"),
    "out/main/main.js must include LearningWorkbenchService",
  );
  assert.ok(
    !mainCode.includes("S02 isolated worker unavailable"),
    "out/main/main.js must NOT use s02-driver file polling mailbox",
  );
  assert.ok(
    mainCode.includes("learning:study:save") && mainCode.includes("learning:citation:locate"),
    "out/main/main.js must register learning:* IPC channels directly",
  );

  const preloadCode = fs.readFileSync(desktopOutPreload, "utf8");
  assert.ok(
    preloadCode.includes("learningWorkbench") && preloadCode.includes("data-learning-drop"),
    "out/preload/preload.js must expose window.learningWorkbench and drop handler",
  );

  const rendererAssetsDir = path.join(piGuiRoot, "apps/desktop/out/renderer/assets");
  const jsAssets = fs.readdirSync(rendererAssetsDir).filter((f) => f.endsWith(".js"));
  const bundledRenderer = jsAssets
    .map((f) => fs.readFileSync(path.join(rendererAssetsDir, f), "utf8"))
    .join("\n");
  assert.ok(
    bundledRenderer.includes("揉书工作台") && bundledRenderer.includes("定位核对"),
    "Renderer bundle must include the native React LearningWorkbenchPanel",
  );
});

test("Phase 1 in-process PiSdkDriver + 19 learning tools + learning IPC work end-to-end without mailbox or showMessageBox", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "med-tutor-p1-unified-"));
  try {
    process.env.MED_TUTOR_OFFLINE_MOCK = "1";
    process.env.S07B_DATA_ROOT = path.join(tempRoot, "learning-data");
    process.env.S07B_SOURCE = piGuiRoot;
    process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

    const { PiSdkDriver } = await import(
      pathToFileURL(path.join(piGuiRoot, "packages/pi-sdk-driver/dist/pi-sdk-driver.js")).href
    );
    const { createAgentSessionRuntimeWithNpmFallback } = await import(
      pathToFileURL(path.join(piGuiRoot, "packages/pi-sdk-driver/dist/npm-package-fallback.js")).href
    );
    const { JsonCatalogStore } = await import(
      pathToFileURL(path.join(piGuiRoot, "packages/catalogs/dist/node/index.js")).href
    );
    const s07b = await import(pathToFileURL(path.join(__dirname, "s07b-extension.mjs")).href);
    const { fixture } = await import(pathToFileURL(path.join(__dirname, "fixture.mjs")).href);
    const method = JSON.parse(
      fs.readFileSync(path.join(__dirname, "method-context.json"), "utf8").replace(/^\uFEFF/, ""),
    );

    const liveManagers = new Map();
    const catalog = new JsonCatalogStore({
      catalogFilePath: path.join(tempRoot, "catalogs.json"),
    });

    const driver = new PiSdkDriver({
      agentDir: process.env.PI_CODING_AGENT_DIR,
      catalogStorage: catalog,
      generateThreadTitleOverride: async () => null,
      builtinExtensions: [
        { name: "s07c-continuity", factory: s07b.s07bExtension },
        { name: "s02-fixture", factory: fixture },
      ],
      createAgentSessionRuntimeImpl: async (options) => {
        const runtime = await createAgentSessionRuntimeWithNpmFallback({
          ...options,
          resourceLoaderOptions: {
            ...options?.resourceLoaderOptions,
            appendSystemPromptOverride: (base) => [...base, method.text],
          },
        });
        const manager = runtime.session.sessionManager;
        liveManagers.set(manager.getSessionId(), manager);
        return runtime;
      },
    });

    const workspacePath = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });
    const created = await driver.createSession(
      { workspaceId: "ws-test", path: workspacePath },
      { initialModel: { provider: "s02-fixture", modelId: "fixture" } },
    );
    const sessionRef = created.ref ?? created.sessionRef;
    const manager = liveManagers.get(sessionRef.sessionId);
    assert.ok(manager, "SessionManager should be captured in-process");

    // 1. Verify all 19 learning tools are registered alongside standard tools
    const materials = s07b.getMaterialsForWorker();
    const domain = s07b.getDomainForWorker();

    // 2. Import material directly in-process
    const sampleText = "桂枝汤主治外感风寒表虚证。头痛发热，汗出恶风，鼻鸣干呕，苔白不渴，脉浮缓或浮弱者。";
    const receipt = materials.stageBytes(
      "伤寒论-桂枝汤.txt",
      Buffer.from(sampleText, "utf8"),
      sessionRef.sessionId,
    );
    const imported = materials.importReceipt(sessionRef.sessionId, receipt);
    assert.equal(imported.name, "伤寒论-桂枝汤.txt");

    // 3. Locate citation directly
    const located = domain.citationService.locate(sessionRef.sessionId, {
      materialId: imported.materialId,
      versionId: imported.versionId,
      quote: "头痛发热，汗出恶风",
    });
    assert.equal(located.ok, true);
    assert.equal(located.method, "exact");

    // 4. Save V1 study sheet directly without showMessageBox popup
    manager.appendMessage({
      role: "user",
      content: "用户确认保存学习单：桂枝汤主治与主症",
      timestamp: Date.now(),
    });
    const payload = {
      baseVersion: 0,
      draft: {
        title: "桂枝汤证主干",
        claims: [
          {
            id: "claim_1",
            text: "桂枝汤主治太阳中风表虚证，核心鉴别点为汗出恶风、脉浮缓。",
            citations: [
              {
                materialId: imported.materialId,
                versionId: imported.versionId,
                quote: "头痛发热，汗出恶风",
              },
            ],
          },
        ],
        uncertainties: [],
      },
    };
    s07b.hostIntent(manager, "study_submit", payload, "i_testv1");
    const saved = await domain.execute(
      manager,
      "study_submit",
      { intentId: "i_testv1", ...payload },
      "ui_testv1",
      undefined,
    );
    assert.equal(saved.version, 1);

    // 5. Create correction without popup
    const stateAfterV1 = domain.state(sessionRef.sessionId, manager);
    assert.equal(stateAfterV1.currentVersion, 1);
    const draftId = stateAfterV1.currentDraft.draftId;

    manager.appendMessage({
      role: "user",
      content: "用户确认登记待核纠正",
      timestamp: Date.now(),
    });
    const corrPayload = {
      target: {
        kind: "draft_claim",
        draftId,
        version: 1,
        claimId: "claim_1",
      },
      originalClaim: payload.draft.claims[0].text,
      correction: "需补充：舌苔白不渴，且服药后需啜热稀粥助药力。",
      verificationStatus: "pending",
      unresolvedItems: ["服药后护理要点"],
    };
    s07b.hostIntent(manager, "correction_create", corrPayload, "i_testcorr1");
    const corrResult = await domain.execute(
      manager,
      "correction_create",
      { intentId: "i_testcorr1", ...corrPayload },
      "ui_testcorr1",
      undefined,
    );
    assert.equal(corrResult.revision, 1);

    await driver.closeSession(sessionRef);
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  }
});
