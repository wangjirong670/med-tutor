import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { emptyState, fold, validateDraft, resolveCitation, changedClaims, type Source, type DraftContent, type Draft } from './model.js';

import { source, content } from './test-fixtures.js';
const at = '2026-10-27T00:00:00Z';
describe('材料领域边界', () => {
  it('只验证位置不把引用存在说成语义正确', () => {
    const raw = structuredClone(content); raw.claims[0]!.text = '故意写反的主张';
    expect(validateDraft(raw, [source]).claims[0]!.citations[0]!.start).toBe(0);
    // This acceptance is a documented semantic-review gap, not medical validation.
  });
  it('拒绝编造、错版、越界与重复未定位引用', () => {
    for (const citation of [{ sourceId: 's1', revision: 2, quote: '甲是红色' }, { sourceId: 's1', revision: 1, quote: '不存在' }, { sourceId: 's1', revision: 1, quote: '甲是红色', start: 0, end: 999 }]) expect(() => resolveCitation(citation, [source])).toThrow();
    expect(() => resolveCitation({ sourceId: 's1', revision: 1, quote: '甲' }, [{ ...source, text: '甲甲' }])).toThrow('多个');
  });
  it('材料主张必须有引用，AI不得挂材料引用洗白', () => {
    const noRef = structuredClone(content); noRef.claims[0]!.citations = [];
    expect(() => validateDraft(noRef, [source])).toThrow('缺引用');
    const ai = structuredClone(content); ai.claims[0]!.origin = 'ai';
    expect(() => validateDraft(ai, [source])).toThrow('AI');
  });
  it('拍板不改变AI来源，文字修正不改变旧引用', () => {
    let s = fold(emptyState(), { type: 'created', at, title: 'test' });
    s = fold(s, { type: 'source_added', at, source });
    s = fold(s, { type: 'generation_started', at, requestId: 'r1', reason: 'test', rulesHash: 'rule' });
    const draft: Draft = { ...validateDraft(content, [source]), version: 1, requestId: 'r1', sourceVersions: ['s1@1'] };
    s = fold(s, { type: 'draft_saved', at, draft, errata: [] });
    s = fold(s, { type: 'decision', at, decision: { version: 1, claimId: 'c2', choice: 'accept', note: '同意表达' } });
    s = fold(s, { type: 'text_corrected', at, source: { ...source, revision: 2, text: '甲是绿色' }, reason: '纠正识别' });
    expect(s.drafts[0]!.claims[1]!.origin).toBe('ai');
    expect(resolveCitation(s.drafts[0]!.claims[0]!.citations[0]!, s.sources).revision).toBe(1);
    expect(s.errata[0]!.cause).toBe('识别文字修正');
  });
  it('主张变化/删除显式勘误', () => {
    const previous: Draft = { ...content, version: 1, requestId: 'r', sourceVersions: ['s1@1'] };
    const next = structuredClone(content); next.claims.splice(0, 1); next.claims[0]!.text = '修正后的句子';
    expect(changedClaims(previous, next, '补充后页', 2)).toHaveLength(2);
  });
  it('只补定位审计元数据不伪造内容勘误', () => {
    const previous: Draft = { ...validateDraft(content, [source], 'legacy-v1'), version: 1, requestId: 'r', sourceVersions: ['s1@1'] };
    const next = validateDraft(previous, [source]);
    expect(next.claims[0]!.citations[0]!.resolution).toBeDefined();
    expect(changedClaims(previous, next, '契约升级', 2)).toEqual([]);
  });
  it('性质：非空白精确子串有稳定位置，错误版本均拒绝', () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 100 }).filter(s => !!s.trim()), text => {
      const s = { ...source, text };
      const c = { sourceId: s.id, revision: 1, quote: text, start: 0, end: text.length };
      expect(resolveCitation(c, [s])).toMatchObject({ ...c, resolution: { method: 'exact', originalQuote: text } });
      expect(() => resolveCitation({ ...c, revision: 2 }, [s])).toThrow();
    }), { numRuns: Number(process.env.PROP_RUNS ?? 100) });
  });
});
