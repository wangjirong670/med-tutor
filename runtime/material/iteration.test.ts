import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session } from './store.js';
import { generate, appendCitations } from './service.js';
import { changedClaims } from '../../core/material/model.js';
import { source, content } from '../../core/material/test-fixtures.js';
import { renderAudit, renderStudy } from './export.js';
import type { loadRules } from './rules.js';
const dirs: string[] = [], at = '2026-10-28T00:00:00Z';
const rules = { mode: 'dev', note: 'offline', text: 'offline', hash: 'offline', skillHash: 'offline', longHash: 'offline', commit: 'offline' } as ReturnType<typeof loadRules>;
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw Error('OFFLINE_TEST_NETWORK_FORBIDDEN'); })); });
afterEach(() => { vi.unstubAllGlobals(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
async function setup() { const root = mkdtempSync(join(tmpdir(), 'med-iteration-')); dirs.push(root); const s = new Session(root, 'test'); s.append({ type: 'created', at, title: 'test' }); s.append({ type: 'source_added', at, source }); await generate(s, { model: 'OFFLINE', async generate() { return { raw: JSON.stringify(content), model: 'OFFLINE', ms: 1, finishReason: 'stop' }; } }, '初稿', { rules, reserve: () => 0 }); return s; }
it('只补引用保留正文、来源性质与旧引用，明确留下人工来源核对记录', async () => {
  const s = await setup(), old = s.read().state.drafts[0]!, oldJson = JSON.stringify(old);
  const next = appendCitations(s, 'c1', [{ sourceId: 's1', revision: 1, quote: '乙是蓝色' }], '执行agent核对，非模型自改/用户或专家终审');
  expect(next.claims.map(c => c.text)).toEqual(old.claims.map(c => c.text)); expect(next.claims[0]!.origin).toBe('material');
  expect(next.claims[0]!.citations[0]).toEqual(old.claims[0]!.citations[0]); expect(next.claims[0]!.citations).toHaveLength(2);
  expect(JSON.stringify(s.read().state.drafts[0])).toBe(oldJson); expect(next.requestId).toBe('manual-reference-repair');
  expect(s.read().state.errata.at(-1)!.impact).toContain('正文未改'); expect(s.read().state.errata.at(-1)!.original).toContain('引用');
  expect(new Session(s.root, s.id).read().state.drafts[1]).toEqual(next); expect(fetch).not.toHaveBeenCalled();
});
it('重复引用不替换旧模型quote，编造/AI升级失败不产生事件', async () => {
  const s = await setup(); const before = s.read();
  expect(() => appendCitations(s, 'c1', [{ sourceId: 's1', revision: 1, quote: '甲是红色' }], '重复')).toThrow('没有新增');
  expect(() => appendCitations(s, 'c1', [{ sourceId: 's1', revision: 1, quote: '没有此句' }], '错误')).toThrow();
  expect(() => appendCitations(s, 'c2', [{ sourceId: 's1', revision: 1, quote: '乙是蓝色' }], '升级')).toThrow('不升级');
  expect(s.read()).toEqual(before);
});
it('注释变化摘要显示实际注释，不用相同正文充当改前改后', async () => {
  const s = await setup(), old = s.read().state.drafts[0]!, next = structuredClone(old);
  next.claims[0]!.citationNote = '新增待审注释';
  const changes = changedClaims(old, next, '补充', 2);
  expect(changes).toHaveLength(1); expect(changes[0]!.original).toContain('模型待审注释：未提供'); expect(changes[0]!.corrected).toContain('模型待审注释：新增待审注释'); expect(changes[0]!.impact).toContain('正文未改');
  const state = s.read().state; next.version = 2; state.drafts.push(next); state.errata.push({ original: `c1: ${old.claims[0]!.text}`, corrected: `c1: ${next.claims[0]!.text}`, cause: '旧记录', impact: '旧记录', version: 2 });
  expect(renderAudit(state)).toContain('旧记录展示澄清'); expect(renderAudit(state)).toContain('新增待审注释');
});
it('继承失败明确标累计历史，不等于成功新轮失败', async () => {
  const s = await setup(); const state = s.read().state; state.failures.push('原先的一次超时');
  expect(renderStudy(state)).toContain('累计/历史失败记录：1轮，不代表本轮失败'); expect(renderAudit(state)).toContain('历史第1轮：原先的一次超时');
});
