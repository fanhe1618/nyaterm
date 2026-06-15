import { listen } from "@tauri-apps/api/event";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useApp } from "@/context/AppContext";
import { invoke } from "@/lib/invoke";
import { filterEnqueueUploadRequests } from "@/lib/transferDuplicateResolution";

export type TransferDirection = "upload" | "download";
export type TransferKind = "file" | "directory";
export type TransferStatus =
  | "queued"
  | "transferring"
  | "paused"
  | "completed"
  | "error"
  | "cancelled";

export interface EnqueueUploadRequest {
  sessionId: string;
  fileName: string;
  localPath: string;
  remotePath: string;
  kind: TransferKind;
  duplicateStrategyOverride?: string;
}

export interface EnqueueDownloadRequest {
  sessionId: string;
  fileName: string;
  localPath: string;
  remotePath: string;
  kind: TransferKind;
}

interface QueuedTransferRequest {
  sessionId: string;
  fileName: string;
  localPath: string;
  remotePath: string;
  kind: TransferKind;
  direction: TransferDirection;
  duplicateStrategyOverride?: string;
}

export interface TransferItem {
  id: string;
  sessionId: string;
  fileName: string;
  remotePath: string;
  localPath: string;
  direction: TransferDirection;
  kind: TransferKind;
  parentId?: string;
  status: TransferStatus;
  size: number;
  bytesTransferred: number;
  totalSize: number;
  itemCountTotal?: number;
  itemCountCompleted?: number;
  error?: string;
  timestamp: number;
  queueState?: "pending" | "running";
}

interface TransferContextValue {
  transfers: TransferItem[];
  clearCompleted: () => void;
  clearAll: () => void;
  removeTransfer: (id: string) => void;
  pauseTransfer: (id: string) => Promise<void>;
  resumeTransfer: (id: string) => Promise<void>;
  cancelTransfer: (id: string) => Promise<void>;
  retryTransfer: (item: TransferItem) => Promise<void>;
  enqueueUploads: (uploads: EnqueueUploadRequest[]) => string[];
  enqueueDownloads: (downloads: EnqueueDownloadRequest[]) => string[];
}

const TransferContext = createContext<TransferContextValue | null>(null);

/** Backend event payload shape. */
interface TransferEventPayload {
  id: string;
  session_id: string;
  file_name: string;
  remote_path: string;
  local_path: string;
  direction: string;
  kind?: string;
  parent_id?: string;
  status: string;
  size: number;
  bytes_transferred: number;
  total_size: number;
  item_count_total?: number;
  item_count_completed?: number;
  error_msg?: string;
}

