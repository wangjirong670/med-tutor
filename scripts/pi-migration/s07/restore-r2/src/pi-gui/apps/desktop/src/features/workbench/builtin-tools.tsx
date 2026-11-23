import type { ComponentType, ReactNode } from "react";
import { BUILTIN_TOOL_KINDS, type BuiltinToolKind } from "../../../contracts/workbench";
import { activeTranslator, type MessageKey, type Translate } from "../../i18n";
import { DiffIcon, FileIcon, TerminalIcon } from "../../ui/icons";

interface BuiltinToolDefinition {
  readonly label: string;
  readonly titleKey: MessageKey;
  /** Shown in the tool chooser. */
  readonly description: string;
  readonly descriptionKey: MessageKey;
  readonly Icon: ComponentType;
  /** Key that toggles the tool with the platform modifier, when it has one. */
  readonly shortcutKey?: string;
}

/** Presentation for every built-in tool; a missing kind fails the build. */
export const BUILTIN_TOOLS = {
  files: {
    label: "Files",
    titleKey: "workbench.tool.files",
    description: "Browse files in this checkout",
    descriptionKey: "workbench.tool.filesDesc",
    Icon: FileIcon,
  },
  changes: {
    label: "Review",
    titleKey: "workbench.tool.review",
    description: "Review uncommitted, branch or turn changes",
    descriptionKey: "workbench.tool.reviewDesc",
    Icon: DiffIcon,
    shortcutKey: "R",
  },
  terminal: {
    label: "Terminal",
    titleKey: "workbench.tool.terminal",
    description: "Run commands in this task's checkout",
    descriptionKey: "workbench.tool.terminalDesc",
    Icon: TerminalIcon,
    shortcutKey: "J",
  },
} as const satisfies Record<BuiltinToolKind, BuiltinToolDefinition>;

export function builtinToolLabel(
  kind: BuiltinToolKind,
  t: Translate = activeTranslator(),
): string {
  return t(BUILTIN_TOOLS[kind].titleKey);
}

export function builtinToolDescription(
  kind: BuiltinToolKind,
  t: Translate = activeTranslator(),
): string {
  return t(BUILTIN_TOOLS[kind].descriptionKey);
}

/** Chooser order follows the contract's kind list. */
export const BUILTIN_TOOL_ENTRIES = BUILTIN_TOOL_KINDS.map(
  (kind): BuiltinToolDefinition & { readonly kind: BuiltinToolKind } => ({
    kind,
    ...BUILTIN_TOOLS[kind],
  }),
);

/** The composition root supplies one panel per built-in tool; rendered only while selected. */
type BuiltinToolPanels = Record<BuiltinToolKind, () => ReactNode>;

/** Requires a panel for every built-in kind, so a new tool cannot silently render nothing. */
export function renderBuiltinToolPanel(
  kind: BuiltinToolKind,
  panels: BuiltinToolPanels,
): ReactNode {
  return panels[kind]();
}
