import { resolveRuntimeCommands } from "../../../contracts/composer-commands";
import type {
  RuntimeCommandRecord,
  RuntimeProviderRecord,
  RuntimeSettingsSnapshot,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import type { ExtensionCommandCompatibilityRecord } from "../../../contracts/desktop-state";
import { activeTranslator, type Translate } from "../../i18n";
import { titleCase } from "../../lib/string-utils";

export type ComposerSlashCommandKind =
  | "runtime"
  | "model"
  | "thinking"
  | "tree"
  | "status"
  | "session"
  | "reload"
  | "compact"
  | "name"
  | "login"
  | "logout"
  | "settings"
  | "scoped-models";

export interface ComposerSlashCommand {
  readonly id: string;
  readonly kind: ComposerSlashCommandKind;
  readonly command: string;
  readonly template: string;
  readonly title: string;
  readonly description: string;
  readonly submitMode?: "immediate" | "prefill" | "pick-option";
  readonly section: "runtime" | "host";
  readonly runtimeCommand?: RuntimeCommandRecord;
  readonly sourceLabel?: string;
  readonly compatibility?: ExtensionCommandCompatibilityRecord;
}

export interface ComposerSlashCommandSection {
  readonly id: "runtime" | "host";
  readonly title?: string;
  readonly items: readonly ComposerSlashCommand[];
}

export interface ComposerSlashOption {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

export interface ComposerSlashOptionEmptyState {
  readonly title: string;
  readonly description: string;
}

export interface ComposerModelOption extends ComposerSlashOption {
  readonly providerId: string;
  readonly modelId: string;
}

export interface ComposerProviderOption extends ComposerSlashOption {
  readonly providerId: string;
}

export const MODEL_OPTIONS_EMPTY_TITLE = "No models available";
export const MODEL_OPTIONS_EMPTY_DESCRIPTION =
  "Open Settings to enable a model or log in to a provider.";

function buildHostActionSlashCommands(t: Translate): readonly ComposerSlashCommand[] {
  return [
    {
      id: "host:model",
      kind: "model",
      command: "/model",
      template: "/model",
      title: t("slash.cmd.model.title"),
      description: t("slash.cmd.model.desc"),
      submitMode: "pick-option",
      section: "host",
    },
    {
      id: "host:thinking",
      kind: "thinking",
      command: "/thinking",
      template: "/thinking",
      title: t("slash.cmd.thinking.title"),
      description: t("slash.cmd.thinking.desc"),
      submitMode: "pick-option",
      section: "host",
    },
    {
      id: "host:tree",
      kind: "tree",
      command: "/tree",
      template: "/tree",
      title: t("slash.cmd.tree.title"),
      description: t("slash.cmd.tree.desc"),
      submitMode: "immediate",
      section: "host",
    },
    {
      id: "host:status",
      kind: "status",
      command: "/status",
      template: "/status",
      title: t("slash.cmd.status.title"),
      description: t("slash.cmd.status.desc"),
      submitMode: "immediate",
      section: "host",
    },
    {
      id: "host:login",
      kind: "login",
      command: "/login",
      template: "/login",
      title: t("slash.cmd.login.title"),
      description: t("slash.cmd.login.desc"),
      submitMode: "pick-option",
      section: "host",
    },
    {
      id: "host:logout",
      kind: "logout",
      command: "/logout",
      template: "/logout",
      title: t("slash.cmd.logout.title"),
      description: t("slash.cmd.logout.desc"),
      submitMode: "pick-option",
      section: "host",
    },
    {
      id: "host:settings",
      kind: "settings",
      command: "/settings",
      template: "/settings",
      title: t("slash.cmd.settings.title"),
      description: t("slash.cmd.settings.desc"),
      submitMode: "immediate",
      section: "host",
    },
    {
      id: "host:scoped-models",
      kind: "scoped-models",
      command: "/scoped-models",
      template: "/scoped-models",
      title: t("slash.cmd.scopedModels.title"),
      description: t("slash.cmd.scopedModels.desc"),
      submitMode: "immediate",
      section: "host",
    },
    {
      id: "host:session",
      kind: "session",
      command: "/session",
      template: "/session",
      title: t("slash.cmd.session.title"),
      description: t("slash.cmd.session.desc"),
      submitMode: "immediate",
      section: "host",
    },
    {
      id: "host:name",
      kind: "name",
      command: "/name",
      template: t("slash.cmd.name.template"),
      title: t("slash.cmd.name.title"),
      description: t("slash.cmd.name.desc"),
      submitMode: "prefill",
      section: "host",
    },
    {
      id: "host:compact",
      kind: "compact",
      command: "/compact",
      template: "/compact",
      title: t("slash.cmd.compact.title"),
      description: t("slash.cmd.compact.desc"),
      submitMode: "immediate",
      section: "host",
    },
    {
      id: "host:reload",
      kind: "reload",
      command: "/reload",
      template: "/reload",
      title: t("slash.cmd.reload.title"),
      description: t("slash.cmd.reload.desc"),
      submitMode: "immediate",
      section: "host",
    },
  ];
}

export function getThinkingOptions(t: Translate = activeTranslator()): readonly ComposerSlashOption[] {
  return [
    {
      value: "low",
      label: t("settings.thinking.low"),
      description: t("slash.thinking.low.desc"),
    },
    {
      value: "medium",
      label: t("settings.thinking.medium"),
      description: t("slash.thinking.medium.desc"),
    },
    {
      value: "high",
      label: t("settings.thinking.high"),
      description: t("slash.thinking.high.desc"),
    },
    {
      value: "xhigh",
      label: t("settings.thinking.xhigh"),
      description: t("slash.thinking.xhigh.desc"),
    },
    {
      value: "max",
      label: t("settings.thinking.max"),
      description: t("slash.thinking.max.desc"),
    },
  ];
}

export const THINKING_OPTIONS: readonly ComposerSlashOption[] = getThinkingOptions();

export function buildSlashCommandSections(
  query: string,
  runtime: RuntimeSnapshot | undefined,
  sessionCommands: readonly RuntimeCommandRecord[],
  compatibilityRecords: readonly ExtensionCommandCompatibilityRecord[] = [],
  options: {
    readonly allowTreeCommand?: boolean;
    readonly t?: Translate;
  } = {},
): readonly ComposerSlashCommandSection[] {
  const t = options.t ?? activeTranslator();
  const normalizedQuery = query.trim().toLowerCase();
  const availableRuntimeCommands = resolveRuntimeCommands(runtime, sessionCommands);
  const compatibilityByKey = new Map(
    compatibilityRecords.map(
      (record) => [`${record.extensionPath}::${record.commandName}`, record] as const,
    ),
  );
  const runtimeMatches = availableRuntimeCommands
    .map<ComposerSlashCommand>((command) => ({
      id: `runtime:${command.source}:${command.name}`,
      kind: "runtime",
      command: `/${command.name}`,
      template: `/${command.name} `,
      title: formatRuntimeCommandTitle(command),
      description: formatRuntimeCommandDescription(command, t),
      submitMode: "prefill",
      section: "runtime",
      runtimeCommand: command,
      sourceLabel: formatRuntimeSourceLabel(command, t),
      compatibility: compatibilityByKey.get(`${command.sourceInfo.path}::${command.name}`),
    }))
    .filter((command) => matchesCommand(command, normalizedQuery));
  const allowTreeCommand = options.allowTreeCommand ?? true;
  const hostMatches = buildHostActionSlashCommands(t).filter(
    (command) =>
      (allowTreeCommand || command.kind !== "tree") && matchesCommand(command, normalizedQuery),
  );

  // Prefer a host action when it is a prefix match and runtime skills only
  // match fuzzily. Otherwise an installed skill such as `observe-state` can
  // steal `/stat` from the built-in `/status` command on Tab.
  const hostHasPrefixMatch = hostMatches.some((command) =>
    command.command.toLowerCase().startsWith(normalizedQuery),
  );
  const runtimeHasPrefixMatch = runtimeMatches.some((command) =>
    command.command.toLowerCase().startsWith(normalizedQuery),
  );
  const runtimeSection: ComposerSlashCommandSection = {
    id: "runtime",
    title: runtimeMatches.length > 0 ? t("slash.section.runtime") : undefined,
    items: runtimeMatches,
  };
  const hostSection: ComposerSlashCommandSection = {
    id: "host",
    title: hostMatches.length > 0 ? t("slash.section.host") : undefined,
    items: hostMatches,
  };
  const sections: ComposerSlashCommandSection[] =
    hostHasPrefixMatch && !runtimeHasPrefixMatch
      ? [hostSection, runtimeSection]
      : [runtimeSection, hostSection];

  return sections.filter((section) => section.items.length > 0);
}

export function flattenSlashSections(
  sections: readonly ComposerSlashCommandSection[],
): readonly ComposerSlashCommand[] {
  return sections.flatMap((section) => section.items);
}

export function buildProviderOptions(
  providers: readonly RuntimeProviderRecord[],
  filter: (provider: RuntimeProviderRecord) => boolean = () => true,
  t: Translate = activeTranslator(),
): readonly ComposerProviderOption[] {
  return providers
    .filter(filter)
    .sort(compareProviders)
    .map((provider) => ({
      value: provider.id,
      label: provider.name,
      description: describeProvider(provider, t),
      providerId: provider.id,
    }));
}

export function buildModelOptions(
  runtime: RuntimeSnapshot | undefined,
): readonly ComposerModelOption[] {
  if (!runtime) {
    return [];
  }

  return runtime.models
    .filter((model) => model.available && model.scope !== "off")
    .sort((left: RuntimeSnapshot["models"][number], right: RuntimeSnapshot["models"][number]) => {
      const providerCompare =
        providerRankForId(runtime.providers, left.providerId) -
        providerRankForId(runtime.providers, right.providerId);
      if (providerCompare !== 0) {
        return providerCompare;
      }
      return `${left.providerName} ${left.label}`.localeCompare(
        `${right.providerName} ${right.label}`,
      );
    })
    .map((model: RuntimeSnapshot["models"][number]) => ({
      value: model.modelId,
      label: `${model.providerName} · ${model.label}`,
      description: model.modelId,
      providerId: model.providerId,
      modelId: model.modelId,
    }));
}

export function slashOptionsForCommand(
  command: ComposerSlashCommand | undefined,
  runtime?: RuntimeSnapshot,
  t: Translate = activeTranslator(),
): readonly ComposerSlashOption[] {
  if (!command) {
    return [];
  }

  if (command.kind === "thinking") {
    return getThinkingOptions(t);
  }
  if (command.kind === "model") {
    return buildModelOptions(runtime);
  }
  if (command.kind === "login") {
    return buildProviderOptions(
      runtime?.providers ?? [],
      (provider) => provider.oauthSupported,
      t,
    );
  }
  if (command.kind === "logout") {
    return buildProviderOptions(
      runtime?.providers ?? [],
      (provider) => provider.authSource === "oauth" || provider.authSource === "auth_file",
      t,
    );
  }

  return [];
}

export function slashOptionEmptyState(
  command: ComposerSlashCommand | undefined,
  runtime?: RuntimeSnapshot,
  t: Translate = activeTranslator(),
): ComposerSlashOptionEmptyState | undefined {
  if (!command) {
    return undefined;
  }

  if (command.kind === "model" && buildModelOptions(runtime).length === 0) {
    return {
      title: t("onboarding.noModelsAvailable"),
      description: t("onboarding.enableInModels"),
    };
  }

  return undefined;
}

function matchesCommand(command: ComposerSlashCommand, normalizedQuery: string): boolean {
  if (!normalizedQuery.startsWith("/")) {
    return false;
  }

  if (normalizedQuery === "/") {
    return true;
  }

  const queryWithoutSlash = normalizedQuery.replace(/^\/+/, "").trim();
  const rawSearchTerms = [command.command.toLowerCase()];
  const aliasSearchTerms = buildSlashSearchAliases(command);
  if (rawSearchTerms.some((value) => value.includes(normalizedQuery))) {
    return true;
  }

  if (!queryWithoutSlash) {
    return false;
  }

  return aliasSearchTerms.some((value) => value.includes(queryWithoutSlash));
}

function buildSlashSearchAliases(command: ComposerSlashCommand): readonly string[] {
  const aliases = new Set<string>([
    command.command.replace(/^\/+/, "").toLowerCase(),
    command.title.toLowerCase(),
    command.sourceLabel?.toLowerCase() ?? "",
    command.compatibility?.status === "terminal-only" ? "terminal-only" : "",
  ]);

  if (command.runtimeCommand) {
    aliases.add(command.runtimeCommand.name.toLowerCase());
    aliases.add(command.runtimeCommand.name.replace(/^skill:/, "").toLowerCase());
  }

  return [...aliases].filter(Boolean);
}

function describeProvider(provider: RuntimeProviderRecord, t: Translate): string {
  if (provider.authSource === "oauth") {
    return t("slash.provider.oauthConnected");
  }
  if (provider.authSource === "auth_file") {
    return t("slash.provider.savedApiKey");
  }
  if (provider.authSource === "env") {
    return t("slash.provider.env");
  }
  if (provider.authSource === "external") {
    return t("slash.provider.external");
  }
  if (provider.oauthSupported) {
    return t("slash.provider.oauthAvailable");
  }
  if (provider.apiKeySetupSupported) {
    return t("slash.provider.needsApiKey");
  }
  return t("slash.provider.available");
}

function compareProviders(left: RuntimeProviderRecord, right: RuntimeProviderRecord): number {
  const leftRank = providerRank(left);
  const rightRank = providerRank(right);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.name.localeCompare(right.name);
}

function providerRank(provider: RuntimeProviderRecord): number {
  if (provider.hasAuth) {
    return 0;
  }
  if (provider.id === "openai" || provider.id === "openai-codex" || provider.id === "anthropic") {
    return 1;
  }
  if (provider.oauthSupported) {
    return 2;
  }
  return 3;
}

function providerRankForId(
  providers: readonly RuntimeProviderRecord[],
  providerId: string,
): number {
  const provider = providers.find((entry) => entry.id === providerId);
  return provider ? providerRank(provider) : 99;
}

function summarizeSkillDescription(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return "Reusable workflow";
  }

  const firstSentence = trimmed.match(/^[^.!?]+[.!?]?/)?.[0]?.trim() ?? trimmed;
  return firstSentence.length > 96 ? `${firstSentence.slice(0, 93).trimEnd()}...` : firstSentence;
}

function formatRuntimeCommandTitle(command: RuntimeCommandRecord): string {
  if (command.source === "skill" && command.name.startsWith("skill:")) {
    return titleCase(command.name.slice("skill:".length));
  }
  return titleCase(command.name.replace(/[:_-]+/g, " "));
}

function formatRuntimeCommandDescription(command: RuntimeCommandRecord, t: Translate): string {
  if (command.description?.trim()) {
    return command.description.trim();
  }
  if (command.source === "prompt") {
    return t("slash.runtime.promptDesc");
  }
  if (command.source === "skill") {
    return t("slash.runtime.skillDesc");
  }
  return t("slash.runtime.extensionDesc");
}

function formatRuntimeSourceLabel(command: RuntimeCommandRecord, t: Translate): string {
  if (command.source === "skill") {
    return t("slash.runtime.skillLabel");
  }
  if (command.source === "prompt") {
    return t("slash.runtime.promptLabel");
  }
  return command.sourceInfo.source.replace(/^extension:/, "");
}

export function isExactSlashCommand(query: string, command: ComposerSlashCommand): boolean {
  return query.trim().toLowerCase() === command.command.toLowerCase();
}

export function parseTreeComposerCommand(
  value: string,
  t: Translate = activeTranslator(),
): { readonly type: "tree" } | { readonly type: "error"; readonly message: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const [command, ...rest] = trimmed.split(/\s+/);
  if (command !== "/tree") {
    return undefined;
  }

  if (rest.length > 0) {
    return {
      type: "error",
      message: t("slash.treeNoArgs"),
    };
  }

  return { type: "tree" };
}
