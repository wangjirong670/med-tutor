import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../../..");
const piGuiRoot = path.join(projectRoot, "scripts/pi-migration/s07/restore-r2/src/pi-gui");

function createToolHarness(s07b) {
  const tools = new Map();
  const events = new Map();
  const pi = {
    on(name, handler) {
      events.set(name, handler);
    },
    registerTool(spec) {
      tools.set(spec.name, spec);
    },
  };
  s07b.s07bExtension(pi);
  return { tools, events };
}

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

async function callTool(tools, manager, name, args, callId = `call_${name}`) {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} must be registered`);
  const res = await tool.execute(callId, args, undefined, undefined, { sessionManager: manager });
  const parsed = JSON.parse(res.content[0].text);
  return { raw: res, parsed };
}

test("19 learning tools have real medical study descriptions and allow autonomous LLM calls without prior hostIntent", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "s07b-p2-tools-"));
  const prevRoot = process.env.S07B_DATA_ROOT;
  const prevSource = process.env.S07B_SOURCE;
  process.env.S07B_DATA_ROOT = tempRoot;
  process.env.S07B_SOURCE = piGuiRoot;

  try {
    const s07b = await import(
      `${pathToFileURL(path.join(__dirname, "s07b-extension.mjs")).href}?t=${Date.now()}`
    );
    const { tools } = createToolHarness(s07b);
    assert.equal(tools.size, 19);

    for (const [name, spec] of tools) {
      assert.ok(
        spec.description && !spec.description.includes("Bounded S07B synthetic learning tool"),
        `${name} should have a clear non-synthetic description`,
      );
    }

    const { manager } = createPersistedSessionFixture(
      tempRoot,
      "sess_agent_auto",
      "请帮我把桂枝汤主治整理成学习单，并记住我备考中医执业医师需要重点标出鉴别点。",
      "好的，桂枝汤主治太阳中风表虚证，核心症见头痛发热、汗出恶风、脉浮缓。",
    );

    const materials = s07b.getMaterialsForWorker();
    const receipt = materials.stageBytes(
      "桂枝汤原文.txt",
      Buffer.from("太阳中风，阳浮而阴弱……头痛发热，汗出恶风，桂枝汤主之。", "utf8"),
      "sess_agent_auto",
    );
    const imported = materials.importReceipt("sess_agent_auto", receipt);

    const listRes = await callTool(tools, manager, "material_list", {});
    assert.equal(listRes.parsed.ok, true);
    assert.equal(listRes.parsed.data.items.length, 1);

    const locRes = await callTool(tools, manager, "citation_locate", {
      materialId: imported.materialId,
      versionId: imported.versionId,
      quote: "头痛发热，汗出恶风",
    });
    assert.equal(locRes.parsed.ok, true);
    assert.equal(locRes.parsed.data.ok, true);

    // study_submit WITHOUT intentId (autonomous LLM call)
    const submitRes = await callTool(tools, manager, "study_submit", {
      baseVersion: 0,
      draft: {
        title: "桂枝汤主干学习单",
        claims: [
          {
            id: "claim_1",
            text: "桂枝汤主治太阳中风表虚证，见汗出恶风、脉浮缓。",
            citations: [
              {
                materialId: imported.materialId,
                versionId: imported.versionId,
                quote: "头痛发热，汗出恶风",
              },
            ],
          },
          {
            id: "claim_2",
            text: "需与麻黄汤太阳伤寒表实证（无汗而喘、脉浮紧）相鉴别。",
            citations: [],
          },
        ],
        uncertainties: ["桂枝汤煎服法中啜热稀粥的具体用量待核原文"],
      },
    });
    assert.equal(submitRes.parsed.ok, true, submitRes.parsed.error);
    assert.equal(submitRes.parsed.data.version, 1);
    const draftId = submitRes.parsed.data.draftId;

    // study_decide WITHOUT intentId
    const decideRes = await callTool(tools, manager, "study_decide", {
      draftId,
      version: 1,
      claimId: "claim_1",
      choice: "accept",
      note: "已核对原文无误",
    });
    assert.equal(decideRes.parsed.ok, true, decideRes.parsed.error);
    assert.equal(decideRes.parsed.data.choice, "accept");

    // correction_create -> correction_supersede -> correction_retract WITHOUT intentId
    const corrCreateRes = await callTool(tools, manager, "correction_create", {
      target: { kind: "draft_claim", draftId, version: 1, claimId: "claim_2" },
      originalClaim: "需与麻黄汤太阳伤寒表实证（无汗而喘、脉浮紧）相鉴别。",
      correction: "还应注意与桂枝加葛根汤鉴别的项背强几几。",
      verificationStatus: "pending",
      unresolvedItems: ["核对桂枝加葛根汤条文"],
    });
    assert.equal(corrCreateRes.parsed.ok, true, corrCreateRes.parsed.error);
    const correctionId = corrCreateRes.parsed.data.correctionId;

    const corrSuperRes = await callTool(tools, manager, "correction_supersede", {
      correctionId,
      expectedRevision: 1,
      target: { kind: "draft_claim", draftId, version: 1, claimId: "claim_2" },
      originalClaim: "需与麻黄汤太阳伤寒表实证（无汗而喘、脉浮紧）相鉴别。",
      correction: "补充：还应对比桂枝加附子汤的漏汗不止。",
    });
    assert.equal(corrSuperRes.parsed.ok, true, corrSuperRes.parsed.error);
    assert.equal(corrSuperRes.parsed.data.revision, 2);

    const corrRetractRes = await callTool(tools, manager, "correction_retract", {
      correctionId,
      expectedRevision: 2,
    });
    assert.equal(corrRetractRes.parsed.ok, true, corrRetractRes.parsed.error);
    assert.equal(corrRetractRes.parsed.data.status, "retracted");

    // profile_create -> profile_update -> profile_delete WITHOUT intentId/source/sourceType
    const profCreateRes = await callTool(tools, manager, "profile_create", {
      value: "备考中医执业医师，重点标出易混方剂鉴别点",
    });
    assert.equal(profCreateRes.parsed.ok, true, profCreateRes.parsed.error);
    const profileId = profCreateRes.parsed.data.id;

    const profUpdateRes = await callTool(tools, manager, "profile_update", {
      id: profileId,
      version: 1,
      value: "备考中医执业医师，每节附带方证对比表",
    });
    assert.equal(profUpdateRes.parsed.ok, true, profUpdateRes.parsed.error);
    assert.equal(profUpdateRes.parsed.data.version, 2);

    const profDeleteRes = await callTool(tools, manager, "profile_delete", {
      id: profileId,
      version: 2,
    });
    assert.equal(profDeleteRes.parsed.ok, true, profDeleteRes.parsed.error);
    assert.equal(profDeleteRes.parsed.data.deleted, true);

    // history_search -> history_read WITHOUT pre-written authorization.json
    const histSearchRes = await callTool(tools, manager, "history_search", {
      query: "桂枝汤",
    });
    assert.equal(histSearchRes.parsed.ok, true, histSearchRes.parsed.error);
    assert.ok(histSearchRes.parsed.data.matches.length >= 1);
    const anchor = histSearchRes.parsed.data.matches[0].anchor;

    const histReadRes = await callTool(tools, manager, "history_read", {
      anchor,
      start: 0,
      maxChars: 200,
    });
    assert.equal(histReadRes.parsed.ok, true, histReadRes.parsed.error);
    assert.ok(histReadRes.parsed.data.text.includes("桂枝汤"));

    // Empty in-memory session history_search returns empty matches cleanly instead of ENOENT
    const emptyBranch = [{ id: "u0", parentId: null, type: "message", message: { role: "user", content: "hi" } }];
    const emptyMgr = {
      getSessionId: () => "sess_memory_only",
      getSessionFile: () => undefined,
      getBranch: () => emptyBranch,
      getLeafId: () => "u0",
      getEntry: (id) => (id === "u0" ? emptyBranch[0] : undefined),
    };
    const emptyHist = await callTool(tools, emptyMgr, "history_search", { query: "不存在" });
    assert.equal(emptyHist.parsed.ok, true);
    assert.deepEqual(emptyHist.parsed.data.matches, []);

    // Backward compatibility: pre-issued & revoked hostIntent still fails closed
    const domain = s07b.getDomainForWorker();
    const revokedPayload = {
      target: { kind: "discussion", scope: "compat-check" },
      originalClaim: "原说法",
      correction: "新说法",
    };
    s07b.hostIntent(manager, "correction_create", revokedPayload, "i_revoked_1");
    domain.revokeIntent("i_revoked_1");
    const revokedCall = await callTool(tools, manager, "correction_create", {
      intentId: "i_revoked_1",
      ...revokedPayload,
    });
    assert.equal(revokedCall.parsed.ok, false);
    assert.match(revokedCall.parsed.error, /intent revoked/);
  } finally {
    if (prevRoot === undefined) delete process.env.S07B_DATA_ROOT;
    else process.env.S07B_DATA_ROOT = prevRoot;
    if (prevSource === undefined) delete process.env.S07B_SOURCE;
    else process.env.S07B_SOURCE = prevSource;
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  }
});
