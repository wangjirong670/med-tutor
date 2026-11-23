import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const validId = (value, label = 'identifier') => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw new Error(`invalid ${label}`);
  return value;
};
const text = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > max) throw new Error(`invalid ${label}`);
  return value.trim();
};
const atomic = (file, value, { failRename = false } = {}) => {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    if (failRename) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
    fs.renameSync(tmp, file);
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
};
const messageText = (entry) => {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
  return '';
};
const publicAnchor = (anchor) => anchor ? {
  profileId: anchor.profileId, workspaceId: anchor.workspaceId, sessionId: anchor.sessionId,
  userEntryId: anchor.userEntryId, userRole: anchor.userRole, userTextSha256: anchor.userTextSha256,
  anchorLeaf: anchor.anchorLeaf, observedLeaf: anchor.observedLeaf,
  lineageSha256: sha(JSON.stringify(anchor.lineage)), action: anchor.action,
  intentId: anchor.intentId, toolCallId: anchor.toolCallId
} : null;
const lineageOf = (manager) => {
  const branch = manager.getBranch();
  if (!Array.isArray(branch) || !branch.length) throw new Error('NATIVE_ANCHOR_INVALID: native branch unavailable');
  const ids = branch.map((e) => e.id).filter((x) => typeof x === 'string');
  if (ids.length !== branch.length || new Set(ids).size !== ids.length) throw new Error('NATIVE_ANCHOR_INVALID: invalid native lineage IDs');
  for (let i = 0; i < branch.length; i += 1) {
    const expectedParent = i === 0 ? null : branch[i - 1].id;
    if ((branch[i].parentId ?? null) !== expectedParent) throw new Error(`NATIVE_ANCHOR_INVALID: broken native parent chain at ${branch[i].id}`);
    const stored = manager.getEntry?.(branch[i].id);
    if (!stored || stored.id !== branch[i].id || (stored.parentId ?? null) !== expectedParent) throw new Error(`NATIVE_ANCHOR_INVALID: native entry linkage changed at ${branch[i].id}`);
  }
  return { branch, ids };
};
const bounded = (value, maxBytes = 12000) => {
  const output = JSON.stringify(value);
  const size = Buffer.byteLength(output);
  if (size > maxBytes) throw new Error(`CONTINUITY_LIMIT:${size}:${maxBytes}; use the source entry pointer for local read`);
  return { value, bytes: size, maxBytes, truncated: false };
};

