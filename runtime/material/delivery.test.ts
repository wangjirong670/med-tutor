import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { source, content } from '../../core/material/test-fixtures.js';
import { inspectGeneration } from '../../core/material/generation.js';
import { projectHistory } from './projection.js';
import { generate } from './service.js';
import { Session } from './store.js';
import { renderStudy, renderAudit, renderSources } from './export.js';
import { createMaterialProvider } from './provider.js';
import type { loadRules } from './rules.js';
const dirs: string[] = [], at = '2026-10-27T00:00:00Z';
const rules = { mode: 'dev', note: '离线fixture', text: '离线规则', hash: 'offline', skillHash: 'offline', longHash: 'offline', commit: 'offline' } as ReturnType<typeof loadRules>;
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw Error('TEST_NETWORK_FORBIDDEN'); })); });
afterEach(() => { vi.unstubAllGlobals(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() { const dir = mkdtempSync(join(tmpdir(), 'med-delivery-')); dirs.push(dir); const s = new Session(dir, 'offline'); s.append({ type: 'created', at, title: '离线' }); s.append({ type: 'source_added', at, source }); return s; }
const provider = { model: 'OFFLINE_ONLY', async generate() { return { raw: JSON.stringify(content), model: 'OFFLINE_ONLY', ms: 1, finishReason: 'stop' }; } };
it('历史白名单保留完整正文、引用选择、拒绝决定与勘误理由，不回传定位证据', async () => {
  const s = setup(); await generate(s, provider, '初稿', { rules, reserve: () => 0 });
  const state = s.read().state;
  state.decisions.push({ version: 1, claimId: 'c1', choice: 'reject', note: '完整拒绝理由：范围不足。' });
  state.errata.push({ version: 1, original: '旧表述完整', cause: '修订原因完整', corrected: '改后完整', impact: '完整影响面' });
  const original = JSON.stringify(state); const projected = projectHistory(state);
  expect(projected.previous!.claims.map(c => c.text)).toEqual(state.drafts[0]!.claims.map(c => c.text));
  expect(projected.previous!.claims.map(c => c.id)).toEqual(state.drafts[0]!.claims.map(c => c.id));
  expect(projected.previous!.sourceKinds).toEqual([{ sourceId: source.id, revision: 1, kind: source.kind }]);
  expect(projected.decisions).toEqual(state.decisions); expect(projected.errata).toEqual(state.errata);
  expect(JSON.stringify(projected)).not.toContain('resolution'); expect(JSON.stringify(projected)).not.toContain('sourceSha256');
  expect(JSON.stringify(state)).toBe(original); expect(fetch).not.toHaveBeenCalled();
});
it('受限citationNote完整保留为模型注释，不改变origin，也不能代替所需引用', () => {
  const raw = structuredClone(content); raw.claims[0]!.citationNote = '原样保留的模型注释，不是教材证据。';
  const result = inspectGeneration(JSON.stringify(raw), [source], { finishReason: 'stop' });
  expect(result.ok).toBe(true); expect(result.content!.claims[0]!.citationNote).toBe(raw.claims[0]!.citationNote);
  expect(result.content!.claims[0]!.origin).toBe('material'); expect(result.semanticStatus).toBe('not-reviewed');
  raw.claims[0]!.citations = []; expect(inspectGeneration(JSON.stringify(raw), [source]).issues[0]!.code).toBe('MATERIAL_NO_CITATION');
});
it('未知字段、非字符串/超长注释、持久化字段不能靠宽松parse通过', () => {
  for (const extra of [{ unknown: '不准丢' }, { citationNote: { note: '不是字符串' } }, { citationNote: 'x'.repeat(2001) }]) {
    const raw = structuredClone(content); Object.assign(raw.claims[0]!, extra);
    const result = inspectGeneration(JSON.stringify(raw), [source]); expect(result.ok).toBe(false); expect(result.issues[0]!.code).toBe('SCHEMA');
  }
  const raw = { ...content, version: 99, requestId: '模型编的ID', referenceContract: 'refs-v2' };
  expect(inspectGeneration(JSON.stringify(raw), [source]).issues.some(i => i.path === 'version')).toBe(true);
  const legacy = inspectGeneration(JSON.stringify(raw), [source], { outputMode: 'legacy-envelope-v1' });
  expect(legacy.ok).toBe(true); expect(legacy.modelMetadata!.requestId).toBe('模型编的ID'); expect(legacy.content).not.toHaveProperty('requestId');
  const citationAudit = structuredClone(content); citationAudit.claims[0]!.citations[0]!.start = 0;
  expect(inspectGeneration(JSON.stringify(citationAudit), [source]).issues[0]!.path).toContain('start');
});
it('额外注释放行后仍逐条校验refs-v2，不洗白编造或重复引用', () => {
  const raw = structuredClone(content); raw.claims[0]!.citationNote = '不能替定位背书'; raw.claims[0]!.citations[0]!.quote = '编造内容';
  const result = inspectGeneration(JSON.stringify(raw), [source]); expect(result.stages!.schema).toBe('passed'); expect(result.stages!.references).toBe('failed'); expect(result.issues[0]!.code).toBe('NOT_FOUND');
});
it.each(['{"title":"截断', JSON.stringify(content)])('length即使偶然为合法JSON也不接收局部或整稿', raw => {
  const r = inspectGeneration(raw, [source], { finishReason: 'length' });
  expect(r.issues[0]!.code).toBe('OUTPUT_TRUNCATED'); expect(r.references).toEqual([]); expect(r.content).toBeUndefined();
  expect(r.stages!.schema).toBe('not-run');
});
it('没有length不假称截断，其他完成原因和空内容分别诊断', () => {
  expect(inspectGeneration('{', [source], { finishReason: 'stop' }).issues[0]!.code).toBe('JSON_INVALID');
  expect(inspectGeneration('{', [source]).finishReason).toBe('unknown');
  expect(inspectGeneration('{}', [source], { finishReason: 'content_filter' }).issues[0]!.code).toBe('INCOMPLETE_RESPONSE');
  expect(inspectGeneration('', [source], { finishReason: 'stop' }).issues[0]!.code).toBe('EMPTY_RESPONSE');
});
it('截断原响应/用量/完成原因留存，有效旧稿不被覆盖且可显式重试', async () => {
  const s = setup(); await generate(s, provider, '初稿', { rules, reserve: () => 0 }); const old = s.read().state.drafts[0];
  const result = { raw: '{"claims":[', model: 'OFFLINE_ONLY', ms: 1, response: { choices: [{ finish_reason: 'length' }] }, usage: { completion_tokens: 10000 } };
  await expect(generate(s, { model: 'OFFLINE_ONLY', async generate() { return result; } }, '截断', { rules, reserve: () => 0 })).rejects.toThrow('OUTPUT_TRUNCATED');
  expect(s.read().state.drafts).toEqual([old]); expect(s.read().state.pending).toBeUndefined();
  const validation = readdirSync(join(s.dir, 'requests')).filter(f => f.endsWith('.validation.json')).map(f => JSON.parse(readFileSync(join(s.dir, 'requests', f), 'utf8'))).find(x => !x.ok)!;
  expect(validation.failureCode).toBe('OUTPUT_TRUNCATED'); expect(validation.finishReason).toBe('length'); expect(validation.usage.completion_tokens).toBe(10000); expect(validation.retryPolicy).toBe('explicit-only');
  expect(fetch).not.toHaveBeenCalled();
});
it('人话和审计同源，全部正文/不确定项保留，审计保留证据与累计历史', async () => {
  const s = setup(); await generate(s, provider, '初稿', { rules, reserve: () => 0 }); const state = s.read().state;
  state.drafts[0]!.claims[0]!.citationNote = '模型待审注释原串';
  state.decisions.push({ version: 1, claimId: 'c1', choice: 'reject', note: '先不要用这条' });
  state.errata.push({ version: 1, original: '完整旧话', cause: '完整错因', corrected: '完整新话', impact: '完整影响' });
  state.sources.push({ ...source, revision: 2, text: '修正后的文字' });
  const before = JSON.stringify(state), learning = renderStudy(state), audit = renderAudit(state);
  for (const c of state.drafts[0]!.claims) { expect(learning).toContain(c.text); expect(audit).toContain(c.text); }
  for (const u of state.drafts[0]!.uncertainties) { expect(learning).toContain(u); expect(audit).toContain(u); }
  expect(learning).toContain('尚未据最新文字重新整理'); expect(learning).toContain('先不要用这条'); expect(learning).toContain('我补的，待你核对');
  expect(learning).not.toContain('字符0-'); expect(learning).not.toContain('sourceSha256'); expect(learning).toContain('audit.md#claim-c1');
  expect(audit).toContain('模型注释（待审，不是教材依据）：模型待审注释原串'); expect(audit).toContain('完整错因'); expect(audit).toContain('sourceSha256');
  expect(renderSources(state, true)).toContain('s1@1'); expect(renderSources(state, true)).toContain('s1@2'); expect(JSON.stringify(state)).toBe(before);
});
it('provider只用受控fetch，实际finish_reason与HTTP/网络/主动取消分类保留', async () => {
  const opts = { MED_TUTOR_API_KEY: 'offline-key', MED_TUTOR_STUDY_MODEL: 'OFFLINE_ONLY', MED_TUTOR_BASE_URL: 'https://invalid.test' };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }], usage: { completion_tokens: 10 } }), { status: 200 })));
  expect((await createMaterialProvider(opts).generate('system', 'user')).finishReason).toBe('length');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('do-not-echo-this', { status: 500 })));
  await expect(createMaterialProvider(opts).generate('s', 'u')).rejects.toMatchObject({ code: 'HTTP_ERROR' });
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('network'); }));
  await expect(createMaterialProvider(opts).generate('s', 'u')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  const ac = new AbortController(); ac.abort(); await expect(createMaterialProvider(opts).generate('s', 'u', ac.signal)).rejects.toMatchObject({ code: 'ABORTED' });
});
it('网络等待超时与正文length是两种不同失败', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_u, init) => new Promise((_resolve, reject) => { const signal = init.signal as AbortSignal; if (signal.aborted) reject(Error('timeout')); else signal.addEventListener('abort', () => reject(Error('timeout')), { once: true }); })));
  await expect(createMaterialProvider({ MED_TUTOR_API_KEY: 'offline', MED_TUTOR_STUDY_MODEL: 'offline', MED_TUTOR_TIMEOUT_MS: '1' }).generate('s', 'u')).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
});
