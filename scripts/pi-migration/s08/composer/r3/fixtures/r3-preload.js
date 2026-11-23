"use strict";
const electron = require("electron");
const PRELOAD_DEV_RELOAD_MARKER = "preload-probe-v1";
const desktopIpc = {
  extensionViewOpenFile: "pi-gui:extension-view-open-file",
  listExtensionViews: "pi-gui:list-extension-views",
  openExtensionView: "pi-gui:open-extension-view",
  sendExtensionViewMessage: "pi-gui:send-extension-view-message",
  closeExtensionView: "pi-gui:close-extension-view",
  runExtensionAction: "pi-gui:run-extension-action",
  extensionViewMessage: "pi-gui:extension-view-message",
  extensionViewCatalogChanged: "pi-gui:extension-view-catalog-changed",
  stateRequest: "pi-gui:state-request",
  stateChanged: "pi-gui:state-changed",
  getTaskWorkbenchTemplate: "pi-gui:get-task-workbench-template",
  saveTaskWorkbenchTemplate: "pi-gui:save-task-workbench-template",
  selectedTranscriptRequest: "pi-gui:selected-transcript-request",
  selectedTranscriptChanged: "pi-gui:selected-transcript-changed",
  selectedTranscriptResend: "pi-gui:selected-transcript-resend",
  extensionUiChanged: "pi-gui:extension-ui-changed",
  appCommand: "pi-gui:app-command",
  workspacePicked: "pi-gui:workspace-picked",
  clipboardImagePasted: "pi-gui:clipboard-image-pasted",
  addWorkspacePath: "pi-gui:add-workspace-path",
  pickWorkspace: "pi-gui:pick-workspace",
  selectWorkspace: "pi-gui:select-workspace",
  renameWorkspace: "pi-gui:rename-workspace",
  removeWorkspace: "pi-gui:remove-workspace",
  reorderWorkspaces: "pi-gui:reorder-workspaces",
  reorderPinnedSessions: "pi-gui:reorder-pinned-sessions",
  openWorkspaceInFinder: "pi-gui:open-workspace-in-finder",
  listEditors: "pi-gui:list-editors",
  setPreferredEditor: "pi-gui:set-preferred-editor",
  openWorkspaceInEditor: "pi-gui:open-workspace-in-editor",
  createWorktree: "pi-gui:create-worktree",
  removeWorktree: "pi-gui:remove-worktree",
  openSkillInFinder: "pi-gui:open-skill-in-finder",
  openExtensionInFinder: "pi-gui:open-extension-in-finder",
  syncCurrentWorkspace: "pi-gui:sync-current-workspace",
  selectSession: "pi-gui:select-session",
  renameSession: "pi-gui:rename-session",
  archiveSession: "pi-gui:archive-session",
  unarchiveSession: "pi-gui:unarchive-session",
  markSessionRead: "pi-gui:mark-session-read",
  setSessionPinned: "pi-gui:set-session-pinned",
  createSession: "pi-gui:create-session",
  startThread: "pi-gui:start-thread",
  forkThread: "pi-gui:fork-thread",
  sendChildThreadFollowUp: "pi-gui:send-child-thread-follow-up",
  setChildSupervisionLoop: "pi-gui:set-child-supervision-loop",
  createScheduledTask: "pi-gui:create-scheduled-task",
  updateScheduledTask: "pi-gui:update-scheduled-task",
  deleteScheduledTask: "pi-gui:delete-scheduled-task",
  beginScheduledTaskInterview: "pi-gui:begin-scheduled-task-interview",
  cancelCurrentRun: "pi-gui:cancel-current-run",
  setActiveView: "pi-gui:set-active-view",
  setSidebarCollapsed: "pi-gui:set-sidebar-collapsed",
  setThreadGrouping: "pi-gui:set-thread-grouping",
  setWorkspaceCollapsed: "pi-gui:set-workspace-collapsed",
  refreshRuntime: "pi-gui:refresh-runtime",
  setModelSettingsScopeMode: "pi-gui:set-model-settings-scope-mode",
  setDefaultModel: "pi-gui:set-default-model",
  setDefaultThinkingLevel: "pi-gui:set-default-thinking-level",
  setSessionModel: "pi-gui:set-session-model",
  setSessionThinkingLevel: "pi-gui:set-session-thinking-level",
  loginProvider: "pi-gui:login-provider",
  logoutProvider: "pi-gui:logout-provider",
  setProviderApiKey: "pi-gui:set-provider-api-key",
  listCustomProviders: "pi-gui:list-custom-providers",
  setCustomProvider: "pi-gui:set-custom-provider",
  deleteCustomProvider: "pi-gui:delete-custom-provider",
  probeCustomProviderModels: "pi-gui:probe-custom-provider-models",
  setEnableSkillCommands: "pi-gui:set-enable-skill-commands",
  setScopedModelPatterns: "pi-gui:set-scoped-model-patterns",
  setSkillEnabled: "pi-gui:set-skill-enabled",
  setExtensionEnabled: "pi-gui:set-extension-enabled",
  listMcpServers: "pi-gui:list-mcp-servers",
  addMcpServer: "pi-gui:add-mcp-server",
  removeMcpServer: "pi-gui:remove-mcp-server",
  setMcpServerEnabled: "pi-gui:set-mcp-server-enabled",
  setCodemodeAlwaysOn: "pi-gui:set-codemode-always-on",
  respondToHostUiRequest: "pi-gui:respond-to-host-ui-request",
  setNotificationPreferences: "pi-gui:set-notification-preferences",
  setIntegratedTerminalShell: "pi-gui:set-integrated-terminal-shell",
  setEnableTransparency: "pi-gui:set-enable-transparency",
  terminalEnsurePanel: "pi-gui:terminal-ensure-panel",
  terminalCreateSession: "pi-gui:terminal-create-session",
  terminalSetActiveSession: "pi-gui:terminal-set-active-session",
  terminalWrite: "pi-gui:terminal-write",
  terminalResize: "pi-gui:terminal-resize",
  terminalRestartSession: "pi-gui:terminal-restart-session",
  terminalCloseSession: "pi-gui:terminal-close-session",
  terminalSetTitle: "pi-gui:terminal-set-title",
  terminalSetFocused: "pi-gui:terminal-set-focused",
  sidePanelSetFocused: "pi-gui:side-panel-set-focused",
  terminalData: "pi-gui:terminal-data",
  terminalExit: "pi-gui:terminal-exit",
  terminalError: "pi-gui:terminal-error",
  getNotificationPermissionStatus: "pi-gui:get-notification-permission-status",
  requestNotificationPermission: "pi-gui:request-notification-permission",
  openSystemNotificationSettings: "pi-gui:open-system-notification-settings",
  notificationPermissionStatusChanged: "pi-gui:notification-permission-status-changed",
  pickComposerAttachments: "pi-gui:pick-composer-attachments",
  readClipboardImage: "pi-gui:read-clipboard-image",
  addComposerAttachments: "pi-gui:add-composer-attachments",
  removeComposerAttachment: "pi-gui:remove-composer-attachment",
  editQueuedComposerMessage: "pi-gui:edit-queued-composer-message",
  cancelQueuedComposerEdit: "pi-gui:cancel-queued-composer-edit",
  removeQueuedComposerMessage: "pi-gui:remove-queued-composer-message",
  steerQueuedComposerMessage: "pi-gui:steer-queued-composer-message",
  persistComposerDraft: "pi-gui:persist-composer-draft",
  updateComposerDraft: "pi-gui:update-composer-draft",
  flushPendingComposerDraft: "pi-gui:flush-pending-composer-draft",
  pendingComposerDraftFlushed: "pi-gui:pending-composer-draft-flushed",
  submitComposer: "pi-gui:submit-composer",
  getSessionTree: "pi-gui:get-session-tree",
  navigateSessionTree: "pi-gui:navigate-session-tree",
  toggleWindowMaximize: "pi-gui:toggle-window-maximize",
  minimizeWindow: "pi-gui:minimize-window",
  closeWindow: "pi-gui:close-window",
  listWorkspaceFiles: "pi-gui:list-workspace-files",
  readWorkspaceFile: "pi-gui:read-workspace-file",
  revealWorkspaceFile: "pi-gui:reveal-workspace-file",
  getChangedFiles: "pi-gui:get-changed-files",
  getFileDiff: "pi-gui:get-file-diff",
  stageFile: "pi-gui:stage-file",
  getTurnChanges: "pi-gui:get-turn-changes",
  getReview: "pi-gui:get-review",
  getReviewFile: "pi-gui:get-review-file",
  setReviewFileReviewed: "pi-gui:set-review-file-reviewed",
  changeReviewFileStage: "pi-gui:change-review-file-stage",
  getThemeMode: "pi-gui:get-theme-mode",
  getResolvedTheme: "pi-gui:get-resolved-theme",
  setThemeMode: "pi-gui:set-theme-mode",
  setThemePresetId: "pi-gui:set-theme-preset-id",
  themeChanged: "pi-gui:theme-changed",
  windowFocused: "pi-gui:window-focused",
  ping: "app:ping",
  openExternal: "app:open-external",
  relaunchApplication: "pi-gui:relaunch-application"
};
const MAX_QUEUED_DESKTOP_COMMANDS = 16;
function createDesktopCommandSubscription() {
  let listener = null;
  const queued = [];
  return {
    subscribe(next) {
      listener = next;
      const pending = queued.splice(0, queued.length);
      for (const command of pending) next(command);
      return () => {
        if (listener === next) listener = null;
      };
    },
    deliver(command) {
      if (listener) {
        listener(command);
        return;
      }
      queued.push(command);
      if (queued.length > MAX_QUEUED_DESKTOP_COMMANDS) queued.shift();
    }
  };
}
const drawWindowControlsArgument = "--pi-draw-window-controls";
const devReloadMarkersEnabled = process.env.PI_APP_DEV_RELOAD_MARKERS === "1";
function resolveDevReloadMarkers() {
  if (!devReloadMarkersEnabled) {
    return void 0;
  }
  return {
    preload: PRELOAD_DEV_RELOAD_MARKER
  };
}
const devReloadMarkers = resolveDevReloadMarkers();
if (devReloadMarkers) {
  electron.contextBridge.exposeInMainWorld("__piDevReloadHost", devReloadMarkers);
}
function subscribeIpc(channel, listener) {
  const handler = (_event, payload) => listener(payload);
  electron.ipcRenderer.on(channel, handler);
  return () => {
    electron.ipcRenderer.removeListener(channel, handler);
  };
}
const pendingDraftFlushHandlers = /* @__PURE__ */ new Set();
electron.ipcRenderer.on(desktopIpc.flushPendingComposerDraft, (_event, requestId) => {
  void Promise.allSettled([...pendingDraftFlushHandlers].map((handler) => handler())).then(() => electron.ipcRenderer.invoke(desktopIpc.pendingComposerDraftFlushed, requestId)).catch((error) => {
    console.error("[preload] pending draft flush acknowledgement failed", error);
  });
});
const appCommands = createDesktopCommandSubscription();
electron.ipcRenderer.on(desktopIpc.appCommand, (_event, command) => {
  appCommands.deliver(command);
});
electron.contextBridge.exposeInMainWorld("piApp", {
  platform: process.platform,
  drawsWindowControls: process.argv.includes(drawWindowControlsArgument),
  versions: process.versions,
  ping: () => electron.ipcRenderer.invoke(desktopIpc.ping),
  getState: () => electron.ipcRenderer.invoke(desktopIpc.stateRequest),
  getTaskWorkbenchTemplate: (target) => electron.ipcRenderer.invoke(
    desktopIpc.getTaskWorkbenchTemplate,
    target
  ),
  saveTaskWorkbenchTemplate: (input) => electron.ipcRenderer.invoke(desktopIpc.saveTaskWorkbenchTemplate, input),
  listExtensionViews: (target) => electron.ipcRenderer.invoke(desktopIpc.listExtensionViews, target),
  openExtensionView: (input) => electron.ipcRenderer.invoke(desktopIpc.openExtensionView, input),
  sendExtensionViewMessage: (input) => electron.ipcRenderer.invoke(desktopIpc.sendExtensionViewMessage, input),
  closeExtensionView: (connectionId) => electron.ipcRenderer.invoke(desktopIpc.closeExtensionView, connectionId),
  onExtensionViewMessage: (listener) => subscribeIpc(desktopIpc.extensionViewMessage, listener),
  onExtensionViewCatalogChanged: (listener) => subscribeIpc(desktopIpc.extensionViewCatalogChanged, listener),
  onExtensionViewOpenFile: (listener) => subscribeIpc(desktopIpc.extensionViewOpenFile, listener),
  runExtensionAction: (request) => electron.ipcRenderer.invoke(
    desktopIpc.runExtensionAction,
    request
  ),
  getTurnChanges: (input) => electron.ipcRenderer.invoke(desktopIpc.getTurnChanges, input),
  getReview: (input) => electron.ipcRenderer.invoke(desktopIpc.getReview, input),
  getReviewFile: (input) => electron.ipcRenderer.invoke(desktopIpc.getReviewFile, input),
  setReviewFileReviewed: (input) => electron.ipcRenderer.invoke(
    desktopIpc.setReviewFileReviewed,
    input
  ),
  changeReviewFileStage: (input) => electron.ipcRenderer.invoke(
    desktopIpc.changeReviewFileStage,
    input
  ),
  onStateChanged: (listener) => {
    const handle = (_event, state) => {
      listener(state);
    };
    electron.ipcRenderer.on(desktopIpc.stateChanged, handle);
    return () => {
      electron.ipcRenderer.removeListener(desktopIpc.stateChanged, handle);
    };
  },
  getSelectedTranscript: () => electron.ipcRenderer.invoke(
    desktopIpc.selectedTranscriptRequest
  ),
  onSelectedTranscriptChanged: (listener) => {
    const handle = (_event, payload) => {
      listener(payload);
    };
    electron.ipcRenderer.on(desktopIpc.selectedTranscriptChanged, handle);
    return () => {
      electron.ipcRenderer.removeListener(desktopIpc.selectedTranscriptChanged, handle);
    };
  },
  resendSelectedTranscript: () => electron.ipcRenderer.send(desktopIpc.selectedTranscriptResend),
  onExtensionUiChanged: (listener) => {
    const handle = (_event, update) => {
      listener(update);
    };
    electron.ipcRenderer.on(desktopIpc.extensionUiChanged, handle);
    return () => {
      electron.ipcRenderer.removeListener(desktopIpc.extensionUiChanged, handle);
    };
  },
  onCommand: (listener) => appCommands.subscribe(listener),
  onWorkspacePicked: (listener) => {
    const handle = (_event, workspaceId) => {
      listener(workspaceId);
    };
    electron.ipcRenderer.on(desktopIpc.workspacePicked, handle);
    return () => {
      electron.ipcRenderer.removeListener(desktopIpc.workspacePicked, handle);
    };
  },
  onClipboardImagePasted: (listener) => {
    const handle = (_event, result) => {
      listener(result);
    };
    electron.ipcRenderer.on(desktopIpc.clipboardImagePasted, handle);
    return () => {
      electron.ipcRenderer.removeListener(desktopIpc.clipboardImagePasted, handle);
    };
  },
  getPathForFile: (file) => electron.webUtils.getPathForFile(file),
  addWorkspacePath: (workspacePath) => electron.ipcRenderer.invoke(desktopIpc.addWorkspacePath, workspacePath),
  pickWorkspace: () => electron.ipcRenderer.invoke(desktopIpc.pickWorkspace),
  selectWorkspace: (workspaceId) => electron.ipcRenderer.invoke(desktopIpc.selectWorkspace, workspaceId),
  renameWorkspace: (workspaceId, displayName) => electron.ipcRenderer.invoke(
    desktopIpc.renameWorkspace,
    workspaceId,
    displayName
  ),
  removeWorkspace: (workspaceId) => electron.ipcRenderer.invoke(desktopIpc.removeWorkspace, workspaceId),
  reorderWorkspaces: (workspaceOrder) => electron.ipcRenderer.invoke(desktopIpc.reorderWorkspaces, workspaceOrder),
  reorderPinnedSessions: (pinnedSessionOrder) => electron.ipcRenderer.invoke(
    desktopIpc.reorderPinnedSessions,
    pinnedSessionOrder
  ),
  openWorkspaceInFinder: (workspaceId) => electron.ipcRenderer.invoke(desktopIpc.openWorkspaceInFinder, workspaceId),
  listEditors: () => electron.ipcRenderer.invoke(desktopIpc.listEditors),
  setPreferredEditor: (editorId) => electron.ipcRenderer.invoke(desktopIpc.setPreferredEditor, editorId),
  openWorkspaceInEditor: (workspaceId, editorId) => electron.ipcRenderer.invoke(
    desktopIpc.openWorkspaceInEditor,
    workspaceId,
    editorId
  ),
  createWorktree: (input) => electron.ipcRenderer.invoke(desktopIpc.createWorktree, input),
  removeWorktree: (input) => electron.ipcRenderer.invoke(desktopIpc.removeWorktree, input),
  openSkillInFinder: (workspaceId, filePath) => electron.ipcRenderer.invoke(desktopIpc.openSkillInFinder, workspaceId, filePath),
  openExtensionInFinder: (workspaceId, filePath) => electron.ipcRenderer.invoke(desktopIpc.openExtensionInFinder, workspaceId, filePath),
  syncCurrentWorkspace: () => electron.ipcRenderer.invoke(desktopIpc.syncCurrentWorkspace),
  selectSession: (target) => electron.ipcRenderer.invoke(desktopIpc.selectSession, target),
  renameSession: (target, title) => electron.ipcRenderer.invoke(desktopIpc.renameSession, target, title),
  archiveSession: (target) => electron.ipcRenderer.invoke(desktopIpc.archiveSession, target),
  unarchiveSession: (target) => electron.ipcRenderer.invoke(desktopIpc.unarchiveSession, target),
  markSessionRead: (target) => electron.ipcRenderer.invoke(desktopIpc.markSessionRead, target),
  setSessionPinned: (target, pinned) => electron.ipcRenderer.invoke(desktopIpc.setSessionPinned, target, pinned),
  createSession: (input) => electron.ipcRenderer.invoke(desktopIpc.createSession, input),
  startThread: (input) => electron.ipcRenderer.invoke(desktopIpc.startThread, input),
  forkThread: (input) => electron.ipcRenderer.invoke(desktopIpc.forkThread, input),
  sendChildThreadFollowUp: (input) => electron.ipcRenderer.invoke(desktopIpc.sendChildThreadFollowUp, input),
  setChildSupervisionLoop: (input) => electron.ipcRenderer.invoke(desktopIpc.setChildSupervisionLoop, input),
  createScheduledTask: (input) => electron.ipcRenderer.invoke(desktopIpc.createScheduledTask, input),
  updateScheduledTask: (id, patch) => electron.ipcRenderer.invoke(desktopIpc.updateScheduledTask, id, patch),
  deleteScheduledTask: (id) => electron.ipcRenderer.invoke(desktopIpc.deleteScheduledTask, id),
  beginScheduledTaskInterview: () => electron.ipcRenderer.invoke(desktopIpc.beginScheduledTaskInterview),
  cancelCurrentRun: () => electron.ipcRenderer.invoke(desktopIpc.cancelCurrentRun),
  setActiveView: (view) => electron.ipcRenderer.invoke(desktopIpc.setActiveView, view),
  setSidebarCollapsed: (collapsed) => electron.ipcRenderer.invoke(desktopIpc.setSidebarCollapsed, collapsed),
  setThreadGrouping: (grouping) => electron.ipcRenderer.invoke(desktopIpc.setThreadGrouping, grouping),
  setWorkspaceCollapsed: (workspaceId, collapsed) => electron.ipcRenderer.invoke(
    desktopIpc.setWorkspaceCollapsed,
    workspaceId,
    collapsed
  ),
  refreshRuntime: (workspaceId) => electron.ipcRenderer.invoke(desktopIpc.refreshRuntime, workspaceId),
  setModelSettingsScopeMode: (mode) => electron.ipcRenderer.invoke(desktopIpc.setModelSettingsScopeMode, mode),
  setDefaultModel: (workspaceId, provider, modelId) => electron.ipcRenderer.invoke(
    desktopIpc.setDefaultModel,
    workspaceId,
    provider,
    modelId
  ),
  setDefaultThinkingLevel: (workspaceId, thinkingLevel) => electron.ipcRenderer.invoke(
    desktopIpc.setDefaultThinkingLevel,
    workspaceId,
    thinkingLevel
  ),
  setSessionModel: (workspaceId, sessionId, provider, modelId) => electron.ipcRenderer.invoke(
    desktopIpc.setSessionModel,
    workspaceId,
    sessionId,
    provider,
    modelId
  ),
  setSessionThinkingLevel: (workspaceId, sessionId, thinkingLevel) => electron.ipcRenderer.invoke(
    desktopIpc.setSessionThinkingLevel,
    workspaceId,
    sessionId,
    thinkingLevel
  ),
  loginProvider: (workspaceId, providerId) => electron.ipcRenderer.invoke(
    desktopIpc.loginProvider,
    workspaceId,
    providerId
  ),
  logoutProvider: (workspaceId, providerId) => electron.ipcRenderer.invoke(
    desktopIpc.logoutProvider,
    workspaceId,
    providerId
  ),
  setProviderApiKey: (workspaceId, providerId, apiKey) => electron.ipcRenderer.invoke(
    desktopIpc.setProviderApiKey,
    workspaceId,
    providerId,
    apiKey
  ),
  listCustomProviders: () => electron.ipcRenderer.invoke(desktopIpc.listCustomProviders),
  setCustomProvider: (workspaceId, config) => electron.ipcRenderer.invoke(
    desktopIpc.setCustomProvider,
    workspaceId,
    config
  ),
  deleteCustomProvider: (workspaceId, providerId) => electron.ipcRenderer.invoke(
    desktopIpc.deleteCustomProvider,
    workspaceId,
    providerId
  ),
  probeCustomProviderModels: (input) => electron.ipcRenderer.invoke(
    desktopIpc.probeCustomProviderModels,
    input
  ),
  setEnableSkillCommands: (workspaceId, enabled) => electron.ipcRenderer.invoke(
    desktopIpc.setEnableSkillCommands,
    workspaceId,
    enabled
  ),
  setScopedModelPatterns: (workspaceId, patterns) => electron.ipcRenderer.invoke(
    desktopIpc.setScopedModelPatterns,
    workspaceId,
    patterns
  ),
  setSkillEnabled: (workspaceId, filePath, enabled) => electron.ipcRenderer.invoke(
    desktopIpc.setSkillEnabled,
    workspaceId,
    filePath,
    enabled
  ),
  setExtensionEnabled: (workspaceId, filePath, enabled) => electron.ipcRenderer.invoke(
    desktopIpc.setExtensionEnabled,
    workspaceId,
    filePath,
    enabled
  ),
  listMcpServers: (workspaceId) => electron.ipcRenderer.invoke(desktopIpc.listMcpServers, workspaceId),
  addMcpServer: (workspaceId, server) => electron.ipcRenderer.invoke(desktopIpc.addMcpServer, workspaceId, server),
  removeMcpServer: (workspaceId, name) => electron.ipcRenderer.invoke(desktopIpc.removeMcpServer, workspaceId, name),
  setMcpServerEnabled: (workspaceId, scope, name, enabled) => electron.ipcRenderer.invoke(
    desktopIpc.setMcpServerEnabled,
    workspaceId,
    scope,
    name,
    enabled
  ),
  setCodemodeAlwaysOn: (workspaceId, alwaysOn) => electron.ipcRenderer.invoke(
    desktopIpc.setCodemodeAlwaysOn,
    workspaceId,
    alwaysOn
  ),
  respondToHostUiRequest: (workspaceId, sessionId, response) => electron.ipcRenderer.invoke(
    desktopIpc.respondToHostUiRequest,
    workspaceId,
    sessionId,
    response
  ),
  setNotificationPreferences: (preferences) => electron.ipcRenderer.invoke(
    desktopIpc.setNotificationPreferences,
    preferences
  ),
  setIntegratedTerminalShell: (shellPath) => electron.ipcRenderer.invoke(
    desktopIpc.setIntegratedTerminalShell,
    shellPath
  ),
  setEnableTransparency: (enabled) => electron.ipcRenderer.invoke(desktopIpc.setEnableTransparency, enabled),
  setThemePresetId: (presetId) => electron.ipcRenderer.invoke(desktopIpc.setThemePresetId, presetId),
  ensureTerminalPanel: (workspaceId, terminalScopeId, size) => electron.ipcRenderer.invoke(
    desktopIpc.terminalEnsurePanel,
    workspaceId,
    terminalScopeId,
    size
  ),
  createTerminalSession: (workspaceId, terminalScopeId, size) => electron.ipcRenderer.invoke(
    desktopIpc.terminalCreateSession,
    workspaceId,
    terminalScopeId,
    size
  ),
  setActiveTerminalSession: (workspaceId, terminalScopeId, terminalId) => electron.ipcRenderer.invoke(
    desktopIpc.terminalSetActiveSession,
    workspaceId,
    terminalScopeId,
    terminalId
  ),
  writeTerminal: (terminalId, data) => electron.ipcRenderer.invoke(desktopIpc.terminalWrite, terminalId, data),
  resizeTerminal: (terminalId, size) => electron.ipcRenderer.invoke(desktopIpc.terminalResize, terminalId, size),
  restartTerminalSession: (terminalId, size) => electron.ipcRenderer.invoke(
    desktopIpc.terminalRestartSession,
    terminalId,
    size
  ),
  closeTerminalSession: (terminalId) => electron.ipcRenderer.invoke(
    desktopIpc.terminalCloseSession,
    terminalId
  ),
  setTerminalTitle: (terminalId, title) => electron.ipcRenderer.invoke(desktopIpc.terminalSetTitle, terminalId, title),
  setTerminalFocused: (focused) => {
    electron.ipcRenderer.send(desktopIpc.terminalSetFocused, focused);
    return Promise.resolve();
  },
  setSidePanelFocused: (focused) => {
    electron.ipcRenderer.send(desktopIpc.sidePanelSetFocused, focused);
    return Promise.resolve();
  },
  onTerminalData: (listener) => subscribeIpc(desktopIpc.terminalData, listener),
  onTerminalExit: (listener) => subscribeIpc(desktopIpc.terminalExit, listener),
  onTerminalError: (listener) => subscribeIpc(desktopIpc.terminalError, listener),
  getNotificationPermissionStatus: () => electron.ipcRenderer.invoke(
    desktopIpc.getNotificationPermissionStatus
  ),
  requestNotificationPermission: () => electron.ipcRenderer.invoke(
    desktopIpc.requestNotificationPermission
  ),
  openSystemNotificationSettings: () => electron.ipcRenderer.invoke(desktopIpc.openSystemNotificationSettings),
  onNotificationPermissionStatusChanged: (callback) => {
    const handler = (_event, status) => callback(status);
    electron.ipcRenderer.on(desktopIpc.notificationPermissionStatusChanged, handler);
    return () => {
      electron.ipcRenderer.removeListener(desktopIpc.notificationPermissionStatusChanged, handler);
    };
  },
  pickComposerAttachments: () => electron.ipcRenderer.invoke(desktopIpc.pickComposerAttachments),
  readClipboardImage: () => electron.ipcRenderer.sendSync(desktopIpc.readClipboardImage),
  addComposerAttachments: (attachments) => electron.ipcRenderer.invoke(desktopIpc.addComposerAttachments, attachments),
  removeComposerAttachment: (attachmentId) => electron.ipcRenderer.invoke(
    desktopIpc.removeComposerAttachment,
    attachmentId
  ),
  editQueuedComposerMessage: (messageId, currentDraft) => electron.ipcRenderer.invoke(
    desktopIpc.editQueuedComposerMessage,
    messageId,
    currentDraft
  ),
  cancelQueuedComposerEdit: () => electron.ipcRenderer.invoke(desktopIpc.cancelQueuedComposerEdit),
  removeQueuedComposerMessage: (messageId) => electron.ipcRenderer.invoke(
    desktopIpc.removeQueuedComposerMessage,
    messageId
  ),
  steerQueuedComposerMessage: (messageId) => electron.ipcRenderer.invoke(
    desktopIpc.steerQueuedComposerMessage,
    messageId
  ),
  persistComposerDraft: (input) => electron.ipcRenderer.invoke(desktopIpc.persistComposerDraft, input),
  updateComposerDraft: (composerDraft, target) => electron.ipcRenderer.invoke(
    desktopIpc.updateComposerDraft,
    composerDraft,
    target
  ),
  onPendingComposerDraftFlush: (handler) => {
    pendingDraftFlushHandlers.add(handler);
    return () => {
      pendingDraftFlushHandlers.delete(handler);
    };
  },
  submitComposer: (text, options) => electron.ipcRenderer.invoke(desktopIpc.submitComposer, text, options),
  getSessionTree: (target) => electron.ipcRenderer.invoke(desktopIpc.getSessionTree, target),
  navigateSessionTree: (target, targetId, options) => electron.ipcRenderer.invoke(desktopIpc.navigateSessionTree, target, targetId, options),
  listWorkspaceFiles: (workspaceId, options) => electron.ipcRenderer.invoke(desktopIpc.listWorkspaceFiles, workspaceId, options),
  readWorkspaceFile: (workspaceId, filePath) => electron.ipcRenderer.invoke(
    desktopIpc.readWorkspaceFile,
    workspaceId,
    filePath
  ),
  revealWorkspaceFile: (workspaceId, filePath) => electron.ipcRenderer.invoke(desktopIpc.revealWorkspaceFile, workspaceId, filePath),
  getChangedFiles: (workspaceId) => electron.ipcRenderer.invoke(desktopIpc.getChangedFiles, workspaceId),
  getFileDiff: (workspaceId, filePath) => electron.ipcRenderer.invoke(desktopIpc.getFileDiff, workspaceId, filePath),
  stageFile: (workspaceId, filePath, stagingSourcePath) => electron.ipcRenderer.invoke(
    desktopIpc.stageFile,
    workspaceId,
    filePath,
    stagingSourcePath
  ),
  toggleWindowMaximize: () => electron.ipcRenderer.invoke(desktopIpc.toggleWindowMaximize),
  minimizeWindow: () => electron.ipcRenderer.send(desktopIpc.minimizeWindow),
  closeWindow: () => electron.ipcRenderer.send(desktopIpc.closeWindow),
  openExternal: (url) => electron.ipcRenderer.invoke(desktopIpc.openExternal, url),
  getThemeMode: () => electron.ipcRenderer.invoke(desktopIpc.getThemeMode),
  getResolvedTheme: () => electron.ipcRenderer.invoke(desktopIpc.getResolvedTheme),
  setThemeMode: (mode) => electron.ipcRenderer.invoke(desktopIpc.setThemeMode, mode),
  onWindowFocused: (listener) => subscribeIpc(desktopIpc.windowFocused, listener),
  onThemeChanged: (callback) => {
    const handler = (_event, theme) => callback(theme);
    electron.ipcRenderer.on(desktopIpc.themeChanged, handler);
    return () => {
      electron.ipcRenderer.removeListener(desktopIpc.themeChanged, handler);
    };
  },
  relaunchApplication: () => electron.ipcRenderer.invoke(desktopIpc.relaunchApplication)
});