export class CorrectionDomain {
  constructor(root, { profileId = 'synthetic-profile', workspaceId = 's07b-fixture-workspace', caller = 's07b-trusted-host', materialStore, citationService, failNextRename = false, faultAfterCommitIntent = '', beforeCommitHook = null } = {}) {
    this.root = path.resolve(root);
    this.profileId = validId(profileId, 'profile');
    this.workspaceId = validId(workspaceId, 'workspace');
    this.caller = validId(caller, 'caller');
    this.materialStore = materialStore;
    this.citationService = citationService;
    this.failNextRename = failNextRename;
    this.faultAfterCommitIntent = faultAfterCommitIntent;
    this.beforeCommitHook = beforeCommitHook;
    this.serial = Promise.resolve();
    this.sessions = path.join(this.root, 'study', 'sessions');
    this.auth = path.join(this.root, 'authorizations');
    this.exports = path.join(this.root, 'study', 'exports');
    fs.mkdirSync(this.sessions, { recursive: true });
    fs.mkdirSync(this.auth, { recursive: true });
    fs.mkdirSync(this.exports, { recursive: true });
  }
  sessionFile(sessionId) { return path.join(this.sessions, `${validId(sessionId, 'session')}.json`); }
  intentFile(intentId) { return path.join(this.auth, `${validId(intentId, 'intent')}.json`); }
  load(sessionId) {
    const file = this.sessionFile(sessionId);
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value.schema !== 1 || value.sessionId !== sessionId || !Array.isArray(value.events) || !value.receipts || typeof value.receipts !== 'object') throw new Error('domain state invalid');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { schema: 1, sessionId, profileId: this.profileId, workspaceId: this.workspaceId, revision: 0, events: [], receipts: {} };
      throw error;
    }
  }
  async enqueue(fn) {
    const next = this.serial.then(fn, fn);
    this.serial = next.catch(() => {});
    return next;
  }
  issueHostIntent(manager, action, payload, intentId = `i_${crypto.randomUUID().replaceAll('-', '')}`) {
    const sessionId = validId(manager.getSessionId(), 'session');
    const { branch, ids } = lineageOf(manager);
    const userEntry = [...branch].reverse().find((entry) => entry.type === 'message' && entry.message?.role === 'user' && typeof entry.id === 'string');
    if (!userEntry) throw new Error('no persisted native user entry for host intent');
    const userText = messageText(userEntry);
    if (!userText.trim()) throw new Error('empty native user entry cannot authorize a write');
    const userHash = sha(userText);
    const leaf = manager.getLeafId();
    const grant = {
      schema: 1, intentId: validId(intentId, 'intent'), caller: this.caller, action,
      payload: structuredClone(payload), payloadSha256: sha(canonical(payload)),
      profileId: this.profileId, workspaceId: this.workspaceId, sessionId,
      userEntry: { id: userEntry.id, role: 'user', sha256: userHash },
      anchorLeaf: leaf, lineageAtIssue: ids,
      target: payload.target ?? (payload.correctionId ? { correctionId: payload.correctionId } : null),
      expectedRevision: payload.expectedRevision ?? payload.baseVersion ?? null,
      issuedAt: new Date().toISOString(), active: true, revokedAt: null,
      nativeUserText: userText
    };
    const file = this.intentFile(intentId);
    if (fs.existsSync(file)) {
      const old = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isDeepStrictEqual(old, grant)) throw new Error('intent ID already bound to different authorization');
      return old;
    }
    atomic(file, grant);
    return grant;
  }
  revokeIntent(intentId) {
    const file = this.intentFile(intentId);
    const grant = JSON.parse(fs.readFileSync(file, 'utf8'));
    grant.active = false; grant.revokedAt = new Date().toISOString();
    atomic(file, grant);
    return { intentId, active: false, revokedAt: grant.revokedAt };
  }
  assertGrant(manager, action, args, signal) {
    if (signal?.aborted) throw new Error('operation cancelled before commit');
    if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.intentId !== 'string') throw new Error('invalid intent envelope');
    const { intentId, ...payload } = args;
    const sessionId = validId(manager.getSessionId(), 'session');
    const file = this.intentFile(intentId);
    const grant = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (grant.active !== true || grant.revokedAt !== null) throw new Error('intent revoked');
    if (grant.caller !== this.caller || grant.action !== action || grant.profileId !== this.profileId || grant.workspaceId !== this.workspaceId || grant.sessionId !== sessionId) throw new Error('intent caller/action/profile/workspace/session mismatch');
    if (!isDeepStrictEqual(grant.payload, payload) || grant.payloadSha256 !== sha(canonical(payload))) throw new Error('intent payload mismatch');
    const { branch, ids } = lineageOf(manager);
    if (!ids.includes(grant.userEntry?.id) || !ids.includes(grant.anchorLeaf) || !ids.includes(grant.lineageAtIssue.at(-1))) throw new Error('intent branch anchor no longer on current native ancestor chain');
    const user = manager.getEntry(grant.userEntry.id);
    if (!user || user.type !== 'message' || user.message?.role !== 'user' || sha(messageText(user)) !== grant.userEntry.sha256 || messageText(user) !== grant.nativeUserText) throw new Error('intent native user anchor invalid');
    if (!grant.lineageAtIssue.every((id) => ids.includes(id))) throw new Error('intent ancestor lineage changed');
    return { intentId, payload, grant, sessionId, branch, ids, leaf: manager.getLeafId() };
  }
  visibleEvents(state, manager) {
    const { branch, ids } = lineageOf(manager);
    const pathSet = new Set(ids);
    const visible = [];
    for (const event of state.events) {
      const a = event.anchor;
      if (!a || !pathSet.has(a.observedLeaf)) continue; // A sibling event is outside this projection.
      const invalid = (why) => { throw new Error(`NATIVE_ANCHOR_INVALID: event ${event.eventId ?? 'unknown'} ${why}`); };
      if (!Array.isArray(a.lineage) || !a.lineage.length || new Set(a.lineage).size !== a.lineage.length) invalid('has malformed persisted lineage');
      const observedIndex = ids.indexOf(a.observedLeaf);
      if (observedIndex < 0 || a.lineage.length !== observedIndex + 1 || !a.lineage.every((id, i) => id === ids[i])) invalid('lineage no longer matches native parent chain');
      const userIndex = ids.indexOf(a.userEntryId);
      const anchorIndex = ids.indexOf(a.anchorLeaf);
      if (userIndex < 0 || anchorIndex < userIndex || anchorIndex > observedIndex) invalid('user entry or anchor leaf is outside its recorded chain');
      const user = manager.getEntry(a.userEntryId);
      if (!user || user.type !== 'message' || user.message?.role !== 'user' || a.userRole !== 'user' || sha(messageText(user)) !== a.userTextSha256) invalid('persisted user role/content hash changed');
      visible.push(event);
    }
    return visible;
  }
  project(sessionId, manager) {
    const state = this.load(sessionId);
    const { branch, ids } = lineageOf(manager);
    const visible = this.visibleEvents(state, manager);
    for (const event of visible) {
      const refs = [...(event.sourceRefs ?? []), ...(event.target?.kind === 'material' ? [event.target] : [])];
      for (const ref of refs) {
        try {
          if (!this.materialStore || this.materialStore.read(sessionId, ref.materialId, ref.versionId, 0, 1).sha256 !== ref.sha256) throw new Error('source identity or grant changed');
        } catch (error) {
          throw new Error(`SOURCE_ANCHOR_INVALID:${ref.materialId}:${error.message}`);
        }
      }
    }
    const drafts = visible.filter((event) => event.kind === 'draft').sort((a, b) => a.sequence - b.sequence);
    const decisions = visible.filter((event) => event.kind === 'decision').sort((a, b) => a.sequence - b.sequence);
    const grouped = new Map();
    for (const event of visible.filter((x) => x.kind === 'correction').sort((a, b) => a.sequence - b.sequence)) grouped.set(event.correctionId, [...(grouped.get(event.correctionId) ?? []), event]);
    const correctionAudit = [...grouped.values()].map((events) => ({ ...events.at(-1), anchor: publicAnchor(events.at(-1).anchor), revisions: events.map(({ action, revision, eventId, anchor, createdAt }) => ({ action, revision, eventId, anchor: publicAnchor(anchor), createdAt })) }));
    const current = drafts.at(-1) ?? null;
    const activeCorrections = correctionAudit.filter((x) => x.status !== 'retracted').map((x) => ({ correctionId: x.correctionId, revision: x.revision, action: x.action, status: x.status, verificationStatus: x.verificationStatus, originalClaim: x.originalClaim, correction: x.correction, target: x.target, unresolvedItems: x.unresolvedItems, anchor: x.anchor }));
    const unresolved = [...(current?.content?.uncertainties ?? []), ...activeCorrections.flatMap((x) => x.unresolvedItems ?? [])];
    const decisionView = decisions.map((x) => ({ decisionId: x.eventId, draftId: x.draftId, version: x.version, claimId: x.claimId, choice: x.choice, status: x.choice === 'pending' ? 'pending' : 'decided', note: x.note, anchor: publicAnchor(x.anchor) }));
    const materials = this.materialStore ? this.materialStore.list(sessionId, 0, 50).items.map((m) => ({ materialId: m.materialId, versionId: m.versionId, name: m.name, sha256: m.sha256, bytes: m.bytes, chars: m.chars })) : [];
    return {
      schema: 1, sessionId, profileId: this.profileId, workspaceId: this.workspaceId,
      branch: { leafId: manager.getLeafId(), ancestorCount: ids.length, lineageSha256: sha(JSON.stringify(ids)) },
      domainRevision: state.revision, currentVersion: current?.version ?? 0,
      currentDraft: current ? { draftId: current.draftId, version: current.version, baseVersion: current.baseVersion, title: current.content.title, claims: current.content.claims, sourceRefs: current.sourceRefs, anchor: publicAnchor(current.anchor) } : null,
      corrections: activeCorrections,
      correctionAudit: correctionAudit.map((x) => ({ correctionId: x.correctionId, revision: x.revision, action: x.action, status: x.status, verificationStatus: x.verificationStatus, originalClaim: x.originalClaim, correction: x.correction, target: x.target, unresolvedItems: x.unresolvedItems, revisions: x.revisions, anchor: x.anchor })),
      decisions: decisionView,
      unresolved,
      materials,
      lastNativeUserEntry: [...branch].reverse().find((e) => e.type === 'message' && e.message?.role === 'user')?.id ?? null,
      sourceTrust: 'user-stated-unverified; no material or user correction is treated as verified educational fact',
      diagnostics: { truncated: false, projection: 'current-native-parent-chain-only', maxBytes: 12000 }
    };
  }
  async execute(manager, action, args, toolCallId, signal) {
    return this.enqueue(async () => {
      const grant = this.assertGrant(manager, action, args, signal);
      const state = this.load(grant.sessionId);
      const prior = state.receipts[grant.intentId];
      if (prior) {
        if (prior.action !== action || prior.payloadSha256 !== grant.grant.payloadSha256) throw new Error('intent already committed with different content');
        return { ...structuredClone(prior.result), replayed: true, historicalCommit: true };
      }
      if (state.profileId !== this.profileId || state.workspaceId !== this.workspaceId) throw new Error('domain scope mismatch');
      const result = this.apply(state, action, grant, toolCallId, manager);
      const receipt = { action, payloadSha256: grant.grant.payloadSha256, result: structuredClone(result), committedAt: new Date().toISOString() };
      state.receipts[grant.intentId] = receipt;
      state.revision += 1;
      if (this.beforeCommitHook) await this.beforeCommitHook({ action, intentId: grant.intentId, signal });
      // Reconstruct from current durable state after the asynchronous boundary.
      // The following validation, reconstruction and atomic rename are synchronous.
      const finalGrant = this.assertGrant(manager, action, args, signal);
      const finalState = this.load(finalGrant.sessionId);
      if (finalState.revision !== state.revision - 1 || finalState.receipts[finalGrant.intentId]) throw new Error('domain changed before commit');
      const finalResult = this.apply(finalState, action, finalGrant, toolCallId, manager);
      finalState.receipts[finalGrant.intentId] = { action, payloadSha256: finalGrant.grant.payloadSha256, result: structuredClone(finalResult), committedAt: new Date().toISOString() };
      finalState.revision += 1;
      if (signal?.aborted) throw new Error('operation cancelled before commit');
      const failRename = this.failNextRename;
      this.failNextRename = false;
      atomic(this.sessionFile(finalGrant.sessionId), finalState, { failRename });
      if (this.faultAfterCommitIntent === grant.intentId) {
        this.faultAfterCommitIntent = '';
        throw Object.assign(new Error('injected response loss after durable commit'), { code: 'S07B_AFTER_COMMIT_FAULT' });
      }
      return finalResult;
    });
  }
  apply(state, action, grant, toolCallId, manager) {
    const { payload, sessionId, ids, leaf, intentId } = grant;
    const anchor = { profileId: this.profileId, workspaceId: this.workspaceId, sessionId, userEntryId: grant.grant.userEntry.id, userRole: 'user', userTextSha256: grant.grant.userEntry.sha256, anchorLeaf: grant.grant.anchorLeaf, observedLeaf: leaf, lineage: [...grant.ids], action, intentId, toolCallId };
    const visible = this.visibleEvents(state, manager);
    const append = (event) => {
      const record = { ...event, sequence: state.events.length + 1, eventId: `e_${sha(`${sessionId}:${intentId}`).slice(0, 32)}`, anchor, createdAt: new Date().toISOString() };
      state.events.push(record);
      return record;
    };
    if (action.startsWith('correction_')) {
      let target;
      let correctionId, revision, status;
      if (action === 'correction_create') {
        target = this.validateTarget(sessionId, payload.target, visible);
        correctionId = `c_${sha(`${sessionId}:${intentId}`).slice(0, 32)}`;
        revision = 1; status = 'active';
      } else {
        correctionId = validId(payload.correctionId, 'correction');
        const previous = [...visible].reverse().find((e) => e.kind === 'correction' && e.correctionId === correctionId);
        if (!previous || previous.status === 'retracted') throw new Error('correction is not visible on this native branch');
        if (previous.revision !== payload.expectedRevision) throw new Error('STALE_CORRECTION_REVISION');
        if (action === 'correction_supersede') {
          target = this.validateTarget(sessionId, payload.target, visible);
          if (!isDeepStrictEqual(previous.target, target)) throw new Error('supersede target changed');
          correctionId = previous.correctionId; revision = previous.revision + 1; status = 'active';
        } else {
          if (payload.expectedRevision !== previous.revision) throw new Error('STALE_CORRECTION_REVISION');
          target = previous.target; correctionId = previous.correctionId; revision = previous.revision + 1; status = 'retracted';
        }
      }
      const originalClaim = action === 'correction_retract' ? [...visible].reverse().find((e) => e.correctionId === correctionId).originalClaim : text(payload.originalClaim, 1000, 'original claim');
      const correction = action === 'correction_retract' ? [...visible].reverse().find((e) => e.correctionId === correctionId).correction : text(payload.correction, 1000, 'correction');
      const verificationStatus = action === 'correction_retract' ? [...visible].reverse().find((e) => e.correctionId === correctionId).verificationStatus : (payload.verificationStatus ?? 'pending');
      if (!['pending', 'user-stated-unverified', 'source-reviewed'].includes(verificationStatus)) throw new Error('invalid verification status');
      const unresolvedItems = action === 'correction_retract' ? [] : this.validateUnresolved(payload.unresolvedItems ?? []);
      const record = append({ kind: 'correction', action, correctionId, revision, status, originalClaim, correction, target, verificationStatus, unresolvedItems, originalAccepted: false });
      return { ok: true, action, correctionId, revision, status, verificationStatus, originalAccepted: false, eventId: record.eventId, domainRevision: state.revision + 1, replayed: false };
    }
    if (action === 'study_submit') {
      const visibleDrafts = visible.filter((e) => e.kind === 'draft');
      const currentVersion = visibleDrafts.at(-1)?.version ?? 0;
      if (payload.baseVersion !== currentVersion) throw new Error('STALE_BASE');
      const content = this.validateDraft(payload.draft, sessionId);
      const version = currentVersion + 1;
      const draftId = `d_${sha(`${sessionId}:${intentId}`).slice(0, 32)}`;
      const sourceRefs = content.claims.flatMap((claim) => claim.citations.map((citation) => ({ materialId: citation.materialId, versionId: citation.versionId, sha256: citation.rawSha256, claimId: claim.id })));
      const record = append({ kind: 'draft', draftId, version, baseVersion: currentVersion, content, sourceRefs, changeReason: 'explicit-user-authorized revision' });
      return { ok: true, draftId, version, baseVersion: currentVersion, sourceRefs, eventId: record.eventId, domainRevision: state.revision + 1, replayed: false };
    }
    if (action === 'study_decide') {
      const draft = [...visible].reverse().find((e) => e.kind === 'draft' && e.version === payload.version);
      if (!draft || draft.draftId !== payload.draftId || !draft.content.claims.some((x) => x.id === payload.claimId)) throw new Error('unknown or unauthorized draft claim');
      if (!['accept', 'reject', 'pending'].includes(payload.choice)) throw new Error('invalid decision');
      const record = append({ kind: 'decision', draftId: draft.draftId, version: draft.version, claimId: payload.claimId, choice: payload.choice, status: payload.choice === 'pending' ? 'pending' : 'decided', note: text(payload.note ?? 'Decision by explicit user intent', 500, 'decision note') });
      return { ok: true, eventId: record.eventId, draftId: draft.draftId, version: draft.version, claimId: payload.claimId, choice: payload.choice, domainRevision: state.revision + 1, replayed: false };
    }
    throw new Error(`unsupported authorized action: ${action}`);
  }
  validateUnresolved(value) {
    if (!Array.isArray(value) || value.length > 20) throw new Error('invalid unresolved items');
    return value.map((x) => text(x, 300, 'unresolved item'));
  }
  validateTarget(sessionId, target, visible) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('explicit correction target required');
    if (target.kind === 'discussion') {
      return { kind: 'discussion', scope: text(target.scope, 160, 'discussion scope') };
    }
    if (target.kind === 'material') {
      const { materialId, versionId } = target;
      const item = this.materialStore?.list(sessionId, 0, 50).items.find((x) => x.materialId === materialId && x.versionId === versionId);
      if (!item) throw new Error('unknown or unauthorized material version');
      const full = this.materialStore.read(sessionId, materialId, versionId, 0, 2048);
      if (full.sha256 !== target.sha256) throw new Error('material version hash changed');
      const fragment = target.fragment;
      if (fragment) {
        const f = this.materialStore.read(sessionId, materialId, versionId, fragment.start, fragment.end - fragment.start);
        if (f.fragmentId !== fragment.id || f.end !== fragment.end || f.start !== fragment.start) throw new Error('material fragment anchor invalid');
      }
      return { kind: 'material', materialId, versionId, sha256: item.sha256, ...(fragment ? { fragment: structuredClone(fragment) } : {}) };
    }
    if (target.kind === 'draft_claim') {
      const draft = [...visible].reverse().find((x) => x.kind === 'draft' && x.draftId === target.draftId && x.version === target.version);
      if (!draft || !draft.content.claims.some((x) => x.id === target.claimId)) throw new Error('unknown or unauthorized draft claim target');
      return { kind: 'draft_claim', draftId: draft.draftId, version: draft.version, claimId: target.claimId };
    }
    throw new Error('unsupported correction target kind');
  }
  validateDraft(draft, sessionId) {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft) || Object.keys(draft).some((k) => !['title', 'claims', 'uncertainties'].includes(k))) throw new Error('invalid draft fields');
    const title = text(draft.title, 160, 'draft title');
    if (!Array.isArray(draft.claims) || draft.claims.length > 30) throw new Error('invalid draft claims');
    const claims = draft.claims.map((claim) => {
      if (!claim || typeof claim !== 'object' || Array.isArray(claim) || Object.keys(claim).some((k) => !['id', 'text', 'citations'].includes(k))) throw new Error('invalid claim fields');
      const id = validId(claim.id, 'claim');
      const value = text(claim.text, 1000, 'claim text');
      if (!Array.isArray(claim.citations) || claim.citations.length > 8) throw new Error('invalid citations');
      const citations = claim.citations.map((citation) => {
        if (!citation || typeof citation !== 'object' || Object.keys(citation).some((k) => !['materialId', 'versionId', 'quote', 'start', 'end', 'fragment'].includes(k))) throw new Error('invalid citation fields');
        const located = this.citationService.locate(sessionId, citation);
        if (!located.ok) throw new Error(`citation invalid: ${located.code}`);
        return { materialId: citation.materialId, versionId: citation.versionId, quote: citation.quote, originalQuote: located.originalQuote, matchMethod: located.method, codepoints: located.codepoints, utf16: located.utf16, start: citation.start, end: citation.end, rawSha256: located.rawSha256, textSha256: located.textSha256, sourceProvenance: located.provenance, semanticStatus: 'not-reviewed' };
      });
      return { id, text: value, citations };
    });
    return { title, status: 'synthetic-unreviewed', claims, uncertainties: this.validateUnresolved(draft.uncertainties ?? []) };
  }
  state(sessionId, manager) {
    const state = this.project(sessionId, manager);
    const { value, ...diagnostics } = bounded(state);
    return { ...value, diagnostics: { ...value.diagnostics, ...diagnostics } };
  }
  listCorrections(sessionId, manager) {
    const state = this.project(sessionId, manager);
    return { corrections: state.corrections, audit: state.correctionAudit, domainRevision: state.domainRevision, branchLeaf: state.branch.leafId };
  }
  export(sessionId, manager, version, format) {
    if (!['study', 'audit'].includes(format)) throw new Error('invalid export format');
    const projected = this.project(sessionId, manager);
    const { ids } = lineageOf(manager);
    const event = this.visibleEvents(this.load(sessionId), manager).filter((x) => x.kind === 'draft' && (version === undefined || x.version === version)).at(-1);
    if (!event) throw new Error('version not visible on current authorized ancestor chain');
    const payload = format === 'study'
      ? { format, draft: event, corrections: projected.corrections, decisions: projected.decisions, sourceRefs: event.sourceRefs, sourceTrust: projected.sourceTrust }
      : { format, sessionId, branchLeaf: projected.branch.leafId, draft: event, audit: projected.correctionAudit, decisions: projected.decisions };
    const content = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(content) > 24000) throw new Error('EXPORT_LIMIT');
    const digest = sha(content);
    const receipt = `export_${digest}`;
    const file = path.join(this.exports, `${validId(sessionId)}_${validId(event.draftId)}_v${event.version}_${format}_${digest.slice(0, 16)}.json`);
    if (!fs.existsSync(file)) atomic(file, payload);
    else if (sha(fs.readFileSync(file)) !== digest) throw new Error('export receipt corrupted');
    return { ok: true, receipt, path: file, sha256: digest, bytes: Buffer.byteLength(content), version: event.version, draftId: event.draftId, branchLeaf: projected.branch.leafId, format };
  }
  snapshot(sessionId, manager) {
    const state = this.load(sessionId);
    const { ids } = lineageOf(manager);
    return { revision: state.revision, events: state.events.length, visibleEvents: this.visibleEvents(state, manager).length, receipts: Object.keys(state.receipts).length, sha256: sha(fs.readFileSync(this.sessionFile(sessionId))) };
  }
}

export { isDeepStrictEqual, lineageOf, messageText, sha, atomic, canonical };
