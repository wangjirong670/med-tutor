import type { Source } from './model.js';

export const REFERENCE_CONTRACT = 'refs-v2' as const;
export const LAYOUT_POLICY = 'layout-space-v1' as const;
export type OffsetPair = [number, number];
export type CitationResolution = {
  contract: typeof REFERENCE_CONTRACT;
  method: 'exact' | 'layout-whitespace';
  originalQuote: string;
  sourceSha256: string;
  normalization?: { policy: typeof LAYOUT_POLICY; text: string; sourceOffsets: OffsetPair[]; quoteOffsets: OffsetPair[] };
};
export type Citation = {
  sourceId: string; revision: number; quote: string; start?: number; end?: number;
  fragmentId?: string; before?: string; after?: string; resolution?: CitationResolution;
};
export type Fragment = { id: string; start: number; end: number; text: string };
export type CitationCandidate = { start: number; end: number; method: CitationResolution['method']; fragmentIds: string[] };
export type CitationCode = 'SOURCE_NOT_FOUND' | 'REVISION_NOT_FOUND' | 'EMPTY_QUOTE' | 'FRAGMENT_NOT_FOUND' | 'NOT_FOUND' | 'POSITION_MISMATCH' | 'CONTEXT_MISMATCH' | 'AMBIGUOUS' | 'RESOLUTION_MISMATCH';
const messages: Record<CitationCode, string> = {
  SOURCE_NOT_FOUND: '来源不存在', REVISION_NOT_FOUND: '来源版本不存在', EMPTY_QUOTE: '引用为空',
  FRAGMENT_NOT_FOUND: '片段ID不属于指定来源版本', NOT_FOUND: '引用片段与原文不符（仅允许排版空白白名单）',
  POSITION_MISMATCH: '引用越界或指定位置与原文不符', CONTEXT_MISMATCH: '紧邻上下文与候选位置不符',
  AMBIGUOUS: '引用有多个位置，须用片段ID、上下文或原文位置消歧', RESOLUTION_MISMATCH: '保存的定位证据与原文重算不符',
};
export class CitationError extends Error {
  constructor(readonly code: CitationCode, readonly candidates: CitationCandidate[] = []) { super(`${code}: ${messages[code]}`); }
}

/** Explicit layout-only policy. Non-whitespace code units are never changed. */
export function normalizeLayout(text: string): { text: string; offsets: OffsetPair[] } {
  let normalized = ''; const offsets: OffsetPair[] = [];
  const space = (c: string) => /^[ \t\r\n\u00a0\u3000]$/.test(c);
  const asciiWord = (c: string) => /^[A-Za-z0-9]$/.test(c);
  for (let i = 0; i < text.length;) {
    if (!space(text[i]!)) { normalized += text[i]; offsets.push([i, i + 1]); i++; continue; }
    const start = i;
    while (i < text.length && space(text[i]!)) i++;
    // Preserve word/number separation. Removing it could change a value or word.
    if (start === 0 || i === text.length || (asciiWord(text[start - 1]!) && asciiWord(text[i]!))) {
      normalized += ' '; offsets.push([start, i]);
    }
  }
  return { text: normalized, offsets };
}

/** Deterministic bounded source catalogue; duplicate text keeps separate IDs. */
export function sourceFragments(source: Source): Fragment[] {
  const fragments: Fragment[] = [];
  const add = (start: number, end: number) => {
    while (start < end && /[ \t\r\n\u00a0\u3000]/.test(source.text[start]!)) start++;
    while (end > start && /[ \t\r\n\u00a0\u3000]/.test(source.text[end - 1]!)) end--;
    while (start < end) {
      let cut = Math.min(start + 600, end);
      if (cut < end) {
        const window = source.text.slice(start, cut);
        const boundaries = [...window.matchAll(/[。！？；\n]/g)];
        const last = boundaries.at(-1)?.index;
        if (last !== undefined && last > 0) cut = start + last + 1;
        // Do not cut a UTF-16 surrogate pair.
        else if (/[\uD800-\uDBFF]/.test(source.text[cut - 1]!)) cut--;
      }
      fragments.push({ id: `f${source.revision}-${source.sha256.slice(0, 12)}-${start}-${cut}`, start, end: cut, text: source.text.slice(start, cut) });
      start = cut;
    }
  };
  let start = 0;
  for (const blank of source.text.matchAll(/\r?\n[ \t\u00a0\u3000]*\r?\n/g)) { add(start, blank.index); start = blank.index + blank[0].length; }
  add(start, source.text.length);
  return fragments;
}
const occurrences = (text: string, needle: string): number[] => {
  const found: number[] = [];
  if (!needle) return found;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
};

