import { randomUUID } from 'node:crypto';
import { validateDraft, changedClaims, latestSources, type Draft, type DraftContent, type State } from '../../core/material/model.js';
import type { MaterialProvider, MaterialResult } from './provider.js';
import { materialPrompt, completionReason, MaterialTransportError } from './provider.js';
import { HISTORY_PROJECTION_VERSION } from './projection.js';
import { MATERIAL_ADAPTER_VERSION } from './provider.js';
import { candidateRecord, inspectResponse } from './candidate.js';
import { DraftValidationError } from '../../core/material/model.js';
import { loadRules } from './rules.js';
import { reserveRequest, type Session } from './store.js';

export const now = () => new Date().toISOString();
export function newDraft(content: DraftContent, state: State, requestId: string): Draft {
  const conflictKey = (c: DraftContent['conflicts'][number]) => JSON.stringify(c.sides.map(r => `${r.sourceId}@${r.revision}:${r.start}:${r.end}:${r.resolution?.originalQuote ?? r.quote}`).sort());
  const conflicts = [...content.conflicts];
  const keys = new Set(conflicts.map(conflictKey));
  for (const previous of state.drafts.flatMap(d => d.conflicts)) {
    const key = conflictKey(previous);
    if (!keys.has(key)) { keys.add(key); conflicts.push({ ...previous, text: previous.text.startsWith('【历史冲突') ? previous.text : `【历史冲突保留；后续更正与核对决定另见记录】${previous.text}` }); }
  }
  const cited = [...content.claims.flatMap(c => c.citations), ...conflicts.flatMap(c => c.sides)].map(r => `${r.sourceId}@${r.revision}`);
  const previous = state.drafts.at(-1);
  const considered = ['manual-erratum', 'manual-reference-repair'].includes(requestId) && previous ? previous.sourceVersions : latestSources(state.sources).map(s => `${s.id}@${s.revision}`);
  const checked = validateDraft({ ...content, conflicts }, state.sources);
  return { ...checked, version: state.drafts.length + 1, requestId, sourceVersions: [...new Set([...considered, ...cited])], rulesNote: previous?.rulesNote, rulesHash: previous?.rulesHash, referenceContract: 'refs-v2' };
}
export function appendCitations(session: Session, claimId: string, additions: import('../../core/material/model.js').Citation[], reason: string): Draft {
  const state = session.read().state, previous = state.drafts.at(-1);
  if (!previous || state.pending) throw Error('须有有效稿且无在途请求');
  if (!Array.isArray(additions) || !additions.length) throw Error('提供非空引用数组');
  const content = structuredClone(previous), claim = content.claims.find(c => c.id === claimId);
  if (!claim || claim.origin !== 'material') throw Error('仅可给既有材料主张补引用；不升级AI补充');
  claim.citations.push(...additions);
  const checked = validateDraft(content, state.sources);
  const target = checked.claims.find(c => c.id === claimId)!;
  const key = (r: import('../../core/material/model.js').Citation) => `${r.sourceId}@${r.revision}:${r.start}:${r.end}`;
  const seen = new Set<string>(); target.citations = target.citations.filter(r => { const k = key(r); if (seen.has(k)) return false; seen.add(k); return true; });
  if (target.citations.length === previous.claims.find(c => c.id === claimId)!.citations.length) throw Error('没有新增引用，未创建新稿');
  const draft = newDraft(checked, state, 'manual-reference-repair');
  const erratum = changedClaims(previous, checked, reason, draft.version).find(e => e.original.startsWith(claimId + ' '));
  if (!erratum) throw Error('引用修订未产生变更记录');
  session.append({ type: 'erratum', at: now(), draft, erratum }); return draft;
}
export async function generate(session: Session, provider: MaterialProvider, reason: string, options: { reserve?: () => number; rules?: ReturnType<typeof loadRules>; signal?: AbortSignal } = {}): Promise<Draft> {
  const state = session.read().state;
  if (state.pending) throw Error('有在途请求；用 abandon 或 retry --send 明确处理');
  const rules = options.rules ?? loadRules();
  const prompt = materialPrompt(state, rules, reason);
  const requestId = randomUUID();
  const sourceManifest = latestSources(state.sources).map(s => ({ id: s.id, revision: s.revision, sha256: s.sha256 }));
  session.file(`requests/${requestId}.input.json`, JSON.stringify({ ...prompt, rules, model: provider.model, reason, adapterVersion: MATERIAL_ADAPTER_VERSION, projectionVersion: HISTORY_PROJECTION_VERSION, outputContract: 'generation-output-v1', sourceManifest }, null, 2));
  session.append({ type: 'generation_started', at: now(), requestId, reason, rulesHash: rules.hash });
  const start = Date.now();
  let result: MaterialResult | undefined;
  try {
    const budget = (options.reserve ?? (() => reserveRequest(session.root)))();
    session.file(`requests/${requestId}.reservation.json`, JSON.stringify({ budget, at: now(), model: provider.model }));
    result = await provider.generate(prompt.system, prompt.user, options.signal);
    session.file(`requests/${requestId}.response.json`, JSON.stringify(result, null, 2));
    const inspection = inspectResponse(result.raw, latestSources(state.sources), { finishReason: completionReason(result) });
    if (!inspection.ok || !inspection.content) {
      session.file(`requests/${requestId}.candidate.json`, JSON.stringify(candidateRecord(requestId, MATERIAL_ADAPTER_VERSION, inspection), null, 2));
      throw new DraftValidationError(inspection);
    }
    const content = inspection.content;
    const draft = newDraft(content, state, requestId);
    draft.rulesNote = rules.note; draft.rulesHash = rules.hash;
    session.append({ type: 'draft_saved', at: now(), draft, errata: changedClaims(state.drafts.at(-1), content, reason, draft.version) });
    session.file(`requests/${requestId}.validation.json`, JSON.stringify({ ok: true, at: now(), rules: rules.hash, model: provider.model, ms: result.ms, usage: result.usage, finishReason: completionReason(result) ?? 'unknown', stages: inspection.stages, adapterVersion: MATERIAL_ADAPTER_VERSION, projectionVersion: HISTORY_PROJECTION_VERSION, semanticStatus: 'not-reviewed', references: inspection.references }));
    return draft;
  } catch (e) {
    const error = e instanceof Error ? e.message : '未知错误';
    const firstCode = e instanceof DraftValidationError ? e.inspection.issues[0]?.code : undefined;
    const failureCode = e instanceof MaterialTransportError ? e.code : firstCode ? ['SCHEMA', 'JSON_INVALID', 'OUTPUT_TRUNCATED', 'INCOMPLETE_RESPONSE', 'EMPTY_RESPONSE'].includes(firstCode) ? firstCode : 'REFERENCE' : 'RUNTIME_ERROR';
    session.file(`requests/${requestId}.validation.json`, JSON.stringify({ ok: false, at: now(), model: provider.model, rules: rules.hash, ms: Date.now() - start, error, failureCode, finishReason: result ? completionReason(result) ?? 'unknown' : undefined, usage: result?.usage, retryPolicy: 'explicit-only', adapterVersion: MATERIAL_ADAPTER_VERSION, projectionVersion: HISTORY_PROJECTION_VERSION, ...(e instanceof DraftValidationError ? { issues: e.inspection.issues, stages: e.inspection.stages, semanticStatus: e.inspection.semanticStatus } : {}) }));
    // If the draft was already committed, a later sidecar write failure must not undo it.
    if (session.read().state.pending === requestId) session.append({ type: 'generation_failed', at: now(), requestId, error });
    throw Error(`本轮失败[${failureCode}]，最后有效稿保留：${error}`);
  }
}
