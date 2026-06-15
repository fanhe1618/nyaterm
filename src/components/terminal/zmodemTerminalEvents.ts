import type { Terminal } from "@xterm/xterm";
import { toast } from "sonner";
import { getLocalPathName } from "@/components/panel/file-explorer/model";
import { invoke } from "@/lib/invoke";
import {
  completePendingZmodemUpload,
  failPendingZmodemUpload,
  getPendingZmodemUploadPaths,
  hasPendingZmodemUpload,
  markPendingZmodemUploadActive,
  probeAndResolveRemoteConflicts,
} from "@/lib/terminalZmodemUpload";

const PROGRESS_RENDER_INTERVAL_MS = 100;

export type ZmodemEventPayload =
  | { type: "detected"; direction: "download" | "upload" }
  | {
      type: "progress";
      fileName?: string;
      file_name?: string;
      bytesTransferred?: number;
      bytes_transferred?: number;
      totalSize?: number;
      total_size?: number;
      direction: "download" | "upload";
    }
  | { type: "complete"; direction: "download" | "upload"; fileCount?: number; file_count?: number }
  | { type: "failed"; reason: string };

type Translate = (key: string, opts?: Record<string, unknown>) => string;

export interface ZmodemEventHandler {
  handle(payload: ZmodemEventPayload): void;
  dispose(): void;
}

