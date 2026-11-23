'use strict';
// Loaded only by the Electron main process; handles user-confirmed learning workbench writes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ScopeLease } = require('./scope-lease.cjs');
const cap = require('./host-capability.cjs');
const recoveryProof = require('./recovery-proof.cjs');

function resolveRegistryDir() {
  const configured = process.env.S08B_REGISTRY_DIR;
  const dir = configured
    ? path.resolve(configured)
    : path.join(process.env.PI_APP_USER_DATA_DIR || os.tmpdir(), 'workbench-registry');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function install({ electron, owners, windows, rpc, ready, clientId }) {
  const guard = new ScopeLease();
  const dir = resolveRegistryDir();
  const guiRunId = process.env.S02_RUN_ID || crypto.randomUUID();
  let inFlight = 0;
  let preparing = null;
  let busy = false;

  const scope = (s) => JSON.stringify([s.selectedWorkspaceId || '', s.selectedSessionId || '']);

  function revoke() {
    if (!preparing || guard.snapshot().locked) return;
    try { cap.transition(dir, preparing, 'issued', 'revoked'); } catch {}
    try { guard.revoke(preparing); } catch {}
  }

  owners.state.subscribe((s) => {
    const next = scope(s);
    if (guard.snapshot().scope !== next) {
      revoke();
      try { guard.observe(next); } catch (e) { console.error('scope changed during lease', e); }
    }
  });

  const originalHandle = electron.ipcMain.handle.bind(electron.ipcMain);
  const originalOn = electron.ipcMain.on.bind(electron.ipcMain);
  const readOnly = new Set(['pi-gui:state-request', 'pi-gui:selected-transcript-request', 'pi-gui:ping']);
  const scopeAction = /select-session|select-workspace|navigate-session|start-thread|create-session|reload-session|fork-thread|sync-current-workspace/i;
  const denied = /^pi-gui:(?:terminal-|.*provider|.*mcp-server|.*model|.*thinking-level|.*scoped-model|.*skill|.*extension|.*worktree|.*scheduled|fork-thread|pick-workspace|add-workspace-path|remove-workspace|rename-workspace|open-workspace-in-|.*editor|list-workspace-files|read-workspace-file|reveal-workspace-file|get-changed-files|get-file-diff|stage-file|get-review-file|set-review-file|change-review-file|read-clipboard-image|set-enable-codemode)/i;

  electron.ipcMain.handle = (channel, handler) => originalHandle(channel, async (event, ...args) => {
    if (denied.test(channel)) throw Error('离线学习工作台不提供此操作。');
    if (guard.snapshot().locked && !readOnly.has(channel)) throw Error('学习单正在提交，请稍候再切换或发送。');
    if (scopeAction.test(channel)) { revoke(); guard.touch(); }
    if (!readOnly.has(channel)) inFlight++;
    try { return await handler(event, ...args); } finally { if (!readOnly.has(channel)) inFlight--; }
  });

  electron.ipcMain.on = (channel, handler) => originalOn(channel, (event, ...args) => {
    if (denied.test(channel)) return;
    if (guard.snapshot().locked && !['pi-gui:selected-transcript-resend'].includes(channel)) return;
    if (scopeAction.test(channel)) { revoke(); guard.touch(); }
    return handler(event, ...args);
  });

  const blockClose = (event) => { if (guard.snapshot().locked) event.preventDefault(); };
  for (const win of windows.allWindows()) win.on('close', blockClose);

  for (const key of ['runStateAction', 'runStateResultAction', 'runUnscopedStateAction', 'runImmediateStateAction']) {
    if (typeof windows[key] !== 'function') continue;
    const original = windows[key].bind(windows);
    windows[key] = (win, action, ...rest) => original(win, async () => {
      guard.assertScopeChangeAllowed();
      inFlight++;
      try { return await action(); } finally { inFlight--; }
    }, ...rest);
  }

  const current = async (event) => {
    const win = windows.windowForSender(event.sender);
    if (event.senderFrame !== event.sender.mainFrame) throw Error('主窗口以外无法提交');
    const s = await owners.state.getState();
    const ref = { workspaceId: s.selectedWorkspaceId, sessionId: s.selectedSessionId };
    if (!ref.workspaceId || !ref.sessionId) throw Error('请先打开学习会话。');
    guard.observe(scope(s));
    return { win, ref, scope: scope(s) };
  };

  const checkInput = (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['title', 'text', 'source', 'quote'].includes(k))) {
      throw Error('学习单输入无效。');
    }
    if (typeof input.title !== 'string' || typeof input.text !== 'string') throw Error('请输入标题和内容。');
    const title = input.title.trim();
    const text = input.text.trim();
    if (!title || Array.from(title).length > 160 || !text || Array.from(text).length > 1000) {
      throw Error('标题或内容为空或过长。');
    }
    return { title, text, source: input.source, quote: input.quote };
  };

  const executeConfirmed = async (event, input, action) => {
    if (busy || preparing || guard.snapshot().locked) throw Error('已有学习单操作正在处理。');
    busy = true;
    try {
      const isProfile = action.startsWith('profile_');
      let candidate;
      if (isProfile) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['value', 'id', 'version'].includes(k))) {
          throw Error('画像输入无效。');
        }
        if (action !== 'profile_delete' && (typeof input.value !== 'string' || !input.value.trim() || Array.from(input.value.trim()).length > 200 || input.value.includes('§'))) {
          throw Error('画像内容为空或过长。');
        }
        candidate = { text: input.value?.trim(), id: input.id, version: input.version };
      } else if (action === 'correction_supersede' || action === 'correction_retract') {
        if (!input || typeof input !== 'object' || Object.keys(input).some((k) => !['id', 'version', 'text'].includes(k)) || typeof input.id !== 'string' || !Number.isSafeInteger(input.version)) {
          throw Error('纠正选择无效。');
        }
        if (action === 'correction_supersede' && (typeof input.text !== 'string' || !input.text.trim() || Array.from(input.text.trim()).length > 1000)) {
          throw Error('请填写不超过 1000 字的说明。');
        }
        candidate = { id: input.id, version: input.version, text: input.text?.trim() };
      } else {
        candidate = checkInput(input);
      }

      const start = await current(event);
      if (cap.pendingForScope(dir, start.ref, undefined, action).length) {
        throw Error('当前会话有未决操作，请先核对恢复状态。');
      }
      const startEpoch = guard.snapshot().epoch;
      const worker = ready();
      const state = await rpc('workbench.study.state', [start.ref]);

      let payload, userText, caption;
      if (action === 'study_submit') {
        let citations = [];
        let sourceDisplay = '用户输入，尚未核实。';
        if (candidate.source !== undefined && candidate.source !== null) {
          const x = candidate.source;
          if (typeof x !== 'object' || Object.keys(x).some((k) => !['materialId', 'versionId'].includes(k)) || typeof candidate.quote !== 'string' || !candidate.quote.trim() || Array.from(candidate.quote.trim()).length > 512) {
            throw Error('请选择材料并填写不超过 512 字的引用原文。');
          }
          const all = await rpc('workbench.materials.list', [start.ref]);
          const source = all.items.find((m) => m.materialId === x.materialId && m.versionId === x.versionId);
          if (!source) throw Error('材料已失效，请刷新后重新选择。');
          const citation = { materialId: source.materialId, versionId: source.versionId, quote: candidate.quote.trim() };
          const located = await rpc('workbench.citation.locate', [start.ref, citation]);
          if (!located.ok) {
            throw Error(located.code === 'AMBIGUOUS' ? '引用有多处匹配，请增加上下文后重试。' : '未能在原文中定位引用，请核对后重试。');
          }
          citations = [citation];
          sourceDisplay = `${source.name}；原文：${citation.quote}；${located.method === 'layout-whitespace' ? '排版空白匹配' : '精确匹配'}。定位不代表事实已核实。`;
        } else if (candidate.quote) {
          throw Error('请先选择引用材料。');
        }
        payload = { baseVersion: state.currentVersion, draft: { title: candidate.title, claims: [{ id: 'claim_1', text: candidate.text, citations }], uncertainties: [] } };
        userText = `用户确认保存学习单（基于版本 ${state.currentVersion}）：\n标题：${candidate.title}\n内容：${candidate.text}\n来源：${sourceDisplay}`;
        caption = `基于当前版本 ${state.currentVersion} 保存新版本？`;
      } else if (action === 'correction_create') {
        const draft = state.currentDraft;
        const claim = draft?.claims?.[0];
        if (!draft || !claim) throw Error('请先保存学习单。');
        payload = { target: { kind: 'draft_claim', draftId: draft.draftId, version: draft.version, claimId: claim.id }, originalClaim: claim.text, correction: candidate.text, verificationStatus: 'pending', unresolvedItems: [candidate.text] };
        userText = `用户确认对学习单版本 ${draft.version} 登记待核纠正：\n原说法：${claim.text}\n用户说明：${candidate.text}\n状态：用户陈述，尚未核实。`;
        caption = `为当前学习单版本 ${draft.version} 登记待核纠正？`;
      } else if (action === 'correction_supersede' || action === 'correction_retract') {
        const target = state.corrections.find((x) => x.correctionId === candidate.id && x.revision === candidate.version);
        if (!target) throw Error('纠正已变化，请刷新后重新选择。');
        if (action === 'correction_supersede') {
          payload = { correctionId: target.correctionId, expectedRevision: target.revision, target: target.target, originalClaim: target.originalClaim, correction: candidate.text, verificationStatus: 'pending', unresolvedItems: [candidate.text] };
          userText = `用户确认修改待核纠正：\n原说法：${target.originalClaim}\n原说明：${target.correction}\n新说明：${candidate.text}\n状态：用户陈述，尚未核实。`;
          caption = '修改所选待核纠正？';
        } else {
          payload = { correctionId: target.correctionId, expectedRevision: target.revision };
          userText = `用户确认撤回待核纠正：\n原说法：${target.originalClaim}\n用户说明：${target.correction}`;
          caption = '撤回所选待核纠正？';
        }
      } else if (isProfile) {
        const entries = await rpc('workbench.profile.list', [start.ref]);
        if (action === 'profile_create') {
          payload = { value: candidate.text, source: '用户明确输入', sourceType: 'explicit-user' };
          userText = `用户确认新增学习偏好：\n内容：${candidate.text}\n来源：用户明确输入。`;
          caption = '新增这条学习偏好？';
        } else {
          const target = entries.find((x) => x.id === candidate.id && x.version === candidate.version);
          if (!target) throw Error('画像内容已变化，请刷新后重新选择。');
          if (action === 'profile_update') {
            payload = { id: target.id, version: target.version, value: candidate.text, source: '用户明确输入', sourceType: 'explicit-user' };
            userText = `用户确认修改学习偏好：\n原内容：${target.value}\n新内容：${candidate.text}\n来源：用户明确输入。`;
            caption = '修改这条学习偏好？';
          } else if (action === 'profile_delete') {
            payload = { id: target.id, version: target.version };
            userText = `用户确认删除学习偏好：\n原内容：${target.value}\n来源：用户明确输入。`;
            caption = '删除这条学习偏好？';
          } else {
            throw Error('unsupported profile action');
          }
        }
      } else {
        throw Error('unsupported action');
      }

      const answer = await electron.dialog.showMessageBox(start.win, {
        type: 'question',
        title: '确认学习操作',
        message: caption,
        detail: userText,
        buttons: ['取消', '确认'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) return { cancelled: true };

      const after = await current(event);
      if (after.scope !== start.scope || guard.snapshot().epoch !== startEpoch) {
        throw Error('会话已切换，本次未提交。');
      }
      const fresh = await rpc('workbench.study.state', [start.ref]);
      if (fresh.branch.leafId !== state.branch.leafId || fresh.currentVersion !== state.currentVersion) {
        throw Error('会话或版本已变化，请重新预览。');
      }

      const before = guard.snapshot();
      const entry = cap.issue(dir, {
        guiRunId,
        workerRunId: worker.runId,
        clientId,
        profile: 'synthetic-profile',
        workspaceId: start.ref.workspaceId,
        sessionId: start.ref.sessionId,
        leafId: state.branch.leafId,
        action,
        payload,
        contentHash: cap.digest(payload),
        userText,
        epoch: before.epoch,
        confirmedAt: Date.now(),
        expiresAt: Date.now() + 90000,
      });

      preparing = entry.operationId;
      const prepared = guard.begin(entry.operationId, start.scope);
      let claimed = false;

      try {
        const prepareMethod = isProfile
          ? 'workbench.profile.prepare'
          : action === 'study_submit'
            ? 'workbench.draft.prepare'
            : 'workbench.correction.prepare';
        const commitMethod = isProfile
          ? 'workbench.profile.commit'
          : action === 'study_submit'
            ? 'workbench.draft.commit'
            : 'workbench.correction.commit';

        await rpc(prepareMethod, [start.ref, entry.operationId]);

        const check = await current(event);
        if (check.scope !== start.scope || inFlight !== 0) {
          throw Error('会话正在变化，请重新操作。');
        }

        guard.claim(entry.operationId, start.scope, prepared.epoch);
        try {
          cap.transition(dir, entry.operationId, 'issued', 'claimed');
          claimed = true;
        } catch (e) {
          guard.finish(entry.operationId, 'not-published');
          throw e;
        }

        const result = await rpc(commitMethod, [start.ref, entry.operationId]);
        cap.transition(dir, entry.operationId, 'claimed', 'consumed');
        guard.finish(entry.operationId, 'receipt');
        claimed = false;
        return { cancelled: false, result };
      } catch (error) {
        if (!claimed) {
          try { cap.transition(dir, entry.operationId, 'issued', 'revoked'); } catch {}
          try { guard.revoke(entry.operationId); } catch {}
          throw error;
        }

        // Check actual commit outcome gracefully instead of killing worker or exiting GUI.
        let inspection;
        try {
          inspection = await rpc('workbench.recovery.inspect', [start.ref, entry.operationId]);
        } catch {
          inspection = null;
        }

        if (inspection && inspection.contentHash === entry.contentHash && inspection.status === 'committed') {
          try { cap.transition(dir, entry.operationId, 'claimed', 'consumed'); } catch {}
          guard.finish(entry.operationId, 'receipt');
          return { cancelled: false, result: inspection.result };
        }

        if (inspection && inspection.contentHash === entry.contentHash && inspection.status === 'no-receipt') {
          try { cap.transition(dir, entry.operationId, 'claimed', 'revoked'); } catch {}
          guard.finish(entry.operationId, 'not-published');
          throw error;
        }

        guard.finish(entry.operationId, 'not-published');
        throw Error(`提交结果未能确认（${error?.message || error}），请刷新当前会话核对学习单状态后再继续。`);
      } finally {
        preparing = null;
      }
    } finally {
      busy = false;
    }
  };

  originalHandle('learning:recovery:resolve', async (event) => {
    if (busy || preparing || guard.snapshot().locked) throw Error('正在处理其他操作，请稍候。');
    busy = true;
    try {
      const start = await current(event);
      const epoch = guard.snapshot().epoch;
      const records = cap.pendingForScope(dir, start.ref);
      const out = [];
      for (const c of records) {
        if (c.unknown || c.sessionId !== start.ref.sessionId) {
          out.push({ status: 'unknown' });
          continue;
        }
        let inspection;
        try {
          inspection = await rpc('workbench.recovery.inspect', [start.ref, c.operationId]);
        } catch {
          out.push({ status: 'unknown' });
          continue;
        }
        if (inspection.contentHash !== c.contentHash || !inspection.anchorId) {
          out.push({ status: 'unknown' });
          continue;
        }
        let status = inspection.status === 'committed' ? 'committed' : 'unknown';
        if (inspection.status === 'no-receipt') {
          status = 'not-submitted';
        }
        if (status === 'unknown') {
          out.push({ status });
          continue;
        }
        const now = await current(event);
        if (now.scope !== start.scope || guard.snapshot().epoch !== epoch) {
          throw Error('会话已变化，请重新核对。');
        }
        const op = 'recovery_' + c.operationId;
        const prepared = guard.begin(op, start.scope);
        guard.claim(op, start.scope, prepared.epoch);
        try {
          const file = cap.recordFile(dir, c.operationId, 'claimed');
          const fresh = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (cap.digest(fresh) !== cap.digest(c)) throw Error('待核记录已变化。');
          const result = {
            schema: 1,
            operationId: c.operationId,
            workerRunId: c.workerRunId,
            sessionId: c.sessionId,
            workspaceId: c.workspaceId,
            contentHash: c.contentHash,
            anchorId: inspection.anchorId,
            status,
            ...(status === 'committed' ? { receipt: inspection.result } : {}),
          };
          recoveryProof.publish(dir, result);
          cap.transition(dir, c.operationId, 'claimed', status === 'committed' ? 'consumed' : 'revoked');
          out.push({ status, ...(inspection.result?.version ? { version: inspection.result.version } : {}) });
          guard.finish(op, 'receipt');
        } catch (e) {
          guard.finish(op, 'not-published');
          throw e;
        }
      }
      return { items: out };
    } finally {
      busy = false;
    }
  });

  originalHandle('learning:study:save', (event, input) => executeConfirmed(event, input, 'study_submit'));
  originalHandle('learning:correction:create', (event, input) => executeConfirmed(event, input, 'correction_create'));
  originalHandle('learning:correction:supersede', (event, input) => executeConfirmed(event, input, 'correction_supersede'));
  originalHandle('learning:correction:retract', (event, input) => executeConfirmed(event, input, 'correction_retract'));
  originalHandle('learning:profile:create', (event, input) => executeConfirmed(event, input, 'profile_create'));
  originalHandle('learning:profile:update', (event, input) => executeConfirmed(event, input, 'profile_update'));
  originalHandle('learning:profile:delete', (event, input) => executeConfirmed(event, input, 'profile_delete'));
  return guard;
}

module.exports = { install };
