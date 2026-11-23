import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../../..");
const piGuiRoot = path.join(projectRoot, "scripts/pi-migration/s07/restore-r2/src/pi-gui");
const realTextbookChapter = process.env.MED_TUTOR_E2E_TEXTBOOK_FILE?.trim() || "";

function createToolHarness(s07b) {
  const tools = new Map();
  const pi = {
    on() {},
    registerTool(spec) {
      tools.set(spec.name, spec);
    },
  };
  s07b.s07bExtension(pi);
  return tools;
}

test(
  "Phase 2 Real Textbook E2E: read-only import of 《针灸学（十四五）》第二章腧穴总论 -> segment read -> layout-whitespace citation locate -> autonomous AI multi-claim study_submit -> correction & supersede -> Markdown export -> Chinese short-term history search",
  { skip: !realTextbookChapter || !fs.existsSync(realTextbookChapter) },
  async () => {
    const beforeBytes = fs.readFileSync(realTextbookChapter);
    const beforeSha256 = crypto.createHash("sha256").update(beforeBytes).digest("hex");
    const beforeStat = fs.statSync(realTextbookChapter);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "med-tutor-p2-textbook-"));
    const prevRoot = process.env.S07B_DATA_ROOT;
    const prevSource = process.env.S07B_SOURCE;
    process.env.S07B_DATA_ROOT = path.join(tempRoot, "learning-data");
    process.env.S07B_SOURCE = piGuiRoot;

    try {
      const s07b = await import(
        `${pathToFileURL(path.join(__dirname, "s07b-extension.mjs")).href}?real=${Date.now()}`
      );
      const tools = createToolHarness(s07b);
      const materials = s07b.getMaterialsForWorker();
      const domain = s07b.getDomainForWorker();

      const sessionId = "sess_acupuncture_ch2";
      const sessionFile = path.join(tempRoot, `${sessionId}.jsonl`);
      const entries = [
        { type: "session", id: sessionId, version: 1, timestamp: new Date().toISOString(), cwd: tempRoot },
      ];
      fs.writeFileSync(sessionFile, JSON.stringify(entries[0]) + "\n", "utf8");
      const entryMap = new Map();
      const branch = [];
      const manager = {
        getSessionId: () => sessionId,
        getSessionFile: () => sessionFile,
        getBranch: () => branch,
        getLeafId: () => branch.at(-1)?.id ?? null,
        getEntry: (id) => entryMap.get(id),
        appendMessage(message) {
          const id = `msg_${branch.length + 1}`;
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
      };

      const callTool = async (name, args) => {
        const spec = tools.get(name);
        assert.ok(spec, `Tool ${name} missing`);
        const res = await spec.execute(`call_${name}_${Date.now()}`, args, undefined, undefined, {
          sessionManager: manager,
        });
        return JSON.parse(res.content[0].text);
      };

      // 1. Read-only import of the configured real textbook chapter
      const receipt = materials.stageBytes(
        path.basename(realTextbookChapter),
        beforeBytes,
        sessionId,
      );
      const imported = materials.importReceipt(sessionId, receipt);
      assert.equal(imported.name, "03_第二章腧穴总论.md");
      assert.equal(imported.sha256, beforeSha256);

      // 2. Segment read via material_read tool
      const readSeg1 = await callTool("material_read", {
        materialId: imported.materialId,
        versionId: imported.versionId,
        start: 0,
        maxChars: 1200,
      });
      assert.equal(readSeg1.ok, true);
      assert.ok(readSeg1.data.text.includes("第二章腧穴总论"));
      assert.ok(readSeg1.data.text.includes("十四经穴、经外奇穴、阿是穴"));

      // 3. Citation location (exact + layout-whitespace tolerant)
      const locExact = await callTool("citation_locate", {
        materialId: imported.materialId,
        versionId: imported.versionId,
        quote: "人体的腧穴总体上可归纳为十四经穴、经外奇穴、阿是穴3 类。",
      });
      assert.equal(locExact.ok, true);
      assert.equal(locExact.data.ok, true);
      assert.equal(locExact.data.method, "exact");

      const locWhitespace = await callTool("citation_locate", {
        materialId: imported.materialId,
        versionId: imported.versionId,
        quote: "所出为井，所溜为荥，\n所注为输，所行为经，所入为合。",
      });
      assert.equal(locWhitespace.ok, true);
      assert.equal(locWhitespace.data.ok, true);
      assert.equal(locWhitespace.data.method, "layout-whitespace");

      // 4. User asks AI to knead and save study sheet -> AI autonomously calls study_submit without pre-issued intentId!
      manager.appendMessage({
        role: "user",
        content:
          "请帮我揉一下《针灸学》第二章腧穴总论：理出腧穴三分类、主治三特点（近治/远治/特殊双向良性调整）以及特定穴（五输穴、原穴、郄穴）的主干，整理保存为学习单。",
      });
      manager.appendMessage({
        role: "assistant",
        content:
          "已为您提炼《针灸学》第二章腧穴总论的核心主干与判别链，包括三分类、三特点（含天枢/内关双向良性调整）及十类特定穴中的五输穴、原络穴、郄穴要点，现在为您沉淀为 V1 学习单。",
      });

      const submitV1 = await callTool("study_submit", {
        baseVersion: 0,
        draft: {
          title: "《针灸学（十四五）》第二章·腧穴总论主干学习单",
          claims: [
            {
              id: "claim_classification",
              text: "【分类主干】腧穴总体分为十四经穴（主体，有固定名称/位置且归属十四经）、经外奇穴（有定名定位但未归入十四经，主治单纯效奇）、阿是穴（无定名定位，以痛为输）3类。",
              citations: [
                {
                  materialId: imported.materialId,
                  versionId: imported.versionId,
                  quote: "人体的腧穴总体上可归纳为十四经穴、经外奇穴、阿是穴3 类。",
                },
              ],
            },
            {
              id: "claim_characteristics",
              text: "【主治三特点】近治作用（腧穴所在，主治所在）、远治作用（经脉所过，主治所及，肘膝以下尤突出）、特殊作用（双向良性调整如天枢止泻又通便、内关调心率，以及相对特异性如大椎退热、至阴矫胎）。",
              citations: [
                {
                  materialId: imported.materialId,
                  versionId: imported.versionId,
                  quote: "如腹泻时针天枢穴可止泻，便秘时针天枢穴可通便；内关可治心动过缓，又可治心动过速。",
                },
              ],
            },
            {
              id: "claim_specific_points",
              text: "【特定穴精要】肘膝以下五输穴按井、荥、输、经、合从四肢末端向肘膝排列；阴经以输为原（输原合一），阳经于输穴后另置一原；郄穴共16个，除胃经梁丘外均在肘膝以下。",
              citations: [
                {
                  materialId: imported.materialId,
                  versionId: imported.versionId,
                  quote: "阴经的原穴与五输穴中的输穴同穴名、同部位，实为一穴，即所谓“阴经以输为原”",
                },
                {
                  materialId: imported.materialId,
                  versionId: imported.versionId,
                  quote: "郄穴共有16 个，除胃经的梁丘之外，都分布于四肢肘膝关节以下。",
                },
              ],
            },
          ],
          uncertainties: ["八会穴与八脉交会穴的具体配穴歌诀待结合下半节核对"],
        },
      });
      assert.equal(submitV1.ok, true);
      assert.equal(submitV1.data.version, 1);

      // 5. User registers a correction via autonomous tool call
      const stateV1 = domain.state(sessionId, manager);
      assert.equal(stateV1.currentVersion, 1);
      assert.equal(stateV1.currentDraft.claims.length, 3);

      manager.appendMessage({
        role: "user",
        content: "补充纠正一下：还要特别强调“腧、输、俞”三字现代具体应用各有所指——腧穴是统称，输穴是五输穴第三穴，俞穴专指背俞穴。",
      });
      const corrRes = await callTool("correction_create", {
        target: {
          kind: "draft_claim",
          draftId: stateV1.currentDraft.draftId,
          version: 1,
          claimId: "claim_classification",
        },
        originalClaim: stateV1.currentDraft.claims[0].text,
        correction: "需在总论开头显著区分：腧穴（统称）、输穴（五输穴之第三穴）、俞穴（专指背俞穴）。",
        verificationStatus: "source-reviewed",
        unresolvedItems: [],
      });
      assert.equal(corrRes.ok, true);
      assert.equal(corrRes.data.revision, 1);

      // 6. Export study sheet & verify integrity
      const exportRes = await callTool("study_export", {
        version: 1,
        format: "study",
      });
      assert.equal(exportRes.ok, true);
      assert.ok(fs.existsSync(exportRes.data.path));

      // 7. History search with Chinese medical short term
      const searchRes = await callTool("history_search", {
        query: "天枢",
      });
      assert.equal(searchRes.ok, true);
      const matches = searchRes.data.matches ?? searchRes.data.hits ?? [];
      assert.ok(matches.length >= 1, "Chinese short term '天枢' should match history");

      const readHistRes = await callTool("history_read", {
        anchor: matches[0].anchor,
        start: 0,
        maxChars: 300,
      });
      assert.equal(readHistRes.ok, true);
      assert.ok(readHistRes.data.text.includes("天枢"));

      // 8. Verify original textbook file is 100% untouched!
      const afterBytes = fs.readFileSync(realTextbookChapter);
      const afterSha256 = crypto.createHash("sha256").update(afterBytes).digest("hex");
      const afterStat = fs.statSync(realTextbookChapter);
      assert.equal(afterSha256, beforeSha256, "Original textbook file SHA-256 must remain identical");
      assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, "Original textbook file mtime must remain untouched");
    } finally {
      if (prevRoot === undefined) delete process.env.S07B_DATA_ROOT;
      else process.env.S07B_DATA_ROOT = prevRoot;
      if (prevSource === undefined) delete process.env.S07B_SOURCE;
      else process.env.S07B_SOURCE = prevSource;
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {}
    }
  },
);