function createTransferId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `transfer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clampTransferConcurrency(value: number) {
  const normalized = Number.isFinite(value) ? Math.floor(value) : 1;
  return Math.min(10, Math.max(1, normalized));
}

function getBackgroundTransferConcurrency(value: number) {
  const configured = clampTransferConcurrency(value);
  return configured > 1 ? configured - 1 : 1;
}

export function TransferProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { appSettings } = useApp();
  const [transferMap, setTransferMap] = useState<Map<string, TransferItem>>(() => new Map());
  const transferMapRef = useRef(transferMap);
  const queuedTransfersRef = useRef<Map<string, QueuedTransferRequest>>(new Map());
  const parkedTransferIdsRef = useRef<Set<string>>(new Set());
  const uploadFolderToastIdsRef = useRef<Map<string, string | number>>(new Map());
  const [queueRevision, setQueueRevision] = useState(0);

  const transfers = useMemo(() => Array.from(transferMap.values()), [transferMap]);

  useEffect(() => {
    transferMapRef.current = transferMap;
  }, [transferMap]);

  useEffect(() => {
    const unlisten = listen<TransferEventPayload>("transfer-event", (e) => {
      const p = e.payload;
      const kind = (p.kind ?? "file") as TransferKind;

      if (p.status === "started") {
        if (p.parent_id) {
          return;
        }
        setTransferMap((prev) => {
          const next = new Map(prev);
          const existing = next.get(p.id);
          next.set(p.id, {
            ...existing,
            id: p.id,
            sessionId: p.session_id,
            fileName: p.file_name,
            remotePath: p.remote_path,
            localPath: p.local_path,
            direction: p.direction as TransferDirection,
            kind,
            parentId: p.parent_id,
            status: "transferring",
            size: 0,
            bytesTransferred: 0,
            totalSize: p.total_size,
            itemCountTotal: p.item_count_total,
            itemCountCompleted: p.item_count_completed,
            timestamp: existing?.timestamp ?? Date.now(),
            queueState:
              existing?.queueState ??
              (queuedTransfersRef.current.has(p.id) ? "running" : undefined),
          });
          return next;
        });
        return;
      }

      setTransferMap((prev) => {
        const existing = prev.get(p.id);
        if (!existing) return prev;
        const next = new Map(prev);
        let updated: TransferItem;

        if (p.status === "progress") {
          updated = {
            ...existing,
            status: "transferring",
            bytesTransferred: p.bytes_transferred,
            totalSize: p.total_size,
            itemCountTotal: p.item_count_total ?? existing.itemCountTotal,
            itemCountCompleted: p.item_count_completed ?? existing.itemCountCompleted,
          };
        } else if (p.status === "paused") {
          updated = {
            ...existing,
            status: "paused",
            bytesTransferred: p.bytes_transferred,
            totalSize: p.total_size,
            itemCountTotal: p.item_count_total ?? existing.itemCountTotal,
            itemCountCompleted: p.item_count_completed ?? existing.itemCountCompleted,
          };
        } else if (p.status === "resumed") {
          updated = {
            ...existing,
            status: "transferring",
            bytesTransferred: p.bytes_transferred,
            totalSize: p.total_size,
            itemCountTotal: p.item_count_total ?? existing.itemCountTotal,
            itemCountCompleted: p.item_count_completed ?? existing.itemCountCompleted,
          };
        } else if (p.status === "cancelled") {
          updated = {
            ...existing,
            status: "cancelled",
            bytesTransferred: p.bytes_transferred,
            totalSize: p.total_size,
            itemCountTotal: p.item_count_total ?? existing.itemCountTotal,
            itemCountCompleted: p.item_count_completed ?? existing.itemCountCompleted,
            queueState: undefined,
            error: undefined,
          };
        } else {
          updated = {
            ...existing,
            status: p.status as TransferStatus,
            size: p.size,
            bytesTransferred: p.bytes_transferred,
            totalSize: p.total_size,
            itemCountTotal: p.item_count_total ?? existing.itemCountTotal,
            itemCountCompleted: p.item_count_completed ?? existing.itemCountCompleted,
            queueState:
              p.status === "completed" || p.status === "error" ? undefined : existing.queueState,
            error: p.error_msg,
          };
        }

        next.set(p.id, updated);
        return next;
      });

      if (
        p.status === "paused" ||
        p.status === "cancelled" ||
        p.status === "completed" ||
        p.status === "error"
      ) {
        if (p.status !== "paused") {
          parkedTransferIdsRef.current.delete(p.id);
          queuedTransfersRef.current.delete(p.id);
        }
        setQueueRevision((revision) => revision + 1);
      }

      if (p.status === "completed" && !p.parent_id) {
        if (p.direction === "download") {
          toast.success(
            kind === "directory"
              ? t("fileTransfer.downloadFolderCompleted")
              : t("fileTransfer.downloadCompleted"),
            {
              description: p.local_path,
            },
          );
          return;
        }

        if (p.direction === "upload") {
          const folderToastId = uploadFolderToastIdsRef.current.get(p.id);
          if (folderToastId !== undefined) {
            toast.dismiss(folderToastId);
            uploadFolderToastIdsRef.current.delete(p.id);
          }
          toast.success(
            kind === "directory"
              ? t("fileTransfer.uploadFolderCompleted")
              : t("fileTransfer.uploadCompleted"),
            {
              description: p.remote_path,
            },
          );
        }
        return;
      }

      if (
        p.status === "started" &&
        p.direction === "upload" &&
        !p.parent_id &&
        kind === "directory"
      ) {
        const toastId = toast.message(t("fileTransfer.uploadFolderStarted", { name: p.file_name }));
        uploadFolderToastIdsRef.current.set(p.id, toastId);
        return;
      }

      if (p.status === "error" && p.direction === "upload" && !p.parent_id) {
        const folderToastId = uploadFolderToastIdsRef.current.get(p.id);
        if (folderToastId !== undefined) {
          toast.dismiss(folderToastId);
          uploadFolderToastIdsRef.current.delete(p.id);
        }
        toast.error(
          kind === "directory"
            ? t("fileTransfer.uploadFolderFailed", { name: p.file_name })
            : t("fileTransfer.uploadFailed", { name: p.file_name }),
          {
            description: p.error_msg,
          },
        );
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  useEffect(() => {
    void queueRevision;
    const maxRunningByDirection: Record<TransferDirection, number> = {
      download: getBackgroundTransferConcurrency(appSettings.transfer.download_threads),
      upload: getBackgroundTransferConcurrency(appSettings.transfer.upload_threads),
    };
    const runningByDirection: Record<TransferDirection, number> = {
      download: 0,
      upload: 0,
    };

    for (const transfer of transferMap.values()) {
      if (transfer.queueState === "running" && transfer.status === "transferring") {
        runningByDirection[transfer.direction] += 1;
      }
    }

    const queuedCandidates = Array.from(transferMap.values())
      .filter(
        (transfer) =>
          queuedTransfersRef.current.has(transfer.id) ||
          parkedTransferIdsRef.current.has(transfer.id),
      )
      .filter((transfer) => transfer.status === "queued");

    for (const nextQueued of queuedCandidates) {
      const direction = nextQueued.direction;
      if (runningByDirection[direction] >= maxRunningByDirection[direction]) {
        continue;
      }

      if (parkedTransferIdsRef.current.has(nextQueued.id)) {
        parkedTransferIdsRef.current.delete(nextQueued.id);
        runningByDirection[direction] += 1;
        setTransferMap((prev) => {
          const existing = prev.get(nextQueued.id);
          if (!existing || existing.status !== "queued") {
            return prev;
          }
          const next = new Map(prev);
          next.set(nextQueued.id, {
            ...existing,
            status: "transferring",
            queueState: "running",
            error: undefined,
          });
          return next;
        });

        void invoke("resume_transfer", { transferId: nextQueued.id }).catch((error) => {
          toast.error(String(error));
          setTransferMap((prev) => {
            const existing = prev.get(nextQueued.id);
            if (!existing || existing.status === "completed" || existing.status === "cancelled") {
              return prev;
            }
            const next = new Map(prev);
            next.set(nextQueued.id, {
              ...existing,
              status: "error",
              queueState: undefined,
              error: String(error),
            });
            return next;
          });
          setQueueRevision((revision) => revision + 1);
        });
        continue;
      }

      const request = queuedTransfersRef.current.get(nextQueued.id);
      if (!request) {
        continue;
      }

      queuedTransfersRef.current.delete(nextQueued.id);
      runningByDirection[direction] += 1;
      setTransferMap((prev) => {
        const existing = prev.get(nextQueued.id);
        if (!existing || existing.status !== "queued") {
          return prev;
        }
        const next = new Map(prev);
        next.set(nextQueued.id, {
          ...existing,
          status: "transferring",
          queueState: "running",
          error: undefined,
        });
        return next;
      });

      void (async () => {
        try {
          if (request.direction === "upload" && request.kind === "directory") {
            await invoke("upload_local_directory", {
              sessionId: request.sessionId,
              localPath: request.localPath,
              remotePath: request.remotePath,
              transferId: nextQueued.id,
              duplicateStrategyOverride: request.duplicateStrategyOverride,
            });
          } else if (request.direction === "upload") {
            await invoke("upload_local_file", {
              sessionId: request.sessionId,
              localPath: request.localPath,
              remotePath: request.remotePath,
              transferId: nextQueued.id,
              duplicateStrategyOverride: request.duplicateStrategyOverride,
            });
          } else if (request.kind === "directory") {
            await invoke("download_remote_directory", {
              sessionId: request.sessionId,
              remotePath: request.remotePath,
              localPath: request.localPath,
              transferId: nextQueued.id,
            });
          } else {
            await invoke("download_remote_file", {
              sessionId: request.sessionId,
              remotePath: request.remotePath,
              localPath: request.localPath,
              transferId: nextQueued.id,
            });
          }
        } catch (error) {
          setTransferMap((prev) => {
            const existing = prev.get(nextQueued.id);
            if (
              !existing ||
              existing.status === "completed" ||
              existing.status === "cancelled" ||
              existing.status === "error"
            ) {
              return prev;
            }
            const next = new Map(prev);
            next.set(nextQueued.id, {
              ...existing,
              status: "error",
              queueState: undefined,
              error: String(error),
            });
            return next;
          });
        } finally {
          setQueueRevision((revision) => revision + 1);
        }
      })();
    }
  }, [
    appSettings.transfer.download_threads,
    appSettings.transfer.upload_threads,
    queueRevision,
    transferMap,
  ]);

  const clearCompleted = useCallback(() => {
    setTransferMap((prev) => {
      const next = new Map(prev);
      for (const [id, t] of prev) {
        if (t.status === "completed") next.delete(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, []);

  const clearAll = useCallback(() => {
    queuedTransfersRef.current.clear();
    parkedTransferIdsRef.current.clear();
    setTransferMap(new Map());
  }, []);

  const removeTransfer = useCallback((id: string) => {
    if (parkedTransferIdsRef.current.has(id)) {
      parkedTransferIdsRef.current.delete(id);
      void invoke("cancel_transfer", { transferId: id }).catch((error) => {
        toast.error(String(error));
      });
    }
    queuedTransfersRef.current.delete(id);
    setTransferMap((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const pauseTransfer = useCallback(async (id: string) => {
    const existing = transferMapRef.current.get(id);
    if (queuedTransfersRef.current.has(id) && existing?.status === "queued") {
      setTransferMap((prev) => {
        const queued = prev.get(id);
        if (!queued || queued.status !== "queued") return prev;
        const next = new Map(prev);
        next.set(id, { ...queued, status: "paused" });
        return next;
      });
      return;
    }

    if (parkedTransferIdsRef.current.has(id) && existing?.status === "queued") {
      setTransferMap((prev) => {
        const queued = prev.get(id);
        if (!queued || queued.status !== "queued") return prev;
        const next = new Map(prev);
        next.set(id, { ...queued, status: "paused", queueState: "running" });
        return next;
      });
      setQueueRevision((revision) => revision + 1);
      return;
    }

    try {
      await invoke("pause_transfer", { transferId: id });
    } catch (error) {
      toast.error(String(error));
    }
  }, []);

  const resumeTransfer = useCallback(async (id: string) => {
    const existing = transferMapRef.current.get(id);
    if (queuedTransfersRef.current.has(id) && existing?.status === "paused") {
      setTransferMap((prev) => {
        const queued = prev.get(id);
        if (!queued || queued.status !== "paused") return prev;
        const next = new Map(prev);
        next.set(id, { ...queued, status: "queued" });
        return next;
      });
      setQueueRevision((revision) => revision + 1);
      return;
    }

    if (existing?.queueState === "running" && existing.status === "paused") {
      parkedTransferIdsRef.current.add(id);
      setTransferMap((prev) => {
        const paused = prev.get(id);
        if (!paused || paused.status !== "paused") return prev;
        const next = new Map(prev);
        next.set(id, { ...paused, status: "queued", queueState: "pending" });
        return next;
      });
      setQueueRevision((revision) => revision + 1);
      return;
    }

    try {
      await invoke("resume_transfer", { transferId: id });
    } catch (error) {
      toast.error(String(error));
    }
  }, []);

  const cancelTransfer = useCallback(async (id: string) => {
    const existing = transferMapRef.current.get(id);
    if (queuedTransfersRef.current.has(id)) {
      queuedTransfersRef.current.delete(id);
      setTransferMap((prev) => {
        const queued = prev.get(id);
        if (!queued || queued.status === "completed" || queued.status === "error") return prev;
        const next = new Map(prev);
        next.set(id, {
          ...queued,
          status: "cancelled",
          queueState: undefined,
          error: undefined,
        });
        return next;
      });
      setQueueRevision((revision) => revision + 1);
      return;
    }

    if (parkedTransferIdsRef.current.has(id)) {
      parkedTransferIdsRef.current.delete(id);
      try {
        await invoke("cancel_transfer", { transferId: id });
      } catch (error) {
        toast.error(String(error));
      }
      setTransferMap((prev) => {
        const parked = prev.get(id);
        if (!parked || parked.status === "completed" || parked.status === "error") return prev;
        const next = new Map(prev);
        next.set(id, {
          ...parked,
          status: "cancelled",
          queueState: undefined,
          error: undefined,
        });
        return next;
      });
      setQueueRevision((revision) => revision + 1);
      return;
    }

    if (!existing) return;

    try {
      await invoke("cancel_transfer", { transferId: id });
      setTransferMap((prev) => {
        const existing = prev.get(id);
        if (!existing || existing.status === "completed" || existing.status === "error") {
          return prev;
        }
        const next = new Map(prev);
        next.set(id, {
          ...existing,
          status: "cancelled",
          queueState: undefined,
          error: undefined,
        });
        return next;
      });
      setQueueRevision((revision) => revision + 1);
    } catch (error) {
      toast.error(String(error));
    }
  }, []);

  const retryTransfer = useCallback(async (item: TransferItem) => {
    parkedTransferIdsRef.current.delete(item.id);
    queuedTransfersRef.current.set(item.id, {
      sessionId: item.sessionId,
      fileName: item.fileName,
      localPath: item.localPath,
      remotePath: item.remotePath,
      kind: item.kind,
      direction: item.direction,
    });
    setTransferMap((prev) => {
      const next = new Map(prev);
      next.set(item.id, {
        ...item,
        status: "queued",
        bytesTransferred: 0,
        totalSize: 0,
        itemCountCompleted: undefined,
        itemCountTotal: undefined,
        queueState: "pending",
        error: undefined,
        timestamp: Date.now(),
      });
      return next;
    });
    setQueueRevision((revision) => revision + 1);
  }, []);

  const enqueueTransfers = useCallback((transfers: QueuedTransferRequest[]) => {
    const normalizedTransfers = transfers.filter(
      (transfer) =>
        transfer.sessionId && transfer.localPath && transfer.remotePath && transfer.fileName,
    );
    if (normalizedTransfers.length === 0) {
      return [];
    }

    const ids = normalizedTransfers.map(() => createTransferId());
    setTransferMap((prev) => {
      const next = new Map(prev);
      normalizedTransfers.forEach((transfer, index) => {
        const id = ids[index];
        queuedTransfersRef.current.set(id, transfer);
        next.set(id, {
          id,
          sessionId: transfer.sessionId,
          fileName: transfer.fileName,
          remotePath: transfer.remotePath,
          localPath: transfer.localPath,
          direction: transfer.direction,
          kind: transfer.kind,
          status: "queued",
          size: 0,
          bytesTransferred: 0,
          totalSize: 0,
          timestamp: Date.now() + index,
          queueState: "pending",
        });
      });
      return next;
    });
    setQueueRevision((revision) => revision + 1);
    return ids;
  }, []);

  const enqueueUploads = useCallback(
    (uploads: EnqueueUploadRequest[]) => {
      void (async () => {
        const filtered = await filterEnqueueUploadRequests(
          uploads,
          appSettings.transfer.duplicate_strategy,
        );
        if (filtered.length === 0) {
          return;
        }
        enqueueTransfers(filtered.map((upload) => ({ ...upload, direction: "upload" as const })));
      })();
      return [];
    },
    [appSettings.transfer.duplicate_strategy, enqueueTransfers],
  );

  const enqueueDownloads = useCallback(
    (downloads: EnqueueDownloadRequest[]) =>
      enqueueTransfers(
        downloads.map((download) => ({ ...download, direction: "download" as const })),
      ),
    [enqueueTransfers],
  );

  const contextValue = useMemo(
    () => ({
      transfers,
      clearCompleted,
      clearAll,
      removeTransfer,
      pauseTransfer,
      resumeTransfer,
      cancelTransfer,
      retryTransfer,
      enqueueUploads,
      enqueueDownloads,
    }),
    [
      transfers,
      clearCompleted,
      clearAll,
      removeTransfer,
      pauseTransfer,
      resumeTransfer,
      cancelTransfer,
      retryTransfer,
      enqueueUploads,
      enqueueDownloads,
    ],
  );

  return <TransferContext.Provider value={contextValue}>{children}</TransferContext.Provider>;
}

export function useTransfer(): TransferContextValue {
  const ctx = useContext(TransferContext);
  if (!ctx) throw new Error("useTransfer must be used within TransferProvider");
  return ctx;
}
