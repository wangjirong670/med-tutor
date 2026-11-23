import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CitationError, normalizeLayout, resolveCitation, resolveLegacyCitation, sourceFragments, type Citation } from './citations.js';
import { inspectDraft, validateDraft, type Source } from './model.js';
import { source, content } from './test-fixtures.js';
const src = (text: string, revision = 1): Source => ({ ...source, text, revision, sha256: `test-${revision}` });
const ref = (quote: string, extra: Partial<Citation> = {}): Citation => ({ sourceId: 's1', revision: 1, quote, ...extra });
const code = (fn: () => unknown) => { try { fn(); return 'ACCEPTED'; } catch (e) { return e instanceof CitationError ? e.code : 'OTHER'; } };
describe('refs-v2 有界排版匹配', () => {
  it('数字旁排版空格、全角空格与换行可定位，原文和模型quote都保留', () => {
    const text = '前文。可分为10\u3000类，共5\t个；仍\r\n需核对。后文。';
    const quote = '可分为10类，共5 个；仍需核对。';
    const c = resolveCitation(ref(quote), [src(text)]);
    expect(c.quote).toBe(quote); expect(text.slice(c.start, c.end)).toBe('可分为10\u3000类，共5\t个；仍\r\n需核对。');
    expect(c.resolution!.originalQuote).toBe(text.slice(c.start, c.end));
    const n = c.resolution!.normalization!;
    expect(n.policy).toBe('layout-space-v1');
    expect(n.sourceOffsets.map(([a, b]) => text.slice(a, b)).join('')).toBe(n.text);
    expect(n.quoteOffsets.map(([a, b]) => quote.slice(a, b)).join('')).toBe(n.text);
    expect(resolveCitation(c, [src(text)])).toEqual(c);
  });
  it.each(['合计16个。', '合计１6个。', '并非全部合格。', '经穴位于腕部。', '又称「测试」。', '不存在。'])(
    '非白名单改写仍拒绝：%s', quote => {
      const s = src('合计15 个。并非多数合格。经穴多位于腕部。又称“测试”。');
      expect(code(() => resolveCitation(ref(quote), [s]))).toBe('NOT_FOUND');
    });
  it('不能将分开的数字或英文词拼接成新值/词，零宽字符也不忽略', () => {
    expect(code(() => resolveCitation(ref('计10个'), [src('计1 0个')]))).toBe('NOT_FOUND');
    expect(code(() => resolveCitation(ref('drugAB'), [src('drug A B')]))).toBe('NOT_FOUND');
    expect(code(() => resolveCitation(ref('计10个'), [src('计1\u200b0个')]))).toBe('NOT_FOUND');
    expect(code(() => resolveCitation(ref(' \n'), [src(' \n')]))).toBe('EMPTY_QUOTE');
  });
  it('重复原句不取第一处，可用片段ID、紧邻上下文或位置消歧', () => {
    const text = '段一：\n共有16 个。\n\n段二：\n共有16 个。'; const s = src(text);
    try { resolveCitation(ref('共有16个。'), [s]); throw Error('must reject'); }
    catch (e) { expect(e).toBeInstanceOf(CitationError); expect((e as CitationError).code).toBe('AMBIGUOUS'); expect((e as CitationError).candidates).toHaveLength(2); }
    const fragment = sourceFragments(s)[1]!;
    const b = resolveCitation(ref('共有16个。', { fragmentId: fragment.id }), [s]);
    expect(b.start).toBe(text.lastIndexOf('共有'));
    expect(resolveCitation(ref('共有16 个。', { before: '段二：\n' }), [s]).start).toBe(b.start);
    expect(resolveCitation(ref('共有16 个。', { start: b.start }), [s]).start).toBe(b.start);
    expect(code(() => resolveCitation(ref('共有16个。', { before: '并不存在的邻文' }), [s]))).toBe('CONTEXT_MISMATCH');
  });
  it('精确唯一但空白等价另有一处时仍是歧义', () => {
    const s = src('计10类。\n\n计10 类。');
    expect(code(() => resolveCitation(ref('计10类。'), [s]))).toBe('AMBIGUOUS');
    expect(resolveCitation(ref('计10类。', { start: 0, end: 5 }), [s]).resolution!.method).toBe('exact');
  });
  it('片段/位置/源/版本均约束定位，不能借另一页或新版兜底', () => {
    const s = src('首段唯一。\n\n第二段引用。'); const f = sourceFragments(s)[0]!;
    expect(code(() => resolveCitation(ref('第二段引用。', { fragmentId: f.id }), [s]))).toBe('NOT_FOUND');
    expect(code(() => resolveCitation(ref('首段唯一。', { fragmentId: 'made-up' }), [s]))).toBe('FRAGMENT_NOT_FOUND');
    expect(code(() => resolveCitation(ref('首段唯一。', { start: 100 }), [s]))).toBe('POSITION_MISMATCH');
    expect(code(() => resolveCitation(ref('首段唯一。', { sourceId: 's9' }), [s]))).toBe('SOURCE_NOT_FOUND');
    expect(code(() => resolveCitation(ref('首段唯一。', { revision: 2 }), [s]))).toBe('REVISION_NOT_FOUND');
    expect(code(() => resolveCitation(ref('首段唯一。', { sourceId: 's2' }), [s, { ...src('另一份原文。'), id: 's2' }]))).toBe('NOT_FOUND');
    expect(code(() => resolveCitation(ref('首段唯一。', { fragmentId: f.id, revision: 2 }), [s, src(s.text, 2)]))).toBe('FRAGMENT_NOT_FOUND');
  });
  it('篡改匹配方法、原文quote或映射不能回放为通过', () => {
    const s = src('共10 个。'); const c = resolveCitation(ref('共10个。'), [s]);
    for (const mutate of [(x: Citation) => { x.resolution!.method = 'exact'; }, (x: Citation) => { x.resolution!.originalQuote = '伪造'; }, (x: Citation) => { x.resolution!.normalization!.sourceOffsets[0]![0] = 99; }]) {
      const bad = structuredClone(c); mutate(bad); expect(code(() => resolveCitation(bad, [s]))).toBe('RESOLUTION_MISMATCH');
    }
  });
  it('旧exact契约保持旧行为，不用新宽松匹配重写历史', () => {
    const s = src('共10 个。'); expect(() => resolveLegacyCitation(ref('共10个。'), [s])).toThrow();
    expect(resolveLegacyCitation(ref('共10 个。'), [s])).toEqual(ref('共10 个。', { start: 0, end: 6 }));
  });
  it('一次列出每项定位错误；真子串省略限定的语义仍未核', () => {
    const d = structuredClone(content); d.claims[0]!.citations = [ref('不存在'), ref('共有16个。')];
    d.conflicts = [{ text: '待核的候选冲突', sides: [ref('不存在2'), ref('不存在3')] }];
    const inspection = inspectDraft(d, [src('共有16 个。共有16 个。')]);
    expect(inspection.issues).toHaveLength(4); expect(inspection.references).toHaveLength(4);
    expect(inspection.issues.map(i => i.ownerId)).toEqual(['c1', 'c1', 'conflict_1', 'conflict_1']);
    expect(inspection.issues[1]!.code).toBe('AMBIGUOUS');
    const partial = structuredClone(content); partial.claims[0]!.text = '全部合格。'; partial.claims[0]!.citations = [ref('合格')];
    const semanticGap = inspectDraft(partial, [src('并非全部合格。')]);
    expect(semanticGap.ok).toBe(true); expect(semanticGap.semanticStatus).toBe('not-reviewed');
    expect(() => validateDraft(d, [source])).toThrow('claims[0].citations[0]');
  });
  it('稳定片段ID分开重复并约束长度，原文没有被改写', () => {
    const s = src('同一句。\n\n同一句。\n\n' + '很长的句子。'.repeat(150));
    const a = sourceFragments(s), b = sourceFragments(s);
    expect(a).toEqual(b); expect(a[0]!.id).not.toBe(a[1]!.id);
    for (const f of a) { expect(f.end - f.start).toBeLessThanOrEqual(600); expect(s.text.slice(f.start, f.end)).toBe(f.text); }
  });
  it('性质：白名单布局变体的每个映射均落回正确原文字符', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(' ', '\t', '\n', '\r\n', '\u3000', '\u00a0'), { minLength: 1, maxLength: 6 }), spaces => {
      const text = `前${spaces.join('')}缀有10${spaces[0]}类。`;
      const c = resolveCitation(ref('前缀有10类。'), [src(text)]);
      expect(c.quote).toBe('前缀有10类。'); expect(c.resolution!.originalQuote).toBe(text);
      const n = c.resolution!.normalization!;
      expect(n.sourceOffsets.map(([a, b]) => text.slice(a, b)).join('')).toBe(n.text);
      expect(normalizeLayout(text).text).toBe(n.text);
    }), { numRuns: Number(process.env.PROP_RUNS ?? 100) });
  });
});