electron.contextBridge.exposeInMainWorld('learningWorkbench', Object.freeze({ recoveryState:()=>electron.ipcRenderer.invoke('learning:recovery:state'),recoveryResolve:()=>electron.ipcRenderer.invoke('learning:recovery:resolve'),list:()=>electron.ipcRenderer.invoke('learning:materials:list'), choose:()=>electron.ipcRenderer.invoke('learning:materials:choose'), read:(item)=>electron.ipcRenderer.invoke('learning:materials:read',item), study:()=>electron.ipcRenderer.invoke('learning:study:state'), exportVersion:(version)=>electron.ipcRenderer.invoke('learning:study:export',version), createCorrection:(text)=>electron.ipcRenderer.invoke('learning:correction:create',{title:'用户纠正',text}), supersedeCorrection:(id,version,text)=>electron.ipcRenderer.invoke('learning:correction:supersede',{id,version,text}),retractCorrection:(id,version)=>electron.ipcRenderer.invoke('learning:correction:retract',{id,version}),locateCitation:(selection)=>electron.ipcRenderer.invoke('learning:citation:locate',selection),historySearch:(query)=>electron.ipcRenderer.invoke('learning:history:search',query),historyRead:(anchor)=>electron.ipcRenderer.invoke('learning:history:read',anchor),profileList:()=>electron.ipcRenderer.invoke('learning:profile:list'),profileCreate:(value)=>electron.ipcRenderer.invoke('learning:profile:create',{value}),profileUpdate:(id,version,value)=>electron.ipcRenderer.invoke('learning:profile:update',{id,version,value}),profileDelete:(id,version)=>electron.ipcRenderer.invoke('learning:profile:delete',{id,version}), saveDraft:(draft)=>electron.ipcRenderer.invoke('learning:study:save',draft) }));

// This listener is installed in the isolated preload, not exposed to page scripts.
// Only an actual OS drop event on the material target can supply a filesystem path.
window.addEventListener('DOMContentLoaded',()=>{
 document.addEventListener('dragover',event=>{if(event.isTrusted&&event.target.closest?.('[data-learning-drop]'))event.preventDefault()});
 document.addEventListener('drop',async event=>{
  if(!event.isTrusted||!event.target.closest?.('[data-learning-drop]'))return;
  event.preventDefault();const files=Array.from(event.dataTransfer?.files??[]);
  if(files.length!==1){window.dispatchEvent(new CustomEvent('learning-drop-result',{detail:{ok:false,message:'请每次拖入一个文本文件。'}}));return;}
  try {const file=electron.webUtils.getPathForFile(files[0]);if(!file)throw Error('无法读取所选文件。');await electron.ipcRenderer.invoke('learning:materials:drop',file);window.dispatchEvent(new CustomEvent('learning-drop-result',{detail:{ok:true}}));}
  catch(error){window.dispatchEvent(new CustomEvent('learning-drop-result',{detail:{ok:false,message:String(error.message??error)}}));}
 },true);
});
