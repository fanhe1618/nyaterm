import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type ComponentType, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MdBackup,
  MdMouse,
  MdPalette,
  MdSearch,
  MdSecurity,
  MdSettings,
  MdSwapHoriz,
  MdTerminal,
  MdTranslate,
} from "react-icons/md";
import { toast } from "sonner";
import ChildWindowHeader from "@/components/layout/ChildWindowHeader";
import { AppearanceTab } from "@/components/settings/AppearanceTab";
import { GeneralTab } from "@/components/settings/GeneralTab";
import { InteractionTab } from "@/components/settings/InteractionTab";
import { SearchTab } from "@/components/settings/SearchTab";
import { SecurityTab } from "@/components/settings/SecurityTab";
import { SyncBackupTab } from "@/components/settings/SyncBackupTab";
import { TerminalTab } from "@/components/settings/TerminalTab";
import { TransferTab } from "@/components/settings/TransferTab";
import { TranslationTab } from "@/components/settings/TranslationTab";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AppContext, useApp } from "@/context/AppContext";
import { SettingsDraftContext } from "@/context/SettingsDraftContext";
import { getErrorMessage } from "@/lib/errors";
import { getCloudSyncValidationErrors, type CloudSyncValidationCode } from "@/lib/cloudSync";
import { invoke } from "@/lib/invoke";
import type { AppSettings, UiConfig } from "@/types/global";

type SettingsTabConfig = {
  id: string;
  label: string;
  icon: string;
  Component?: ComponentType;
};

