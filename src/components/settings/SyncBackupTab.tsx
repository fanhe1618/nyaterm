import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SelectItem } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApp } from "@/context/AppContext";
import { useSettingsDraft } from "@/context/SettingsDraftContext";
import {
  type CloudSyncValidationCode,
  DEFAULT_CLOUD_SYNC_STATUS,
  formatCloudProvider,
  formatTimestamp,
  getCloudSyncValidationErrors,
  secretInputValue,
  secretPlaceholder,
  shortValue,
  sortRemoteBackups,
} from "@/lib/cloudSync";
import { getErrorMessage } from "@/lib/errors";
import { invoke } from "@/lib/invoke";
import type {
  CloudConflictPreview,
  CloudSyncSettings,
  CloudSyncStatus,
  RemoteBackupEntry,
} from "@/types/global";
import {
  SettingFieldGrid,
  SettingInput,
  SettingNumberInput,
  SettingRow,
  SettingSection,
  SettingSelect,
  SettingSwitch,
} from "./SettingFormItems";

interface SyncBackupTabProps {
  onNavigateSecurity: () => void;
}

function getValidationMessage(
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
    case "giteeSnippetEndpointRequired":
      return t("settings.giteeSnippetEndpointRequired");
    case "giteeSnippetIdRequired":
      return t("settings.giteeSnippetIdRequired");
    case "giteeSnippetTokenRequired":
      return t("settings.giteeSnippetTokenRequired");
  }
}

