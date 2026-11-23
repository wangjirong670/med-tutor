import type {
  RuntimeExtensionRecord,
  RuntimeSourceScope,
} from "@pi-gui/session-driver/runtime-types";
import { activeTranslator, type Translate } from "../../i18n";

export function extensionSourceSummary(
  extension: RuntimeExtensionRecord,
  t: Translate = activeTranslator(),
): string {
  return `${extensionScopeLabel(extension, t)} · ${extension.sourceInfo.origin}`;
}

export const PI_GUI_TOOLS_LABEL = "pi-gui tools";
export const PI_ADDONS_LABEL = "Built into pi";

/** Extensions pi-gui itself adds to every session; switched on and off app-wide. */
export function isPiGuiBuiltinExtension(extension: RuntimeExtensionRecord): boolean {
  return (
    extension.sourceInfo.source === "builtin" &&
    extension.sourceInfo.origin === "top-level" &&
    extension.sourceInfo.scope === "temporary"
  );
}

/**
 * pi's own add-ons (MCP, code mode, tool search), named `builtin:<name>`. Their switch writes
 * pi's `extensions` setting, so terminal pi follows it too.
 */
export function isPiAddonExtension(extension: RuntimeExtensionRecord): boolean {
  return extension.sourceInfo.source === "builtin" && extension.path.startsWith("builtin:");
}

export function extensionScopeLabel(
  extension: RuntimeExtensionRecord,
  t: Translate = activeTranslator(),
): string {
  if (isPiGuiBuiltinExtension(extension)) return t("customize.scope.builtinTools");
  if (isPiAddonExtension(extension)) return t("customize.scope.builtinAddons");
  return sourceScopeGroupLabel(extension.sourceInfo.scope, t);
}

/** Group heading for where a skill or extension was discovered. */
export function sourceScopeGroupLabel(
  scope: RuntimeSourceScope,
  t: Translate = activeTranslator(),
): string {
  switch (scope) {
    case "project":
      return t("customize.scope.workspace");
    case "user":
      return t("customize.scope.user");
    case "temporary":
      return t("customize.scope.session");
  }
}

export function extensionGroupLabel(
  extension: RuntimeExtensionRecord,
  t: Translate = activeTranslator(),
): string {
  if (isPiGuiBuiltinExtension(extension)) return t("customize.scope.builtinTools");
  if (isPiAddonExtension(extension)) return t("customize.scope.builtinAddons");
  return sourceScopeGroupLabel(extension.sourceInfo.scope, t);
}
