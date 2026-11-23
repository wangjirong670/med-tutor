import { z } from 'zod';
import { CitationError, resolveCitation, resolveLegacyCitation, type Citation, type CitationCandidate } from './citations.js';
export { resolveCitation } from './citations.js';
export type { Citation } from './citations.js';

const pair = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
export const citationSchema = z.object({ sourceId: z.string(), revision: z.number().int().positive(), quote: z.string().min(1), start: z.number().int().nonnegative().optional(), end: z.number().int().positive().optional(), fragmentId: z.string().min(1).optional(), before: z.string().min(1).optional(), after: z.string().min(1).optional(), resolution: z.object({ contract: z.literal('refs-v2'), method: z.enum(['exact', 'layout-whitespace']), originalQuote: z.string(), sourceSha256: z.string(), normalization: z.object({ policy: z.literal('layout-space-v1'), text: z.string(), sourceOffsets: z.array(pair), quoteOffsets: z.array(pair) }).strict().optional() }).strict().optional() }).strict();
const citation = citationSchema;
export const claimSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), section: z.enum(['concept', 'backbone', 'pitfall']), text: z.string().min(1), origin: z.enum(['material', 'ai']), citations: z.array(citation), citationNote: z.string().min(1).max(2000).optional() }).strict();
const claim = claimSchema;
export const draftSchema = z.object({
  title: z.string().min(1), status: z.string().min(1), claims: z.array(claim).min(1),
  conflicts: z.array(z.object({ text: z.string().min(1), sides: z.array(citation).min(2) }).strict()),
  uncertainties: z.array(z.string()), next: z.array(z.string()),
}).strict();
export type DraftContent = z.infer<typeof draftSchema>;
export type Source = {
  id: string; revision: number; name: string; locator: string; kind: 'note' | 'document' | 'ocr';
  text: string; sha256: string; original: string; originalSha256: string;
  method: string; coverage: string; uncertainties: string[]; preview?: string;
  lines?: { text: string; box: number[] }[]; width?: number; height?: number;
};
export type Erratum = { original: string; cause: string; corrected: string; impact: string; version: number };
export type Draft = DraftContent & { version: number; requestId: string; sourceVersions: string[]; rulesNote?: string; rulesHash?: string; referenceContract?: 'refs-v2' };
export type Decision = { version: number; claimId: string; choice: 'accept' | 'reject' | 'pending'; note: string };
export type DialogueBlock = { text: string; origin: 'material' | 'ai'; citations: Citation[] };
export type DialogueTurn = { requestId: string; text: string; action: 'chat' | 'organize'; sourceVersions: string[]; draftVersion?: number; correction: boolean; status: 'pending' | 'completed' | 'failed' | 'abandoned'; blocks?: DialogueBlock[]; error?: string; resultingVersion?: number };
export type Event = { at: string } & (
  | { type: 'renamed'; title: string }
  | { type: 'dialogue_cancelled'; requestId: string }
  | { type: 'created'; title: string; goal?: string }
  | { type: 'dialogue_started'; turn: DialogueTurn }
  | { type: 'dialogue_completed'; requestId: string; blocks: DialogueBlock[]; draft?: Draft; errata: Erratum[] }
  | { type: 'dialogue_failed'; requestId: string; error: string }
  | { type: 'dialogue_abandoned'; requestId: string }
  | { type: 'source_added' | 'text_corrected'; source: Source; reason?: string }
  | { type: 'generation_started'; requestId: string; reason: string; rulesHash: string }
  | { type: 'generation_failed'; requestId: string; error: string }
  | { type: 'generation_abandoned'; requestId: string }
  | { type: 'draft_saved'; draft: Draft; errata: Erratum[] }
  | { type: 'decision'; decision: Decision }
  | { type: 'erratum'; draft: Draft; erratum: Erratum }
);
export type State = { title: string; sources: Source[]; drafts: Draft[]; decisions: Decision[]; errata: Erratum[]; pending?: string; failures: string[]; goal?: string; dialogue?: DialogueTurn[] };
export const emptyState = (): State => ({ title: '', sources: [], drafts: [], decisions: [], errata: [], failures: [], dialogue: [] });
export function fold(state: State, event: Event): State {
  const s = structuredClone(state);
  switch (event.type) {
    case 'renamed': s.title = event.title; break;
    case 'dialogue_cancelled': {
      const turn = s.dialogue?.find(t => t.requestId === event.requestId);
      if (!turn || s.pending !== event.requestId) throw Error('对话标识不匹配');
      turn.status = 'abandoned'; turn.error = '已主动停止；已预留次数不返还。'; s.pending = undefined; break;
    }
    case 'created': if (s.title) throw Error('会话已存在'); s.title = event.title; s.goal = event.goal; break;
    case 'dialogue_started':
      if (s.pending || event.turn.status !== 'pending' || (s.dialogue ?? []).some(t => t.requestId === event.turn.requestId)) throw Error('对话在途或标识重复');
      s.pending = event.turn.requestId; (s.dialogue ??= []).push(event.turn); break;
    case 'dialogue_completed': {
      const turn = s.dialogue?.find(t => t.requestId === event.requestId);
      if (!turn || s.pending !== event.requestId) throw Error('对话标识不匹配');
      if (!event.blocks.length) throw Error('对话回复为空');
      for (const b of event.blocks) {
        if (b.origin === 'ai' && b.citations.length || b.origin === 'material' && !b.citations.length) throw Error('对话来源性质不符');
        for (const c of b.citations) resolveCitation(c, s.sources);
      }
      if (event.draft) {
        if (turn.action !== 'organize' || event.draft.version !== s.drafts.length + 1 || event.draft.requestId !== event.requestId) throw Error('未授权改稿或版本不符');
        validateDraft(event.draft, s.sources); s.drafts.push(event.draft); s.errata.push(...event.errata); turn.resultingVersion = event.draft.version;
      } else if (turn.action === 'organize') throw Error('整理未交付学习单');
      turn.status = 'completed'; turn.blocks = event.blocks; s.pending = undefined; break;
    }
    case 'dialogue_failed': case 'dialogue_abandoned': {
      const turn = s.dialogue?.find(t => t.requestId === event.requestId);
      if (!turn || s.pending !== event.requestId) throw Error('对话标识不匹配');
      turn.status = event.type === 'dialogue_failed' ? 'failed' : 'abandoned';
      if (event.type === 'dialogue_failed') { turn.error = event.error; s.failures.push(event.error); }
      s.pending = undefined; break;
    }
    case 'source_added': case 'text_corrected':
      if (s.pending) throw Error('在途请求须先 abandon 或 retry');
      if (s.sources.some(x => x.id === event.source.id && x.revision === event.source.revision)) throw Error('文字版本重复');
      s.sources.push(event.source);
      if (event.type === 'text_corrected') s.errata.push({ original: `${event.source.id} 文字 v${event.source.revision - 1}`, cause: '识别文字修正', corrected: `文字 v${event.source.revision}`, impact: event.reason ?? '', version: s.drafts.length });
      break;
    case 'generation_started': if (s.pending) throw Error('已有在途请求'); s.pending = event.requestId; break;
    case 'generation_failed': case 'generation_abandoned':
      if (s.pending !== event.requestId) throw Error('请求标识不匹配');
      s.pending = undefined;
      if (event.type === 'generation_failed') s.failures.push(event.error);
      break;
    case 'draft_saved':
      if (s.pending !== event.draft.requestId) throw Error('请求标识不匹配');
      if (event.draft.version !== s.drafts.length + 1) throw Error('稿件版本不连续');
      validateDraft(event.draft, s.sources, event.draft.referenceContract ? 'refs-v2' : 'legacy-v1'); s.pending = undefined; s.drafts.push(event.draft); s.errata.push(...event.errata); break;
    case 'decision':
      if (s.pending) throw Error('请先处理在途请求');
      if (!s.drafts.some(d => d.version === event.decision.version && (event.decision.claimId === 'all' || d.claims.some(c => c.id === event.decision.claimId)))) throw Error('决定的稿件或主张不存在');
      s.decisions.push(event.decision); break;
    case 'erratum':
      if (s.pending) throw Error('请先处理在途请求');
      if (event.draft.version !== s.drafts.length + 1) throw Error('稿件版本不连续');
      validateDraft(event.draft, s.sources, event.draft.referenceContract ? 'refs-v2' : 'legacy-v1'); s.drafts.push(event.draft); s.errata.push(event.erratum); break;
  }
  return s;
}
export function latestSources(sources: Source[]): Source[] {
  return [...new Map(sources.map(s => [s.id, s])).values()];
}
export type ReferenceIssue = { code: string; path: string; ownerId?: string; message: string; sourceId?: string; revision?: number; candidates?: CitationCandidate[] };
export type ReferenceCheck = { path: string; ownerId: string; sourceId: string; revision: number; quote: string; ok: boolean; resolved?: Citation; issue?: ReferenceIssue };
export type DraftInspection = { ok: boolean; semanticStatus: 'not-reviewed'; content?: DraftContent; issues: ReferenceIssue[]; references: ReferenceCheck[]; modelMetadata?: Record<string, unknown>; stages?: { completion: string; schema: string; references: string }; finishReason?: string };
export class DraftValidationError extends Error {
  constructor(readonly inspection: DraftInspection) { super(inspection.issues.map(i => `${i.ownerId ? `${i.ownerId} ` : ''}${i.path} ${i.code}: ${i.message}`).join('; ')); }
}
export function inspectDraft(raw: unknown, sources: Source[], contract: 'refs-v2' | 'legacy-v1' = 'refs-v2'): DraftInspection {
  const input = raw && typeof raw === 'object' && 'version' in raw ? Object.fromEntries(Object.entries(raw).filter(([k]) => !['version', 'requestId', 'sourceVersions', 'rulesNote', 'rulesHash', 'referenceContract'].includes(k))) : raw;
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, semanticStatus: 'not-reviewed', issues: parsed.error.issues.map(i => ({ code: 'SCHEMA', path: i.path.join('.'), message: i.message })), references: [] };
  const d = parsed.data, issues: ReferenceIssue[] = [], references: ReferenceCheck[] = [];
  const check = (r: Citation, path: string, ownerId: string): Citation => {
    try {
      const resolved = (contract === 'legacy-v1' ? resolveLegacyCitation : resolveCitation)(r, sources);
      references.push({ path, ownerId, sourceId: r.sourceId, revision: r.revision, quote: r.quote, ok: true, resolved }); return resolved;
    } catch (e) {
      const issue: ReferenceIssue = { code: e instanceof CitationError ? e.code : 'LEGACY_REFERENCE', path, ownerId, message: (e as Error).message, sourceId: r.sourceId, revision: r.revision, ...(e instanceof CitationError ? { candidates: e.candidates } : {}) };
      issues.push(issue); references.push({ path, ownerId, sourceId: r.sourceId, revision: r.revision, quote: r.quote, ok: false, issue }); return r;
    }
  };
  const seen = new Set<string>();
  d.claims.forEach((c, index) => {
    const path = `claims[${index}]`;
    if (seen.has(c.id)) issues.push({ code: 'DUPLICATE_CLAIM', path, ownerId: c.id, message: '主张 id 重复' });
    seen.add(c.id);
    if (c.origin === 'ai' && c.citations.length) issues.push({ code: 'AI_HAS_CITATION', path, ownerId: c.id, message: 'AI 补充不得伪装材料引用' });
    if (c.origin === 'material' && !c.citations.length) issues.push({ code: 'MATERIAL_NO_CITATION', path, ownerId: c.id, message: '材料主张缺引用' });
    c.citations = c.citations.map((r, i) => check(r, `${path}.citations[${i}]`, c.id));
  });
  d.conflicts.forEach((c, index) => { c.sides = c.sides.map((r, i) => check(r, `conflicts[${index}].sides[${i}]`, `conflict_${index + 1}`)); });
  return { ok: !issues.length, semanticStatus: 'not-reviewed', content: d, issues, references };
}
export function validateDraft(raw: unknown, sources: Source[], contract: 'refs-v2' | 'legacy-v1' = 'refs-v2'): DraftContent {
  const inspection = inspectDraft(raw, sources, contract);
  if (!inspection.ok || !inspection.content) throw new DraftValidationError(inspection);
  return inspection.content;
}
export function changedClaims(previous: Draft | undefined, next: DraftContent, reason: string, version: number): Erratum[] {
  if (!previous) return [];
  return previous.claims.flatMap(old => {
    const c = next.claims.find(c => c.id === old.id);
    if (!c) return [{ original: `${old.id} 正文：${old.text}`, corrected: '本版移除，旧稿保留', cause: reason, impact: `学习单 v${previous.version} → v${version}；${old.section}`, version }];
    const changes = claimChanges(old, c);
    return changes.length ? [{ original: `${old.id} ${changes.map(x => `${x.field}：${x.before}`).join('；')}`, corrected: `${c.id} ${changes.map(x => `${x.field}：${x.after}`).join('；')}`, cause: reason, impact: `学习单 v${previous.version} → v${version}；改变${changes.map(x => x.field).join('、')}；${old.text === c.text ? '正文未改' : old.section}`, version }] : [];
  });
}
export function claimChanges(a: DraftContent['claims'][number], b: DraftContent['claims'][number]): { field: string; before: string; after: string }[] {
  const citations = (c: typeof a) => c.citations.map(r => ({ sourceId: r.sourceId, revision: r.revision, start: r.start, end: r.end, quote: r.resolution?.originalQuote ?? r.quote }));
  const fields: [string, unknown, unknown][] = [['正文', a.text, b.text], ['来源性质', a.origin, b.origin], ['引用', citations(a), citations(b)], ['模型待审注释', a.citationNote ?? '未提供', b.citationNote ?? '未提供'], ['分区', a.section, b.section]];
  const format = (x: unknown) => typeof x === 'string' ? x : JSON.stringify(x);
  return fields.filter(([, x, y]) => JSON.stringify(x) !== JSON.stringify(y)).map(([field, x, y]) => ({ field, before: format(x), after: format(y) }));
}
