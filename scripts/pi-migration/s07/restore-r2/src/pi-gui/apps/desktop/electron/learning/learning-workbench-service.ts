import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  app as electronApp,
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { BuiltinExtension, PiSdkDriverConfig } from "@pi-gui/pi-sdk-driver";
import type { SessionRef } from "@pi-gui/session-driver";
import type {
  LearningAppConfigStatus,
  LearningDataDirOpenResult,
  LearningLegacyImportResult,
} from "../../contracts/ipc";
import type { WindowOwner } from "../windows/window-owner";

const execFileAsync = promisify(execFile);
const MAX_MATERIAL_BYTES = 20 * 1024 * 1024;
const EXPORT_MAX_BYTES = 24_000;
const HISTORY_CALLER = "s07b-trusted-host";
const PDF_DEFAULT_MAX_PAGES = 5;
const SUPPORTED_MATERIAL_EXTENSIONS = new Set([".txt", ".md", ".pdf", ".png", ".jpg", ".jpeg"]);
const IMAGE_MATERIAL_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const STUDY_SYNC_GUIDANCE = [
  "## 侧边栏学习单同步引导",
  "当你在本轮对话中完成了清晰的知识点主干梳理、病理机制链或易混鉴别总结，且内容适合沉淀为可复习的结构化学习单时，请优先主动调用 `study_submit` 工具保存新版学习单（提炼明确标题与结构化主张，若有导入材料则尽量附上原文 quote 引用）。",
  "若是简单寒暄、澄清追问或尚未成型的零散问答，则不必强行调用 `study_submit`。",
].join("\n");

const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<Record<string, any>>;

interface MethodContextFile {
  readonly warning?: string;
  readonly text: string;
}

interface LearningWorkbenchServiceOptions {
  readonly isPackaged?: boolean;
  readonly resourcesPath?: string;
}

interface LearningWorkbenchServiceDeps {
  readonly windows: WindowOwner;
  readonly ensureSessionReady: (sessionRef: SessionRef) => Promise<unknown>;
  readonly onSessionMutated: (sessionRef: SessionRef) => Promise<void>;
  readonly onProviderConfigChanged?: () => Promise<void>;
}

interface MedTutorStoredConfig {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly models?: readonly string[];
  readonly offlineMock?: boolean;
}

interface EffectiveMedTutorConfig {
  readonly configured: boolean;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly models: readonly string[];
  readonly offlineMock: boolean;
  readonly textbookRoot: string;
}

interface S07bExports {
  readonly s07bExtension: BuiltinExtension["factory"];
  readonly getMaterialsForWorker: () => any;
  readonly getDomainForWorker: () => any;
  readonly getHistoryForWorker: () => any;
  readonly getProfileForWorker: () => any;
  readonly commitProfileFromTrustedUi: (
    manager: SessionManager,
    action: string,
    args: Record<string, unknown>,
    guard: () => void,
  ) => Promise<unknown>;
  readonly hostIntent: (
    manager: SessionManager,
    action: string,
    payload: Record<string, unknown>,
    intentId: string,
    options?: { readonly profile?: boolean },
  ) => unknown;
}

function findAncestorDir(startDir: string, predicate: (dir: string) => boolean): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    if (predicate(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolvePiGuiRoot(): string {
  const candidates = [__dirname, process.cwd()];
  for (const start of candidates) {
    const found = findAncestorDir(
      start,
      (dir) =>
        fs.existsSync(path.join(dir, "packages", "pi-sdk-driver", "dist", "npm-package-fallback.js")) &&
        fs.existsSync(path.join(dir, "apps", "desktop", "package.json")),
    );
    if (found) {
      return found;
    }
  }
  throw new Error("无法定位 pi-gui 源码根目录（packages/pi-sdk-driver/dist/npm-package-fallback.js 缺失）。");
}

function resolveMedTutorRoot(piGuiRoot: string): string {
  const envRoot = process.env.MED_TUTOR_ROOT?.trim();
  if (envRoot) {
    const resolved = path.resolve(envRoot);
    if (
      fs.existsSync(
        path.join(resolved, "scripts", "pi-migration", "s08", "learning-workbench-r4", "s07b-extension.mjs"),
      )
    ) {
      return resolved;
    }
    throw new Error(`MED_TUTOR_ROOT 指向的目录无效: ${resolved}`);
  }
  for (const start of [piGuiRoot, __dirname, process.cwd()]) {
    const found = findAncestorDir(start, (dir) =>
      fs.existsSync(
        path.join(dir, "scripts", "pi-migration", "s08", "learning-workbench-r4", "s07b-extension.mjs"),
      ),
    );
    if (found) {
      return found;
    }
  }
  throw new Error("无法定位 med-tutor 仓库根目录，请检查目录结构或设置 MED_TUTOR_ROOT 环境变量。");
}

function resolvePackagedRuntimeRoot(resourcesPath: string): string {
  const candidates = [
    path.join(resourcesPath, "app.asar"),
    path.join(resourcesPath, "app"),
    path.join(resourcesPath, "med-tutor", "pi-runtime"),
    path.resolve(__dirname, "..", ".."),
  ];
  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, "packages", "pi-sdk-driver", "dist", "npm-package-fallback.js")) &&
      fs.existsSync(path.join(dir, "packages", "hermes-memory", "dist", "store", "memory-store.js"))
    ) {
      return dir;
    }
  }
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "packages", "pi-sdk-driver", "dist", "npm-package-fallback.js"))) {
      return dir;
    }
  }
  throw new Error(
    `打包运行时资源缺失：未能在 ${resourcesPath} 下找到 app 或 med-tutor/pi-runtime（缺少 packages/pi-sdk-driver/dist）。`,
  );
}

function resolvePackagedMedTutorResources(resourcesPath: string): {
  readonly workbenchDir: string;
  readonly scriptsDir: string;
} {
  const medTutorDir = path.join(resourcesPath, "med-tutor");
  const workbenchDir = path.join(medTutorDir, "learning-workbench-r4");
  if (!fs.existsSync(path.join(workbenchDir, "s07b-extension.mjs"))) {
    throw new Error(`打包学习工作台资源缺失：未找到 ${path.join(workbenchDir, "s07b-extension.mjs")}。`);
  }
  return {
    workbenchDir,
    scriptsDir: path.join(medTutorDir, "scripts"),
  };
}

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertOnlyKeys(value: unknown, allowedKeys: readonly string[], message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    throw new Error(message);
  }
  return record;
}

function parseDotEnvFile(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) {
    return {};
  }
  const parsed: Record<string, string> = {};
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1]!;
    let value = match[2]!.trim();
    if (/^(['"]).*\1$/.test(value)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    parsed[key] = value;
  }
  return parsed;
}

function readStoredConfig(configPath: string): MedTutorStoredConfig {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.apiKey === "string" ? { apiKey: record.apiKey } : {}),
      ...(typeof record.baseUrl === "string" ? { baseUrl: record.baseUrl } : {}),
      ...(Array.isArray(record.models)
        ? { models: record.models.filter((item): item is string => typeof item === "string") }
        : {}),
      ...(typeof record.offlineMock === "boolean" ? { offlineMock: record.offlineMock } : {}),
    };
  } catch (error) {
    console.warn(
      "[learning-workbench] 读取配置文件失败，将使用默认/环境变量配置:",
      error instanceof Error ? error.message : String(error),
    );
    return {};
  }
}

function writeStoredConfig(configPath: string, config: MedTutorStoredConfig): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${configPath}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmpPath, configPath);
}

