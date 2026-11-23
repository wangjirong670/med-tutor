import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import { activeTranslator, type Translate } from "../../i18n";
import { buildModelOptions } from "../conversation/composer-commands";

export type ModelOnboardingSettingsSection = "models" | "providers";

export interface ModelOnboardingNotice {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly actionSection: ModelOnboardingSettingsSection;
}

export interface ModelOnboardingState {
  readonly hasSelectableModels: boolean;
  readonly requiresModelSelection: boolean;
  readonly unselectedModelLabel: string;
  readonly emptyModelTitle: string;
  readonly emptyModelDescription: string;
  readonly notice?: ModelOnboardingNotice;
}

interface ModelSelectionInput {
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
}

export function deriveModelOnboardingState(
  runtime: RuntimeSnapshot | undefined,
  currentSelection: ModelSelectionInput,
  t: Translate = activeTranslator(),
): ModelOnboardingState {
  const selectableModels = buildModelOptions(runtime);
  const selectableSet = new Set(
    selectableModels.map((model) => `${model.providerId}:${model.modelId}`),
  );
  const hasSelectableModels = selectableModels.length > 0;
  const connectedProviderCount =
    runtime?.providers.filter((provider) => provider.hasAuth).length ?? 0;
  const settingsDefault = {
    provider: runtime?.settings.defaultProvider,
    modelId: runtime?.settings.defaultModelId,
  };
  const hasDefaultModel = Boolean(settingsDefault.provider && settingsDefault.modelId);
  const defaultModelUsable = isUsableSelection(settingsDefault, selectableSet);
  const hasCurrentSelection = Boolean(currentSelection.provider && currentSelection.modelId);
  const currentSelectionUsable = isUsableSelection(currentSelection, selectableSet);

  if (!hasSelectableModels) {
    return {
      hasSelectableModels: false,
      requiresModelSelection: true,
      unselectedModelLabel: t("onboarding.noModelsAvailable"),
      emptyModelTitle: t("onboarding.noModelsAvailable"),
      emptyModelDescription:
        connectedProviderCount > 0
          ? t("onboarding.enableInModels")
          : t("onboarding.connectInProviders"),
      notice:
        connectedProviderCount > 0
          ? {
              title: t("onboarding.noModelsAvailable"),
              description: t("onboarding.allDisabledDesc"),
              actionLabel: t("onboarding.action.openModels"),
              actionSection: "models",
            }
          : {
              title: t("onboarding.noModelsAvailable"),
              description: t("onboarding.noProviderDesc"),
              actionLabel: t("onboarding.action.openProviders"),
              actionSection: "providers",
            },
    };
  }

  if (hasCurrentSelection && !currentSelectionUsable) {
    return {
      hasSelectableModels: true,
      requiresModelSelection: true,
      unselectedModelLabel: t("onboarding.pickModel"),
      emptyModelTitle: t("onboarding.noModelsAvailable"),
      emptyModelDescription: t("onboarding.pickModelDesc"),
      notice: {
        title: t("onboarding.selectedModelUnavailable"),
        description: hasDefaultModel
          ? t("onboarding.selectedUnavailableWithDefault")
          : t("onboarding.selectedUnavailableNoDefault"),
        actionLabel: t("onboarding.action.openModels"),
        actionSection: "models",
      },
    };
  }

  if (!hasDefaultModel) {
    return {
      hasSelectableModels: true,
      requiresModelSelection: !currentSelectionUsable,
      unselectedModelLabel: t("onboarding.pickModel"),
      emptyModelTitle: t("onboarding.noDefaultModel"),
      emptyModelDescription: t("onboarding.pickModelDesc"),
      notice: currentSelectionUsable
        ? undefined
        : {
            title: t("onboarding.noDefaultModel"),
            description: t("onboarding.setDefaultDesc"),
            actionLabel: t("onboarding.action.openModels"),
            actionSection: "models",
          },
    };
  }

  if (!defaultModelUsable) {
    const defaultLabel = `${settingsDefault.provider}:${settingsDefault.modelId}`;
    return {
      hasSelectableModels: true,
      requiresModelSelection: !currentSelectionUsable,
      unselectedModelLabel: t("onboarding.pickModel"),
      emptyModelTitle: t("onboarding.defaultModelUnavailable"),
      emptyModelDescription: t("onboarding.pickModelDesc"),
      notice: {
        title: t("onboarding.defaultModelUnavailable"),
        description: currentSelectionUsable
          ? t("onboarding.defaultUnavailableSelected", { label: defaultLabel })
          : t("onboarding.defaultUnavailableUnselected", { label: defaultLabel }),
        actionLabel: t("onboarding.action.openModels"),
        actionSection: "models",
      },
    };
  }

  return {
    hasSelectableModels: true,
    requiresModelSelection: false,
    unselectedModelLabel: t("onboarding.pickModel"),
    emptyModelTitle: t("onboarding.noModelsAvailable"),
    emptyModelDescription: t("onboarding.pickModelDesc"),
  };
}

function isUsableSelection(
  selection: ModelSelectionInput,
  selectableSet: ReadonlySet<string>,
): boolean {
  return Boolean(
    selection.provider &&
    selection.modelId &&
    selectableSet.has(`${selection.provider}:${selection.modelId}`),
  );
}