/** Historical exact contract. Used only for old immutable event payloads. */
export function resolveLegacyCitation(c: Citation, sources: Source[]): Citation {
  const source = sources.find(s => s.id === c.sourceId && s.revision === c.revision);
  if (!source || !c.quote) throw Error('来源版本不存在或引用为空');
  const start = c.start ?? source.text.indexOf(c.quote);
  if (c.start === undefined && source.text.indexOf(c.quote, start + 1) !== -1) throw Error('引用有多个位置，请指定 start/end');
  const end = c.end ?? start + c.quote.length;
  if (start < 0 || end <= start || end > source.text.length || source.text.slice(start, end) !== c.quote) throw Error('引用越界或片段与原文不符');
  return { ...c, start, end };
}

export function resolveCitation(c: Citation, sources: Source[]): Citation {
  if (!sources.some(s => s.id === c.sourceId)) throw new CitationError('SOURCE_NOT_FOUND');
  const source = sources.find(s => s.id === c.sourceId && s.revision === c.revision);
  if (!source) throw new CitationError('REVISION_NOT_FOUND');
  if (!c.quote?.trim()) throw new CitationError('EMPTY_QUOTE');
  const fragments = sourceFragments(source);
  const fragment = c.fragmentId ? fragments.find(f => f.id === c.fragmentId) : undefined;
  if (c.fragmentId && !fragment) throw new CitationError('FRAGMENT_NOT_FOUND');
  const normalizedSource = normalizeLayout(source.text), normalizedQuote = normalizeLayout(c.quote);
  const candidates = new Map<string, CitationCandidate>();
  const add = (start: number, end: number, method: CitationResolution['method']) => {
    const key = `${start}:${end}`;
    if (!candidates.has(key)) candidates.set(key, { start, end, method, fragmentIds: fragments.filter(f => start >= f.start && end <= f.end).map(f => f.id) });
  };
  for (const start of occurrences(source.text, c.quote)) add(start, start + c.quote.length, 'exact');
  for (const start of occurrences(normalizedSource.text, normalizedQuote.text)) {
    const last = start + normalizedQuote.text.length - 1;
    const a = normalizedSource.offsets[start], b = normalizedSource.offsets[last];
    if (a && b) {
      const raw = source.text.slice(a[0], b[1]);
      // Normalizing the selected raw span must itself agree (boundary spaces matter).
      if (normalizeLayout(raw).text === normalizedQuote.text) add(a[0], b[1], raw === c.quote ? 'exact' : 'layout-whitespace');
    }
  }
  let possible = [...candidates.values()].sort((a, b) => a.start - b.start || a.end - b.end);
  if (!possible.length) throw new CitationError('NOT_FOUND');
  if (fragment) possible = possible.filter(p => p.start >= fragment.start && p.end <= fragment.end);
  if (fragment && !possible.length) throw new CitationError('NOT_FOUND');
  if (c.end !== undefined && c.start === undefined) throw new CitationError('POSITION_MISMATCH', possible);
  if (c.start !== undefined) {
    const selected = possible.filter(p => p.start === c.start && (c.end === undefined || p.end === c.end));
    if (!selected.length) throw new CitationError('POSITION_MISMATCH', possible);
    possible = selected;
  }
  if (c.before !== undefined || c.after !== undefined) {
    // Context is immediate, not a loose nearby keyword. It follows the same policy.
    possible = possible.filter(p => (c.before === undefined || source.text.slice(0, p.start).endsWith(c.before) || normalizeLayout(source.text.slice(0, p.start)).text.endsWith(normalizeLayout(c.before).text)) && (c.after === undefined || source.text.slice(p.end).startsWith(c.after) || normalizeLayout(source.text.slice(p.end)).text.startsWith(normalizeLayout(c.after).text)));
    if (!possible.length) throw new CitationError('CONTEXT_MISMATCH', [...candidates.values()]);
  }
  if (possible.length !== 1) throw new CitationError('AMBIGUOUS', possible);
  const selected = possible[0]!;
  const originalQuote = source.text.slice(selected.start, selected.end);
  const resolution: CitationResolution = { contract: REFERENCE_CONTRACT, method: selected.method, originalQuote, sourceSha256: source.sha256 };
  if (selected.method === 'layout-whitespace') {
    const n = normalizeLayout(originalQuote);
    resolution.normalization = { policy: LAYOUT_POLICY, text: n.text, sourceOffsets: n.offsets.map(([a, b]) => [a + selected.start, b + selected.start]), quoteOffsets: normalizedQuote.offsets };
  }
  if (c.resolution && JSON.stringify(c.resolution) !== JSON.stringify(resolution)) throw new CitationError('RESOLUTION_MISMATCH', possible);
  return { ...c, start: selected.start, end: selected.end, resolution };
}
