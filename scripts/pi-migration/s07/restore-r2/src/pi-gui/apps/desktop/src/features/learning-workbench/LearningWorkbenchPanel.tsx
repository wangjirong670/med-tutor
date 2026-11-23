import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { SessionRef } from "@pi-gui/session-driver";
import type {
  LearningAppConfigStatus,
  LearningHistoryAnchor,
  LearningHistoryReadResult,
  LearningHistorySearchHit,
  LearningLocateCitationResult,
  LearningMaterialItem,
  LearningMaterialProvenance,
  LearningMaterialReadResult,
  LearningModeStatus,
  LearningProfileItem,
  LearningRecoveryStateResult,
  LearningStudySaveClaimInput,
  LearningStudySaveInput,
  LearningStudyState,
  LearningWorkbenchApi,
} from "../../../contracts/ipc";

type WorkbenchTab = "study" | "materials" | "corrections" | "memory";
type StudyViewMode = "card" | "markdown";

interface BannerNotice {
  readonly kind: "success" | "error" | "info";
  readonly text: string;
}

interface ReaderState {
  readonly material: LearningMaterialItem;
  readonly page: LearningMaterialReadResult;
  readonly prevStarts: readonly number[];
}

interface DraftClaimEntry {
  readonly key: string;
  readonly text: string;
  readonly selectedMaterialKey: string;
  readonly quote: string;
  readonly locateNotice: BannerNotice | null;
}

export interface LearningLatestAssistantReply {
  readonly messageId: string;
  readonly altMessageId?: string;
  readonly text: string;
  readonly userPrompt?: string;
  readonly createdAt?: string;
  readonly hasStudySubmitInTurn?: boolean;
}

export interface LearningSessionConversationSnapshot {
  readonly status: string;
  readonly isRunning: boolean;
  readonly messageCount: number;
  readonly completedToolCount: number;
  readonly transcriptFingerprint: string;
  readonly latestAssistantReply: LearningLatestAssistantReply | null;
}

interface PendingAutoSyncDraft {
  readonly messageId: string;
  readonly altMessageId?: string;
  readonly title: string;
  readonly claims: readonly string[];
  readonly uncertainties: readonly string[];
  readonly rawText: string;
  readonly userPrompt?: string;
}

interface LearningWorkbenchPanelProps {
  readonly selectedSession: SessionRef | null;
  readonly conversation?: LearningSessionConversationSnapshot | null;
  readonly onClose?: () => void;
  readonly onInsertPrompt?: (prompt: string) => void;
}

const MAX_STUDY_TITLE_CHARS = 160;
const MAX_STUDY_CLAIMS = 30;
const MAX_STUDY_CLAIM_CHARS = 1000;
const MAX_STUDY_UNCERTAINTIES = 20;
const MAX_STUDY_UNCERTAINTY_CHARS = 300;
const AUTO_REFRESH_DEBOUNCE_MS = 260;

const resolvedAutoSyncIdsBySession = new Map<string, Set<string>>();

function getResolvedSyncSet(sessionKey: string): Set<string> {
  let set = resolvedAutoSyncIdsBySession.get(sessionKey);
  if (!set) {
    set = new Set<string>();
    resolvedAutoSyncIdsBySession.set(sessionKey, set);
  }
  return set;
}

function isReplyResolvedForSession(
  sessionKey: string,
  reply: Pick<LearningLatestAssistantReply, "messageId" | "altMessageId">,
): boolean {
  const set = resolvedAutoSyncIdsBySession.get(sessionKey);
  if (!set) return false;
  return set.has(reply.messageId) || (reply.altMessageId ? set.has(reply.altMessageId) : false);
}

function markReplyResolvedForSession(
  sessionKey: string,
  reply: Pick<LearningLatestAssistantReply, "messageId" | "altMessageId">,
): void {
  if (!sessionKey) return;
  const set = getResolvedSyncSet(sessionKey);
  set.add(reply.messageId);
  if (reply.altMessageId) {
    set.add(reply.altMessageId);
  }
}

const TABS: ReadonlyArray<{ readonly id: WorkbenchTab; readonly label: string }> = [
  { id: "study", label: "学习单" },
  { id: "materials", label: "材料与原文" },
  { id: "corrections", label: "待核纠正" },
  { id: "memory", label: "记忆与历史" },
];

const PROMPT_STARTERS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
}> = [
  {
    id: "backbone",
    label: "🧠 理主干与机制链",
    prompt:
      "请基于当前已导入的学习材料，按揉书方法提炼本节核心主干、病理生理/病机演变链条与关键判别点，并明确区分【教材所述】与【AI补充推导】。",
  },
  {
    id: "compare",
    label: "⚖️ 易混鉴别与排雷",
    prompt:
      "请针对当前材料与我们刚才讨论的内容，梳理最容易混淆的鉴别诊断/方药对比表格及高频易错点，每一处教材依据请标明原文出处。",
  },
  {
    id: "submit",
    label: "📋 沉淀保存学习单",
    prompt:
      "请将我们目前核对无误的主干、核心主张、教材原文引用以及尚未解决的待核存疑项，调用 study_submit 整理保存为新版学习单。",
  },
];

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isImeComposing(event: KeyboardEvent<HTMLElement>): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

function formatLocateMessage(result: LearningLocateCitationResult): BannerNotice {
  if (result.ok) {
    const start = result.codepoints?.start ?? 0;
    const end = result.codepoints?.end ?? 0;
    if (result.method === "layout-whitespace") {
      return { kind: "success", text: `✅ 排版空白容错匹配 [码点 ${start}..${end}]` };
    }
    if (result.method === "exact") {
      return { kind: "success", text: `✅ 精确匹配 [码点 ${start}..${end}]` };
    }
    return { kind: "success", text: `✅ 已定位（${result.method ?? "matched"}）[码点 ${start}..${end}]` };
  }
  if (result.code === "AMBIGUOUS") {
    const count = result.candidates?.length ?? "多";
    return { kind: "info", text: `⚠️ 多处匹配歧义（共 ${count} 处），请补充引用上下文` };
  }
  return { kind: "error", text: `❌ 未找到原文（${result.code ?? "NOT_FOUND"}）` };
}

function materialKey(material: Pick<LearningMaterialItem, "materialId" | "versionId">): string {
  return `${material.materialId}::${material.versionId}`;
}

function collectProvenanceBadges(provenance?: LearningMaterialProvenance): string[] {
  if (!provenance) return [];
  const badges: string[] = [];
  for (const value of [provenance.locator, provenance.method, provenance.coverage, provenance.type]) {
    const trimmed = value?.trim();
    if (trimmed && !badges.includes(trimmed)) {
      badges.push(trimmed);
    }
  }
  return badges;
}

function buildStudyMarkdown(
  studyState: LearningStudyState | null,
  materials: readonly LearningMaterialItem[],
): string {
  const draft = studyState?.currentDraft;
  if (!studyState || !draft) {
    return "";
  }
  const materialNameByKey = new Map<string, string>();
  for (const m of materials) {
    materialNameByKey.set(materialKey(m), m.name);
  }
  for (const m of studyState.materials ?? []) {
    materialNameByKey.set(materialKey(m), m.name);
  }

  const lines: string[] = [
    `# ${draft.title}`,
    "",
    `> 版本：V${draft.version}（基于 V${draft.baseVersion}）`,
    "",
    "## 核心主张",
  ];

  if (draft.claims.length === 0) {
    lines.push("", "_暂无核心主张_");
  } else {
    draft.claims.forEach((claim, index) => {
      lines.push("", `${index + 1}. ${claim.text}`);
      if (claim.citations.length > 0) {
        for (const citation of claim.citations) {
          const matName =
            materialNameByKey.get(`${citation.materialId}::${citation.versionId}`) ??
            citation.materialId;
          const matchLabel = citation.matchMethod === "layout-whitespace" ? "排版容错" : "精确";
          const span = citation.codepoints
            ? ` [${citation.codepoints.start}..${citation.codepoints.end}]`
            : "";
          lines.push(`   - 引用：「${citation.quote}」（来源：${matName} · ${matchLabel}${span}）`);
        }
      } else {
        lines.push("   - 引用：未绑定原文引用");
      }
    });
  }

  if (studyState.unresolved.length > 0) {
    lines.push("", "## 待核 / 存疑项", "");
    for (const item of studyState.unresolved) {
      lines.push(`- ${item}`);
    }
  }

  const activeCorrections = studyState.corrections.filter((c) => c.status !== "retracted");
  if (activeCorrections.length > 0) {
    lines.push("", "## 活跃纠正", "");
    for (const item of activeCorrections) {
      lines.push(
        `- [r${item.revision} · ${item.status} / ${item.verificationStatus}] 原说法：${item.originalClaim} → 纠正：${item.correction}`,
      );
    }
  }

  return lines.join("\n");
}

function createEmptyClaim(seq: number): DraftClaimEntry {
  return {
    key: `claim-${seq}`,
    text: "",
    selectedMaterialKey: "",
    quote: "",
    locateNotice: null,
  };
}

function truncateCodepoints(text: string, maxChars: number): string {
  const chars = Array.from(text.trim());
  if (chars.length <= maxChars) {
    return chars.join("");
  }
  if (maxChars <= 1) {
    return chars.slice(0, maxChars).join("");
  }
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

function splitLongSegment(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (Array.from(trimmed).length <= maxChars) {
    return [trimmed];
  }

  const pieces = trimmed
    .split(/(?<=[。！？；;\n])/)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";
  const pushHardChunks = (segment: string) => {
    const chars = Array.from(segment);
    for (let offset = 0; offset < chars.length; offset += maxChars) {
      const slice = chars.slice(offset, offset + maxChars).join("").trim();
      if (slice) chunks.push(slice);
    }
  };

  for (const piece of pieces) {
    if (Array.from(piece).length > maxChars) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = "";
      }
      pushHardChunks(piece);
      continue;
    }
    const candidate = current ? `${current} ${piece}` : piece;
    if (Array.from(candidate).length <= maxChars) {
      current = candidate;
    } else {
      if (current.trim()) {
        chunks.push(current.trim());
      }
      current = piece;
    }
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }
  return chunks;
}

