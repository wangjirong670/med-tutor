import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../../..");
const piGuiRoot = path.join(projectRoot, "scripts/pi-migration/s07/restore-r2/src/pi-gui");
const serviceTsPath = path.join(
  piGuiRoot,
  "apps/desktop/electron/learning/learning-workbench-service.ts",
);

const require = createRequire(import.meta.url);
const ts = require(path.join(piGuiRoot, "node_modules/typescript/lib/typescript.js"));

function createPersistedSessionFixture(rootDir, sessionId, userText, assistantText) {
  const sessionFile = path.join(rootDir, `${sessionId}.jsonl`);
  const entries = [
    { type: "session", id: sessionId, version: 1, timestamp: new Date().toISOString(), cwd: rootDir },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: userText },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: assistantText },
    },
  ];
  fs.writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  const entryMap = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
  const branch = entries.filter((e) => e.type === "message");
  return {
    sessionFile,
    manager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
      getBranch: () => branch,
      getLeafId: () => branch.at(-1)?.id ?? null,
      getEntry: (id) => entryMap.get(id),
      appendMessage(message) {
        const id = `m_${branch.length + 1}`;
        const entry = {
          type: "message",
          id,
          parentId: branch.at(-1)?.id ?? null,
          timestamp: new Date().toISOString(),
          message,
        };
        branch.push(entry);
        entryMap.set(id, entry);
        fs.appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
        return id;
      },
    },
  };
}