export function createZmodemEventHandler(
  terminal: Terminal,
  sessionId: string,
  getT: () => Translate,
  getDuplicateStrategy: () => string = () => "ask",
): ZmodemEventHandler {
  let pendingProgress: Extract<ZmodemEventPayload, { type: "progress" }> | null = null;
  let progressRaf: number | null = null;
  let progressTimer: number | null = null;
  let lastProgressWriteAt = 0;
  let uploadStarted = false;
  let uploadFileName = "";
  let uploadToastId: string | number | null = null;
  let disposed = false;

  const clearProgressTimer = () => {
    if (progressTimer !== null) {
      window.clearTimeout(progressTimer);
      progressTimer = null;
    }
  };

  const clearProgressRaf = () => {
    if (progressRaf !== null) {
      window.cancelAnimationFrame(progressRaf);
      progressRaf = null;
    }
  };

  const renderProgress = () => {
    progressRaf = null;
    clearProgressTimer();
    if (disposed || !pendingProgress) return;

    const payload = pendingProgress;
    pendingProgress = null;
    lastProgressWriteAt = Date.now();

    if (payload.direction === "upload") {
      const fileName = payload.fileName ?? payload.file_name ?? uploadFileName;
      if (fileName) {
        uploadFileName = fileName;
      }
      if (!uploadStarted) {
        uploadStarted = true;
        uploadToastId = toast.message(
          getT()("fileTransfer.uploadStarted", { name: uploadFileName || fileName }),
        );
      }
      return;
    }

    const fileName = payload.fileName ?? payload.file_name ?? "";
    const bytesTransferred = payload.bytesTransferred ?? payload.bytes_transferred ?? 0;
    const totalSize = payload.totalSize ?? payload.total_size ?? 0;
    const percent = totalSize > 0 ? Math.round((bytesTransferred / totalSize) * 100) : 0;
    const t = getT();
    terminal.write(`\r\x1b[36m[ZMODEM] ${t("zmodem.downloading", { fileName, percent })}\x1b[K`);
  };

  const scheduleProgressRender = () => {
    if (disposed) return;
    if (progressRaf !== null || progressTimer !== null) return;

    const elapsed = Date.now() - lastProgressWriteAt;
    if (elapsed >= PROGRESS_RENDER_INTERVAL_MS) {
      progressRaf = window.requestAnimationFrame(renderProgress);
      return;
    }

    progressTimer = window.setTimeout(() => {
      progressTimer = null;
      progressRaf = window.requestAnimationFrame(renderProgress);
    }, PROGRESS_RENDER_INTERVAL_MS - elapsed);
  };

  const flushProgress = () => {
    clearProgressRaf();
    clearProgressTimer();
    renderProgress();
  };

  const dismissUploadToast = () => {
    if (uploadToastId !== null) {
      toast.dismiss(uploadToastId);
      uploadToastId = null;
    }
  };

  const showUploadCompletedToast = () => {
    dismissUploadToast();
    const t = getT();
    const description = uploadFileName;
    toast.success(t("fileTransfer.uploadCompleted"), { description });
  };

  const handleDetected = async (payload: Extract<ZmodemEventPayload, { type: "detected" }>) => {
    const t = getT();
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
    if (disposed) return;

    if (payload.direction === "download") {
      terminal.write(`\r\n\x1b[36m[ZMODEM] ${t("zmodem.selectSaveDir")}\x1b[0m\r\n`);
      const dir = await openDialog({ directory: true, multiple: false });
      if (disposed) return;
      if (dir) {
        await invoke("zmodem_accept_download", {
          sessionId,
          saveDir: dir,
        });
      } else {
        await invoke("zmodem_cancel", { sessionId });
        terminal.write(`\r\n\x1b[33m[ZMODEM] ${t("zmodem.cancelled")}\x1b[0m\r\n`);
      }
      return;
    }

    uploadStarted = false;
    uploadFileName = "";
    uploadToastId = null;

    const pendingPaths = getPendingZmodemUploadPaths(sessionId);
    if (pendingPaths) {
      markPendingZmodemUploadActive(sessionId);
      // Files were already resolved in uploadFilesViaZmodem before rz was sent —
      // accept immediately so the remote rz won't time out.
      if (pendingPaths.length === 1) {
        uploadFileName = getLocalPathName(pendingPaths[0] ?? "", "uploaded_file");
        uploadToastId = toast.message(t("fileTransfer.uploadStarted", { name: uploadFileName }));
        uploadStarted = true;
      }
      await invoke("zmodem_accept_upload", {
        sessionId,
        filePaths: pendingPaths,
      });
      return;
    }

    const selected = await openDialog({ multiple: true });
    if (disposed) return;
    if (selected && selected.length > 0) {
      const filePaths = selected.map(String);

      // Probe remote directory and delete conflicting files so plain rz
      // never sees an existing file to prompt about.
      const { paths: resolvedPaths } = await probeAndResolveRemoteConflicts(
        sessionId,
        filePaths,
        getDuplicateStrategy(),
      );

      if (resolvedPaths.length === 0) {
        await invoke("zmodem_cancel", { sessionId });
        terminal.write(`\r\n\x1b[33m[ZMODEM] ${t("zmodem.cancelled")}\x1b[0m\r\n`);
        return;
      }

      if (resolvedPaths.length === 1) {
        uploadFileName = getLocalPathName(resolvedPaths[0] ?? "", "uploaded_file");
        uploadToastId = toast.message(t("fileTransfer.uploadStarted", { name: uploadFileName }));
        uploadStarted = true;
      }
      await invoke("zmodem_accept_upload", {
        sessionId,
        filePaths: resolvedPaths,
      });
    } else {
      await invoke("zmodem_cancel", { sessionId });
      terminal.write(`\r\n\x1b[33m[ZMODEM] ${t("zmodem.cancelled")}\x1b[0m\r\n`);
    }
  };

  return {
    handle(payload) {
      if (disposed) return;

      switch (payload.type) {
        case "detected":
          if (payload.direction === "upload" && hasPendingZmodemUpload(sessionId)) {
            markPendingZmodemUploadActive(sessionId);
          }
          void handleDetected(payload);
          break;
        case "progress":
          if (payload.direction === "upload") {
            markPendingZmodemUploadActive(sessionId);
          }
          pendingProgress = payload;
          scheduleProgressRender();
          break;
        case "complete": {
          flushProgress();
          if (payload.direction === "upload") {
            showUploadCompletedToast();
            completePendingZmodemUpload(sessionId);
          } else {
            terminal.write(`\r\n\x1b[32m[ZMODEM] ${getT()("zmodem.complete")}\x1b[0m\r\n`);
          }
          uploadStarted = false;
          uploadFileName = "";
          uploadToastId = null;
          break;
        }
        case "failed": {
          flushProgress();
          const isUpload = hasPendingZmodemUpload(sessionId) || uploadStarted;
          if (isUpload) {
            dismissUploadToast();
            if (payload.reason !== "cancelled") {
              toast.error(
                getT()("fileTransfer.uploadFailed", {
                  name: uploadFileName || "file",
                }),
                {
                  description: payload.reason,
                },
              );
            }
            failPendingZmodemUpload(sessionId, payload.reason);
          } else {
            terminal.write(
              `\r\n\x1b[31m[ZMODEM] ${getT()("zmodem.failed", {
                reason: payload.reason,
              })}\x1b[0m\r\n`,
            );
          }
          uploadStarted = false;
          uploadFileName = "";
          uploadToastId = null;
          break;
        }
      }
    },
    dispose() {
      disposed = true;
      pendingProgress = null;
      uploadStarted = false;
      uploadFileName = "";
      uploadToastId = null;
      clearProgressRaf();
      clearProgressTimer();
    },
  };
}