function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= 8) {
    return "****";
  }
  const prefixLen = trimmed.startsWith("sk-") ? 3 : 2;
  return `${trimmed.slice(0, prefixLen)}****${trimmed.slice(-4)}`;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizePathForCompare(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrNestedPath(parentCandidate: string, childCandidate: string): boolean {
  const parent = normalizePathForCompare(parentCandidate);
  const child = normalizePathForCompare(childCandidate);
  if (parent === child) {
    return true;
  }
  const parentWithSep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(parentWithSep);
}

function filesAreIdentical(fileA: string, fileB: string): boolean {
  const statA = fs.statSync(fileA);
  const statB = fs.statSync(fileB);
  if (statA.size !== statB.size) {
    return false;
  }
  return sha256Hex(fs.readFileSync(fileA)) === sha256Hex(fs.readFileSync(fileB));
}

function copyDirSafely(
  srcDir: string,
  destDir: string,
  backupRootDir: string,
  relPrefix: string,
  stats: { copiedFiles: number; backedUpConflicts: number; skippedIdentical: number; backupUsed: boolean },
): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    const relPath = path.join(relPrefix, entry.name);
    if (entry.isDirectory()) {
      copyDirSafely(srcPath, destPath, backupRootDir, relPath, stats);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
      stats.copiedFiles += 1;
      continue;
    }
    if (filesAreIdentical(srcPath, destPath)) {
      stats.skippedIdentical += 1;
      continue;
    }
    const backupPath = path.join(backupRootDir, relPath);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(destPath, backupPath);
    stats.backupUsed = true;
    stats.backedUpConflicts += 1;
    fs.copyFileSync(srcPath, destPath);
    stats.copiedFiles += 1;
  }
}

function extractEnvApiKey(envMap: Record<string, string | undefined>): {
  readonly apiKey: string;
  readonly isDeepseek: boolean;
} {
  const medKey = envMap.MED_TUTOR_API_KEY?.trim();
  if (medKey) {
    return { apiKey: medKey, isDeepseek: false };
  }
  const deepseekKey = envMap.DEEPSEEK_API_KEY?.trim();
  if (deepseekKey) {
    return { apiKey: deepseekKey, isDeepseek: true };
  }
  const openaiKey = envMap.OPENAI_API_KEY?.trim();
  if (openaiKey) {
    return { apiKey: openaiKey, isDeepseek: false };
  }
  return { apiKey: "", isDeepseek: false };
}

function extractEnvBaseUrl(envMap: Record<string, string | undefined>): string {
  return envMap.MED_TUTOR_BASE_URL?.trim() || envMap.OPENAI_BASE_URL?.trim() || "";
}

function extractEnvModels(envMap: Record<string, string | undefined>): readonly string[] {
  const rawModels = [
    envMap.MED_TUTOR_STUDY_MODEL?.trim(),
    envMap.MED_TUTOR_QA_MODEL?.trim(),
    envMap.MED_TUTOR_JUDGE_MODEL?.trim(),
  ].filter((id): id is string => Boolean(id));
  return Array.from(new Set(rawModels));
}

function resolvePythonExecutable(): string {
  const envPython = process.env.MED_STUDY_PYTHON?.trim();
  if (envPython) {
    return envPython;
  }
  const bundled = path.join(
    process.env.USERPROFILE ?? "",
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "python",
    "python.exe",
  );
  return fs.existsSync(bundled) ? bundled : "python";
}

async function runLocalTool(command: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync(command, [...args], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 90_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`本地材料解析失败（${path.basename(command)}）：${detail}`);
  }
}

interface NormalizedStudyClaimInput {
  readonly id: string;
  readonly text: string;
  readonly source: unknown;
  readonly quote: string | undefined;
}

interface NormalizedStudySaveInput {
  readonly title: string;
  readonly claims: readonly NormalizedStudyClaimInput[];
  readonly uncertainties: readonly string[];
}

function validateStudySaveInput(input: unknown): NormalizedStudySaveInput {
  const record = assertOnlyKeys(
    input,
    ["title", "text", "source", "quote", "claims", "uncertainties"],
    "学习单输入无效。",
  );
  if (typeof record.title !== "string") {
    throw new Error("请输入标题和内容。");
  }
  const title = record.title.trim();
  if (!title || Array.from(title).length > 160) {
    throw new Error("标题或内容为空或过长。");
  }

  let uncertainties: string[] = [];
  if (record.uncertainties !== undefined) {
    if (!Array.isArray(record.uncertainties) || record.uncertainties.length > 20) {
      throw new Error("待核/存疑项格式无效或超过 20 条。");
    }
    uncertainties = record.uncertainties
      .map((item) => {
        if (typeof item !== "string") {
          throw new Error("待核/存疑项必须为文本。");
        }
        return item.trim();
      })
      .filter((item) => item.length > 0);
    if (uncertainties.some((item) => Array.from(item).length > 300)) {
      throw new Error("单条待核/存疑项不能超过 300 字。");
    }
  }

  if (record.claims !== undefined) {
    if (!Array.isArray(record.claims) || record.claims.length === 0 || record.claims.length > 30) {
      throw new Error("主张列表不能为空且最多 30 条。");
    }
    const seenIds = new Set<string>();
    const claims: NormalizedStudyClaimInput[] = record.claims.map((rawClaim, index) => {
      const claimRec = assertOnlyKeys(rawClaim, ["id", "text", "source", "quote"], "主张条目无效。");
      if (typeof claimRec.text !== "string") {
        throw new Error("每条主张都必须填写文本内容。");
      }
      const claimText = claimRec.text.trim();
      if (!claimText || Array.from(claimText).length > 1000) {
        throw new Error("主张内容为空或超过 1000 字。");
      }
      const rawId = typeof claimRec.id === "string" && claimRec.id.trim() ? claimRec.id.trim() : `claim_${index + 1}`;
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(rawId) || seenIds.has(rawId)) {
        throw new Error("主张 ID 无效或重复。");
      }
      seenIds.add(rawId);
      if (claimRec.quote !== undefined && typeof claimRec.quote !== "string") {
        throw new Error("引用原文必须为字符串。");
      }
      return {
        id: rawId,
        text: claimText,
        source: claimRec.source,
        quote: typeof claimRec.quote === "string" ? claimRec.quote : undefined,
      };
    });
    return { title, claims, uncertainties };
  }

  if (typeof record.text !== "string") {
    throw new Error("请输入标题和内容。");
  }
  const text = record.text.trim();
  if (!text || Array.from(text).length > 1000) {
    throw new Error("标题或内容为空或过长。");
  }
  if (record.quote !== undefined && typeof record.quote !== "string") {
    throw new Error("引用原文必须为字符串。");
  }
  return {
    title,
    claims: [
      {
        id: "claim_1",
        text,
        source: record.source,
        quote: typeof record.quote === "string" ? record.quote : undefined,
      },
    ],
    uncertainties,
  };
}

export class LearningWorkbenchService {
  private readonly isPackaged: boolean;
  private readonly piRuntimeRoot: string;
  private readonly medTutorRoot: string | null;
  private readonly workbenchDir: string;
  private readonly scriptsDir: string;
  private readonly dataRoot: string;
  private readonly configPath: string;
  private offlineMock: boolean;
  private readonly liveManagers = new Map<string, SessionManager>();
  private writeQueue: Promise<unknown> = Promise.resolve();
  private initPromise: Promise<{
    readonly s07b: S07bExports;
    readonly method: MethodContextFile;
    readonly createRuntimeWithFallback: (options?: Record<string, unknown>) => Promise<any>;
    readonly renderAudit: (state: unknown, draft?: unknown) => string;
    readonly fixtureExtension: BuiltinExtension;
  }> | undefined;