function getCloudSyncValidationMessage(
  code: CloudSyncValidationCode,
  t: ReturnType<typeof useTranslation>["t"],
) {
  switch (code) {
    case "webdavEndpointRequired":
      return t("settings.webdavEndpointRequired");
    case "s3EndpointRequired":
      return t("settings.s3EndpointRequired");
    case "s3BucketRequired":
      return t("settings.s3BucketRequired");
    case "s3CredentialsIncomplete":
      return t("settings.s3CredentialsIncomplete");
  }
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const app = useApp();
  const committedSettings = app.appSettings;

  const params = new URLSearchParams(window.location.search);
  const initialTab = params.get("tab") || "general";
  const [activeTab, setActiveTab] = useState(initialTab);
  const [draftSettings, setDraftSettings] = useState<AppSettings>(committedSettings);
  const [isSaving, setIsSaving] = useState(false);

  const committedSerialized = useMemo(
    () => JSON.stringify(committedSettings),
    [committedSettings],
  );
  const draftSerialized = useMemo(() => JSON.stringify(draftSettings), [draftSettings]);
  const isDirty = committedSerialized !== draftSerialized;

  useEffect(() => {
    if (!isDirty) {
      setDraftSettings(committedSettings);
    }
  }, [committedSettings, isDirty]);

  const updateDraftSettings = useCallback(
    (updates: Partial<AppSettings> | ((prev: AppSettings) => Partial<AppSettings>)) => {
      setDraftSettings((prev) => {
        const nextUpdates = typeof updates === "function" ? updates(prev) : updates;
        return { ...prev, ...nextUpdates };
      });
    },
    [],
  );

  const updateDraftUi = useCallback(
    (updates: Partial<UiConfig> | ((prev: UiConfig) => Partial<UiConfig>)) => {
      updateDraftSettings((prev) => {
        const nextUpdates = typeof updates === "function" ? updates(prev.ui) : updates;
        return { ui: { ...prev.ui, ...nextUpdates } };
      });
    },
    [updateDraftSettings],
  );

  const nestedAppContextValue = useMemo(
    () => ({
      ...app,
      appSettings: draftSettings,
      updateAppSettings: updateDraftSettings,
      updateUi: updateDraftUi,
      replaceAppSettings: app.replaceAppSettings,
    }),
    [app, draftSettings, updateDraftSettings, updateDraftUi],
  );

  const tabs: SettingsTabConfig[] = [
    { id: "general", label: t("settings.general"), icon: "settings", Component: GeneralTab },
    {
      id: "appearance",
      label: t("settings.appearance"),
      icon: "palette",
      Component: AppearanceTab,
    },
    { id: "transfer", label: t("settings.transfer"), icon: "swap_horiz", Component: TransferTab },
    { id: "search", label: t("settings.search"), icon: "search", Component: SearchTab },
    {
      id: "translation",
      label: t("settings.translation"),
      icon: "translate",
      Component: TranslationTab,
    },
    { id: "security", label: t("settings.security"), icon: "security", Component: SecurityTab },
    { id: "syncBackup", label: t("settings.syncBackup"), icon: "backup" },
    { id: "terminal", label: t("settings.terminal"), icon: "terminal", Component: TerminalTab },
    {
      id: "interaction",
      label: t("settings.interaction"),
      icon: "mouse",
      Component: InteractionTab,
    },
  ];

  const activeTabConfig = tabs.find((tab) => tab.id === activeTab);
  const ActiveComponent = activeTabConfig?.Component;

  const iconMap: Record<string, React.ElementType> = {
    backup: MdBackup,
    settings: MdSettings,
    palette: MdPalette,
    swap_horiz: MdSwapHoriz,
    search: MdSearch,
    translate: MdTranslate,
    security: MdSecurity,
    terminal: MdTerminal,
    mouse: MdMouse,
  };

  function DynamicIcon({ name, className }: { name: string; className?: string }) {
    const Icon = iconMap[name];
    if (!Icon) return null;
    return <Icon className={className} />;
  }

  const getDraftSaveBlockState = useCallback(() => {
    if (!draftSettings.cloud_sync.enabled) {
      return null;
    }

    if (!draftSettings.security.master_password) {
      return {
        message: t("settings.masterPasswordRequiredDesc"),
        targetTab: "security" as const,
      };
    }

    const errors = getCloudSyncValidationErrors(draftSettings.cloud_sync);
    if (errors.length === 0) {
      return null;
    }

    return {
      message: getCloudSyncValidationMessage(errors[0], t),
      targetTab: "syncBackup" as const,
    };
  }, [draftSettings.cloud_sync, draftSettings.security.master_password, t]);

  const saveBlockState = useMemo(
    () => (isDirty ? getDraftSaveBlockState() : null),
    [getDraftSaveBlockState, isDirty],
  );
  const saveBlockedMessage = saveBlockState?.message ?? null;

  const saveDraftSettings = useCallback(
    async (closeAfterSave: boolean) => {
      const validationState = getDraftSaveBlockState();
      if (validationState) {
        toast.error(validationState.message);
        return;
      }

      setIsSaving(true);
      try {
        await invoke("save_app_settings", { settings: draftSettings });
        const nextSettings = await invoke<AppSettings>("get_app_settings");
        app.replaceAppSettings(nextSettings);
        setDraftSettings(nextSettings);
        await emit("settings-changed", nextSettings).catch(() => {});

        if (closeAfterSave) {
          await getCurrentWindow().close();
        } else {
          toast.success(t("settings.saveSuccess"));
        }
      } catch (error) {
        toast.error(getErrorMessage(error));
      } finally {
        setIsSaving(false);
      }
    },
    [app, draftSettings, getDraftSaveBlockState, t],
  );

  const handleCancel = useCallback(async () => {
    setDraftSettings(committedSettings);
    await getCurrentWindow().close();
  }, [committedSettings]);

  const handleConfirm = useCallback(async () => {
    if (!isDirty) {
      await getCurrentWindow().close();
      return;
    }
    await saveDraftSettings(true);
  }, [isDirty, saveDraftSettings]);

  const handleApply = useCallback(async () => {
    if (!isDirty || isSaving) {
      return;
    }
    await saveDraftSettings(false);
  }, [isDirty, isSaving, saveDraftSettings]);

  return (
    <div
      className="h-full min-h-0 flex flex-col overflow-hidden"
      style={{ fontFamily: committedSettings.appearance.font_family }}
    >
      <ChildWindowHeader
        title={t("settings.title")}
        icon={<MdSettings className="text-base" />}
        onClose={() => {
          void handleCancel();
        }}
      />

      <SettingsDraftContext.Provider
        value={{
          committedSettings,
          isDirty,
          isSaving,
        }}
      >
        <AppContext.Provider value={nestedAppContextValue}>
          <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
            <div className="flex w-14 shrink-0 flex-col border-r border-border/70 bg-muted/20 sm:w-48 lg:w-56">
              <div
                className="flex items-center justify-center gap-3 border-b border-border/70 px-3 py-4 sm:justify-start sm:px-4 sm:py-5"
                data-tauri-drag-region
              >
                <MdSettings className="shrink-0 text-2xl text-primary" />
                <h1 className="hidden text-lg font-semibold sm:block lg:text-xl">
                  {t("settings.title")}
                </h1>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3 sm:px-3 sm:py-4">
                <div className="flex flex-col gap-1.5">
                  {tabs.map((tab) => (
                    <Button
                      key={tab.id}
                      variant="ghost"
                      onClick={() => setActiveTab(tab.id)}
                      title={tab.label}
                      className={`h-auto w-full justify-center gap-3 rounded-xl border px-2 py-2.5 text-sm font-medium transition-colors sm:justify-start sm:px-3 ${
                        activeTab === tab.id
                          ? "border-primary/20 bg-primary/12 text-foreground shadow-xs hover:bg-primary/16"
                          : "border-transparent text-muted-foreground hover:border-border/70 hover:bg-background hover:text-foreground"
                      }`}
                    >
                      <DynamicIcon
                        name={tab.icon}
                        className={`shrink-0 text-[1.125rem] ${
                          activeTab === tab.id ? "text-primary" : ""
                        }`}
                      />
                      <span className="hidden truncate sm:inline">{tab.label}</span>
                    </Button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex flex-1 min-h-0 min-w-0 flex-col">
              <div
                className="flex shrink-0 items-center justify-between border-b border-border/70 bg-background/90 px-4 py-4 backdrop-blur sm:px-6 sm:py-5"
                data-tauri-drag-region
              >
                <h3 className="text-lg font-semibold sm:text-2xl">{activeTabConfig?.label}</h3>
              </div>

              <div className="flex-1 overflow-y-auto bg-gradient-to-b from-background via-background to-muted/10 px-4 py-4 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
                <div className="mx-auto w-full max-w-5xl space-y-5 text-base sm:space-y-6">
                  {activeTab === "syncBackup" ? (
                    <SyncBackupTab onNavigateSecurity={() => setActiveTab("security")} />
                  ) : ActiveComponent ? (
                    <ActiveComponent />
                  ) : null}
                </div>
              </div>

              <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/70 bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
                <div className="min-w-0 flex-1">
                  {saveBlockState ? (
                    <div className="flex flex-wrap items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
                      <span className="min-w-0 flex-1">{saveBlockedMessage}</span>
                      {activeTab !== saveBlockState.targetTab ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="shrink-0"
                          onClick={() => setActiveTab(saveBlockState.targetTab)}
                        >
                          {saveBlockState.targetTab === "security"
                            ? t("settings.security")
                            : t("settings.syncBackup")}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <Button variant="outline" onClick={() => void handleCancel()} disabled={isSaving}>
                  {t("common.cancel")}
                </Button>
                {saveBlockedMessage ? (
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="inline-flex">
                          <Button variant="outline" disabled>
                            {t("common.apply")}
                          </Button>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="top">{saveBlockedMessage}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="inline-flex">
                          <Button disabled>
                            {isSaving ? t("common.saving") : t("common.confirm")}
                          </Button>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="top">{saveBlockedMessage}</TooltipContent>
                    </Tooltip>
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => void handleApply()}
                      disabled={!isDirty || isSaving}
                    >
                      {t("common.apply")}
                    </Button>
                    <Button onClick={() => void handleConfirm()} disabled={isSaving}>
                      {isSaving ? t("common.saving") : t("common.confirm")}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
        </AppContext.Provider>
      </SettingsDraftContext.Provider>
    </div>
  );
}