test("LearningWorkbenchService loads .env custom provider, toggles mode IPC, and saves multi-claim study drafts", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "s07b-p2-svc-"));
  const medRoot = path.join(tempRoot, "med-tutor-mock");
  const agentDir = path.join(tempRoot, "agent");
  const userDataDir = path.join(tempRoot, "user-data");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  fs.mkdirSync(path.join(medRoot, "scripts/pi-migration/s08"), { recursive: true });
  fs.cpSync(__dirname, path.join(medRoot, "scripts/pi-migration/s08/learning-workbench-r4"), {
    recursive: true,
  });

  const syntheticTestToken = "sk-synthetic-test-value-not-real";
  fs.writeFileSync(
    path.join(medRoot, ".env"),
    [
      `MED_TUTOR_API_KEY=${syntheticTestToken}`,
      "MED_TUTOR_BASE_URL=https://api.deepseek.com/v1",
      "MED_TUTOR_STUDY_MODEL=deepseek-chat",
      "MED_TUTOR_QA_MODEL=deepseek-reasoner",
      "MED_TUTOR_OFFLINE_MOCK=1",
    ].join("\n"),
    "utf8",
  );

  const sourceTs = fs.readFileSync(serviceTsPath, "utf8");
  const transpiled = ts.transpileModule(sourceTs, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const compiledPath = path.join(tempRoot, "learning-workbench-service.cjs");
  fs.writeFileSync(compiledPath, transpiled.outputText, "utf8");

  const ipcHandlers = new Map();
  const mainFrame = {};
  const fakeWindow = { id: 1 };
  const fakeElectron = {
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
    },
    ipcMain: {
      handle(channel, fn) {
        ipcHandlers.set(channel, fn);
      },
    },
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    return originalLoad.call(this, request, parent, isMain);
  };

  const envBackup = {
    MED_TUTOR_ROOT: process.env.MED_TUTOR_ROOT,
    S07B_DATA_ROOT: process.env.S07B_DATA_ROOT,
    S07B_SOURCE: process.env.S07B_SOURCE,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    MED_TUTOR_API_KEY: process.env.MED_TUTOR_API_KEY,
    MED_TUTOR_BASE_URL: process.env.MED_TUTOR_BASE_URL,
    MED_TUTOR_STUDY_MODEL: process.env.MED_TUTOR_STUDY_MODEL,
    MED_TUTOR_QA_MODEL: process.env.MED_TUTOR_QA_MODEL,
    MED_TUTOR_OFFLINE_MOCK: process.env.MED_TUTOR_OFFLINE_MOCK,
  };
  for (const key of [
    "MED_TUTOR_API_KEY",
    "MED_TUTOR_BASE_URL",
    "MED_TUTOR_STUDY_MODEL",
    "MED_TUTOR_QA_MODEL",
    "MED_TUTOR_OFFLINE_MOCK",
  ]) {
    delete process.env[key];
  }
  process.env.MED_TUTOR_ROOT = medRoot;
  process.env.S07B_DATA_ROOT = path.join(tempRoot, "learning-data");
  process.env.S07B_SOURCE = piGuiRoot;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const prevCwd = process.cwd();
  process.chdir(piGuiRoot);
  try {
    const { LearningWorkbenchService } = require(compiledPath);
    const service = new LearningWorkbenchService(userDataDir);

    const { manager } = createPersistedSessionFixture(
      tempRoot,
      "sess_svc_multi",
      "开始学习",
      "已准备",
    );
    const driverOptions = await service.buildDriverOptions();
    assert.ok(driverOptions.builtinExtensions.some((e) => e.name === "s07c-continuity"));
    assert.ok(driverOptions.builtinExtensions.some((e) => e.name === "s02-fixture"));
    service.liveManagers.set("sess_svc_multi", manager);

    const modelsJson = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    assert.equal(modelsJson.providers["med-tutor-env"].baseUrl, "https://api.deepseek.com/v1");
    assert.deepEqual(
      modelsJson.providers["med-tutor-env"].models.map((m) => m.id),
      ["deepseek-chat", "deepseek-reasoner"],
    );

    let mutatedCount = 0;
    service.registerIpc({
      windows: {
        windowForSender: () => fakeWindow,
        stateForWindow: async () => ({
          selectedWorkspaceId: "ws-1",
          selectedSessionId: "sess_svc_multi",
        }),
      },
      ensureSessionReady: async () => undefined,
      onSessionMutated: async () => {
        mutatedCount += 1;
      },
    });

    const event = { sender: { mainFrame }, senderFrame: mainFrame };
    const modeInitial = await ipcHandlers.get("learning:mode:get")(event);
    assert.equal(modeInitial.offlineMock, true);
    assert.equal(modeInitial.envProviderConfigured, true);
    assert.equal(modeInitial.envBaseUrl, "https://api.deepseek.com/v1");
    assert.deepEqual(modeInitial.envModels, ["deepseek-chat", "deepseek-reasoner"]);
    assert.equal(JSON.stringify(modeInitial).includes(syntheticTestToken), false);

    const modeSwitched = await ipcHandlers.get("learning:mode:set")(event, { offlineMock: false });
    assert.equal(modeSwitched.offlineMock, false);
    assert.equal(process.env.MED_TUTOR_OFFLINE_MOCK, "0");

    const sampleMd = path.join(tempRoot, "麻黄汤.md");
    fs.writeFileSync(
      sampleMd,
      "太阳病，头痛发热，身疼腰痛，骨节疼痛，恶风，无汗而喘者，麻黄汤主之。",
      "utf8",
    );
    const dropped = await ipcHandlers.get("learning:materials:drop")(event, sampleMd);
    assert.equal(dropped.cancelled, false);
    const mat = dropped.material;

    const savedMulti = await ipcHandlers.get("learning:study:save")(event, {
      title: "麻黄汤证多主张学习单",
      claims: [
        {
          id: "c_1",
          text: "麻黄汤证核心表现为恶风、无汗而喘。",
          source: { materialId: mat.materialId, versionId: mat.versionId },
          quote: "恶风，无汗而喘者",
        },
        {
          id: "c_2",
          text: "伴见头身骨节疼痛等表寒闭郁之象。",
          source: null,
          quote: "",
        },
      ],
      uncertainties: ["麻黄先煎去上沫的现代煎煮时间待核"],
    });
    assert.equal(savedMulti.cancelled, false);
    assert.equal(savedMulti.result.version, 1);
    assert.equal(mutatedCount, 1);

    const studyState = await ipcHandlers.get("learning:study:state")(event);
    assert.equal(studyState.currentDraft.claims.length, 2);
    assert.equal(studyState.currentDraft.claims[0].citations.length, 1);
    assert.deepEqual(studyState.unresolved, ["麻黄先煎去上沫的现代煎煮时间待核"]);

    const savedCompat = await ipcHandlers.get("learning:study:save")(event, {
      title: "麻黄汤单条兼容模式",
      text: "麻黄汤禁忌：表虚自汗者禁用。",
      source: { materialId: mat.materialId, versionId: mat.versionId },
      quote: "无汗而喘者",
      claims: [
        {
          text: "麻黄汤禁忌：表虚自汗者禁用。",
          source: { materialId: mat.materialId, versionId: mat.versionId },
          quote: "无汗而喘者",
        },
      ],
      uncertainties: ["尺度把握待核"],
    });
    assert.equal(savedCompat.result.version, 2);
  } finally {
    process.chdir(prevCwd);
    Module._load = originalLoad;
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  }
});
