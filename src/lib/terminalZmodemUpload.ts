import { toast } from "sonner";
import { getLocalPathName } from "@/components/panel/file-explorer/model";
import i18n from "@/i18n";
import { invoke } from "@/lib/invoke";
import { buildTerminalCommandInput, sendSessionInput } from "@/lib/sessionInput";
import { showTransferDuplicatePrompt } from "@/lib/transferDuplicatePrompt";

const ZMODEM_UPLOAD_TIMEOUT_MS = 60_000;

type PendingUploadPhase = "waiting" | "active";

type PendingUpload = {
  sessionId: string;
  filePaths: string[];
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: number | null;
  phase: PendingUploadPhase;
};

let pendingUpload: PendingUpload | null = null;
let preparingUploadToastId: string | number | null = null;

function clearWaitingTimeout() {
  if (pendingUpload?.timeoutId !== null && pendingUpload?.timeoutId !== undefined) {
    window.clearTimeout(pendingUpload.timeoutId);
    pendingUpload.timeoutId = null;
  }
}

function clearPendingUpload() {
  clearWaitingTimeout();
  pendingUpload = null;
  if (preparingUploadToastId !== null) {
    toast.dismiss(preparingUploadToastId);
    preparingUploadToastId = null;
  }
}

export function getPendingZmodemUploadPaths(sessionId: string): string[] | null {
  if (!pendingUpload || pendingUpload.sessionId !== sessionId) {
    return null;
  }
  return pendingUpload.filePaths;
}

export function hasPendingZmodemUpload(sessionId: string): boolean {
  return pendingUpload?.sessionId === sessionId;
}

export function markPendingZmodemUploadActive(sessionId: string) {
  if (!pendingUpload || pendingUpload.sessionId !== sessionId) {
    return;
  }
  clearWaitingTimeout();
  pendingUpload.phase = "active";
  if (preparingUploadToastId !== null) {
    toast.dismiss(preparingUploadToastId);
    preparingUploadToastId = null;
  }
}

export function completePendingZmodemUpload(sessionId: string) {
  if (!pendingUpload || pendingUpload.sessionId !== sessionId) {
    return;
  }
  const { resolve } = pendingUpload;
  clearPendingUpload();
  resolve();
}

export function failPendingZmodemUpload(sessionId: string, reason: string) {
  if (!pendingUpload || pendingUpload.sessionId !== sessionId) {
    return;
  }
  const { reject } = pendingUpload;
  clearPendingUpload();
  reject(new Error(reason));
}

export function cancelPendingZmodemUpload(sessionId?: string) {
  if (!pendingUpload) return;
  if (sessionId && pendingUpload.sessionId !== sessionId) return;
  failPendingZmodemUpload(pendingUpload.sessionId, "cancelled");
}

const SFTP_PROBE_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

export interface ConflictProbeResult {
  paths: string[];
  probeSkipped: boolean;
}

/**
 * Probe the remote working directory for files that match the local file
 * names. Resolves conflicts according to the configured duplicate strategy.
 *
 * - "overwrite" / "rename": delete remote files silently, include all local paths
 * - "skip": silently exclude conflicting local paths
 * - "ask" (default): prompt the user per conflict
 *
 * SFTP operations are time-boxed — if the SFTP channel is busy (e.g. the
 * file explorer panel is open), the probe is skipped, all files are uploaded
 * without conflict detection, and `probeSkipped` is set to true.
 */
