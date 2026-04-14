import { listen } from "@tauri-apps/api/event";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { toast } from "sonner";
import { invoke } from "@/lib/invoke";

export type TransferDirection = "upload" | "download";
export type TransferStatus = "transferring" | "paused" | "completed" | "error" | "cancelled";

export interface TransferItem {
  id: string;
  sessionId: string;
  fileName: string;
  remotePath: string;
  localPath: string;
  direction: TransferDirection;
  status: TransferStatus;
  size: number;
  bytesTransferred: number;
  totalSize: number;
  error?: string;
  timestamp: number;
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
  status: string;
  size: number;
  bytes_transferred: number;
  total_size: number;
  error_msg?: string;
}

export function TransferProvider({ children }: { children: ReactNode }) {
  const [transfers, setTransfers] = useState<TransferItem[]>([]);

  useEffect(() => {
    const unlisten = listen<TransferEventPayload>("transfer-event", (e) => {
      const p = e.payload;

      if (p.status === "started") {
        setTransfers((prev) => [
          {
            id: p.id,
            sessionId: p.session_id,
            fileName: p.file_name,
            remotePath: p.remote_path,
            localPath: p.local_path,
            direction: p.direction as TransferDirection,
            status: "transferring",
            size: 0,
            bytesTransferred: 0,
            totalSize: p.total_size,
            timestamp: Date.now(),
          },
          ...prev,
        ]);
      } else if (p.status === "progress") {
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === p.id
              ? {
                  ...t,
                  bytesTransferred: p.bytes_transferred,
                  totalSize: p.total_size,
                }
              : t,
          ),
        );
      } else if (p.status === "paused") {
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === p.id
              ? {
                  ...t,
                  status: "paused",
                  bytesTransferred: p.bytes_transferred,
                  totalSize: p.total_size,
                }
              : t,
          ),
        );
      } else if (p.status === "resumed") {
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === p.id
              ? {
                  ...t,
                  status: "transferring",
                  bytesTransferred: p.bytes_transferred,
                  totalSize: p.total_size,
                }
              : t,
          ),
        );
      } else if (p.status === "cancelled") {
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === p.id
              ? {
                  ...t,
                  status: "cancelled",
                  bytesTransferred: p.bytes_transferred,
                  totalSize: p.total_size,
                  error: undefined,
                }
              : t,
          ),
        );
      } else {
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === p.id
              ? {
                  ...t,
                  status: p.status as TransferStatus,
                  size: p.size,
                  bytesTransferred: p.bytes_transferred,
                  totalSize: p.total_size,
                  error: p.error_msg,
                }
              : t,
          ),
        );
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const clearCompleted = useCallback(() => {
    setTransfers((prev) => prev.filter((t) => t.status !== "completed"));
  }, []);

  const clearAll = useCallback(() => {
    setTransfers([]);
  }, []);

  const removeTransfer = useCallback((id: string) => {
    setTransfers((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const pauseTransfer = useCallback(async (id: string) => {
    try {
      await invoke("pause_transfer", { transferId: id });
    } catch (error) {
      toast.error(String(error));
    }
  }, []);

  const resumeTransfer = useCallback(async (id: string) => {
    try {
      await invoke("resume_transfer", { transferId: id });
    } catch (error) {
      toast.error(String(error));
    }
  }, []);

  const cancelTransfer = useCallback(async (id: string) => {
    try {
      await invoke("cancel_transfer", { transferId: id });
    } catch (error) {
      toast.error(String(error));
    }
  }, []);

  const retryTransfer = useCallback(async (item: TransferItem) => {
    try {
      if (item.direction === "upload") {
        await invoke("upload_local_file", {
          sessionId: item.sessionId,
          localPath: item.localPath,
          remotePath: item.remotePath,
        });
      } else {
        await invoke("download_remote_file", {
          sessionId: item.sessionId,
          remotePath: item.remotePath,
          localPath: item.localPath,
        });
      }
    } catch (error) {
      toast.error(String(error));
    }
  }, []);

  return (
    <TransferContext.Provider
      value={{
        transfers,
        clearCompleted,
        clearAll,
        removeTransfer,
        pauseTransfer,
        resumeTransfer,
        cancelTransfer,
        retryTransfer,
      }}
    >
      {children}
    </TransferContext.Provider>
  );
}

export function useTransfer(): TransferContextValue {
  const ctx = useContext(TransferContext);
  if (!ctx) throw new Error("useTransfer must be used within TransferProvider");
  return ctx;
}
