import { listen } from "@tauri-apps/api/event";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MdRefresh } from "react-icons/md";
import { toast } from "sonner";
import PanelHeader from "@/components/layout/PanelHeader";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_CLOUD_SYNC_STATUS,
  formatCloudProvider,
  formatDuration,
  formatTimestamp,
  shortValue,
} from "@/lib/cloudSync";
import { getErrorMessage } from "@/lib/errors";
import { invoke } from "@/lib/invoke";
import type {
  CloudConflictPreview,
  CloudSyncHistoryEntry,
  CloudSyncStatus,
} from "@/types/global";

function SyncBackupHistoryPanel() {
  const { t } = useTranslation();
  const [history, setHistory] = useState<CloudSyncHistoryEntry[]>([]);
  const [status, setStatus] = useState<CloudSyncStatus>(DEFAULT_CLOUD_SYNC_STATUS);
  const [loading, setLoading] = useState(true);
  const [runningAction, setRunningAction] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextHistory, nextStatus] = await Promise.all([
        invoke<CloudSyncHistoryEntry[]>("list_cloud_sync_history"),
        invoke<CloudSyncStatus>("get_cloud_sync_status"),
      ]);
      setHistory(nextHistory);
      setStatus(nextStatus);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unsubs = [
      listen<CloudSyncHistoryEntry[]>("cloud-sync-history-changed", (event) => {
        setHistory(event.payload);
      }),
      listen<CloudSyncStatus>("cloud-sync-status-changed", (event) => {
        setStatus(event.payload);
      }),
      listen<CloudConflictPreview | null>("cloud-sync-conflict", (event) => {
        const conflict = event.payload;
        if (!conflict) return;
        setStatus((current) => ({
          ...current,
          state: "conflict",
          message: conflict.message,
          conflict,
        }));
      }),
    ];
    return () => {
      unsubs.forEach((promise) => {
        promise.then((unlisten) => unlisten());
      });
    };
  }, []);

  const handleResolveConflict = useCallback(
    async (action: "download_remote" | "upload_local") => {
      setRunningAction(action);
      try {
        await invoke("resolve_cloud_sync_conflict", { action });
        await refresh();
        toast.success(
          action === "download_remote"
            ? t("settings.syncResolveDownloadSuccess")
            : t("settings.syncResolveUploadSuccess"),
        );
      } catch (error) {
        toast.error(getErrorMessage(error));
      } finally {
        setRunningAction(null);
      }
    },
    [refresh, t],
  );

  const kindLabels = useMemo(
    () => ({
      sync: t("settings.historyKindSync"),
      backup: t("settings.historyKindBackup"),
    }),
    [t],
  );

  const statusLabels = useMemo(
    () => ({
      success: t("settings.syncState.success"),
      conflict: t("settings.syncState.conflict"),
      running: t("settings.syncState.running"),
      failed: t("settings.syncState.failed"),
      idle: t("settings.syncState.idle"),
      disabled: t("settings.syncState.disabled"),
    }),
    [t],
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <PanelHeader
        title={t("panel.syncBackupHistory")}
        actions={
          <Button variant="ghost" className="h-4 w-4" onClick={() => void refresh()} disabled={loading}>
            <MdRefresh />
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto p-2 space-y-3 text-xs terminal-scroll">
        <div className="rounded-lg border border-border/70 bg-card/60 px-3 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-primary/10 px-2 py-1 font-medium text-primary">
              {t(`settings.syncState.${status.state}`, status.state)}
            </span>
            <span className="text-muted-foreground">{formatCloudProvider(status.provider)}</span>
          </div>
          {status.message ? (
            <div className="mt-2 text-muted-foreground">{status.message}</div>
          ) : null}
          <div className="mt-3 grid gap-2 text-[0.6875rem] text-muted-foreground sm:grid-cols-2">
            <div>
              {t("settings.lastSyncCheck")}: {formatTimestamp(status.last_checked_at_ms) ?? t("settings.never")}
            </div>
            <div>
              {t("settings.lastSyncAt")}: {formatTimestamp(status.last_synced_at_ms) ?? t("settings.never")}
            </div>
            <div>
              {t("settings.lastBackupAt")}: {formatTimestamp(status.last_backup_at_ms) ?? t("settings.never")}
            </div>
            <div>
              {t("settings.currentOperation")}: {status.current_operation || t("settings.none")}
            </div>
          </div>
        </div>

        {status.conflict ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3">
            <div className="text-sm font-semibold">{t("settings.syncConflictTitle")}</div>
            <div className="mt-1 text-muted-foreground">{status.conflict.message}</div>
            <div className="mt-3 grid gap-2 text-[0.6875rem] text-muted-foreground">
              <div>
                {t("settings.remoteSnapshot")}: {shortValue(status.conflict.remote_revision, 10)}
              </div>
              <div>
                {t("settings.remoteDeviceLabel")}: {status.conflict.remote_device_id}
              </div>
              <div>
                {t("settings.payloadHashLabel")}: {shortValue(status.conflict.remote_payload_hash, 10)}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleResolveConflict("download_remote")}
                disabled={runningAction !== null}
              >
                {t("settings.downloadRemoteVersion")}
              </Button>
              <Button
                size="sm"
                onClick={() => void handleResolveConflict("upload_local")}
                disabled={runningAction !== null}
              >
                {t("settings.uploadLocalVersion")}
              </Button>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="py-6 text-center text-muted-foreground">{t("common.loading")}</div>
        ) : history.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 px-3 py-8 text-center text-muted-foreground">
            {t("settings.noSyncHistory")}
          </div>
        ) : (
          history.map((entry) => (
            <div
              key={entry.id}
              className="rounded-lg border border-border/70 bg-card/60 px-3 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-muted px-2 py-1 font-medium">
                  {kindLabels[entry.kind as keyof typeof kindLabels] ?? entry.kind}
                </span>
                <span className="rounded-full bg-background px-2 py-1 text-muted-foreground">
                  {statusLabels[entry.status as keyof typeof statusLabels] ?? entry.status}
                </span>
                <span className="ml-auto text-[0.6875rem] text-muted-foreground">
                  {formatTimestamp(entry.timestamp_ms) ?? t("settings.never")}
                </span>
              </div>

              <div className="mt-2 text-sm">{entry.message}</div>

              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[0.6875rem] text-muted-foreground">
                <span>
                  {t("settings.triggerLabel")}: {entry.trigger}
                </span>
                <span>
                  {t("settings.providerLabel")}: {formatCloudProvider(entry.provider)}
                </span>
                <span>
                  {t("settings.revisionLabel")}: {shortValue(entry.revision, 8)}
                </span>
                <span>
                  {t("settings.durationLabel")}: {formatDuration(entry.duration_ms) ?? t("settings.none")}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default memo(SyncBackupHistoryPanel);
