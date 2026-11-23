import type { Citation, DraftContent, State } from '../../core/material/model.js';
export const HISTORY_PROJECTION_VERSION = 'history-projection-v1';
export function projectCitation(r: Citation) {
  return { sourceId: r.sourceId, revision: r.revision, quote: r.quote,
    ...(r.fragmentId ? { fragmentId: r.fragmentId } : { ...(r.start !== undefined ? { start: r.start } : {}), ...(r.end !== undefined ? { end: r.end } : {}) }),
    ...(r.before !== undefined ? { before: r.before } : {}), ...(r.after !== undefined ? { after: r.after } : {}) };
}
export function projectContent(d: DraftContent) {
  return { title: d.title, status: d.status,
    claims: d.claims.map(c => ({ id: c.id, section: c.section, text: c.text, origin: c.origin, citations: c.citations.map(projectCitation), ...(c.citationNote !== undefined ? { citationNote: c.citationNote } : {}) })),
    conflicts: d.conflicts.map(c => ({ text: c.text, sides: c.sides.map(projectCitation) })),
    uncertainties: [...d.uncertainties], next: [...d.next] };
}
export function projectHistory(state: State) {
  const d = state.drafts.at(-1);
  return { projectionVersion: HISTORY_PROJECTION_VERSION,
    previous: d ? { version: d.version, ...projectContent(d), sourceVersions: [...d.sourceVersions],
      sourceKinds: state.sources.filter(s => d.sourceVersions.includes(`${s.id}@${s.revision}`)).map(s => ({ sourceId: s.id, revision: s.revision, kind: s.kind })) } : undefined,
    decisions: state.decisions.map(d => ({ version: d.version, claimId: d.claimId, choice: d.choice, note: d.note })),
    errata: state.errata.map(e => ({ version: e.version, original: e.original, cause: e.cause, corrected: e.corrected, impact: e.impact })) };
}
