import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session, reserveRequest, hash } from './store.js';
import { generate, newDraft } from './service.js';
import { renderStudy, renderAudit } from './export.js';
import { pageRange, decodeText } from './import.js';
import { source, content } from '../../core/material/test-fixtures.js';
import { loadRules } from './rules.js';
import { createMaterialProvider } from './provider.js';
import { materialPrompt, MATERIAL_ADAPTER_VERSION } from './provider.js';
import { candidateRecord, inspectResponse, renderCandidate } from './candidate.js';
const dirs: string[] = [];
const at = '2026-10-27T00:00:00Z';
function setup() { const dir = mkdtempSync(join(tmpdir(), 'med-material-')); dirs.push(dir); const s = new Session(dir, 'test'); s.append({ type: 'created', at, title: 'test' }); s.append({ type: 'source_added', at, source }); return s; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const rules = { mode: 'dev', note: '离线测试规则', text: '只做合成离线测试', commit: 'test', hash: 'test', skillHash: 'test', longHash: 'test' } as ReturnType<typeof loadRules>;
it('生成失败保留有效稿和原响应，恢复回放不调用模型', async () => {
  const session = setup(); let calls = 0;
  const provider = { model: 'offline-test-only', async generate() { calls++; return { raw: JSON.stringify(content), model: 'offline-test-only', ms: 1 }; } };
  await session.locked(async () => { await generate(session, provider, '初稿', { reserve: () => 0, rules }); });
  const before = session.read().state.drafts[0];
  const bad = structuredClone(content); bad.claims[0]!.citations[0]!.quote = '模型编造的原文';
  await expect(session.locked(async () => generate(session, { model: 'offline-test-only', async generate() { return { raw: JSON.stringify(bad), model: 'offline-test-only', ms: 1 }; } }, '失败测试', { reserve: () => 0, rules }))).rejects.toThrow('保留');
  const state = new Session(session.root, 'test').read().state;
  expect(state.drafts).toEqual([before]); expect(state.pending).toBeUndefined(); expect(state.failures).toHaveLength(1); expect(calls).toBe(1);
  expect(readdirSync(join(session.dir, 'requests')).filter(f => f.endsWith('.response.json'))).toHaveLength(2);
});
it('中断在途请求不永久阻塞，显式放弃后可新生成', async () => {
  const session = setup(); session.append({ type: 'generation_started', at, requestId: 'interrupted', reason: '测试中断', rulesHash: 'test' });
  const recovered = new Session(session.root, 'test'); expect(recovered.read().state.pending).toBe('interrupted');
  await expect(generate(recovered, { model: 'offline', async generate() { throw Error('不得自动调用'); } }, 'test', { reserve: () => 0, rules })).rejects.toThrow('在途');
  recovered.append({ type: 'generation_abandoned', at, requestId: 'interrupted' });
  await generate(recovered, { model: 'offline', async generate() { return { raw: JSON.stringify(content), model: 'offline', ms: 1 }; } }, '显式重试', { reserve: () => 0, rules });
  expect(recovered.read().state.drafts).toHaveLength(1);
});
it('网络失败留失败事件；预算不自动重置', async () => {
  const s = setup();
  await expect(generate(s, { model: 'offline', async generate() { throw Error('synthetic timeout'); } }, '超时', { rules, reserve: () => 0 })).rejects.toThrow('timeout');
  expect(s.read().state.pending).toBeUndefined();
  for (let n = 1; n <= 10; n++) expect(reserveRequest(s.root)).toBe(n);
  expect(() => reserveRequest(s.root)).toThrow('10次');
});
it('哈希链损坏失败关闭，残留tmp不视为提交事件，锁排他', async () => {
  const s = setup(); writeFileSync(join(s.dir, 'events', '000003.json.tmp'), '{'); expect(s.read().events).toHaveLength(2);
  await s.locked(async () => { await expect(s.locked(async () => 1)).rejects.toThrow('锁定'); expect(() => s.unlock()).toThrow('仍存在'); });
  const path = join(s.dir, 'events', '000002.json'); writeFileSync(path, readFileSync(path, 'utf8').replace('全文', '偷改'));
  expect(() => s.read()).toThrow('损坏');
});
it('接受AI补充后导出仍待核；来源、决定和勘误不丢', async () => {
  const s = setup(); await generate(s, { model: 'offline', async generate() { return { raw: JSON.stringify(content), model: 'offline', ms: 1 }; } }, '初稿', { rules, reserve: () => 0 });
  s.append({ type: 'decision', at, decision: { version: 1, claimId: 'c2', choice: 'accept', note: '表达可用' } });
  const text = renderStudy(s.read().state); expect(text).toContain('我补的，待你核对'); expect(text).toContain('c2：accept'); expect(text).toContain('s1@1'); expect(text).toContain('audit.md'); expect(renderAudit(s.read().state)).toContain('【勘误】');
});
it('范围、编码与缺模型不静默降级', () => {
  expect(pageRange('1-2,4', 6)).toEqual([1, 2, 4]);
  for (const [range, total] of [[undefined, 11], ['1-11', 20], ['0', 3], ['4', 3]] as const) expect(() => pageRange(range, total)).toThrow();
  expect(() => decodeText(Buffer.from([0xff]))).toThrow('UTF-8'); expect(() => createMaterialProvider({})).toThrow('不会切换');
});
it('规则漂移按快照且明示；快照被改则停用', () => {
  const root = mkdtempSync(join(tmpdir(), 'med-rules-')); dirs.push(root);
  const skill = join(root, 'skills/med-study-knead');
  mkdirSync(join(skill, 'references/snapshot'), { recursive: true }); mkdirSync(join(root, 'docs'), { recursive: true }); mkdirSync(join(root, 'prompts'), { recursive: true });
  const text = 'authoritative rules\n';
  writeFileSync(join(root, 'prompts/quickstart.zh.md'), text);
  writeFileSync(join(root, 'docs/long-material.zh.md'), 'long'); writeFileSync(join(skill, 'SKILL.md'), 'skill');
  const snap = join(skill, 'references/snapshot/quickstart.snapshot.md'); writeFileSync(snap, `generated header\n\n${text}`);
  writeFileSync(join(skill, 'references/snapshot/MANIFEST.json'), JSON.stringify({ sources: [{ source_relpath: 'prompts/quickstart.zh.md', source_sha256: hash(text), snapshot_relpath: 'references/snapshot/quickstart.snapshot.md' }] }));
  expect(loadRules(root).mode).toBe('dev');
  writeFileSync(join(root, 'prompts/quickstart.zh.md'), 'drift'); const fallback = loadRules(root);
  expect(fallback.mode).toBe('snapshot'); expect(fallback.note).toContain('依据 skill 快照');
  writeFileSync(snap, 'generated header\n\ntampered'); expect(() => loadRules(root)).toThrow('快照正文');
});
it('人工改一条不冒称已重新整理全部新材料', async () => {
  const s = setup(); await generate(s, { model: 'offline', async generate() { return { raw: JSON.stringify(content), model: 'offline', ms: 1 }; } }, '初稿', { rules, reserve: () => 0 });
  s.append({ type: 'text_corrected', at, source: { ...source, revision: 2, text: '甲是绿色' }, reason: '识别修正' });
  const state = s.read().state; const previous = state.drafts[0]!;
  const draft = newDraft(previous, state, 'manual-erratum');
  expect(draft.sourceVersions).toEqual(['s1@1']);
  expect(renderStudy(state, draft)).toContain('尚未据最新文字重新整理');
});
it('模型删除冲突不能抹掉两侧历史依据', async () => {
  const s = setup(); const conflicted = structuredClone(content);
  conflicted.conflicts = [{ text: '两说待核', sides: [{ sourceId: 's1', revision: 1, quote: '甲是红色' }, { sourceId: 's1', revision: 1, quote: '乙是蓝色' }] }];
  await generate(s, { model: 'offline', async generate() { return { raw: JSON.stringify(conflicted), model: 'offline', ms: 1 }; } }, '初稿', { rules, reserve: () => 0 });
  const revised = await generate(s, { model: 'offline', async generate() { return { raw: JSON.stringify(content), model: 'offline', ms: 1 }; } }, '模型想删冲突', { rules, reserve: () => 0 });
  expect(revised.conflicts).toHaveLength(1); expect(revised.conflicts[0]!.text).toContain('历史冲突保留'); expect(revised.conflicts[0]!.sides).toHaveLength(2);
});
it('引用失败保存逐项候选诊断而不修改有效稿，读候选不产生接收事件', async () => {
  const s = setup();
  const provider = { model: 'offline', async generate() { return { raw: JSON.stringify(content), model: 'offline', ms: 1 }; } };
  await generate(s, provider, '初稿', { rules, reserve: () => 0 });
  const before = s.read().state.drafts[0];
  const invalid = structuredClone(content); invalid.claims[0]!.citations.push({ sourceId: 's1', revision: 1, quote: '编造片段' }, { sourceId: 's1', revision: 2, quote: '甲是红色' });
  invalid.conflicts = [{ text: '仅作候选核对的两侧', sides: [{ sourceId: 's1', revision: 1, quote: '甲是红色' }, { sourceId: 's1', revision: 1, quote: '乙是蓝色' }] }];
  await expect(generate(s, { model: 'offline', async generate() { return { raw: JSON.stringify(invalid), model: 'offline', ms: 1 }; } }, '候选失败', { rules, reserve: () => 0 })).rejects.toThrow('claims[0].citations[1]');
  const candidateFile = readdirSync(join(s.dir, 'requests')).find(f => f.endsWith('.candidate.json'))!;
  const record = JSON.parse(readFileSync(join(s.dir, 'requests', candidateFile), 'utf8')) as ReturnType<typeof candidateRecord>;
  expect(record.kind).toBe('unaccepted-candidate'); expect(record.inspection.issues.map(i => i.code)).toEqual(['NOT_FOUND', 'REVISION_NOT_FOUND']);
  const view = renderCandidate(record); expect(view).toContain('不是有效学习单'); expect(view).toContain('引用定位成立不代表整句有依据');
  expect(view).toContain('编造片段'); expect(view).toContain('REVISION_NOT_FOUND');
  expect(view).toContain('conflicts[0].sides[0]'); expect(view).toContain('是否互斥未核');
  const state = s.read().state; expect(state.drafts).toEqual([before]); expect(state.pending).toBeUndefined();
  expect(state.decisions).toHaveLength(0); expect(record.adapterVersion).toBe(MATERIAL_ADAPTER_VERSION);
});
it('新稿保存白名单映射并可回放；篡改映射不能作为有效稿接收', async () => {
  const s = setup();
  const changed = { ...source, id: 's2', text: '合计10 个。', sha256: hash('合计10 个。') };
  s.append({ type: 'source_added', at, source: changed });
  const d = structuredClone(content); d.claims[0]!.citations = [{ sourceId: 's2', revision: 1, quote: '合计10个。' }];
  const draft = await generate(s, { model: 'offline', async generate() { return { raw: JSON.stringify(d), model: 'offline', ms: 1 }; } }, '规范化', { rules, reserve: () => 0 });
  expect(draft.referenceContract).toBe('refs-v2'); expect(draft.claims[0]!.citations[0]!.resolution!.normalization!.sourceOffsets).toHaveLength(6);
  expect(new Session(s.root, s.id).read().state.drafts[0]).toEqual(draft);
  expect(renderAudit(s.read().state)).toContain('排版空白匹配'); expect(renderStudy(s.read().state)).not.toContain('模型原 quote');
  const bad = structuredClone(draft); bad.version = 2; bad.requestId = 'manual-erratum'; bad.claims[0]!.citations[0]!.resolution!.normalization!.quoteOffsets[0]![1] = 100;
  expect(() => s.append({ type: 'erratum', at, draft: bad, erratum: { original: 'old', cause: 'test', corrected: 'bad', impact: 'test', version: 2 } })).toThrow('RESOLUTION_MISMATCH');
  expect(s.read().state.drafts).toHaveLength(1);
});
it('未带新契约字段的历史事件可继续读取，原负例不会因新匹配而变成历史有效稿', () => {
  const s = setup();
  s.append({ type: 'generation_started', at, requestId: 'legacy', reason: '历史稿', rulesHash: 'legacy' });
  const draft = { ...content, claims: [{ ...content.claims[0]!, citations: [{ sourceId: 's1', revision: 1, quote: '甲是红色', start: 0, end: 4 }] }], version: 1, requestId: 'legacy', sourceVersions: ['s1@1'] };
  s.append({ type: 'draft_saved', at, draft, errata: [] });
  expect(s.read().state.drafts[0]).toEqual(draft);
  expect(s.read().state.drafts[0]!.referenceContract).toBeUndefined();
  const invalid = structuredClone(draft); invalid.version = 2; invalid.claims[0]!.citations[0]!.quote = '甲 是红色';
  expect(() => s.append({ type: 'erratum', at, draft: invalid, erratum: { original: 'old', cause: 'test', corrected: 'bad', impact: 'test', version: 2 } })).toThrow('LEGACY_REFERENCE');
});
it('新结构提示带版本与稳定片段，不把离线旧响应当新提示结果', () => {
  const s = setup(); const prompt = materialPrompt(s.read().state, rules, 'test');
  expect(prompt.system).toContain(MATERIAL_ADAPTER_VERSION); expect(prompt.system).toContain('不同标题次序/组织轴');
  const payload = JSON.parse(prompt.user); expect(payload.referenceContract).toBe('refs-v2');
  expect(payload.sources[0].fragments[0].text).toBe(source.text); expect(payload.sources[0].fragments[0].id).toMatch(/^f1-/);
  expect(inspectResponse('not JSON', [source]).issues[0]!.code).toBe('JSON_INVALID');
});