export async function probeAndResolveRemoteConflicts(
  sessionId: string,
  filePaths: string[],
  duplicateStrategy = "ask",
): Promise<ConflictProbeResult> {
  if (filePaths.length === 0) return { paths: [], probeSkipped: false };

  // Resolve remote upload directory (terminal CWD is a shell operation, not SFTP).
  const cwd = await withTimeout(
    invoke<string>("get_terminal_cwd", { sessionId }).catch(() => null),
    SFTP_PROBE_TIMEOUT_MS,
    null,
  );

  // If CWD fails (non-SSH or timeout), try home dir via SFTP with timeout.
  const home = !cwd
    ? await withTimeout(
        invoke<string>("get_home_dir", { sessionId }).catch(() => "/"),
        SFTP_PROBE_TIMEOUT_MS,
        null as string | null,
      )
    : null;
  const remoteDir = (cwd || home || "/").replace(/\/+$/, "") || "/";

  // List remote directory (SFTP, time-boxed).
  const entries = await withTimeout(
    invoke<{ name: string; is_dir: boolean }[] | null>("list_remote_dir", {
      sessionId,
      path: remoteDir,
    }).catch(() => null),
    SFTP_PROBE_TIMEOUT_MS,
    null as { name: string; is_dir: boolean }[] | null,
  );

  // If the SFTP probe timed out, skip conflict detection entirely.
  if (entries === null) {
    toast.message(i18n.t("zmodem.sftpProbeSkipped"));
    return { paths: filePaths, probeSkipped: true };
  }

  const existingNames = new Set(entries.map((e) => e.name));

  // Separate conflicting and clean files.
  const conflicts: string[] = [];
  const clean: string[] = [];
  for (const fp of filePaths) {
    const name = getLocalPathName(fp, "file");
    if (existingNames.has(name)) {
      conflicts.push(fp);
    } else {
      clean.push(fp);
    }
  }

  if (conflicts.length === 0) return { paths: filePaths, probeSkipped: false };

  // Auto-resolve based on configured strategy.
  if (duplicateStrategy === "skip") {
    return { paths: clean, probeSkipped: false };
  }

  if (duplicateStrategy === "overwrite" || duplicateStrategy === "rename") {
    for (const fp of conflicts) {
      const name = getLocalPathName(fp, "file");
      const remotePath = remoteDir === "/" ? `/${name}` : `${remoteDir}/${name}`;
      await withTimeout(
        invoke("delete_remote_file", { sessionId, path: remotePath }).catch(() => {}),
        SFTP_PROBE_TIMEOUT_MS,
        undefined,
      );
    }
    return { paths: filePaths, probeSkipped: false };
  }

  // "ask" — prompt the user for each conflict.
  const resolved: string[] = [...clean];

  for (const fp of conflicts) {
    const name = getLocalPathName(fp, "file");
    const remotePath = remoteDir === "/" ? `/${name}` : `${remoteDir}/${name}`;

    const choice = await showTransferDuplicatePrompt({
      requestId: crypto.randomUUID(),
      sessionId,
      remotePath,
      fileName: name,
      isDirectory: false,
    });

    if (choice === "overwrite") {
      await withTimeout(
        invoke("delete_remote_file", { sessionId, path: remotePath }).catch(() => {}),
        SFTP_PROBE_TIMEOUT_MS,
        undefined,
      );
      resolved.push(fp);
    }
    // "skip" → don't add.
  }

  return { paths: resolved, probeSkipped: false };
}

export async function uploadFilesViaZmodem(
  sessionId: string,
  filePaths: string[],
  duplicateStrategy = "ask",
): Promise<void> {
  if (filePaths.length === 0) {
    return Promise.resolve();
  }

  // Cancel any previous pending upload.
  if (pendingUpload?.sessionId === sessionId && pendingUpload.phase === "waiting") {
    clearPendingUpload();
    await invoke("zmodem_cancel", { sessionId }).catch(() => {});
  } else {
    cancelPendingZmodemUpload(sessionId);
  }

  // Show immediate feedback so the user knows the drop was received,
  // even while the SFTP probe may be slow (e.g. file explorer panel open).
  if (preparingUploadToastId !== null) {
    toast.dismiss(preparingUploadToastId);
  }
  preparingUploadToastId = toast.message(
    i18n.t("zmodem.preparingUpload", { count: filePaths.length }),
  );

  // Netcatty approach: probe remote directory and delete conflicting files
  // BEFORE sending `rz`, so the remote rz never sees an existing file to
  // prompt about.  If the SFTP channel is busy (e.g. file explorer panel is
  // open), the probe is time-boxed and we fall through.
  const conflict = await probeAndResolveRemoteConflicts(sessionId, filePaths, duplicateStrategy);

  if (conflict.paths.length === 0) {
    if (preparingUploadToastId !== null) {
      toast.dismiss(preparingUploadToastId);
      preparingUploadToastId = null;
    }
    throw new Error("All files were skipped or probe failed");
  }

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      if (pendingUpload?.sessionId !== sessionId || pendingUpload.phase !== "waiting") {
        return;
      }
      clearPendingUpload();
      void invoke("zmodem_cancel", { sessionId }).catch(() => {});
      reject(new Error("zmodem timeout"));
    }, ZMODEM_UPLOAD_TIMEOUT_MS);

    pendingUpload = {
      sessionId,
      filePaths: conflict.paths,
      resolve,
      reject,
      timeoutId,
      phase: "waiting",
    };

    sendSessionInput(sessionId, buildTerminalCommandInput("rz", true)).catch((error) => {
      if (pendingUpload?.sessionId !== sessionId) return;
      clearPendingUpload();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