export function SyncBackupTab({ onNavigateSecurity }: SyncBackupTabProps) {
  const { t } = useTranslation();
  const { appSettings, updateAppSettings } = useApp();
  const { committedSettings, isDirty, isSaving } = useSettingsDraft();

  const settings = appSettings.cloud_sync;
  const committedCloudSync = committedSettings.cloud_sync;
  const hasDraftMasterPassword = Boolean(appSettings.security.master_password);
  const hasCommittedMasterPassword = Boolean(committedSettings.security.master_password);

  const [status, setStatus] = useState<CloudSyncStatus>(DEFAULT_CLOUD_SYNC_STATUS);
  const [remoteBackups, setRemoteBackups] = useState<RemoteBackupEntry[]>([]);
  const [remoteBackupsLoading, setRemoteBackupsLoading] = useState(false);
  const [remoteBackupsError, setRemoteBackupsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningAction, setRunningAction] = useState<string | null>(null);

  const validationErrors = useMemo(() => getCloudSyncValidationErrors(settings), [settings]);
  const committedValidationErrors = useMemo(
    () => getCloudSyncValidationErrors(committedCloudSync),
    [committedCloudSync],
  );

  const formDisabled = !hasDraftMasterPassword || isSaving;
  const autoSyncSectionDisabled = formDisabled || !settings.enabled;
  const backupSectionDisabled = formDisabled || !settings.enabled;
  const canUseCommittedProvider =
    hasCommittedMasterPassword && committedValidationErrors.length === 0;
  const canRunConfigDependentActions = canUseCommittedProvider && !isDirty && !isSaving;
  const canRunEnabledActions = canRunConfigDependentActions && committedCloudSync.enabled;
  const isBusy = loading || isSaving || runningAction !== null;

  const updateCloudSync = useCallback(
    (patch: Partial<CloudSyncSettings>) => {
      updateAppSettings({
        cloud_sync: {
          ...settings,
          ...patch,
        },
      });
    },
    [settings, updateAppSettings],
  );

  const handleEnabledChange = useCallback(
    (enabled: boolean) => {
      if (enabled && !hasDraftMasterPassword) {
        toast.error(t("settings.masterPasswordRequiredDesc"));
        onNavigateSecurity();
        return;
      }

      updateCloudSync({ enabled });
    },
    [hasDraftMasterPassword, onNavigateSecurity, t, updateCloudSync],
  );

  const refreshStatus = useCallback(async () => {
    const nextStatus = await invoke<CloudSyncStatus>("get_cloud_sync_status");
    setStatus(nextStatus);
    return nextStatus;
  }, []);

  const doFetchRemoteBackups = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!canUseCommittedProvider) {
        setRemoteBackups([]);
        setRemoteBackupsError(null);
        return [];
      }

      setRemoteBackupsLoading(true);
      try {
        const entries = sortRemoteBackups(await invoke<RemoteBackupEntry[]>("list_remote_backups"));
        setRemoteBackups(entries);
        setRemoteBackupsError(null);
        return entries;
      } catch (error) {
        const message = getErrorMessage(error);
        setRemoteBackups([]);
        setRemoteBackupsError(message);
        if (!options?.silent) {
          toast.error(message);
        }
        return [];
      } finally {
        setRemoteBackupsLoading(false);
      }
    },
    [canUseCommittedProvider],
  );

  const loadRuntimeData = useCallback(async () => {
    setLoading(true);
    try {
      await refreshStatus();
      if (canUseCommittedProvider) {
        await doFetchRemoteBackups({ silent: true });
      } else {
        setRemoteBackups([]);
        setRemoteBackupsError(null);
      }
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [canUseCommittedProvider, doFetchRemoteBackups, refreshStatus]);

  useEffect(() => {
    void loadRuntimeData();
  }, [loadRuntimeData]);

  useEffect(() => {
    const unsubs = [
      listen<CloudSyncStatus>("cloud-sync-status-changed", (event) => {
        setStatus(event.payload);
      }),
      listen<CloudConflictPreview | null>("cloud-sync-conflict", (event) => {
        const conflict = event.payload;
        if (!conflict) {
          return;
        }
        setStatus((current) => ({
          ...current,
          state: "conflict",
          message: conflict.message,
          conflict,
        }));
      }),
      listen("cloud-sync-history-changed", () => {
        if (canUseCommittedProvider) {
          void doFetchRemoteBackups({ silent: true });
        }
      }),
    ];

    return () => {
      unsubs.forEach((promise) => {
        promise.then((unlisten) => unlisten());
      });
    };
  }, [canUseCommittedProvider, doFetchRemoteBackups]);

  const runAction = useCallback(
    async (
      actionKey: string,
      successMessage: string,
      task: () => Promise<void>,
      options?: { allowWhenDisabled?: boolean; refreshBackups?: boolean },
    ) => {
      if (!hasCommittedMasterPassword) {
        toast.error(t("settings.masterPasswordRequiredDesc"));
        onNavigateSecurity();
        return;
      }

      if (isDirty) {
        toast.error(t("settings.applySettingsFirst"));
        return;
      }

      if (committedValidationErrors.length > 0) {
        toast.error(getValidationMessage(committedValidationErrors[0], t));
        return;
      }

      if (!options?.allowWhenDisabled && !committedCloudSync.enabled) {
        toast.error(t("settings.syncEnableFirst"));
        return;
      }

      setRunningAction(actionKey);
      try {
        await task();
        await refreshStatus();
        if (options?.refreshBackups) {
          await doFetchRemoteBackups({ silent: true });
        }
        toast.success(successMessage);
      } catch (error) {
        toast.error(getErrorMessage(error));
      } finally {
        setRunningAction(null);
      }
    },
    [
      committedCloudSync.enabled,
      committedValidationErrors,
      doFetchRemoteBackups,
      hasCommittedMasterPassword,
      isDirty,
      onNavigateSecurity,
      refreshStatus,
      t,
    ],
  );

  const handleRestoreBackup = useCallback(
    async (entry: RemoteBackupEntry) => {
      const confirmed = await ask(
        t("settings.restoreRemoteBackupConfirm", {
          revision: shortValue(entry.revision, 6),
        }),
        {
          title: t("settings.remoteBackups"),
          kind: "warning",
        },
      );
      if (confirmed !== true) {
        return;
      }

      await runAction(
        `restore-${entry.revision}`,
        t("settings.restoreRemoteBackupSuccess"),
        () => invoke("restore_remote_backup", { revision: entry.revision }),
        { allowWhenDisabled: true, refreshBackups: true },
      );
    },
    [runAction, t],
  );

  const statusItems = useMemo(
    () => [
      {
        label: t("settings.syncStatus"),
        value: t(`settings.syncState.${status.state}`, status.state),
      },
      {
        label: t("settings.syncProvider"),
        value: formatCloudProvider(status.provider),
      },
      {
        label: t("settings.lastSyncCheck"),
        value: formatTimestamp(status.last_checked_at_ms) ?? t("settings.never"),
      },
      {
        label: t("settings.lastSyncAt"),
        value: formatTimestamp(status.last_synced_at_ms) ?? t("settings.never"),
      },
      {
        label: t("settings.lastBackupAt"),
        value: formatTimestamp(status.last_backup_at_ms) ?? t("settings.never"),
      },
      {
        label: t("settings.currentOperation"),
        value:
          status.current_operation && status.current_operation.length > 0
            ? status.current_operation
            : t("settings.none"),
      },
    ],
    [status, t],
  );

  const actionBlockMessage = useMemo(() => {
    if (!hasCommittedMasterPassword) {
      return t("settings.masterPasswordRequiredDesc");
    }
    if (isDirty) {
      return t("settings.applySettingsFirst");
    }
    if (committedValidationErrors.length > 0) {
      return getValidationMessage(committedValidationErrors[0], t);
    }
    return null;
  }, [committedValidationErrors, hasCommittedMasterPassword, isDirty, t]);

  if (loading) {
    return <div className="py-10 text-sm text-muted-foreground">{t("common.loading")}</div>;
  }

  return (
    <div className="min-w-0 space-y-5">
      <SettingSection
        title={t("settings.syncProviderConfig")}
        desc={t("settings.syncProviderConfigDesc")}
        contentClassName="space-y-5"
      >
        <SettingRow label={t("settings.enableCloudSync")} desc={t("settings.enableCloudSyncDesc")}>
          {hasDraftMasterPassword ? (
            <SettingSwitch
              checked={settings.enabled}
              disabled={isSaving}
              onChange={handleEnabledChange}
            />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="inline-flex">
                  <SettingSwitch
                    checked={settings.enabled}
                    disabled
                    onChange={handleEnabledChange}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="top">{t("settings.masterPasswordRequiredDesc")}</TooltipContent>
            </Tooltip>
          )}
        </SettingRow>

        {!hasDraftMasterPassword ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-4">
            <div className="text-sm text-muted-foreground">
              {t("settings.syncMasterPasswordMissingDesc")}
            </div>
            <div className="mt-3">
              <Button size="sm" onClick={onNavigateSecurity}>
                {t("settings.openSecuritySettings")}
              </Button>
            </div>
          </div>
        ) : null}

        {settings.enabled && validationErrors.length > 0 ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-muted-foreground">
            {getValidationMessage(validationErrors[0], t)}
          </div>
        ) : null}

        <SettingFieldGrid>
          <SettingSelect
            label={t("settings.syncProvider")}
            desc={t("settings.syncProviderDesc")}
            value={settings.provider}
            disabled={formDisabled}
            onValueChange={(provider) => updateCloudSync({ provider })}
          >
            <SelectItem value="webdav">WebDAV</SelectItem>
            <SelectItem value="s3">S3 Compatible</SelectItem>
            <SelectItem value="gitee_snippet">Gitee Snippet</SelectItem>
          </SettingSelect>

          <SettingInput
            label={t("settings.deviceName")}
            desc={t("settings.deviceNameDesc")}
            value={settings.device_name}
            disabled={formDisabled}
            onChange={(event) => updateCloudSync({ device_name: event.target.value })}
          />

          <SettingInput
            label={t("settings.remoteNamespace")}
            desc={t("settings.remoteNamespaceDesc")}
            value={settings.remote_root}
            disabled={formDisabled}
            onChange={(event) => updateCloudSync({ remote_root: event.target.value })}
          />
        </SettingFieldGrid>

        {settings.provider === "webdav" ? (
          <SettingFieldGrid>
            <SettingInput
              label={t("settings.webdavEndpoint")}
              value={settings.webdav.endpoint}
              placeholder="https://dav.example.com"
              disabled={formDisabled}
              onChange={(event) =>
                updateCloudSync({
                  webdav: { ...settings.webdav, endpoint: event.target.value },
                })
              }
            />
            <SettingInput
              label={t("settings.providerRoot")}
              desc={t("settings.providerRootDesc")}
              value={settings.webdav.root}
              placeholder="/apps/nyaterm"
              disabled={formDisabled}
              onChange={(event) =>
                updateCloudSync({
                  webdav: { ...settings.webdav, root: event.target.value },
                })
              }
            />
            <SettingInput
              label={t("dialog.username")}
              value={settings.webdav.username}
              disabled={formDisabled}
              onChange={(event) =>
                updateCloudSync({
                  webdav: { ...settings.webdav, username: event.target.value },
                })
              }
            />
            <SettingInput
              label={t("dialog.password")}
              type="password"
              value={secretInputValue(settings.webdav.password)}
              placeholder={secretPlaceholder(settings.webdav.password, t("dialog.password"))}
              disabled={formDisabled}
              onChange={(event) =>
                updateCloudSync({
                  webdav: { ...settings.webdav, password: event.target.value },
                })
              }
            />
          </SettingFieldGrid>
        ) : settings.provider === "s3" ? (
          <SettingFieldGrid>
            <SettingInput
              label={t("settings.s3Endpoint")}
              value={settings.s3.endpoint}
              placeholder="https://s3.example.com"
              disabled={formDisabled}
              onChange={(event) =>
                updateCloudSync({
                  s3: { ...settings.s3, endpoint: event.target.value },
                })
              }
            />
            <SettingInput
              label={t("settings.s3Bucket")}
              value={settings.s3.bucket}
              disabled={formDisabled}
              onChange={(event) =>
                updateCloudSync({
                  s3: { ...settings.s3, bucket: event.target.value },
                })
              }
            />
            <SettingInput
              label={t("settings.s3Region")}
              value={settings.s3.region}
              placeholder="auto"
              disabled={formDisabled}
              onChange={(event) =>
                updateCloudSync({
                  s3: { ...settings.s3, region: event.target.value },
                })
              }
            />
            <SettingInput
              label={t("settings.providerRoot")}
              desc={t("settings.providerRootDesc")}
              value={settings.s3.root}
              placeholder="/apps/nyaterm"
              disabled={formDisabled}
              onChange={(event) =>
                updateCloudSync({
                  s3: { ...settings.s3, root: event.target.value },
                })
              }
            />
            <SettingInput
              label={t("settings.s3AccessKeyId")}
              value={secretInputValue(settings.s3.access_key_id)}
              placeholder={secretPlaceholder(settings.s3.access_key_id, "AKIA...")}
              disabled={formDisabled}
              onChange={(event) =>
                updateCloudSync({
                  s3: { ...settings.s3, access_key_id: event.target.value },
                })
              }
            />
            <SettingInput
              label={t("settings.s3SecretAccessKey")}
              type="password"
              value={secretInputValue(settings.s3.secret_access_key)}
              placeholder={secretPlaceholder(
                settings.s3.secret_access_key,
                t("settings.s3SecretAccessKey"),
              )}
              disabled={formDisabled}
              onChange={(event) =>
                updateCloudSync({
                  s3: { ...settings.s3, secret_access_key: event.target.value },
                })
              }
            />
            <SettingInput
              label={t("settings.s3SessionToken")}
              type="password"
              value={secretInputValue(settings.s3.session_token)}
              placeholder={secretPlaceholder(
                settings.s3.session_token,
                t("settings.optionalField"),
              )}
              disabled={formDisabled}
              onChange={(event) =>
                updateCloudSync({
                  s3: { ...settings.s3, session_token: event.target.value },
                })
              }
            />
            <SettingRow
              label={t("settings.s3VirtualHostStyle")}
              desc={t("settings.s3VirtualHostStyleDesc")}
            >
              <SettingSwitch
                checked={settings.s3.virtual_host_style}
                disabled={formDisabled}
                onChange={(virtual_host_style) =>
                  updateCloudSync({
                    s3: { ...settings.s3, virtual_host_style },
                  })
                }
              />
            </SettingRow>
          </SettingFieldGrid>
        ) : (
          <SettingFieldGrid>
            <SettingInput
              label={t("settings.giteeSnippetApiEndpoint")}
              desc={t("settings.giteeSnippetApiEndpointDesc")}
              value={settings.gitee_snippet.api_endpoint}
              placeholder="https://gitee.com/api/v5"
              disabled={formDisabled}
              onChange={(event) =>
                updateCloudSync({
                  gitee_snippet: {
                    ...settings.gitee_snippet,
                    api_endpoint: event.target.value,
                  },
                })
              }
            />
            <SettingInput
              label={t("settings.giteeSnippetId")}
              desc={t("settings.giteeSnippetIdDesc")}
              value={settings.gitee_snippet.gist_id}
              disabled={formDisabled}
              onChange={(event) =>
                updateCloudSync({
                  gitee_snippet: { ...settings.gitee_snippet, gist_id: event.target.value },
                })
              }
            />
            <SettingInput
              label={t("settings.giteeSnippetAccessToken")}
              desc={t("settings.giteeSnippetAccessTokenDesc")}
              type="password"
              value={secretInputValue(settings.gitee_snippet.access_token)}
              placeholder={secretPlaceholder(
                settings.gitee_snippet.access_token,
                t("settings.giteeSnippetAccessToken"),
              )}
              disabled={formDisabled}
              onChange={(event) =>
                updateCloudSync({
                  gitee_snippet: {
                    ...settings.gitee_snippet,
                    access_token: event.target.value,
                  },
                })
              }
            />
          </SettingFieldGrid>
        )}
      </SettingSection>

      <SettingSection
        title={t("settings.autoSyncStrategy")}
        desc={t("settings.autoSyncStrategyDesc")}
        contentClassName="space-y-5"
      >
        <SettingRow
          label={t("settings.autoCheckOnStartup")}
          desc={t("settings.autoCheckOnStartupDesc")}
        >
          <SettingSwitch
            checked={settings.auto_check_on_startup}
            disabled={autoSyncSectionDisabled}
            onChange={(auto_check_on_startup) => updateCloudSync({ auto_check_on_startup })}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.autoPushOnChange")}
          desc={t("settings.autoPushOnChangeDesc")}
        >
          <SettingSwitch
            checked={settings.auto_push_on_change}
            disabled={autoSyncSectionDisabled}
            onChange={(auto_push_on_change) => updateCloudSync({ auto_push_on_change })}
          />
        </SettingRow>
        <SettingNumberInput
          label={t("settings.syncDebounceSeconds")}
          desc={t("settings.syncDebounceSecondsDesc")}
          value={settings.sync_debounce_seconds}
          disabled={autoSyncSectionDisabled || !settings.auto_push_on_change}
          min={1}
          max={3600}
          onChange={(sync_debounce_seconds) => updateCloudSync({ sync_debounce_seconds })}
        />
      </SettingSection>

      <SettingSection
        title={t("settings.backupStrategy")}
        desc={t("settings.backupStrategyDesc")}
        contentClassName="space-y-5"
      >
        <SettingRow
          label={t("settings.scheduledBackupEnabled")}
          desc={t("settings.scheduledBackupEnabledDesc")}
        >
          <SettingSwitch
            checked={settings.scheduled_backup_enabled}
            disabled={backupSectionDisabled}
            onChange={(scheduled_backup_enabled) => updateCloudSync({ scheduled_backup_enabled })}
          />
        </SettingRow>
        <SettingFieldGrid>
          <SettingNumberInput
            label={t("settings.backupIntervalHours")}
            desc={t("settings.backupIntervalHoursDesc")}
            value={settings.backup_interval_hours}
            disabled={backupSectionDisabled || !settings.scheduled_backup_enabled}
            min={1}
            max={720}
            onChange={(backup_interval_hours) => updateCloudSync({ backup_interval_hours })}
          />
          <SettingNumberInput
            label={t("settings.backupRetentionCount")}
            desc={t("settings.backupRetentionCountDesc")}
            value={settings.backup_retention_count}
            disabled={backupSectionDisabled || !settings.scheduled_backup_enabled}
            min={1}
            max={365}
            onChange={(backup_retention_count) => updateCloudSync({ backup_retention_count })}
          />
        </SettingFieldGrid>
      </SettingSection>

      <SettingSection title={t("settings.manualSyncActions")} contentClassName="space-y-5">
        {actionBlockMessage ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-muted-foreground">
            {actionBlockMessage}
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {statusItems.map((item) => (
            <div
              key={item.label}
              className="rounded-lg border border-border/70 bg-muted/15 px-3 py-3"
            >
              <div className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {item.label}
              </div>
              <div className="mt-2 min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]">
                {item.value}
              </div>
            </div>
          ))}
        </div>

        {status.message ? (
          <div className="min-w-0 rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">
            {status.message}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() =>
              void runAction(
                "test",
                t("settings.syncTestSuccess"),
                () => invoke("test_cloud_sync_connection"),
                { allowWhenDisabled: true },
              )
            }
            disabled={isBusy || !canRunConfigDependentActions}
          >
            {t("settings.testConnection")}
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              void runAction("push", t("settings.syncPushSuccess"), () => invoke("sync_push_now"))
            }
            disabled={isBusy || !canRunEnabledActions}
          >
            {t("settings.syncPushNow")}
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              void runAction("pull", t("settings.syncPullSuccess"), () => invoke("sync_pull_now"))
            }
            disabled={isBusy || !canRunEnabledActions}
          >
            {t("settings.syncPullNow")}
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              void runAction(
                "backup",
                t("settings.backupRunSuccess"),
                () => invoke("run_cloud_backup_now"),
                { refreshBackups: true },
              )
            }
            disabled={isBusy || !canRunEnabledActions}
          >
            {t("settings.runBackupNow")}
          </Button>
        </div>
      </SettingSection>

      <SettingSection
        title={t("settings.remoteBackups")}
        desc={t("settings.remoteBackupsDesc")}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void doFetchRemoteBackups({ silent: false })}
            disabled={remoteBackupsLoading || !canRunConfigDependentActions}
          >
            {t("resourceMonitor.refresh")}
          </Button>
        }
        contentClassName="space-y-4"
      >
        {status.conflict ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-4">
            <div className="text-sm font-semibold">{t("settings.syncConflictTitle")}</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              <span className="break-words [overflow-wrap:anywhere]">
                {status.conflict.message}
              </span>
            </p>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              <div className="rounded-md border border-border/70 bg-background/70 px-3 py-3">
                <div className="text-[0.6875rem] uppercase tracking-[0.14em] text-muted-foreground">
                  {t("settings.localSnapshot")}
                </div>
                <div className="mt-2 text-xs font-medium">
                  {shortValue(status.conflict.local_payload_hash, 10)}
                </div>
              </div>
              <div className="rounded-md border border-border/70 bg-background/70 px-3 py-3">
                <div className="text-[0.6875rem] uppercase tracking-[0.14em] text-muted-foreground">
                  {t("settings.remoteSnapshot")}
                </div>
                <div className="mt-2 text-xs font-medium">
                  {shortValue(status.conflict.remote_revision, 10)}
                </div>
                <div className="mt-1 text-[0.6875rem] text-muted-foreground">
                  {formatTimestamp(status.conflict.remote_created_at_ms)}
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void runAction(
                    "resolve-download",
                    t("settings.syncResolveDownloadSuccess"),
                    () =>
                      invoke("resolve_cloud_sync_conflict", {
                        action: "download_remote",
                      }),
                    { allowWhenDisabled: true },
                  )
                }
                disabled={isBusy || !canRunConfigDependentActions}
              >
                {t("settings.downloadRemoteVersion")}
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  void runAction(
                    "resolve-upload",
                    t("settings.syncResolveUploadSuccess"),
                    () =>
                      invoke("resolve_cloud_sync_conflict", {
                        action: "upload_local",
                      }),
                    { allowWhenDisabled: true },
                  )
                }
                disabled={isBusy || !canRunConfigDependentActions}
              >
                {t("settings.uploadLocalVersion")}
              </Button>
            </div>
          </div>
        ) : null}

        {remoteBackupsError ? (
          <div className="min-w-0 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive break-words [overflow-wrap:anywhere]">
            {remoteBackupsError}
          </div>
        ) : null}

        {remoteBackups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
            {remoteBackupsLoading ? t("common.loading") : t("settings.noRemoteBackups")}
          </div>
        ) : (
          <div className="space-y-3">
            {remoteBackups.map((entry) => (
              <div
                key={entry.revision}
                className="rounded-lg border border-border/70 bg-card/60 px-4 py-4"
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{entry.message}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {formatTimestamp(entry.created_at_ms) ?? t("settings.never")}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleRestoreBackup(entry)}
                    disabled={isBusy || !canRunConfigDependentActions}
                  >
                    {t("menu.restore")}
                  </Button>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
                  <div>
                    {t("settings.revisionLabel")}: {shortValue(entry.revision, 10)}
                  </div>
                  <div>
                    {t("settings.deviceLabel")}: {entry.device_id}
                  </div>
                  <div>
                    {t("settings.payloadHashLabel")}: {shortValue(entry.payload_hash, 10)}
                  </div>
                  <div>
                    {t("settings.appVersionLabel")}: {entry.app_version}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingSection>
    </div>
  );
}