function stripMarkdownDecorators(line: string): string {
  return line
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function isSubstantiveAssistantReply(text: string): boolean {
  const trimmed = text.trim();
  if (Array.from(trimmed).length < 24) {
    return false;
  }
  if (
    !trimmed.includes("\n") &&
    Array.from(trimmed).length < 48 &&
    /^(?:好的|收到|明白|了解|没问题|当然|可以|请提供|请发送|请继续|你好|您好)/.test(trimmed)
  ) {
    return false;
  }
  return true;
}

function extractStudyTitleFromReply(reply: LearningLatestAssistantReply): string {
  const normalized = reply.text.replace(/\r\n/g, "\n");
  for (const rawLine of normalized.split("\n")) {
    const headingMatch = rawLine.trim().match(/^#{1,3}\s+(.+)$/);
    if (!headingMatch) continue;
    const candidate = stripMarkdownDecorators(headingMatch[1] ?? "")
      .replace(/[：:]\s*$/, "")
      .trim();
    if (
      candidate.length >= 2 &&
      !/^〈.+〉/.test(candidate) &&
      !/^(?:一句话状态|学习钉子单|收尾)$/.test(candidate)
    ) {
      return truncateCodepoints(candidate, MAX_STUDY_TITLE_CHARS);
    }
  }

  if (reply.userPrompt) {
    const firstUserLine = reply.userPrompt
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean);
    if (firstUserLine) {
      const cleanedPrompt = stripMarkdownDecorators(firstUserLine)
        .replace(
          /^(?:你好[，,。!！\s]*|请问|请帮我|帮我|请基于当前已导入的学习材料[，,\s]*|请针对当前材料[与和]我们刚才讨论的内容[，,\s]*|请)/,
          "",
        )
        .replace(/[？?。!！]+$/, "")
        .trim();
      if (Array.from(cleanedPrompt).length >= 3) {
        return truncateCodepoints(cleanedPrompt, 64);
      }
    }
  }

  for (const rawLine of normalized.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^[-*_]{3,}$/.test(trimmed)) continue;
    const cleaned = stripMarkdownDecorators(
      trimmed.replace(/^(?:#+\s*|[-*•]\s+|\d+[.、)]\s+|[①②③④⑤⑥⑦⑧⑨⑩]\s*)/, ""),
    );
    if (!cleaned) continue;
    const firstSentence = cleaned.split(/[。！？\n]/)[0]?.trim() || cleaned;
    if (Array.from(firstSentence).length >= 3) {
      return truncateCodepoints(firstSentence, 64);
    }
  }

  return "对话同步学习单";
}

function parseAssistantReplyToStudySync(
  reply: LearningLatestAssistantReply,
): PendingAutoSyncDraft | null {
  const normalized = reply.text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return null;
  }

  const title = extractStudyTitleFromReply(reply);
  const rawLines = normalized.split("\n");
  const mainItems: string[] = [];
  const uncertaintyItems: string[] = [];

  let currentSection = "";
  let inUncertaintySection = false;
  let inSkipSection = false;
  let currentBlockLines: string[] = [];
  let currentTarget: "main" | "uncertainty" = "main";

  const flushBlock = () => {
    if (currentBlockLines.length === 0) return;
    const joined = stripMarkdownDecorators(currentBlockLines.join("\n")).trim();
    currentBlockLines = [];
    if (!joined) return;
    if (/^学习向输出：用于整理理解与复习，不构成诊疗建议/.test(joined)) return;
    if (currentTarget === "uncertainty") {
      uncertaintyItems.push(joined);
    } else {
      mainItems.push(joined);
    }
  };

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushBlock();
      continue;
    }
    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushBlock();
      continue;
    }
    if (/^学习向输出：用于整理理解与复习，不构成诊疗建议/.test(trimmed)) {
      flushBlock();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flushBlock();
      const level = headingMatch[1]?.length ?? 2;
      const headingText = stripMarkdownDecorators(headingMatch[2] ?? "");
      if (level === 1 && headingText === title) {
        currentSection = "";
        inUncertaintySection = false;
        inSkipSection = false;
        continue;
      }
      currentSection = headingText;
      inUncertaintySection = /(?:待核|存疑|还不能当真|要你拍板|待查|待确认|问老师)/.test(headingText);
      inSkipSection = /^(?:收尾|固定句)$/.test(headingText);
      continue;
    }

    if (inSkipSection) {
      continue;
    }

    if (/^\|[\s:|-]+\|$/.test(trimmed)) {
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      flushBlock();
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((c) => stripMarkdownDecorators(c))
        .filter(Boolean);
      if (cells.length > 0) {
        const prefix = currentSection ? `【${currentSection}】` : "";
        const rowText = `${prefix}${cells.join("｜")}`;
        if (inUncertaintySection) {
          uncertaintyItems.push(rowText);
        } else {
          mainItems.push(rowText);
        }
      }
      continue;
    }

    const listMatch = rawLine.match(/^(\s*)(?:(?:[-*•]|\d+[.、)])\s+|[①②③④⑤⑥⑦⑧⑨⑩]\s*)(.+)$/);
    if (listMatch) {
      const indent = listMatch[1]?.length ?? 0;
      const itemBody = (listMatch[2] ?? "").trim();
      if (!itemBody) continue;
      if (indent >= 2 && currentBlockLines.length > 0) {
        currentBlockLines.push(`  - ${itemBody}`);
      } else {
        flushBlock();
        currentTarget = inUncertaintySection ? "uncertainty" : "main";
        const prefix =
          !inUncertaintySection && currentSection && mainItems.every((m) => !m.startsWith(`【${currentSection}】`))
            ? `【${currentSection}】`
            : "";
        currentBlockLines.push(`${prefix}${itemBody}`);
      }
      continue;
    }

    if (currentBlockLines.length === 0) {
      currentTarget = inUncertaintySection ? "uncertainty" : "main";
      const prefix =
        !inUncertaintySection && currentSection && mainItems.every((m) => !m.startsWith(`【${currentSection}】`))
          ? `【${currentSection}】`
          : "";
      currentBlockLines.push(`${prefix}${trimmed}`);
    } else {
      currentBlockLines.push(trimmed);
    }
  }
  flushBlock();

  const normalizedClaims: string[] = [];
  for (const item of mainItems) {
    for (const chunk of splitLongSegment(item, MAX_STUDY_CLAIM_CHARS)) {
      normalizedClaims.push(chunk);
    }
  }

  if (normalizedClaims.length === 0) {
    const cleanedFull = stripMarkdownDecorators(normalized);
    for (const chunk of splitLongSegment(cleanedFull, 950)) {
      normalizedClaims.push(chunk);
    }
  }

  if (normalizedClaims.length === 0) {
    return null;
  }

  let finalClaims = normalizedClaims;
  if (finalClaims.length > MAX_STUDY_CLAIMS) {
    const head = finalClaims.slice(0, MAX_STUDY_CLAIMS - 1);
    const tailMerged = finalClaims.slice(MAX_STUDY_CLAIMS - 1).join("\n");
    const lastClaim = truncateCodepoints(tailMerged, MAX_STUDY_CLAIM_CHARS);
    finalClaims = [...head, lastClaim];
  }

  const finalUncertainties = uncertaintyItems
    .map((item) => truncateCodepoints(item, MAX_STUDY_UNCERTAINTY_CHARS))
    .filter(Boolean)
    .slice(0, MAX_STUDY_UNCERTAINTIES);

  return {
    messageId: reply.messageId,
    ...(reply.altMessageId ? { altMessageId: reply.altMessageId } : {}),
    title,
    claims: finalClaims,
    uncertainties: finalUncertainties,
    rawText: reply.text,
    ...(reply.userPrompt ? { userPrompt: reply.userPrompt } : {}),
  };
}