  constructor(
    private readonly userDataDir: string,
    options?: LearningWorkbenchServiceOptions,
  ) {
    this.isPackaged = options?.isPackaged ?? Boolean(electronApp?.isPackaged);
    this.configPath = path.join(userDataDir, "med-tutor-config.json");

    if (this.isPackaged) {
      const resourcesPath =
        options?.resourcesPath ??
        (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath ??
        path.resolve(__dirname, "..", "..", "..");
      this.piRuntimeRoot = resolvePackagedRuntimeRoot(resourcesPath);
      this.medTutorRoot = null;
      const packagedResources = resolvePackagedMedTutorResources(resourcesPath);
      this.workbenchDir = packagedResources.workbenchDir;
      this.scriptsDir = packagedResources.scriptsDir;
    } else {
      this.piRuntimeRoot = resolvePiGuiRoot();
      this.medTutorRoot = resolveMedTutorRoot(this.piRuntimeRoot);
      this.workbenchDir = path.join(
        this.medTutorRoot,
        "scripts",
        "pi-migration",
        "s08",
        "learning-workbench-r4",
      );
      this.scriptsDir = path.join(this.medTutorRoot, "scripts");
    }

    const configuredDataRoot = process.env.S07B_DATA_ROOT?.trim();
    this.dataRoot = configuredDataRoot
      ? path.resolve(configuredDataRoot)
      : path.join(userDataDir, "learning-data");
    this.offlineMock = this.resolveEffectiveConfig().offlineMock;
  }

  private resolveAgentDir(): string {
    const override = process.env.PI_CODING_AGENT_DIR?.trim();
    if (override) {
      return path.resolve(override);
    }
    return path.join(this.userDataDir, "agent");
  }

  private resolveEffectiveConfig(): EffectiveMedTutorConfig {
    const stored = readStoredConfig(this.configPath);
    const userDotEnv = parseDotEnvFile(path.join(this.userDataDir, ".env"));
    const repoDotEnv =
      !this.isPackaged && this.medTutorRoot
        ? parseDotEnvFile(path.join(this.medTutorRoot, ".env"))
        : {};

    const procKey = extractEnvApiKey(process.env);
    const userEnvKey = extractEnvApiKey(userDotEnv);
    const repoEnvKey = extractEnvApiKey(repoDotEnv);

    let apiKey = procKey.apiKey;
    let apiKeyIsDeepseek = procKey.isDeepseek;
    if (!apiKey && stored.apiKey?.trim()) {
      apiKey = stored.apiKey.trim();
      apiKeyIsDeepseek = false;
    }
    if (!apiKey && userEnvKey.apiKey) {
      apiKey = userEnvKey.apiKey;
      apiKeyIsDeepseek = userEnvKey.isDeepseek;
    }
    if (!apiKey && repoEnvKey.apiKey) {
      apiKey = repoEnvKey.apiKey;
      apiKeyIsDeepseek = repoEnvKey.isDeepseek;
    }

    const baseUrl =
      extractEnvBaseUrl(process.env) ||
      stored.baseUrl?.trim() ||
      extractEnvBaseUrl(userDotEnv) ||
      extractEnvBaseUrl(repoDotEnv) ||
      (apiKeyIsDeepseek ? "https://api.deepseek.com/v1" : "https://api.openai.com/v1");

    const procModels = extractEnvModels(process.env);
    const storedModels = Array.from(
      new Set((stored.models ?? []).map((id) => id.trim()).filter(Boolean)),
    );
    const userEnvModels = extractEnvModels(userDotEnv);
    const repoEnvModels = extractEnvModels(repoDotEnv);
    const models =
      procModels.length > 0
        ? procModels
        : storedModels.length > 0
          ? storedModels
          : userEnvModels.length > 0
            ? userEnvModels
            : repoEnvModels.length > 0
              ? repoEnvModels
              : ["deepseek-chat", "deepseek-reasoner"];

    let offlineMock = false;
    if (process.env.MED_TUTOR_OFFLINE_MOCK !== undefined) {
      offlineMock = process.env.MED_TUTOR_OFFLINE_MOCK === "1";
    } else if (userDotEnv.MED_TUTOR_OFFLINE_MOCK !== undefined) {
      offlineMock = userDotEnv.MED_TUTOR_OFFLINE_MOCK === "1";
    } else if (repoDotEnv.MED_TUTOR_OFFLINE_MOCK !== undefined) {
      offlineMock = repoDotEnv.MED_TUTOR_OFFLINE_MOCK === "1";
    }

    const rawTextbookRoot =
      process.env.MED_TUTOR_TEXTBOOK_ROOT?.trim() ||
      userDotEnv.MED_TUTOR_TEXTBOOK_ROOT?.trim() ||
      repoDotEnv.MED_TUTOR_TEXTBOOK_ROOT?.trim() ||
      "";
    const textbookRoot = rawTextbookRoot ? path.resolve(rawTextbookRoot) : "";

    return {
      configured: Boolean(apiKey),
      apiKey,
      baseUrl,
      models,
      offlineMock,
      textbookRoot,
    };
  }

  private async ensureLoaded() {
    if (!this.initPromise) {
      this.initPromise = this.loadInternal();
    }
    return this.initPromise;
  }

  private async syncEnvCustomProvider(): Promise<void> {
    const effective = this.resolveEffectiveConfig();
    if (!effective.configured) {
      return;
    }
    try {
      const runtimeDepsMod = await dynamicImport(
        pathToFileURL(
          path.join(this.piRuntimeRoot, "packages", "pi-sdk-driver", "dist", "runtime-deps.js"),
        ).href,
      );
      const createRuntimeDependencies = runtimeDepsMod.createRuntimeDependencies as (options?: {
        readonly agentDir?: string;
      }) => {
        readonly customProviderStore: {
          set(input: {
            readonly providerId: string;
            readonly baseUrl: string;
            readonly apiKey?: string;
            readonly models: readonly { readonly id: string }[];
          }): Promise<void>;
        };
      };
      const agentDirOverride = process.env.PI_CODING_AGENT_DIR?.trim()
        ? path.resolve(process.env.PI_CODING_AGENT_DIR.trim())
        : this.isPackaged
          ? path.join(this.userDataDir, "agent")
          : undefined;
      const { customProviderStore } = createRuntimeDependencies(
        agentDirOverride ? { agentDir: agentDirOverride } : undefined,
      );
      await customProviderStore.set({
        providerId: "med-tutor-env",
        baseUrl: effective.baseUrl,
        apiKey: effective.apiKey,
        models: effective.models.map((id) => ({ id })),
      });
    } catch (error) {
      console.warn(
        "[learning-workbench] 同步环境变量模型配置失败:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private getModeStatus() {
    const effective = this.resolveEffectiveConfig();
    return {
      offlineMock: this.offlineMock,
      envProviderConfigured: effective.configured,
      ...(effective.configured ? { envBaseUrl: effective.baseUrl } : {}),
      envModels: effective.configured ? effective.models : ([] as readonly string[]),
      ...(effective.textbookRoot ? { textbookRoot: effective.textbookRoot } : {}),
      textbookRootExists: Boolean(effective.textbookRoot && fs.existsSync(effective.textbookRoot)),
    };
  }

  private getConfigStatus(): LearningAppConfigStatus {
    const effective = this.resolveEffectiveConfig();
    return {
      dataDir: this.userDataDir,
      configPath: this.configPath,
      envProviderConfigured: effective.configured,
      baseUrl: effective.baseUrl,
      models: effective.models,
      apiKeyMasked: maskApiKey(effective.apiKey),
      offlineMock: this.offlineMock,
      isPackaged: this.isPackaged,
    };
  }

  private async saveConfig(
    rawInput: unknown,
    deps: LearningWorkbenchServiceDeps,
  ): Promise<LearningAppConfigStatus> {
    const input = assertOnlyKeys(
      rawInput,
      ["apiKey", "baseUrl", "models", "offlineMock"],
      "配置参数无效。",
    );
    const existing = readStoredConfig(this.configPath);

    let nextApiKey = existing.apiKey;
    if (input.apiKey !== undefined) {
      if (typeof input.apiKey !== "string") {
        throw new Error("API Key 格式无效。");
      }
      const trimmedKey = input.apiKey.trim();
      if (trimmedKey) {
        nextApiKey = trimmedKey;
      }
    }

    let nextBaseUrl = existing.baseUrl;
    if (input.baseUrl !== undefined) {
      if (typeof input.baseUrl !== "string") {
        throw new Error("Base URL 格式无效。");
      }
      const trimmedBaseUrl = input.baseUrl.trim();
      if (trimmedBaseUrl) {
        if (!isValidHttpUrl(trimmedBaseUrl)) {
          throw new Error("Base URL 必须以 http:// 或 https:// 开头。");
        }
        nextBaseUrl = trimmedBaseUrl;
      } else {
        nextBaseUrl = undefined;
      }
    }

    let nextModels = existing.models;
    if (input.models !== undefined) {
      if (!Array.isArray(input.models) || input.models.length > 20) {
        throw new Error("模型列表格式无效或超过 20 项。");
      }
      const cleaned = Array.from(
        new Set(
          input.models.map((item) => {
            if (typeof item !== "string") {
              throw new Error("模型名称必须为文本。");
            }
            return item.trim();
          }).filter(Boolean),
        ),
      );
      if (cleaned.length === 0) {
        throw new Error("请至少填写一个有效的模型名称。");
      }
      nextModels = cleaned;
    }

    let nextOfflineMock = existing.offlineMock;
    if (input.offlineMock !== undefined) {
      if (typeof input.offlineMock !== "boolean") {
        throw new Error("离线模式参数无效。");
      }
      nextOfflineMock = input.offlineMock;
      this.offlineMock = input.offlineMock;
      process.env.MED_TUTOR_OFFLINE_MOCK = input.offlineMock ? "1" : "0";
    }

    const nextConfig: MedTutorStoredConfig = {
      ...(nextApiKey ? { apiKey: nextApiKey } : {}),
      ...(nextBaseUrl ? { baseUrl: nextBaseUrl } : {}),
      ...(nextModels && nextModels.length > 0 ? { models: nextModels } : {}),
      ...(typeof nextOfflineMock === "boolean" ? { offlineMock: nextOfflineMock } : {}),
    };
    writeStoredConfig(this.configPath, nextConfig);
    await this.syncEnvCustomProvider();
    await deps.onProviderConfigChanged?.().catch(() => undefined);
    return this.getConfigStatus();
  }

  private async importLegacyDataFromDialog(
    window: BrowserWindow,
    deps: LearningWorkbenchServiceDeps,
  ): Promise<LearningLegacyImportResult> {
    const selected = await dialog.showOpenDialog(window, {
      title: "选择旧版 MedTutor 数据目录（如 .study/personal）",
      properties: ["openDirectory"],
    });
    if (selected.canceled || selected.filePaths.length !== 1) {
      return { cancelled: true };
    }
    const sourceDir = path.resolve(selected.filePaths[0]!);
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      throw new Error("所选旧数据目录不存在或不可读取。");
    }

    const targetRoots = [this.userDataDir, this.dataRoot, this.resolveAgentDir()];
    for (const target of targetRoots) {
      if (isSameOrNestedPath(sourceDir, target) || isSameOrNestedPath(target, sourceDir)) {
        throw new Error("不能选择当前正在使用的数据目录或其父/子目录。");
      }
    }

    const candidates = [
      { name: "learning-data", dest: this.dataRoot },
      { name: "agent", dest: this.resolveAgentDir() },
      { name: "workspace", dest: path.join(this.userDataDir, "workspace") },
    ] as const;

    const present = candidates.filter((entry) => {
      const candidatePath = path.join(sourceDir, entry.name);
      return fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory();
    });
    if (present.length === 0) {
      throw new Error("所选目录无效：未在其下找到 learning-data、agent 或 workspace 目录。");
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(this.userDataDir, "import-backups", stamp);
    const stats = {
      copiedFiles: 0,
      backedUpConflicts: 0,
      skippedIdentical: 0,
      backupUsed: false,
    };

    for (const entry of present) {
      copyDirSafely(path.join(sourceDir, entry.name), entry.dest, backupDir, entry.name, stats);
    }

    await this.syncEnvCustomProvider();
    await deps.onProviderConfigChanged?.().catch(() => undefined);

    const importedDirs = present.map((entry) => entry.name);
    return {
      cancelled: false,
      sourceDir,
      targetDir: this.userDataDir,
      importedDirs,
      copiedFiles: stats.copiedFiles,
      backedUpConflicts: stats.backedUpConflicts,
      skippedIdentical: stats.skippedIdentical,
      ...(stats.backupUsed ? { backupDir } : {}),
      requiresRestart: true,
      message: `已从 ${sourceDir} 安全导入 ${importedDirs.join("、")}（新增/更新 ${stats.copiedFiles} 个文件，备份冲突 ${stats.backedUpConflicts} 个，跳过相同 ${stats.skippedIdentical} 个）。建议重启 MedTutor 以加载全部历史会话与工作区。`,
    };
  }

  private async loadInternal() {
    fs.mkdirSync(this.dataRoot, { recursive: true });
    fs.mkdirSync(path.join(this.dataRoot, "logs"), { recursive: true });
    process.env.S07B_DATA_ROOT = this.dataRoot;
    if (!process.env.S07B_SOURCE?.trim()) {
      process.env.S07B_SOURCE = this.piRuntimeRoot;
    }

    await this.syncEnvCustomProvider();

    const methodPath = path.join(this.workbenchDir, "method-context.json");
    const method = JSON.parse(
      fs.readFileSync(methodPath, "utf8").replace(/^\uFEFF/, ""),
    ) as MethodContextFile;

    const s07b = (await dynamicImport(
      pathToFileURL(path.join(this.workbenchDir, "s07b-extension.mjs")).href,
    )) as S07bExports;

    const fallbackMod = await dynamicImport(
      pathToFileURL(
        path.join(this.piRuntimeRoot, "packages", "pi-sdk-driver", "dist", "npm-package-fallback.js"),
      ).href,
    );
    const domainBundle = await dynamicImport(
      pathToFileURL(path.join(this.workbenchDir, "domain-bundle-s06.mjs")).href,
    );

    const fixtureMod = await dynamicImport(
      pathToFileURL(path.join(this.workbenchDir, "fixture.mjs")).href,
    );
    const fixtureExtension: BuiltinExtension = {
      name: "s02-fixture",
      displayName: "Offline Mock Fixture",
      description: "Zero-cost offline mock model provider for development and tests",
      factory: fixtureMod.fixture as BuiltinExtension["factory"],
    };

    return {
      s07b,
      method,
      createRuntimeWithFallback: fallbackMod.createAgentSessionRuntimeWithNpmFallback as (
        options?: Record<string, unknown>,
      ) => Promise<any>,
      renderAudit: domainBundle.renderAudit as (state: unknown, draft?: unknown) => string,
      fixtureExtension,
    };
  }

  /** Build PiSdkDriver options that wire the 19 learning tools, method prompt, and optional test fixture. */
  async buildDriverOptions(): Promise<{
    readonly builtinExtensions: readonly BuiltinExtension[];
    readonly createAgentSessionRuntimeImpl: NonNullable<
      PiSdkDriverConfig["createAgentSessionRuntimeImpl"]
    >;
  }> {
    const { s07b, method, createRuntimeWithFallback, fixtureExtension } = await this.ensureLoaded();
    const methodPrompt = [method.warning, method.text].filter(Boolean).join("\n").trim();
    const systemPromptAppend = [methodPrompt, STUDY_SYNC_GUIDANCE].filter(Boolean).join("\n\n").trim();
    const enableFixtureExtension = process.env.MED_TUTOR_OFFLINE_MOCK === "1" || this.offlineMock;

    const builtinExtensions: BuiltinExtension[] = [
      {
        name: "s07c-continuity",
        displayName: "医学揉书学习工具集",
        description: "提供学习单、原文引用定位、待核纠正、材料管理、个人学习偏好与历史检索 19 个工具",
        factory: s07b.s07bExtension,
      },
      ...(enableFixtureExtension ? [fixtureExtension] : []),
    ];

    const createAgentSessionRuntimeImpl: NonNullable<
      PiSdkDriverConfig["createAgentSessionRuntimeImpl"]
    > = async (options) => {
      const baseAppendOverride = options?.resourceLoaderOptions?.appendSystemPromptOverride;
      const runtime = await createRuntimeWithFallback({
        ...options,
        resourceLoaderOptions: {
          ...options?.resourceLoaderOptions,
          appendSystemPromptOverride: (base: string[]) => {
            const next = baseAppendOverride ? baseAppendOverride(base) : base;
            return systemPromptAppend ? [...next, systemPromptAppend] : next;
          },
        },
      });
      const manager = runtime.session.sessionManager as SessionManager;
      this.liveManagers.set(manager.getSessionId(), manager);
      return runtime;
    };

    return {
      builtinExtensions,
      createAgentSessionRuntimeImpl,
    };
  }

  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(fn, fn);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private requireMainWindowSender(
    event: IpcMainInvokeEvent,
    deps: LearningWorkbenchServiceDeps,
  ): BrowserWindow {
    const window = deps.windows.windowForSender(event.sender);
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error("仅主窗口可使用学习工作台。");
    }
    return window;
  }

  private async requireSelectedSession(
    event: IpcMainInvokeEvent,
    deps: LearningWorkbenchServiceDeps,
  ): Promise<{ readonly window: BrowserWindow; readonly ref: SessionRef }> {
    const window = this.requireMainWindowSender(event, deps);
    const state = await deps.windows.stateForWindow(window);
    if (!state.selectedWorkspaceId || !state.selectedSessionId) {
      throw new Error("请先打开一个学习会话。");
    }
    return {
      window,
      ref: { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId },
    };
  }

  private async requireManager(
    ref: SessionRef,
    deps: LearningWorkbenchServiceDeps,
  ): Promise<SessionManager> {
    let manager = this.liveManagers.get(ref.sessionId);
    if (!manager) {
      await deps.ensureSessionReady(ref);
      manager = this.liveManagers.get(ref.sessionId);
    }
    if (!manager || manager.getSessionId() !== ref.sessionId) {
      throw new Error("当前会话尚未就绪，请重试。");
    }
    return manager;
  }

  private appendUserAnchor(manager: SessionManager, userText: string): void {
    manager.appendMessage({
      role: "user",
      content: userText,
      timestamp: Date.now(),
    });
  }

  private emptyStudyState(sessionId: string, materials: any, manager: SessionManager) {
    return {
      schema: 1,
      sessionId,
      profileId: "synthetic-profile",
      workspaceId: "s07b-fixture-workspace",
      branch: {
        leafId: manager.getLeafId() ?? "",
        ancestorCount: 0,
        lineageSha256: "",
      },
      domainRevision: 0,
      currentVersion: 0,
      currentDraft: null,
      corrections: [],
      correctionAudit: [],
      decisions: [],
      unresolved: [],
      materials: materials.list(sessionId, 0, 50).items.map((m: any) => ({
        materialId: m.materialId,
        versionId: m.versionId,
        name: m.name,
        sha256: m.sha256,
        bytes: m.bytes,
        chars: m.chars,
        ...(m.provenance ? { provenance: m.provenance } : {}),
      })),
      lastNativeUserEntry: null,
      sourceTrust:
        "user-stated-unverified; no material or user correction is treated as verified educational fact",
      diagnostics: {
        truncated: false,
        projection: "current-native-parent-chain-only",
        maxBytes: 12000,
      },
    };
  }

  private readStudyState(sessionId: string, manager: SessionManager, s07b: S07bExports) {
    if (manager.getBranch().length === 0) {
      return this.emptyStudyState(sessionId, s07b.getMaterialsForWorker(), manager);
    }
    return s07b.getDomainForWorker().state(sessionId, manager);
  }

  private syncHistoryGrants(s07b: S07bExports): boolean {
    const history = s07b.getHistoryForWorker();
    let grants: Array<Record<string, unknown>> = [];
    try {
      grants = history.grants();
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    const validGrants = grants.filter(
      (g) => typeof g.file === "string" && fs.existsSync(g.file) && fs.lstatSync(g.file).isFile(),
    );
    let updated = validGrants.length !== grants.length;

    for (const [sessionId, manager] of this.liveManagers) {
      const file = manager.getSessionFile();
      const leaf = manager.getLeafId();
      if (!file || !leaf || !fs.existsSync(file)) {
        continue;
      }
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        continue;
      }
      const realFile = fs.realpathSync.native(file);
      const alreadyCurrent = validGrants.some(
        (g) =>
          g.caller === HISTORY_CALLER &&
          g.session === sessionId &&
          g.leaf === leaf &&
          g.file === realFile &&
          g.active === true,
      );
      if (!alreadyCurrent) {
        for (let i = 0; i < validGrants.length; i += 1) {
          const g = validGrants[i]!;
          if (g.caller === HISTORY_CALLER && g.session === sessionId) {
            validGrants[i] = { ...g, active: false };
          }
        }
        validGrants.push({
          caller: HISTORY_CALLER,
          session: sessionId,
          leaf,
          file: realFile,
          active: true,
        });
        updated = true;
      }
    }

    if (validGrants.length === 0) {
      return false;
    }

    if (updated || !fs.existsSync(history.index)) {
      const dir = path.dirname(history.auth);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${history.auth}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ profile: "synthetic-profile", grants: validGrants })}\n`, {
        flag: "wx",
      });
      fs.renameSync(tmp, history.auth);
      history.rebuild(HISTORY_CALLER);
    }
    return true;
  }

  private async importMaterialFile(ref: SessionRef, filePath: string, s07b: S07bExports) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("无法读取所选文件。");
    }
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_MATERIAL_EXTENSIONS.has(ext)) {
      throw new Error("当前仅支持 .txt、.md、.pdf、.png、.jpg、.jpeg 格式的学习材料。");
    }
    const resolvedPath = path.resolve(filePath);
    const stat = fs.lstatSync(resolvedPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MATERIAL_BYTES) {
      throw new Error("请选择不超过 20 MiB 的普通文件。");
    }
    const fd = fs.openSync(resolvedPath, "r");
    let bytes: Buffer;
    try {
      const opened = fs.fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.ino !== stat.ino ||
        opened.dev !== stat.dev ||
        opened.size !== stat.size
      ) {
        throw new Error("文件在选择后发生变化，请重试。");
      }
      bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd);
      if (
        bytes.length !== stat.size ||
        after.size !== stat.size ||
        after.mtimeMs !== opened.mtimeMs
      ) {
        throw new Error("文件读取时发生变化，请重试。");
      }
    } finally {
      fs.closeSync(fd);
    }

    const materials = s07b.getMaterialsForWorker();
    const baseName = path.basename(resolvedPath);

    if (ext === ".txt" || ext === ".md") {
      const receipt = materials.stageBytes(baseName, bytes, ref.sessionId);
      const value = materials.importReceipt(ref.sessionId, receipt);
      return { cancelled: false, material: value };
    }

    if (IMAGE_MATERIAL_EXTENSIONS.has(ext)) {
      const ocrScript = path.join(this.scriptsDir, "windows-ocr.ps1");
      if (!fs.existsSync(ocrScript)) {
        throw new Error(`OCR 脚本缺失：${ocrScript}`);
      }
      const rawJson = await runLocalTool("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ocrScript,
        "-ImagePath",
        resolvedPath,
        "-Language",
        "zh-Hans-CN",
      ]);
      const parsed = JSON.parse(rawJson) as { text?: string };
      const ocrText = typeof parsed.text === "string" && parsed.text.trim()
        ? parsed.text
        : "（Windows OCR 未识别出文字，请对照原图核对）";
      const hasRecognizedText = Boolean(parsed.text && parsed.text.trim());
      const receipt = materials.stageDerived(
        `${baseName}.txt`,
        Buffer.from(ocrText, "utf8"),
        ref.sessionId,
        {
          type: "image",
          ordinal: 1,
          locator: "图片1",
          method: "Windows OCR zh-Hans-CN",
          coverage: hasRecognizedText
            ? "图片文字已提取，形近字/排版待核"
            : "图片未识别出文字，请对照原图核对",
          uncertainties: ["转写自图片，须对照原图核对"],
        },
        bytes,
        bytes,
      );
      const value = materials.importReceipt(ref.sessionId, receipt);
      return { cancelled: false, material: value };
    }

    const pdfScript = path.join(this.scriptsDir, "material_pdf.py");
    if (!fs.existsSync(pdfScript)) {
      throw new Error(`PDF 提取脚本缺失：${pdfScript}`);
    }
    const pythonExe = resolvePythonExecutable();
    const infoJson = await runLocalTool(pythonExe, [pdfScript, resolvedPath]);
    const info = JSON.parse(infoJson) as { pages?: number };
    const totalPages = Number(info.pages ?? 0);
    if (!Number.isSafeInteger(totalPages) || totalPages < 1) {
      throw new Error("PDF 文件不包含可读取的页面。");
    }
    const maxPage = Math.min(PDF_DEFAULT_MAX_PAGES, totalPages);
    const pageSections: string[] = [];
    let hasAnyText = false;
    for (let page = 1; page <= maxPage; page += 1) {
      const pageJson = await runLocalTool(pythonExe, [pdfScript, resolvedPath, String(page)]);
      const pageData = JSON.parse(pageJson) as { text?: string };
      const pageText = typeof pageData.text === "string" ? pageData.text.trim() : "";
      if (pageText) {
        hasAnyText = true;
      }
      pageSections.push(
        `[第 ${page} 页]\n${pageText || "（本页未检测到可选中文本层，可能为扫描页）"}`,
      );
    }
    const combinedText = pageSections.join("\n\n");
    const receipt = materials.stageDerived(
      `${baseName}.txt`,
      Buffer.from(combinedText, "utf8"),
      ref.sessionId,
      {
        type: "pdf",
        ordinal: 1,
        locator: `PDF第1-${maxPage}页/共${totalPages}页`,
        method: "pdfplumber 文本层提取",
        coverage: hasAnyText
          ? `已提取前 ${maxPage}/${totalPages} 页文本层`
          : `前 ${maxPage}/${totalPages} 页未检测到文本层（可能为扫描件）`,
        uncertainties: ["表格行列与插图须对照原PDF核对"],
      },
      bytes,
      Buffer.from("pdf-preview"),
    );
    const value = materials.importReceipt(ref.sessionId, receipt);
    return { cancelled: false, material: value };
  }

  /** Register all `learning:*` IPC handlers directly in the Electron main process. */
  registerIpc(deps: LearningWorkbenchServiceDeps): void {
    ipcMain.handle("learning:mode:get", async (event) => {
      this.requireMainWindowSender(event, deps);
      await this.ensureLoaded().catch(() => undefined);
      return this.getModeStatus();
    });

    ipcMain.handle("learning:mode:set", async (event, rawInput: unknown) => {
      this.requireMainWindowSender(event, deps);
      const input = assertOnlyKeys(rawInput, ["offlineMock"], "模式参数无效。");
      if (typeof input.offlineMock !== "boolean") {
        throw new Error("模式参数无效。");
      }
      this.offlineMock = input.offlineMock;
      process.env.MED_TUTOR_OFFLINE_MOCK = input.offlineMock ? "1" : "0";
      if (this.isPackaged || fs.existsSync(this.configPath)) {
        const existing = readStoredConfig(this.configPath);
        writeStoredConfig(this.configPath, { ...existing, offlineMock: input.offlineMock });
      }
      return this.getModeStatus();
    });

    ipcMain.handle("learning:config:get", async (event) => {
      this.requireMainWindowSender(event, deps);
      await this.ensureLoaded().catch(() => undefined);
      return this.getConfigStatus();
    });

    ipcMain.handle("learning:config:save", (event, rawInput: unknown) =>
      this.enqueueWrite(async () => {
        this.requireMainWindowSender(event, deps);
        await this.ensureLoaded().catch(() => undefined);
        return this.saveConfig(rawInput, deps);
      }),
    );

    ipcMain.handle("learning:data:open-dir", async (event): Promise<LearningDataDirOpenResult> => {
      this.requireMainWindowSender(event, deps);
      fs.mkdirSync(this.userDataDir, { recursive: true });
      const err = shell?.openPath ? await shell.openPath(this.userDataDir) : "";
      return {
        ok: !err,
        path: this.userDataDir,
        ...(err ? { error: err } : {}),
      };
    });

    ipcMain.handle("learning:data:import", (event) =>
      this.enqueueWrite(async () => {
        const window = this.requireMainWindowSender(event, deps);
        return this.importLegacyDataFromDialog(window, deps);
      }),
    );

    ipcMain.handle("learning:recovery:state", async (event) => {
      await this.requireSelectedSession(event, deps);
      return { pending: [], more: false };
    });

    ipcMain.handle("learning:recovery:resolve", async (event) => {
      await this.requireSelectedSession(event, deps);
      return { items: [] };
    });

    ipcMain.handle("learning:study:state", async (event) => {
      const { ref } = await this.requireSelectedSession(event, deps);
      const { s07b } = await this.ensureLoaded();
      const manager = await this.requireManager(ref, deps);
      return this.readStudyState(ref.sessionId, manager, s07b);
    });

    ipcMain.handle("learning:study:save", (event, rawInput: unknown) =>
      this.enqueueWrite(async () => {
        const candidate = validateStudySaveInput(rawInput);
        const { ref } = await this.requireSelectedSession(event, deps);
        const { s07b } = await this.ensureLoaded();
        const manager = await this.requireManager(ref, deps);
        const domain = s07b.getDomainForWorker();
        const materials = s07b.getMaterialsForWorker();
        const state = this.readStudyState(ref.sessionId, manager, s07b);

        const allMaterials = materials.list(ref.sessionId, 0, 50);
        const claimLines: string[] = [];
        const builtClaims = candidate.claims.map((claim, index) => {
          let citations: Array<{ materialId: string; versionId: string; quote: string }> = [];
          let sourceDisplay = "用户输入，尚未核实。";
          if (claim.source !== undefined && claim.source !== null) {
            const sourceSpec = assertOnlyKeys(
              claim.source,
              ["materialId", "versionId"],
              "请选择材料并填写不超过 512 字的引用原文。",
            );
            if (
              typeof claim.quote !== "string" ||
              !claim.quote.trim() ||
              Array.from(claim.quote.trim()).length > 512
            ) {
              throw new Error("请选择材料并填写不超过 512 字的引用原文。");
            }
            const source = allMaterials.items.find(
              (m: any) =>
                m.materialId === sourceSpec.materialId && m.versionId === sourceSpec.versionId,
            );
            if (!source) {
              throw new Error("材料已失效，请刷新后重新选择。");
            }
            const citation = {
              materialId: source.materialId as string,
              versionId: source.versionId as string,
              quote: claim.quote.trim(),
            };
            const located = domain.citationService.locate(ref.sessionId, citation);
            if (!located.ok) {
              throw new Error(
                located.code === "AMBIGUOUS"
                  ? "引用有多处匹配，请增加上下文后重试。"
                  : "未能在原文中定位引用，请核对后重试。",
              );
            }
            citations = [citation];
            sourceDisplay = `${source.name}；原文：${citation.quote}；${
              located.method === "layout-whitespace" ? "排版空白匹配" : "精确匹配"
            }。定位不代表事实已核实。`;
          } else if (claim.quote && claim.quote.trim()) {
            throw new Error("请先选择引用材料。");
          }

          claimLines.push(`主张 ${index + 1}（${claim.id}）：${claim.text}\n来源：${sourceDisplay}`);
          return {
            id: claim.id,
            text: claim.text,
            citations,
          };
        });

        const payload = {
          baseVersion: state.currentVersion,
          draft: {
            title: candidate.title,
            claims: builtClaims,
            uncertainties: [...candidate.uncertainties],
          },
        };
        const uncertaintySection =
          candidate.uncertainties.length > 0
            ? `\n待核存疑：\n${candidate.uncertainties.map((item) => `- ${item}`).join("\n")}`
            : "";
        const userText = `用户确认保存学习单（基于版本 ${state.currentVersion}）：\n标题：${candidate.title}\n${claimLines.join("\n")}${uncertaintySection}`;
        this.appendUserAnchor(manager, userText);

        const opId = randomUUID();
        const intentId = `i_${opId.replaceAll("-", "")}`;
        s07b.hostIntent(manager, "study_submit", payload, intentId);
        const result = await domain.execute(
          manager,
          "study_submit",
          { intentId, ...payload },
          `ui_${opId}`,
          undefined,
        );
        await deps.onSessionMutated(ref).catch(() => undefined);
        return { cancelled: false, result };
      }),
    );

    ipcMain.handle("learning:study:export", async (event, version: unknown) => {
      const { window, ref } = await this.requireSelectedSession(event, deps);
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
        throw new Error("请选择有效的版本。");
      }
      const { s07b, renderAudit } = await this.ensureLoaded();
      const manager = await this.requireManager(ref, deps);
      const domain = s07b.getDomainForWorker();
      const exportResult = domain.export(ref.sessionId, manager, version, "study");
      const rawJson = fs.readFileSync(exportResult.path);
      if (rawJson.length !== exportResult.bytes || sha256Hex(rawJson) !== exportResult.sha256) {
        throw new Error("导出校验失败。");
      }

      const exported = JSON.parse(rawJson.toString("utf8"));
      const draftEvent = exported.draft;
      const sources: Array<Record<string, unknown>> = [];
      for (const sourceRef of draftEvent.sourceRefs ?? []) {
        if (!sources.some((x) => x.id === sourceRef.materialId)) {
          sources.push(domain.citationService.source(ref.sessionId, sourceRef.materialId, sourceRef.versionId));
        }
      }
      const draft = {
        title: draftEvent.content.title,
        status: "用户确认的合成学习内容，尚未核实。",
        version: draftEvent.version,
        requestId: draftEvent.anchor.intentId,
        sourceVersions: sources.map((x) => `${x.id}@1`),
        referenceContract: "refs-v2",
        claims: draftEvent.content.claims.map((claim: any) => ({
          id: claim.id,
          section: "concept",
          origin: "user",
          text: `用户输入（待核）：${claim.text}`,
          citations: claim.citations.map((c: any) => ({
            sourceId: c.materialId,
            revision: 1,
            quote: c.quote,
            start: c.utf16?.start,
            end: c.utf16?.end,
            resolution: {
              originalQuote: c.originalQuote,
              method: c.matchMethod,
            },
          })),
        })),
        conflicts: [],
        uncertainties: draftEvent.content.uncertainties ?? [],
        next: [],
      };
      const markdownText = renderAudit(
        {
          sources,
          drafts: [draft],
          decisions: exported.decisions ?? [],
          errata: [],
          failures: [],
        },
        draft,
      );
      const rendered = Buffer.from(markdownText, "utf8");
      if (rendered.length > EXPORT_MAX_BYTES * 8) {
        throw new Error("导出内容超出上限。");
      }

      const defaultExportDir = path.join(this.dataRoot, "exports");
      fs.mkdirSync(defaultExportDir, { recursive: true });
      const chosen = await dialog.showSaveDialog(window, {
        title: "保存学习单",
        defaultPath: path.join(defaultExportDir, `学习单-版本${version}.md`),
        filters: [{ name: "学习单 (Markdown)", extensions: ["md"] }],
      });
      if (chosen.canceled || !chosen.filePath) {
        return { cancelled: true };
      }
      const dest =
        path.extname(chosen.filePath).toLowerCase() === ".md"
          ? path.resolve(chosen.filePath)
          : `${path.resolve(chosen.filePath)}.md`;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, rendered);
      return { cancelled: false, version: exportResult.version, path: dest };
    });

    ipcMain.handle("learning:materials:list", async (event) => {
      const { ref } = await this.requireSelectedSession(event, deps);
      const { s07b } = await this.ensureLoaded();
      return s07b.getMaterialsForWorker().list(ref.sessionId, 0, 50);
    });

    ipcMain.handle("learning:materials:read", async (event, rawItem: unknown) => {
      const { ref } = await this.requireSelectedSession(event, deps);
      const item = assertOnlyKeys(rawItem, ["materialId", "versionId", "start"], "材料选择无效。");
      const { s07b } = await this.ensureLoaded();
      return s07b
        .getMaterialsForWorker()
        .read(ref.sessionId, item.materialId, item.versionId, item.start ?? 0, 2048);
    });

    ipcMain.handle("learning:materials:choose", async (event) => {
      const { window, ref } = await this.requireSelectedSession(event, deps);
      const textbookRoot = this.resolveEffectiveConfig().textbookRoot;
      const selected = await dialog.showOpenDialog(window, {
        title: "选择学习材料（MD/TXT/PDF/图片，最大 20 MiB）",
        ...(textbookRoot && fs.existsSync(textbookRoot) ? { defaultPath: textbookRoot } : {}),
        properties: ["openFile"],
        filters: [
          {
            name: "学习材料 (MD/TXT/PDF/图片)",
            extensions: ["md", "txt", "pdf", "png", "jpg", "jpeg"],
          },
        ],
      });
      if (selected.canceled || selected.filePaths.length !== 1) {
        return { cancelled: true };
      }
      const { s07b } = await this.ensureLoaded();
      return this.importMaterialFile(ref, selected.filePaths[0]!, s07b);
    });

    ipcMain.handle("learning:materials:drop", async (event, rawFile: unknown) => {
      const { ref } = await this.requireSelectedSession(event, deps);
      if (typeof rawFile !== "string") {
        throw new Error("无法读取所选文件。");
      }
      const { s07b } = await this.ensureLoaded();
      return this.importMaterialFile(ref, rawFile, s07b);
    });

    ipcMain.handle("learning:citation:locate", async (event, rawSelection: unknown) => {
      const { ref } = await this.requireSelectedSession(event, deps);
      const selection = assertOnlyKeys(
        rawSelection,
        ["materialId", "versionId", "quote"],
        "来源无效。",
      );
      if (
        typeof selection.quote !== "string" ||
        !selection.quote.trim() ||
        Array.from(selection.quote).length > 512
      ) {
        throw new Error("引用原文无效或过长（最多 512 字）。");
      }
      const { s07b } = await this.ensureLoaded();
      return s07b.getDomainForWorker().citationService.locate(ref.sessionId, selection);
    });

    ipcMain.handle("learning:correction:create", (event, rawInput: unknown) =>
      this.enqueueWrite(async () => {
        const record = assertOnlyKeys(rawInput, ["title", "text"], "纠正输入无效。");
        if (typeof record.text !== "string") {
          throw new Error("请填写纠正内容。");
        }
        const text = record.text.trim();
        if (!text || Array.from(text).length > 1000) {
          throw new Error("纠正内容为空或超过 1000 字。");
        }
        const { ref } = await this.requireSelectedSession(event, deps);
        const { s07b } = await this.ensureLoaded();
        const manager = await this.requireManager(ref, deps);
        const domain = s07b.getDomainForWorker();
        const state = this.readStudyState(ref.sessionId, manager, s07b);
        const draft = state.currentDraft;
        const claim = draft?.claims?.[0];
        if (!draft || !claim) {
          throw new Error("请先保存学习单。");
        }
        const payload = {
          target: {
            kind: "draft_claim",
            draftId: draft.draftId,
            version: draft.version,
            claimId: claim.id,
          },
          originalClaim: claim.text,
          correction: text,
          verificationStatus: "pending",
          unresolvedItems: [text],
        };
        const userText = `用户确认对学习单版本 ${draft.version} 登记待核纠正：\n原说法：${claim.text}\n用户说明：${text}\n状态：用户陈述，尚未核实。`;
        this.appendUserAnchor(manager, userText);

        const opId = randomUUID();
        const intentId = `i_${opId.replaceAll("-", "")}`;
        s07b.hostIntent(manager, "correction_create", payload, intentId);
        const result = await domain.execute(
          manager,
          "correction_create",
          { intentId, ...payload },
          `ui_${opId}`,
          undefined,
        );
        await deps.onSessionMutated(ref).catch(() => undefined);
        return { cancelled: false, result };
      }),
    );

    ipcMain.handle("learning:correction:supersede", (event, rawInput: unknown) =>
      this.enqueueWrite(async () => {
        const record = assertOnlyKeys(rawInput, ["id", "version", "text"], "纠正选择无效。");
        if (
          typeof record.id !== "string" ||
          typeof record.version !== "number" ||
          !Number.isSafeInteger(record.version)
        ) {
          throw new Error("纠正选择无效。");
        }
        if (
          typeof record.text !== "string" ||
          !record.text.trim() ||
          Array.from(record.text.trim()).length > 1000
        ) {
          throw new Error("请填写不超过 1000 字的说明。");
        }
        const text = record.text.trim();
        const { ref } = await this.requireSelectedSession(event, deps);
        const { s07b } = await this.ensureLoaded();
        const manager = await this.requireManager(ref, deps);
        const domain = s07b.getDomainForWorker();
        const state = this.readStudyState(ref.sessionId, manager, s07b);
        const target = state.corrections.find(
          (x: any) => x.correctionId === record.id && x.revision === record.version,
        );
        if (!target) {
          throw new Error("纠正已变化，请刷新后重新选择。");
        }
        const payload = {
          correctionId: target.correctionId,
          expectedRevision: target.revision,
          target: target.target,
          originalClaim: target.originalClaim,
          correction: text,
          verificationStatus: "pending",
          unresolvedItems: [text],
        };
        const userText = `用户确认修改待核纠正：\n原说法：${target.originalClaim}\n原说明：${target.correction}\n新说明：${text}\n状态：用户陈述，尚未核实。`;
        this.appendUserAnchor(manager, userText);

        const opId = randomUUID();
        const intentId = `i_${opId.replaceAll("-", "")}`;
        s07b.hostIntent(manager, "correction_supersede", payload, intentId);
        const result = await domain.execute(
          manager,
          "correction_supersede",
          { intentId, ...payload },
          `ui_${opId}`,
          undefined,
        );
        await deps.onSessionMutated(ref).catch(() => undefined);
        return { cancelled: false, result };
      }),
    );

    ipcMain.handle("learning:correction:retract", (event, rawInput: unknown) =>
      this.enqueueWrite(async () => {
        const record = assertOnlyKeys(rawInput, ["id", "version", "text"], "纠正选择无效。");
        if (
          typeof record.id !== "string" ||
          typeof record.version !== "number" ||
          !Number.isSafeInteger(record.version)
        ) {
          throw new Error("纠正选择无效。");
        }
        const { ref } = await this.requireSelectedSession(event, deps);
        const { s07b } = await this.ensureLoaded();
        const manager = await this.requireManager(ref, deps);
        const domain = s07b.getDomainForWorker();
        const state = this.readStudyState(ref.sessionId, manager, s07b);
        const target = state.corrections.find(
          (x: any) => x.correctionId === record.id && x.revision === record.version,
        );
        if (!target) {
          throw new Error("纠正已变化，请刷新后重新选择。");
        }
        const payload = {
          correctionId: target.correctionId,
          expectedRevision: target.revision,
        };
        const userText = `用户确认撤回待核纠正：\n原说法：${target.originalClaim}\n用户说明：${target.correction}`;
        this.appendUserAnchor(manager, userText);

        const opId = randomUUID();
        const intentId = `i_${opId.replaceAll("-", "")}`;
        s07b.hostIntent(manager, "correction_retract", payload, intentId);
        const result = await domain.execute(
          manager,
          "correction_retract",
          { intentId, ...payload },
          `ui_${opId}`,
          undefined,
        );
        await deps.onSessionMutated(ref).catch(() => undefined);
        return { cancelled: false, result };
      }),
    );

    ipcMain.handle("learning:profile:list", async (event) => {
      await this.requireSelectedSession(event, deps);
      const { s07b } = await this.ensureLoaded();
      return s07b.getProfileForWorker().list();
    });

    ipcMain.handle("learning:profile:create", (event, rawInput: unknown) =>
      this.enqueueWrite(async () => {
        const record = assertOnlyKeys(rawInput, ["value", "id", "version"], "画像输入无效。");
        if (
          typeof record.value !== "string" ||
          !record.value.trim() ||
          Array.from(record.value.trim()).length > 200 ||
          record.value.includes("§")
        ) {
          throw new Error("画像内容为空或过长。");
        }
        const value = record.value.trim();
        const { ref } = await this.requireSelectedSession(event, deps);
        const { s07b } = await this.ensureLoaded();
        const manager = await this.requireManager(ref, deps);
        const payload = { value, source: "用户明确输入", sourceType: "explicit-user" };
        const userText = `用户确认新增学习偏好：\n内容：${value}\n来源：用户明确输入。`;
        this.appendUserAnchor(manager, userText);

        const opId = randomUUID();
        const intentId = `i_${opId.replaceAll("-", "")}`;
        s07b.hostIntent(manager, "create", payload, intentId, { profile: true });
        const result = await s07b.commitProfileFromTrustedUi(
          manager,
          "create",
          { intentId, ...payload },
          () => undefined,
        );
        await deps.onSessionMutated(ref).catch(() => undefined);
        return { cancelled: false, result };
      }),
    );

    ipcMain.handle("learning:profile:update", (event, rawInput: unknown) =>
      this.enqueueWrite(async () => {
        const record = assertOnlyKeys(rawInput, ["value", "id", "version"], "画像输入无效。");
        if (
          typeof record.id !== "string" ||
          typeof record.version !== "number" ||
          !Number.isSafeInteger(record.version)
        ) {
          throw new Error("画像选择无效。");
        }
        if (
          typeof record.value !== "string" ||
          !record.value.trim() ||
          Array.from(record.value.trim()).length > 200 ||
          record.value.includes("§")
        ) {
          throw new Error("画像内容为空或过长。");
        }
        const value = record.value.trim();
        const { ref } = await this.requireSelectedSession(event, deps);
        const { s07b } = await this.ensureLoaded();
        const manager = await this.requireManager(ref, deps);
        const entries = (await s07b.getProfileForWorker().list()) as Array<Record<string, any>>;
        const target = entries.find((x) => x.id === record.id && x.version === record.version);
        if (!target) {
          throw new Error("画像内容已变化，请刷新后重新选择。");
        }
        const payload = {
          id: target.id,
          version: target.version,
          value,
          source: "用户明确输入",
          sourceType: "explicit-user",
        };
        const userText = `用户确认修改学习偏好：\n原内容：${target.value}\n新内容：${value}\n来源：用户明确输入。`;
        this.appendUserAnchor(manager, userText);

        const opId = randomUUID();
        const intentId = `i_${opId.replaceAll("-", "")}`;
        s07b.hostIntent(manager, "update", payload, intentId, { profile: true });
        const result = await s07b.commitProfileFromTrustedUi(
          manager,
          "update",
          { intentId, ...payload },
          () => undefined,
        );
        await deps.onSessionMutated(ref).catch(() => undefined);
        return { cancelled: false, result };
      }),
    );

    ipcMain.handle("learning:profile:delete", (event, rawInput: unknown) =>
      this.enqueueWrite(async () => {
        const record = assertOnlyKeys(rawInput, ["value", "id", "version"], "画像输入无效。");
        if (
          typeof record.id !== "string" ||
          typeof record.version !== "number" ||
          !Number.isSafeInteger(record.version)
        ) {
          throw new Error("画像选择无效。");
        }
        const { ref } = await this.requireSelectedSession(event, deps);
        const { s07b } = await this.ensureLoaded();
        const manager = await this.requireManager(ref, deps);
        const entries = (await s07b.getProfileForWorker().list()) as Array<Record<string, any>>;
        const target = entries.find((x) => x.id === record.id && x.version === record.version);
        if (!target) {
          throw new Error("画像内容已变化，请刷新后重新选择。");
        }
        const payload = { id: target.id, version: target.version };
        const userText = `用户确认删除学习偏好：\n原内容：${target.value}\n来源：用户明确输入。`;
        this.appendUserAnchor(manager, userText);

        const opId = randomUUID();
        const intentId = `i_${opId.replaceAll("-", "")}`;
        s07b.hostIntent(manager, "delete", payload, intentId, { profile: true });
        const result = await s07b.commitProfileFromTrustedUi(
          manager,
          "delete",
          { intentId, ...payload },
          () => undefined,
        );
        await deps.onSessionMutated(ref).catch(() => undefined);
        return { cancelled: false, result };
      }),
    );

    ipcMain.handle("learning:history:search", async (event, rawQuery: unknown) => {
      const { ref } = await this.requireSelectedSession(event, deps);
      if (
        typeof rawQuery !== "string" ||
        !rawQuery.trim() ||
        Array.from(rawQuery).length > 40
      ) {
        throw new Error("请输入不超过 40 字的关键词。");
      }
      const { s07b } = await this.ensureLoaded();
      await this.requireManager(ref, deps);
      const hasHistory = this.syncHistoryGrants(s07b);
      if (!hasHistory) {
        return { matches: [], method: "substring", semantics: "not-inferred" };
      }
      return s07b.getHistoryForWorker().search(HISTORY_CALLER, rawQuery.trim(), false);
    });

    ipcMain.handle("learning:history:read", async (event, rawAnchor: unknown) => {
      const { ref } = await this.requireSelectedSession(event, deps);
      if (!rawAnchor || typeof rawAnchor !== "object" || Array.isArray(rawAnchor)) {
        throw new Error("历史记录无效。");
      }
      const { s07b } = await this.ensureLoaded();
      await this.requireManager(ref, deps);
      this.syncHistoryGrants(s07b);
      return s07b.getHistoryForWorker().read(HISTORY_CALLER, rawAnchor, 0, 500);
    });
  }
}