export function LearningWorkbenchPanel({
  selectedSession,
  conversation,
  onClose,
  onInsertPrompt,
}: LearningWorkbenchPanelProps) {
  const api: LearningWorkbenchApi | undefined =
    typeof window !== "undefined" ? window.learningWorkbench : undefined;
  const sessionKey = selectedSession
    ? `${selectedSession.workspaceId}:${selectedSession.sessionId}`
    : "";

  const [activeTab, setActiveTab] = useState<WorkbenchTab>("study");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<BannerNotice | null>(null);
  const [modeStatus, setModeStatus] = useState<LearningModeStatus | null>(null);

  const [studyState, setStudyState] = useState<LearningStudyState | null>(null);
  const [studyViewMode, setStudyViewMode] = useState<StudyViewMode>("card");
  const [materials, setMaterials] = useState<readonly LearningMaterialItem[]>([]);
  const [profileItems, setProfileItems] = useState<readonly LearningProfileItem[]>([]);
  const [recoveryState, setRecoveryState] = useState<LearningRecoveryStateResult | null>(null);

  // Study tab form (multi-claim + uncertainties) + zero-cost auto-sync state
  const claimSeqRef = useRef(1);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftClaims, setDraftClaims] = useState<readonly DraftClaimEntry[]>(() => [
    createEmptyClaim(1),
  ]);
  const [uncertaintiesText, setUncertaintiesText] = useState("");
  const [exportVersion, setExportVersion] = useState<number>(1);
  const [pendingSyncDraft, setPendingSyncDraft] = useState<PendingAutoSyncDraft | null>(null);
  const [syncRawExpanded, setSyncRawExpanded] = useState(false);
  const [isFormDirty, setIsFormDirty] = useState(false);

  // Materials tab state
  const [isDragOver, setIsDragOver] = useState(false);
  const [readerState, setReaderState] = useState<ReaderState | null>(null);

  // Corrections tab state
  const [correctionInput, setCorrectionInput] = useState("");
  const [editingCorrectionId, setEditingCorrectionId] = useState<string | null>(null);
  const [editingCorrectionText, setEditingCorrectionText] = useState("");

  // Memory & History tab state
  const [newProfileValue, setNewProfileValue] = useState("");
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [editingProfileValue, setEditingProfileValue] = useState("");
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyHits, setHistoryHits] = useState<readonly LearningHistorySearchHit[]>([]);
  const [historyMethod, setHistoryMethod] = useState<string | null>(null);
  const [historyDetail, setHistoryDetail] = useState<LearningHistoryReadResult | null>(null);
  const [selectedHitKey, setSelectedHitKey] = useState<string | null>(null);

  // Minimal app config & data-dir shell state
  const [configOpen, setConfigOpen] = useState(false);
  const [configStatus, setConfigStatus] = useState<LearningAppConfigStatus | null>(null);
  const [configBaseUrl, setConfigBaseUrl] = useState("");
  const [configModelsText, setConfigModelsText] = useState("");
  const [configApiKey, setConfigApiKey] = useState("");
  const [configNotice, setConfigNotice] = useState<BannerNotice | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);

  const requestSeqRef = useRef(0);
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const studyStateRef = useRef<LearningStudyState | null>(studyState);
  studyStateRef.current = studyState;
  const isFormDirtyRef = useRef(isFormDirty);
  isFormDirtyRef.current = isFormDirty;

  const hasLoadedOnceRef = useRef(false);
  const turnBaselineVersionRef = useRef<number | null>(null);
  const lastEvaluatedSyncKeyRef = useRef("");
  const lastRefreshedIdleKeyRef = useRef("");
  const syncSourceMessageIdRef = useRef<{ readonly messageId: string; readonly altMessageId?: string } | null>(null);
  const prevIsRunningRef = useRef(false);
  const prevCompletedToolCountRef = useRef(0);
  const autoRefreshTimerRef = useRef<number | null>(null);

  const buildIdleKey = useCallback(
    (key: string, conv: LearningSessionConversationSnapshot | null | undefined): string => {
      if (!key || !conv) return "";
      return [
        key,
        conv.messageCount,
        conv.completedToolCount,
        conv.latestAssistantReply?.messageId ?? "",
        conv.latestAssistantReply?.text.length ?? 0,
        conv.latestAssistantReply?.hasStudySubmitInTurn ? "1" : "0",
      ].join(":");
    },
    [],
  );

  const applySyncDraftToForm = useCallback((draft: PendingAutoSyncDraft) => {
    setDraftTitle(draft.title);
    setDraftClaims(
      draft.claims.map((claimText) => {
        claimSeqRef.current += 1;
        return {
          key: `claim-${claimSeqRef.current}`,
          text: claimText,
          selectedMaterialKey: "",
          quote: "",
          locateNotice: null,
        };
      }),
    );
    setUncertaintiesText(draft.uncertainties.join("\n"));
    syncSourceMessageIdRef.current = {
      messageId: draft.messageId,
      ...(draft.altMessageId ? { altMessageId: draft.altMessageId } : {}),
    };
    setIsFormDirty(false);
    isFormDirtyRef.current = false;
  }, []);

  const evaluateAssistantAutoSync = useCallback(
    (freshStudyState: LearningStudyState | null) => {
      const currentKey = sessionKeyRef.current;
      const conv = conversationRef.current;
      if (!currentKey || !conv || conv.isRunning) {
        return;
      }
      const reply = conv.latestAssistantReply;
      if (!reply) {
        return;
      }

      if (isReplyResolvedForSession(currentKey, reply)) {
        return;
      }

      const currentStudyVersion = freshStudyState?.currentVersion ?? 0;
      const versionIncreased =
        turnBaselineVersionRef.current !== null &&
        currentStudyVersion > turnBaselineVersionRef.current;
      const modelSubmittedStudy = Boolean(reply.hasStudySubmitInTurn) || versionIncreased;

      if (modelSubmittedStudy) {
        markReplyResolvedForSession(currentKey, reply);
        setPendingSyncDraft(null);
        setSyncRawExpanded(false);
        turnBaselineVersionRef.current = currentStudyVersion;
        lastEvaluatedSyncKeyRef.current = `${currentKey}:${reply.messageId}:${reply.text.length}:submitted:${currentStudyVersion}`;
        return;
      }

      const evalKey = `${currentKey}:${reply.messageId}:${reply.text.length}:${currentStudyVersion}`;
      if (lastEvaluatedSyncKeyRef.current === evalKey) {
        return;
      }
      lastEvaluatedSyncKeyRef.current = evalKey;

      if (!isSubstantiveAssistantReply(reply.text)) {
        return;
      }

      const parsed = parseAssistantReplyToStudySync(reply);
      if (!parsed) {
        return;
      }

      setPendingSyncDraft(parsed);
      setSyncRawExpanded(false);
      if (!isFormDirtyRef.current) {
        applySyncDraftToForm(parsed);
      }
      turnBaselineVersionRef.current = currentStudyVersion;
    },
    [applySyncDraftToForm],
  );

  useEffect(() => {
    if (!api?.getMode) {
      return;
    }
    let cancelled = false;
    void api
      .getMode()
      .then((status) => {
        if (!cancelled) {
          setModeStatus(status);
        }
      })
      .catch(() => {
        // Ignore if mode IPC is unavailable in isolated test hosts
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const loadAllForSession = useCallback(
    async (options?: { readonly silent?: boolean }): Promise<LearningStudyState | null> => {
      if (!api || !sessionKey) {
        return null;
      }
      const reqSeq = ++requestSeqRef.current;
      const expectedKey = sessionKey;
      if (!options?.silent) {
        setLoading(true);
      }
      try {
        const [matRes, studyRes, profRes, recRes, modeRes] = await Promise.all([
          api.list(),
          api.study(),
          api.profileList(),
          api.recoveryState().catch(() => null),
          api.getMode ? api.getMode().catch(() => null) : Promise.resolve(null),
        ]);
        if (requestSeqRef.current !== reqSeq || sessionKeyRef.current !== expectedKey) {
          return null;
        }
        setMaterials(matRes.items ?? []);
        setStudyState(studyRes);
        studyStateRef.current = studyRes;
        setProfileItems(profRes ?? []);
        setRecoveryState(recRes);
        if (modeRes) {
          setModeStatus(modeRes);
        }
        if (studyRes.currentVersion > 0) {
          setExportVersion((prev) =>
            prev >= 1 && prev <= studyRes.currentVersion ? prev : studyRes.currentVersion,
          );
        }
        hasLoadedOnceRef.current = true;
        if (!conversationRef.current?.isRunning) {
          lastRefreshedIdleKeyRef.current = buildIdleKey(expectedKey, conversationRef.current);
          evaluateAssistantAutoSync(studyRes);
        }
        return studyRes;
      } catch (error) {
        if (requestSeqRef.current !== reqSeq || sessionKeyRef.current !== expectedKey) {
          return null;
        }
        setBanner({ kind: "error", text: `加载学习工作台失败：${errorMessage(error)}` });
        return null;
      } finally {
        if (requestSeqRef.current === reqSeq && !options?.silent) {
          setLoading(false);
        }
      }
    },
    [api, buildIdleKey, evaluateAssistantAutoSync, sessionKey],
  );

  const refreshMaterialsOnly = useCallback(async () => {
    if (!api || !sessionKey) return;
    const expectedKey = sessionKey;
    const matRes = await api.list();
    if (sessionKeyRef.current !== expectedKey) return;
    setMaterials(matRes.items ?? []);
  }, [api, sessionKey]);

  // Reset form fields and reload data when switching sessions
  useEffect(() => {
    requestSeqRef.current += 1;
    if (autoRefreshTimerRef.current !== null) {
      window.clearTimeout(autoRefreshTimerRef.current);
      autoRefreshTimerRef.current = null;
    }

    hasLoadedOnceRef.current = false;
    turnBaselineVersionRef.current = null;
    lastEvaluatedSyncKeyRef.current = "";
    lastRefreshedIdleKeyRef.current = "";
    syncSourceMessageIdRef.current = null;
    prevIsRunningRef.current = Boolean(conversationRef.current?.isRunning);
    prevCompletedToolCountRef.current = conversationRef.current?.completedToolCount ?? 0;

    setBanner(null);
    setStudyState(null);
    studyStateRef.current = null;
    setStudyViewMode("card");
    setMaterials([]);
    setProfileItems([]);
    setRecoveryState(null);
    setPendingSyncDraft(null);
    setSyncRawExpanded(false);
    setIsFormDirty(false);
    isFormDirtyRef.current = false;

    claimSeqRef.current += 1;
    setDraftTitle("");
    setDraftClaims([createEmptyClaim(claimSeqRef.current)]);
    setUncertaintiesText("");
    setExportVersion(1);

    setReaderState(null);
    setCorrectionInput("");
    setEditingCorrectionId(null);
    setEditingCorrectionText("");

    setNewProfileValue("");
    setEditingProfileId(null);
    setEditingProfileValue("");
    setHistoryQuery("");
    setHistoryHits([]);
    setHistoryMethod(null);
    setHistoryDetail(null);
    setSelectedHitKey(null);

    if (sessionKey && api) {
      void loadAllForSession();
    }
  }, [api, loadAllForSession, sessionKey]);

  // Auto-refresh workbench & sync latest assistant reply when conversation updates
  useEffect(() => {
    if (!sessionKey || !api || !conversation) {
      return;
    }

    const prevRunning = prevIsRunningRef.current;
    const prevTools = prevCompletedToolCountRef.current;
    if (!prevRunning && conversation.isRunning) {
      turnBaselineVersionRef.current = studyStateRef.current?.currentVersion ?? 0;
    }
    const runJustFinished = prevRunning && !conversation.isRunning;
    const toolJustCompleted = conversation.completedToolCount > prevTools;
    prevIsRunningRef.current = conversation.isRunning;
    prevCompletedToolCountRef.current = conversation.completedToolCount;

    if (conversation.isRunning) {
      if (!toolJustCompleted) {
        return;
      }
      if (autoRefreshTimerRef.current !== null) {
        window.clearTimeout(autoRefreshTimerRef.current);
      }
      const expectedKey = sessionKey;
      autoRefreshTimerRef.current = window.setTimeout(() => {
        autoRefreshTimerRef.current = null;
        if (sessionKeyRef.current !== expectedKey) return;
        void loadAllForSession({ silent: true });
      }, AUTO_REFRESH_DEBOUNCE_MS);
      return;
    }

    if (!hasLoadedOnceRef.current) {
      return;
    }

    const idleKey = buildIdleKey(sessionKey, conversation);
    if (!runJustFinished && !toolJustCompleted && lastRefreshedIdleKeyRef.current === idleKey) {
      return;
    }

    if (autoRefreshTimerRef.current !== null) {
      window.clearTimeout(autoRefreshTimerRef.current);
    }
    const expectedKey = sessionKey;
    autoRefreshTimerRef.current = window.setTimeout(() => {
      autoRefreshTimerRef.current = null;
      if (sessionKeyRef.current !== expectedKey) return;
      void loadAllForSession({ silent: true });
    }, AUTO_REFRESH_DEBOUNCE_MS);
  }, [api, buildIdleKey, conversation, loadAllForSession, sessionKey]);

  useEffect(() => {
    return () => {
      if (autoRefreshTimerRef.current !== null) {
        window.clearTimeout(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
    };
  }, []);

  // Listen to preload drop notifications
  useEffect(() => {
    const handleDropResult = (event: Event) => {
      setIsDragOver(false);
      const detail = event instanceof CustomEvent ? (event.detail as { ok?: boolean; message?: string } | undefined) : undefined;
      if (detail?.ok) {
        setBanner({ kind: "success", text: "材料已拖入并导入当前会话。" });
        void refreshMaterialsOnly().catch((error) => {
          setBanner({ kind: "error", text: errorMessage(error) });
        });
      } else if (detail) {
        setBanner({ kind: "error", text: detail.message ?? "拖入材料导入失败。" });
      }
    };
    window.addEventListener("learning-drop-result", handleDropResult);
    return () => {
      window.removeEventListener("learning-drop-result", handleDropResult);
    };
  }, [refreshMaterialsOnly]);

  const runAction = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      setBanner({ kind: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const materialByKey = useMemo(() => {
    const map = new Map<string, LearningMaterialItem>();
    for (const item of materials) {
      map.set(materialKey(item), item);
    }
    return map;
  }, [materials]);

  const studyMarkdownText = useMemo(
    () => buildStudyMarkdown(studyState, materials),
    [materials, studyState],
  );

  const applyConfigStatus = useCallback((cfg: LearningAppConfigStatus) => {
    setConfigStatus(cfg);
    setConfigBaseUrl(cfg.baseUrl);
    setConfigModelsText(cfg.models.join(", "));
  }, []);

  const loadConfig = useCallback(async () => {
    if (!api?.getConfig) return;
    const cfg = await api.getConfig();
    applyConfigStatus(cfg);
  }, [api, applyConfigStatus]);

  const handleToggleConfigOpen = () => {
    const nextOpen = !configOpen;
    setConfigOpen(nextOpen);
    setConfigNotice(null);
    if (nextOpen) {
      void loadConfig().catch((error) => {
        setConfigNotice({ kind: "error", text: `读取配置失败：${errorMessage(error)}` });
      });
    }
  };

  const handleSaveConfig = () => {
    if (!api?.saveConfig) return;
    const models = configModelsText
      .split(/[,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    setBusy(true);
    setConfigNotice(null);
    void (async () => {
      try {
        const next = await api.saveConfig!({
          ...(configApiKey.trim() ? { apiKey: configApiKey.trim() } : {}),
          baseUrl: configBaseUrl.trim(),
          models,
          offlineMock: Boolean(modeStatus?.offlineMock),
        });
        applyConfigStatus(next);
        setConfigApiKey("");
        if (api.getMode) {
          const modeNext = await api.getMode().catch(() => null);
          if (modeNext) setModeStatus(modeNext);
        }
        setConfigNotice({
          kind: "success",
          text: "配置已保存并热同步 med-tutor-env Provider。",
        });
      } catch (error) {
        setConfigNotice({ kind: "error", text: errorMessage(error) });
      } finally {
        setBusy(false);
      }
    })();
  };

  const handleOpenDataDir = () => {
    if (!api?.openDataDir) return;
    setBusy(true);
    setConfigNotice(null);
    void (async () => {
      try {
        const res = await api.openDataDir!();
        if (!res.ok) {
          setConfigNotice({ kind: "error", text: res.error || "无法打开数据目录。" });
        }
      } catch (error) {
        setConfigNotice({ kind: "error", text: errorMessage(error) });
      } finally {
        setBusy(false);
      }
    })();
  };

  const handleImportLegacyData = () => {
    if (!api?.importLegacyData) return;
    setBusy(true);
    setConfigNotice(null);
    void (async () => {
      try {
        const res = await api.importLegacyData!();
        if (res.cancelled) {
          return;
        }
        setRestartNeeded(Boolean(res.requiresRestart));
        setConfigNotice({
          kind: "success",
          text: res.message ?? "旧数据已安全导入。",
        });
        await loadConfig().catch(() => undefined);
      } catch (error) {
        setConfigNotice({ kind: "error", text: errorMessage(error) });
      } finally {
        setBusy(false);
      }
    })();
  };

  const markFormDirty = () => {
    if (!isFormDirtyRef.current) {
      isFormDirtyRef.current = true;
      setIsFormDirty(true);
    }
  };

  const handleFillFormFromPendingSync = () => {
    if (!pendingSyncDraft) return;
    applySyncDraftToForm(pendingSyncDraft);
    setBanner({ kind: "info", text: "已将自动同步内容填入下方学习单表单，可补充教材引用后保存。" });
  };

  const handleDismissPendingSync = () => {
    if (!pendingSyncDraft) return;
    if (sessionKey) {
      markReplyResolvedForSession(sessionKey, pendingSyncDraft);
    }
    setPendingSyncDraft(null);
    setSyncRawExpanded(false);
  };

  const handleSavePendingSync = () => {
    if (!api || !pendingSyncDraft) return;
    const draftToSave = pendingSyncDraft;
    const normalizedClaims: LearningStudySaveClaimInput[] = draftToSave.claims.map((text) => ({
      text,
      source: null,
    }));
    const firstClaim = normalizedClaims[0];
    if (!firstClaim) return;

    const payload: LearningStudySaveInput =
      normalizedClaims.length === 1
        ? {
            title: draftToSave.title,
            text: firstClaim.text,
            source: null,
            claims: normalizedClaims,
            ...(draftToSave.uncertainties.length > 0
              ? { uncertainties: [...draftToSave.uncertainties] }
              : {}),
          }
        : {
            title: draftToSave.title,
            claims: normalizedClaims,
            ...(draftToSave.uncertainties.length > 0
              ? { uncertainties: [...draftToSave.uncertainties] }
              : {}),
          };

    void runAction(async () => {
      const res = await api.saveDraft(payload);
      if (res?.cancelled) {
        setBanner({ kind: "info", text: "已取消保存学习单。" });
        return;
      }
      if (sessionKeyRef.current) {
        markReplyResolvedForSession(sessionKeyRef.current, draftToSave);
      }
      setPendingSyncDraft(null);
      setSyncRawExpanded(false);
      setIsFormDirty(false);
      isFormDirtyRef.current = false;
      const nextVersion = res?.result?.version ?? res?.version;
      turnBaselineVersionRef.current =
        nextVersion ?? ((studyStateRef.current?.currentVersion ?? 0) + 1);
      setBanner({
        kind: "success",
        text: nextVersion
          ? `已一键固化为学习单版本 V${nextVersion}。`
          : "已一键固化为正式学习单版本。",
      });
      await loadAllForSession();
    });
  };

  const updateDraftClaim = (key: string, patch: Partial<DraftClaimEntry>) => {
    if ("text" in patch || "selectedMaterialKey" in patch || "quote" in patch) {
      markFormDirty();
    }
    setDraftClaims((prev) =>
      prev.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  };

  const handleAddClaim = () => {
    markFormDirty();
    claimSeqRef.current += 1;
    setDraftClaims((prev) => [...prev, createEmptyClaim(claimSeqRef.current)]);
  };

  const handleRemoveClaim = (key: string) => {
    markFormDirty();
    setDraftClaims((prev) => (prev.length <= 1 ? prev : prev.filter((item) => item.key !== key)));
  };

  const handleLocateClaimCitation = (claimKey: string) => {
    if (!api) return;
    const claim = draftClaims.find((c) => c.key === claimKey);
    if (!claim) return;
    const selectedMaterial = claim.selectedMaterialKey
      ? materialByKey.get(claim.selectedMaterialKey)
      : undefined;
    if (!selectedMaterial) {
      updateDraftClaim(claimKey, {
        locateNotice: { kind: "error", text: "❌ 请先选择要核对的关联材料" },
      });
      return;
    }
    const quote = claim.quote.trim();
    if (!quote) {
      updateDraftClaim(claimKey, {
        locateNotice: { kind: "error", text: "❌ 请输入要核对的引用原文片段" },
      });
      return;
    }
    void runAction(async () => {
      const result = await api.locateCitation({
        materialId: selectedMaterial.materialId,
        versionId: selectedMaterial.versionId,
        quote,
      });
      updateDraftClaim(claimKey, { locateNotice: formatLocateMessage(result) });
    });
  };

  const handleSaveDraft = () => {
    if (!api) return;
    const title = draftTitle.trim();
    if (!title) {
      setBanner({ kind: "error", text: "请填写学习单标题。" });
      return;
    }
    if (draftClaims.length === 0) {
      setBanner({ kind: "error", text: "请至少填写一条核心主张。" });
      return;
    }

    const normalizedClaims: LearningStudySaveClaimInput[] = [];
    for (let index = 0; index < draftClaims.length; index += 1) {
      const entry = draftClaims[index];
      if (!entry) continue;
      const text = entry.text.trim();
      const quote = entry.quote.trim();
      const selectedMaterial = entry.selectedMaterialKey
        ? materialByKey.get(entry.selectedMaterialKey)
        : undefined;
      if (!text) {
        setBanner({ kind: "error", text: `第 ${index + 1} 条核心主张内容不能为空。` });
        return;
      }
      if (selectedMaterial && !quote) {
        setBanner({
          kind: "error",
          text: `第 ${index + 1} 条主张已选择关联材料，请填写引用原文片段（或取消关联材料）。`,
        });
        return;
      }
      if (!selectedMaterial && quote) {
        setBanner({
          kind: "error",
          text: `第 ${index + 1} 条主张填写了引用原文，请先选择关联材料。`,
        });
        return;
      }
      normalizedClaims.push({
        text,
        source: selectedMaterial
          ? { materialId: selectedMaterial.materialId, versionId: selectedMaterial.versionId }
          : null,
        ...(quote ? { quote } : {}),
      });
    }

    const uncertainties = uncertaintiesText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const firstClaim = normalizedClaims[0];
    const payload: LearningStudySaveInput =
      normalizedClaims.length === 1 && firstClaim
        ? {
            title,
            text: firstClaim.text,
            source: firstClaim.source ?? null,
            ...(firstClaim.quote ? { quote: firstClaim.quote } : {}),
            claims: normalizedClaims,
            ...(uncertainties.length > 0 ? { uncertainties } : {}),
          }
        : {
            title,
            claims: normalizedClaims,
            ...(uncertainties.length > 0 ? { uncertainties } : {}),
          };

    void runAction(async () => {
      const res = await api.saveDraft(payload);
      if (res?.cancelled) {
        setBanner({ kind: "info", text: "已取消保存学习单。" });
        return;
      }
      const nextVersion = res?.result?.version ?? res?.version;
      setDraftClaims((prev) => prev.map((item) => ({ ...item, locateNotice: null })));
      if (syncSourceMessageIdRef.current && sessionKeyRef.current) {
        markReplyResolvedForSession(sessionKeyRef.current, syncSourceMessageIdRef.current);
      }
      if (
        pendingSyncDraft &&
        syncSourceMessageIdRef.current?.messageId === pendingSyncDraft.messageId
      ) {
        setPendingSyncDraft(null);
        setSyncRawExpanded(false);
      }
      setIsFormDirty(false);
      isFormDirtyRef.current = false;
      turnBaselineVersionRef.current =
        nextVersion ?? ((studyStateRef.current?.currentVersion ?? 0) + 1);
      setBanner({
        kind: "success",
        text: nextVersion ? `已保存学习单版本 V${nextVersion}。` : "学习单版本已保存。",
      });
      await loadAllForSession();
    });
  };

  const handleCopyMarkdown = () => {
    if (!studyMarkdownText) return;
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setBanner({ kind: "error", text: "当前环境不支持一键复制，请在文本框中手动全选复制。" });
      return;
    }
    void navigator.clipboard
      .writeText(studyMarkdownText)
      .then(() => {
        setBanner({ kind: "success", text: "已复制学习单 Markdown 到剪贴板。" });
      })
      .catch((error: unknown) => {
        setBanner({ kind: "error", text: `复制失败：${errorMessage(error)}` });
      });
  };

  const handleExportCurrentDraft = () => {
    if (!api || !studyState?.currentDraft) return;
    const versionToExport = studyState.currentDraft.version;
    void runAction(async () => {
      const res = await api.exportVersion(versionToExport);
      if (res?.cancelled) {
        setBanner({ kind: "info", text: "已取消导出。" });
        return;
      }
      setBanner({
        kind: "success",
        text: `学习单 V${res?.version ?? versionToExport} 已导出为 Markdown${res?.path ? `（${res.path}）` : ""}。`,
      });
    });
  };

  const handleExportVersion = () => {
    if (!api || !studyState || studyState.currentVersion < 1) return;
    const versionToExport = Math.max(1, Math.min(exportVersion, studyState.currentVersion));
    void runAction(async () => {
      const res = await api.exportVersion(versionToExport);
      if (res?.cancelled) {
        setBanner({ kind: "info", text: "已取消导出。" });
        return;
      }
      setBanner({
        kind: "success",
        text: `学习单 V${res?.version ?? versionToExport} 已导出为 Markdown${res?.path ? `（${res.path}）` : ""}。`,
      });
    });
  };

  const handleChooseMaterial = () => {
    if (!api) return;
    void runAction(async () => {
      const res = await api.choose();
      if (res.cancelled) {
        return;
      }
      setBanner({
        kind: "success",
        text: res.material ? `已导入材料：${res.material.name}` : "材料导入成功。",
      });
      await loadAllForSession();
    });
  };

  const handleReadMaterial = (material: LearningMaterialItem, start = 0, prevStarts: readonly number[] = []) => {
    if (!api) return;
    void runAction(async () => {
      const page = await api.read({
        materialId: material.materialId,
        versionId: material.versionId,
        start,
      });
      setReaderState({ material, page, prevStarts });
    });
  };

  const handleCreateCorrection = () => {
    if (!api) return;
    const text = correctionInput.trim();
    if (!text) {
      setBanner({ kind: "error", text: "请输入待核纠正说明。" });
      return;
    }
    if (!studyState?.currentDraft) {
      setBanner({ kind: "error", text: "请先保存至少一个学习单版本，再登记纠正。" });
      return;
    }
    void runAction(async () => {
      await api.createCorrection(text);
      setCorrectionInput("");
      setBanner({ kind: "success", text: "已登记待核纠正。" });
      await loadAllForSession();
    });
  };

  const handleSupersedeCorrection = (id: string, revision: number) => {
    if (!api) return;
    const nextText = editingCorrectionText.trim();
    if (!nextText) {
      setBanner({ kind: "error", text: "修改后的说明不能为空。" });
      return;
    }
    void runAction(async () => {
      await api.supersedeCorrection(id, revision, nextText);
      setEditingCorrectionId(null);
      setEditingCorrectionText("");
      setBanner({ kind: "success", text: "已更新纠正说明。" });
      await loadAllForSession();
    });
  };

  const handleRetractCorrection = (id: string, revision: number) => {
    if (!api) return;
    void runAction(async () => {
      await api.retractCorrection(id, revision);
      if (editingCorrectionId === id) {
        setEditingCorrectionId(null);
        setEditingCorrectionText("");
      }
      setBanner({ kind: "success", text: "已撤回该条纠正。" });
      await loadAllForSession();
    });
  };

  const handleCreateProfile = () => {
    if (!api) return;
    const value = newProfileValue.trim();
    if (!value) {
      setBanner({ kind: "error", text: "请输入个人学习偏好内容。" });
      return;
    }
    void runAction(async () => {
      await api.profileCreate(value);
      setNewProfileValue("");
      setBanner({ kind: "success", text: "已新增个人学习偏好。" });
      await loadAllForSession();
    });
  };

  const handleUpdateProfile = (id: string, version: number) => {
    if (!api) return;
    const value = editingProfileValue.trim();
    if (!value) {
      setBanner({ kind: "error", text: "偏好内容不能为空。" });
      return;
    }
    void runAction(async () => {
      await api.profileUpdate(id, version, value);
      setEditingProfileId(null);
      setEditingProfileValue("");
      setBanner({ kind: "success", text: "已更新个人学习偏好。" });
      await loadAllForSession();
    });
  };

  const handleDeleteProfile = (id: string, version: number) => {
    if (!api) return;
    void runAction(async () => {
      await api.profileDelete(id, version);
      if (editingProfileId === id) {
        setEditingProfileId(null);
        setEditingProfileValue("");
      }
      setBanner({ kind: "success", text: "已删除个人学习偏好。" });
      await loadAllForSession();
    });
  };

  const handleHistorySearch = () => {
    if (!api) return;
    const query = historyQuery.trim();
    if (!query) {
      setBanner({ kind: "error", text: "请输入检索关键词（最多 40 字）。" });
      return;
    }
    void runAction(async () => {
      const res = await api.historySearch(query);
      setHistoryHits(res.matches ?? []);
      setHistoryMethod(res.method ?? null);
      setHistoryDetail(null);
      setSelectedHitKey(null);
    });
  };

  const handleHistoryRead = (anchor: LearningHistoryAnchor, hitKey: string) => {
    if (!api) return;
    void runAction(async () => {
      const detail = await api.historyRead(anchor);
      setSelectedHitKey(hitKey);
      setHistoryDetail(detail);
    });
  };

  const handleResolveRecovery = () => {
    if (!api) return;
    void runAction(async () => {
      const res = await api.recoveryResolve();
      setBanner({
        kind: "info",
        text: `已完成 ${res.items?.length ?? 0} 条待核状态同步。`,
      });
      await loadAllForSession();
    });
  };

  const currentVersion = studyState?.currentVersion ?? 0;
  const exportVersionOptions = studyState?.versions?.length
    ? studyState.versions.map((v) => v.version)
    : Array.from({ length: currentVersion }, (_, idx) => idx + 1);

  return (
    <aside className="lwb-panel" aria-label="揉书工作台" data-testid="learning-workbench-panel">
      <header className="lwb-header">
        <div className="lwb-header__title-group">
          <span className="lwb-header__title">📚 揉书工作台</span>
          <span className="lwb-badge">
            {selectedSession ? (currentVersion > 0 ? `V${currentVersion}` : "未建稿") : "未选会话"}
          </span>
        </div>
        <div className="lwb-header__actions">
          {api?.getConfig ? (
            <button
              type="button"
              className="lwb-icon-btn"
              disabled={busy}
              onClick={handleToggleConfigOpen}
              title="模型与数据目录设置"
            >
              {configOpen ? "收起设置" : "设置"}
            </button>
          ) : null}
          <button
            type="button"
            className="lwb-icon-btn"
            disabled={!selectedSession || !api || loading || busy}
            onClick={() => void loadAllForSession()}
            title="刷新工作台数据"
          >
            刷新
          </button>
          {onClose ? (
            <button
              type="button"
              className="lwb-icon-btn"
              onClick={onClose}
              aria-label="收起揉书工作台"
              title="收起工作台"
            >
              ×
            </button>
          ) : null}
        </div>
      </header>

      {api && modeStatus ? (
        <div className="lwb-mode-bar" data-testid="learning-mode-bar">
          <div className="lwb-mode-bar__badges">
            {modeStatus.offlineMock ? (
              <span
                className="lwb-mode-badge lwb-mode-badge--mock"
                title="内部测试模式（MED_TUTOR_OFFLINE_MOCK=1）"
              >
                🧪 内部测试模式
              </span>
            ) : (
              <span
                className="lwb-mode-badge lwb-mode-badge--live"
                title={`真模直连${modeStatus.envBaseUrl ? ` · ${modeStatus.envBaseUrl}` : ""}${modeStatus.envModels?.length ? ` (${modeStatus.envModels.join(", ")})` : ""}`}
              >
                🟢 真模直连
              </span>
            )}
            {modeStatus.textbookRootExists ? (
              <span
                className="lwb-mode-badge lwb-mode-badge--library"
                title={modeStatus.textbookRoot ?? "数字版教材库"}
              >
                📚 数字版教材库已就绪（只读）
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {api && configOpen ? (
        <section className="lwb-card" style={{ margin: "8px 10px" }} data-testid="learning-config-shell">
          <div className="lwb-card__header">
            <span className="lwb-card__title">模型与数据目录设置</span>
            <button
              type="button"
              className="lwb-btn lwb-btn--ghost lwb-btn--xs"
              onClick={() => setConfigOpen(false)}
            >
              收起
            </button>
          </div>
          {configNotice ? (
            <div className={`lwb-notice lwb-notice--${configNotice.kind}`} role="status">
              <span className="lwb-notice__text">{configNotice.text}</span>
              {restartNeeded && window.piApp?.relaunchApplication ? (
                <button
                  type="button"
                  className="lwb-btn lwb-btn--primary lwb-btn--xs"
                  onClick={() => void window.piApp?.relaunchApplication()}
                >
                  立即重启
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="lwb-muted lwb-text-xs" style={{ wordBreak: "break-all" }}>
            数据目录：{configStatus?.dataDir ?? "加载中…"}
          </div>
          <div className="lwb-btn-row" style={{ margin: "6px 0" }}>
            <button
              type="button"
              className="lwb-btn lwb-btn--secondary lwb-btn--xs"
              disabled={busy || !api.openDataDir}
              onClick={handleOpenDataDir}
            >
              打开数据目录
            </button>
            <button
              type="button"
              className="lwb-btn lwb-btn--secondary lwb-btn--xs"
              disabled={busy || !api.importLegacyData}
              onClick={handleImportLegacyData}
            >
              导入旧数据
            </button>
          </div>
          <div className="lwb-form" style={{ gap: "6px" }}>
            <input
              type="text"
              className="lwb-input"
              placeholder="Base URL（如 https://api.deepseek.com/v1）"
              value={configBaseUrl}
              onChange={(e) => setConfigBaseUrl(e.target.value)}
            />
            <input
              type="text"
              className="lwb-input"
              placeholder="模型列表（逗号分隔，如 deepseek-chat, deepseek-reasoner）"
              value={configModelsText}
              onChange={(e) => setConfigModelsText(e.target.value)}
            />
            <input
              type="password"
              className="lwb-input"
              placeholder={
                configStatus?.apiKeyMasked
                  ? `API Key（当前 ${configStatus.apiKeyMasked}，留空保留原值）`
                  : "输入 API Key"
              }
              value={configApiKey}
              onChange={(e) => setConfigApiKey(e.target.value)}
            />
            <div className="lwb-btn-row">
              <button
                type="button"
                className="lwb-btn lwb-btn--primary lwb-btn--xs"
                disabled={busy || !api.saveConfig}
                onClick={handleSaveConfig}
              >
                保存配置
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {!selectedSession ? (
        <div className="lwb-empty">
          <p>请先在左侧选择或新建一个学习会话，即可在此查看学习单、导入教材原文并核对引用。</p>
        </div>
      ) : !api ? (
        <div className="lwb-empty">
          <p>学习工作台 IPC 桥接尚未就绪（缺少 window.learningWorkbench）。</p>
        </div>
      ) : (
        <>
          <div className="lwb-starters" role="group" aria-label="一键揉书快捷指令">
            {PROMPT_STARTERS.map((starter) => (
              <button
                key={starter.id}
                type="button"
                className="lwb-starter-chip"
                disabled={!onInsertPrompt}
                title={starter.prompt}
                onClick={() => onInsertPrompt?.(starter.prompt)}
              >
                {starter.label}
              </button>
            ))}
          </div>

          {recoveryState && recoveryState.pending.length > 0 ? (
            <div className="lwb-notice lwb-notice--info">
              <span>存在 {recoveryState.pending.length} 条待核操作记录。</span>
              <button
                type="button"
                className="lwb-btn lwb-btn--ghost lwb-btn--xs"
                disabled={busy}
                onClick={handleResolveRecovery}
              >
                核对状态
              </button>
            </div>
          ) : null}

          {banner ? (
            <div className={`lwb-notice lwb-notice--${banner.kind}`} role="status">
              <span className="lwb-notice__text">{banner.text}</span>
              <button
                type="button"
                className="lwb-notice__close"
                aria-label="关闭提示"
                onClick={() => setBanner(null)}
              >
                ×
              </button>
            </div>
          ) : null}

          <nav className="lwb-tabs" role="tablist" aria-label="工作台视图">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className={`lwb-tab${activeTab === tab.id ? " lwb-tab--active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="lwb-body">
            {loading && !studyState ? (
              <div className="lwb-muted">正在加载当前会话数据…</div>
            ) : null}

            {activeTab === "study" ? (
              <div className="lwb-section-stack">
                {pendingSyncDraft ? (
                  <section
                    className="lwb-card lwb-card--autosync"
                    data-testid="learning-auto-sync-card"
                  >
                    <div className="lwb-card__header">
                      <span className="lwb-card__title">✨ 已自动同步最新对话内容（待确认）</span>
                      <div className="lwb-card__actions">
                        <span className="lwb-pill">{pendingSyncDraft.claims.length} 条主张</span>
                        <button
                          type="button"
                          className="lwb-btn lwb-btn--ghost lwb-btn--xs"
                          disabled={busy}
                          onClick={handleDismissPendingSync}
                          title="暂不保存此同步草稿"
                        >
                          忽略
                        </button>
                      </div>
                    </div>

                    <div className="lwb-draft-view">
                      <div className="lwb-draft-view__title">{pendingSyncDraft.title}</div>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "6px",
                          maxHeight: "220px",
                          overflowY: "auto",
                        }}
                      >
                        {pendingSyncDraft.claims.map((claimText, idx) => (
                          <div key={idx} className="lwb-claim">
                            <div className="lwb-claim__text">
                              {idx + 1}. {claimText}
                            </div>
                          </div>
                        ))}
                      </div>

                      {pendingSyncDraft.uncertainties.length > 0 ? (
                        <div className="lwb-uncertainties">
                          <div className="lwb-label">待核 / 存疑项</div>
                          <ul>
                            {pendingSyncDraft.uncertainties.map((item, idx) => (
                              <li key={idx}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {isFormDirty ? (
                        <div className="lwb-inline-result lwb-inline-result--info">
                          检测到下方表单有未提交的手动编辑，已保留您的输入；可点击「填入表单」覆盖或直接「一键保存为学习单」。
                        </div>
                      ) : null}

                      {syncRawExpanded ? (
                        <pre className="lwb-reader-text">{pendingSyncDraft.rawText}</pre>
                      ) : null}

                      <div className="lwb-btn-row">
                        <button
                          type="button"
                          className="lwb-btn lwb-btn--primary lwb-btn--xs"
                          disabled={busy}
                          onClick={handleSavePendingSync}
                        >
                          一键保存为学习单
                        </button>
                        <button
                          type="button"
                          className="lwb-btn lwb-btn--secondary lwb-btn--xs"
                          disabled={busy}
                          onClick={handleFillFormFromPendingSync}
                        >
                          填入表单
                        </button>
                        <button
                          type="button"
                          className="lwb-btn lwb-btn--ghost lwb-btn--xs"
                          onClick={() => setSyncRawExpanded((prev) => !prev)}
                        >
                          {syncRawExpanded ? "收起原文预览" : "完整原文预览"}
                        </button>
                      </div>
                    </div>
                  </section>
                ) : null}

                <section className="lwb-card">
                  <div className="lwb-card__header">
                    <span className="lwb-card__title">当前学习单</span>
                    <div className="lwb-card__actions">
                      {studyState?.currentDraft ? (
                        <div className="lwb-segmented" role="group" aria-label="学习单视图切换">
                          <button
                            type="button"
                            className={`lwb-segmented__btn${studyViewMode === "card" ? " lwb-segmented__btn--active" : ""}`}
                            onClick={() => setStudyViewMode("card")}
                          >
                            卡片视图
                          </button>
                          <button
                            type="button"
                            className={`lwb-segmented__btn${studyViewMode === "markdown" ? " lwb-segmented__btn--active" : ""}`}
                            onClick={() => setStudyViewMode("markdown")}
                          >
                            Markdown 预览
                          </button>
                        </div>
                      ) : null}
                      <span className="lwb-pill">
                        {currentVersion > 0 ? `V${currentVersion}` : "未建稿"}
                      </span>
                    </div>
                  </div>
                  {studyState?.currentDraft ? (
                    studyViewMode === "markdown" ? (
                      <div className="lwb-draft-view">
                        <textarea
                          className="lwb-textarea lwb-markdown-preview"
                          readOnly
                          rows={10}
                          aria-label="学习单 Markdown 预览"
                          value={studyMarkdownText}
                        />
                        <div className="lwb-btn-row">
                          <button
                            type="button"
                            className="lwb-btn lwb-btn--secondary"
                            onClick={handleCopyMarkdown}
                          >
                            📋 复制 Markdown
                          </button>
                          <button
                            type="button"
                            className="lwb-btn lwb-btn--primary"
                            disabled={busy}
                            onClick={handleExportCurrentDraft}
                          >
                            💾 导出 .md 文件
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="lwb-draft-view">
                        <div className="lwb-draft-view__title">{studyState.currentDraft.title}</div>
                        {studyState.currentDraft.claims.map((claim) => (
                          <div key={claim.id} className="lwb-claim">
                            <div className="lwb-claim__text">{claim.text}</div>
                            {claim.citations.length > 0 ? (
                              <ul className="lwb-citation-list">
                                {claim.citations.map((c, idx) => (
                                  <li key={`${c.materialId}-${idx}`} className="lwb-citation-item">
                                    <span className="lwb-citation-quote">“{c.quote}”</span>
                                    <span className="lwb-citation-meta">
                                      {c.matchMethod === "layout-whitespace" ? "排版容错" : "精确"}
                                      {c.codepoints
                                        ? ` [${c.codepoints.start}..${c.codepoints.end}]`
                                        : ""}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <div className="lwb-muted lwb-text-xs">未绑定原文引用</div>
                            )}
                          </div>
                        ))}
                        {studyState.unresolved.length > 0 ? (
                          <div className="lwb-uncertainties">
                            <div className="lwb-label">待核项</div>
                            <ul>
                              {studyState.unresolved.map((u, i) => (
                                <li key={i}>{u}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                    )
                  ) : (
                    <div className="lwb-muted">当前会话尚未保存学习单版本。</div>
                  )}
                </section>

                <section className="lwb-card">
                  <div className="lwb-card__header">
                    <span className="lwb-card__title">保存 / 修订学习单</span>
                    <button
                      type="button"
                      className="lwb-btn lwb-btn--secondary lwb-btn--xs"
                      disabled={busy}
                      onClick={handleAddClaim}
                    >
                      + 添加主张
                    </button>
                  </div>
                  <div className="lwb-form">
                    <label className="lwb-field">
                      <span className="lwb-label">学习单标题</span>
                      <input
                        type="text"
                        className="lwb-input"
                        maxLength={160}
                        placeholder="例：第3章 抗心律失常药主干"
                        value={draftTitle}
                        onChange={(e) => {
                          markFormDirty();
                          setDraftTitle(e.target.value);
                        }}
                      />
                    </label>

                    <div className="lwb-claim-editor-list">
                      {draftClaims.map((entry, idx) => {
                        const claimMaterial = entry.selectedMaterialKey
                          ? materialByKey.get(entry.selectedMaterialKey)
                          : undefined;
                        return (
                          <div key={entry.key} className="lwb-claim-editor-item">
                            <div className="lwb-claim-editor-item__header">
                              <span className="lwb-claim-editor-item__title">
                                核心主张 #{idx + 1}
                              </span>
                              {draftClaims.length > 1 ? (
                                <button
                                  type="button"
                                  className="lwb-btn lwb-btn--ghost lwb-btn--xs"
                                  disabled={busy}
                                  onClick={() => handleRemoveClaim(entry.key)}
                                >
                                  删除
                                </button>
                              ) : null}
                            </div>

                            <label className="lwb-field">
                              <span className="lwb-label">主张内容</span>
                              <textarea
                                className="lwb-textarea"
                                rows={3}
                                maxLength={1000}
                                placeholder="提炼核心机制、分类或易错鉴别要点…"
                                value={entry.text}
                                onChange={(e) =>
                                  updateDraftClaim(entry.key, { text: e.target.value })
                                }
                              />
                            </label>

                            <label className="lwb-field">
                              <span className="lwb-label">关联材料（可选）</span>
                              <select
                                className="lwb-select"
                                value={entry.selectedMaterialKey}
                                onChange={(e) =>
                                  updateDraftClaim(entry.key, {
                                    selectedMaterialKey: e.target.value,
                                    locateNotice: null,
                                  })
                                }
                              >
                                <option value="">不关联材料（纯手写记录）</option>
                                {materials.map((m) => (
                                  <option key={materialKey(m)} value={materialKey(m)}>
                                    {m.name}（{m.chars} 字）
                                  </option>
                                ))}
                              </select>
                            </label>

                            <label className="lwb-field">
                              <span className="lwb-label">引用原文片段（选填）</span>
                              <textarea
                                className="lwb-textarea"
                                rows={2}
                                maxLength={512}
                                placeholder="粘贴材料原文句子以核对码点定位…"
                                value={entry.quote}
                                onChange={(e) =>
                                  updateDraftClaim(entry.key, {
                                    quote: e.target.value,
                                    locateNotice: null,
                                  })
                                }
                              />
                            </label>

                            {entry.locateNotice ? (
                              <div
                                className={`lwb-inline-result lwb-inline-result--${entry.locateNotice.kind}`}
                              >
                                {entry.locateNotice.text}
                              </div>
                            ) : null}

                            <div className="lwb-btn-row">
                              <button
                                type="button"
                                className="lwb-btn lwb-btn--secondary lwb-btn--xs"
                                disabled={busy || !claimMaterial || !entry.quote.trim()}
                                onClick={() => handleLocateClaimCitation(entry.key)}
                              >
                                定位核对
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <label className="lwb-field">
                      <span className="lwb-label">待核/存疑项（每行一条，可选）</span>
                      <textarea
                        className="lwb-textarea"
                        rows={2}
                        maxLength={1000}
                        placeholder="每行输入一条尚待核对的教材细节或存疑问题…"
                        value={uncertaintiesText}
                        onChange={(e) => {
                          markFormDirty();
                          setUncertaintiesText(e.target.value);
                        }}
                      />
                    </label>

                    <div className="lwb-btn-row">
                      <button
                        type="button"
                        className="lwb-btn lwb-btn--primary"
                        disabled={
                          busy ||
                          !draftTitle.trim() ||
                          draftClaims.some((entry) => !entry.text.trim())
                        }
                        onClick={handleSaveDraft}
                      >
                        保存学习单版本
                      </button>
                    </div>
                  </div>
                </section>

                {currentVersion > 0 ? (
                  <section className="lwb-card">
                    <div className="lwb-card__header">
                      <span className="lwb-card__title">导出学习单</span>
                    </div>
                    <div className="lwb-inline-bar">
                      <select
                        className="lwb-select lwb-select--compact"
                        aria-label="选择导出版本号"
                        value={exportVersion}
                        onChange={(e) => setExportVersion(Number(e.target.value))}
                      >
                        {exportVersionOptions.map((v) => (
                          <option key={v} value={v}>
                            版本 V{v}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="lwb-btn lwb-btn--secondary"
                        disabled={busy}
                        onClick={handleExportVersion}
                      >
                        导出 Markdown
                      </button>
                    </div>
                  </section>
                ) : null}
              </div>
            ) : null}

            {activeTab === "materials" ? (
              <div className="lwb-section-stack">
                <div className="lwb-drop-row">
                  <div
                    data-learning-drop="true"
                    className={`lwb-dropzone${isDragOver ? " lwb-dropzone--active" : ""}`}
                    onDragEnter={() => setIsDragOver(true)}
                    onDragLeave={() => setIsDragOver(false)}
                    onDrop={() => setIsDragOver(false)}
                  >
                    拖拽 .md / .txt / .pdf / .png / .jpg 到此处，或点击「选择材料导入」（
                    {modeStatus?.textbookRootExists && modeStatus.textbookRoot
                      ? `默认打开只读教材库：${modeStatus.textbookRoot}`
                      : "原文件只读不修改"}
                    ）
                  </div>
                  <button
                    type="button"
                    className="lwb-btn lwb-btn--primary"
                    disabled={busy}
                    onClick={handleChooseMaterial}
                  >
                    选择材料导入
                  </button>
                </div>

                <section className="lwb-card">
                  <div className="lwb-card__header">
                    <span className="lwb-card__title">已导入材料（{materials.length}）</span>
                  </div>
                  {materials.length === 0 ? (
                    <div className="lwb-muted">
                      暂无材料，请拖入或选择 .md / .txt / .pdf / 图片文件导入。
                    </div>
                  ) : (
                    <ul className="lwb-list">
                      {materials.map((m) => {
                        const isReading =
                          readerState?.material.materialId === m.materialId &&
                          readerState?.material.versionId === m.versionId;
                        const provenanceBadges = collectProvenanceBadges(m.provenance);
                        return (
                          <li key={materialKey(m)} className="lwb-list-item">
                            <div className="lwb-list-item__main">
                              <div className="lwb-list-item__title" title={m.name}>
                                {m.name}
                              </div>
                              <div className="lwb-list-item__meta">{m.chars} 字符</div>
                              {provenanceBadges.length > 0 ? (
                                <div className="lwb-provenance-tags">
                                  {provenanceBadges.map((badge) => (
                                    <span key={badge} className="lwb-tag">
                                      {badge}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                            <button
                              type="button"
                              className={`lwb-btn lwb-btn--xs ${isReading ? "lwb-btn--primary" : "lwb-btn--secondary"}`}
                              disabled={busy}
                              onClick={() => handleReadMaterial(m, 0, [])}
                            >
                              阅读原文
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>

                {readerState ? (
                  <section className="lwb-card">
                    <div className="lwb-card__header">
                      <span className="lwb-card__title" title={readerState.material.name}>
                        原文：{readerState.material.name}
                      </span>
                      <span className="lwb-pill">
                        [{readerState.page.start}..{readerState.page.end}]
                      </span>
                    </div>
                    {(() => {
                      const readerProvenance =
                        readerState.page.provenance ?? readerState.material.provenance;
                      const readerBadges = collectProvenanceBadges(readerProvenance);
                      return (
                        <>
                          {readerBadges.length > 0 ? (
                            <div className="lwb-provenance-tags">
                              {readerBadges.map((badge) => (
                                <span key={badge} className="lwb-tag">
                                  {badge}
                                </span>
                              ))}
                            </div>
                          ) : null}
                          {readerProvenance?.uncertainties?.length ? (
                            <div className="lwb-inline-result lwb-inline-result--info">
                              解析提示：{readerProvenance.uncertainties.join("；")}
                            </div>
                          ) : null}
                        </>
                      );
                    })()}
                    <pre className="lwb-reader-text">{readerState.page.text}</pre>
                    <div className="lwb-btn-row">
                      <button
                        type="button"
                        className="lwb-btn lwb-btn--secondary lwb-btn--xs"
                        disabled={busy || readerState.prevStarts.length === 0}
                        onClick={() => {
                          const prev = readerState.prevStarts[readerState.prevStarts.length - 1];
                          if (prev === undefined) return;
                          handleReadMaterial(
                            readerState.material,
                            prev,
                            readerState.prevStarts.slice(0, -1),
                          );
                        }}
                      >
                        上一段
                      </button>
                      <button
                        type="button"
                        className="lwb-btn lwb-btn--secondary lwb-btn--xs"
                        disabled={busy || readerState.page.next === null}
                        onClick={() => {
                          if (readerState.page.next === null) return;
                          handleReadMaterial(readerState.material, readerState.page.next, [
                            ...readerState.prevStarts,
                            readerState.page.start,
                          ]);
                        }}
                      >
                        下一段
                      </button>
                    </div>
                  </section>
                ) : null}
              </div>
            ) : null}

            {activeTab === "corrections" ? (
              <div className="lwb-section-stack">
                <section className="lwb-card">
                  <div className="lwb-card__header">
                    <span className="lwb-card__title">登记待核纠正</span>
                  </div>
                  <div className="lwb-form">
                    <textarea
                      className="lwb-textarea"
                      rows={2}
                      maxLength={1000}
                      placeholder={
                        studyState?.currentDraft
                          ? "描述需要纠正或待核对的内容…"
                          : "请先在「学习单」标签页保存至少一个版本…"
                      }
                      value={correctionInput}
                      onChange={(e) => setCorrectionInput(e.target.value)}
                    />
                    <div className="lwb-btn-row">
                      <button
                        type="button"
                        className="lwb-btn lwb-btn--primary"
                        disabled={busy || !studyState?.currentDraft || !correctionInput.trim()}
                        onClick={handleCreateCorrection}
                      >
                        登记纠正
                      </button>
                    </div>
                  </div>
                </section>

                <section className="lwb-card">
                  <div className="lwb-card__header">
                    <span className="lwb-card__title">
                      纠正记录（{studyState?.corrections.length ?? 0}）
                    </span>
                  </div>
                  {!studyState?.corrections.length ? (
                    <div className="lwb-muted">暂无待核纠正记录。</div>
                  ) : (
                    <ul className="lwb-card-list">
                      {studyState.corrections.map((item) => {
                        const isEditing = editingCorrectionId === item.correctionId;
                        const isRetracted = item.status === "retracted";
                        return (
                          <li key={item.correctionId} className="lwb-entry">
                            <div className="lwb-entry__meta">
                              <span className="lwb-pill">r{item.revision}</span>
                              <span className="lwb-muted lwb-text-xs">
                                {item.status} · {item.verificationStatus}
                              </span>
                            </div>
                            <div className="lwb-entry__quote">原说法：{item.originalClaim}</div>
                            <div className="lwb-entry__body">纠正：{item.correction}</div>
                            {!isRetracted ? (
                              isEditing ? (
                                <div className="lwb-inline-edit">
                                  <textarea
                                    className="lwb-textarea"
                                    rows={2}
                                    maxLength={1000}
                                    value={editingCorrectionText}
                                    onChange={(e) => setEditingCorrectionText(e.target.value)}
                                  />
                                  <div className="lwb-btn-row">
                                    <button
                                      type="button"
                                      className="lwb-btn lwb-btn--primary lwb-btn--xs"
                                      disabled={busy || !editingCorrectionText.trim()}
                                      onClick={() =>
                                        handleSupersedeCorrection(item.correctionId, item.revision)
                                      }
                                    >
                                      保存修改
                                    </button>
                                    <button
                                      type="button"
                                      className="lwb-btn lwb-btn--ghost lwb-btn--xs"
                                      onClick={() => {
                                        setEditingCorrectionId(null);
                                        setEditingCorrectionText("");
                                      }}
                                    >
                                      取消
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="lwb-btn-row">
                                  <button
                                    type="button"
                                    className="lwb-btn lwb-btn--secondary lwb-btn--xs"
                                    disabled={busy}
                                    onClick={() => {
                                      setEditingCorrectionId(item.correctionId);
                                      setEditingCorrectionText(item.correction);
                                    }}
                                  >
                                    修改说明
                                  </button>
                                  <button
                                    type="button"
                                    className="lwb-btn lwb-btn--danger lwb-btn--xs"
                                    disabled={busy}
                                    onClick={() =>
                                      handleRetractCorrection(item.correctionId, item.revision)
                                    }
                                  >
                                    撤回
                                  </button>
                                </div>
                              )
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </div>
            ) : null}

            {activeTab === "memory" ? (
              <div className="lwb-section-stack">
                <section className="lwb-card">
                  <div className="lwb-card__header">
                    <span className="lwb-card__title">个人学习偏好（USER.md）</span>
                    <span className="lwb-pill">{profileItems.length}</span>
                  </div>
                  {profileItems.length === 0 ? (
                    <div className="lwb-muted">暂无学习偏好记录。</div>
                  ) : (
                    <ul className="lwb-card-list">
                      {profileItems.map((entry) => {
                        const isEditing = editingProfileId === entry.id;
                        return (
                          <li key={entry.id} className="lwb-entry">
                            {isEditing ? (
                              <div className="lwb-inline-edit">
                                <input
                                  type="text"
                                  className="lwb-input"
                                  maxLength={200}
                                  value={editingProfileValue}
                                  onChange={(e) => setEditingProfileValue(e.target.value)}
                                />
                                <div className="lwb-btn-row">
                                  <button
                                    type="button"
                                    className="lwb-btn lwb-btn--primary lwb-btn--xs"
                                    disabled={busy || !editingProfileValue.trim()}
                                    onClick={() => handleUpdateProfile(entry.id, entry.version)}
                                  >
                                    保存
                                  </button>
                                  <button
                                    type="button"
                                    className="lwb-btn lwb-btn--ghost lwb-btn--xs"
                                    onClick={() => {
                                      setEditingProfileId(null);
                                      setEditingProfileValue("");
                                    }}
                                  >
                                    取消
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <div className="lwb-entry__body">{entry.value}</div>
                                <div className="lwb-entry__footer">
                                  <span className="lwb-muted lwb-text-xs">v{entry.version}</span>
                                  <div className="lwb-btn-row">
                                    <button
                                      type="button"
                                      className="lwb-btn lwb-btn--secondary lwb-btn--xs"
                                      disabled={busy}
                                      onClick={() => {
                                        setEditingProfileId(entry.id);
                                        setEditingProfileValue(entry.value);
                                      }}
                                    >
                                      编辑
                                    </button>
                                    <button
                                      type="button"
                                      className="lwb-btn lwb-btn--danger lwb-btn--xs"
                                      disabled={busy}
                                      onClick={() => handleDeleteProfile(entry.id, entry.version)}
                                    >
                                      删除
                                    </button>
                                  </div>
                                </div>
                              </>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <div className="lwb-inline-bar">
                    <input
                      type="text"
                      className="lwb-input"
                      maxLength={200}
                      placeholder="新增学习偏好（如：先给机制树状图）…"
                      value={newProfileValue}
                      onChange={(e) => setNewProfileValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (isImeComposing(e) || e.key !== "Enter") return;
                        e.preventDefault();
                        handleCreateProfile();
                      }}
                    />
                    <button
                      type="button"
                      className="lwb-btn lwb-btn--primary"
                      disabled={busy || !newProfileValue.trim()}
                      onClick={handleCreateProfile}
                    >
                      新增偏好
                    </button>
                  </div>
                </section>

                <section className="lwb-card">
                  <div className="lwb-card__header">
                    <span className="lwb-card__title">跨会话历史检索</span>
                  </div>
                  <div className="lwb-inline-bar">
                    <input
                      type="text"
                      className="lwb-input"
                      maxLength={40}
                      placeholder="输入关键词（最多 40 字）…"
                      value={historyQuery}
                      onChange={(e) => setHistoryQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (isImeComposing(e) || e.key !== "Enter") return;
                        e.preventDefault();
                        handleHistorySearch();
                      }}
                    />
                    <button
                      type="button"
                      className="lwb-btn lwb-btn--secondary"
                      disabled={busy || !historyQuery.trim()}
                      onClick={handleHistorySearch}
                    >
                      检索
                    </button>
                  </div>

                  {historyMethod ? (
                    <div className="lwb-muted lwb-text-xs">
                      命中 {historyHits.length} 条（{historyMethod}）
                    </div>
                  ) : null}

                  {historyHits.length > 0 ? (
                    <ul className="lwb-card-list">
                      {historyHits.map((hit, idx) => {
                        const hitKey = `${hit.anchor.session}:${hit.anchor.id}:${idx}`;
                        const active = selectedHitKey === hitKey;
                        return (
                          <li key={hitKey}>
                            <button
                              type="button"
                              className={`lwb-history-hit${active ? " lwb-history-hit--active" : ""}`}
                              disabled={busy}
                              onClick={() => handleHistoryRead(hit.anchor, hitKey)}
                            >
                              <span className="lwb-history-hit__meta">
                                {hit.anchor.role} · {hit.anchor.session}
                              </span>
                              <span className="lwb-history-hit__snippet">{hit.snippet}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}

                  {historyDetail ? (
                    <div className="lwb-history-detail">
                      <div className="lwb-history-detail__meta">
                        原对话（{historyDetail.role}）[{historyDetail.start}..{historyDetail.end}]
                      </div>
                      <pre className="lwb-reader-text">{historyDetail.text}</pre>
                    </div>
                  ) : null}
                </section>
              </div>
            ) : null}
          </div>
        </>
      )}
    </aside>
  );
}
