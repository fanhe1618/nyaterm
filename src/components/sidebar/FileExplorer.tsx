import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { tempDir, join } from "@tauri-apps/api/path";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath as openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import AutoUploadDialog, { AutoUploadDialogData } from "../dialog/AutoUploadDialog";
import MoveDialog, { MoveDialogData } from "../dialog/MoveDialog";
import PropertiesDialog, { PropertiesDialogData } from "../dialog/PropertiesDialog";
import RenameDialog, { RenameDialogData } from "../dialog/RenameDialog";
import { useTranslation } from "react-i18next";
import { useApp } from "../../context/AppContext";
import { useToast } from "../toast/ToastContext";

interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
  permissions: string;
}

interface FileExplorerProps {
  activeSessionId: string | null;
}

function getFileIcon(entry: FileEntry): { icon: string; color: string } {
  if (entry.is_dir) return { icon: "folder", color: "#fbbf24" }; // amber-400

  const ext = entry.name.includes('.') ? entry.name.split(".").pop()?.toLowerCase() ?? "" : "";

  switch (ext) {
    // --- Web & Scripting ---
    case "js":
    case "jsx":
      return { icon: "javascript", color: "#facc15" }; // yellow-400
    case "ts":
    case "tsx":
      return { icon: "code", color: "#60a5fa" }; // blue-400
    case "html":
    case "htm":
      return { icon: "html", color: "#f97316" }; // orange-500
    case "css":
    case "scss":
    case "less":
      return { icon: "css", color: "#38bdf8" }; // sky-400
    case "py":
    case "pyc":
      return { icon: "terminal", color: "#4ade80" }; // green-400
    case "sh":
    case "bash":
    case "zsh":
    case "bat":
    case "ps1":
      return { icon: "terminal", color: "#22c55e" }; // green-500
    case "rs":
    case "go":
    case "c":
    case "cpp":
    case "java":
      return { icon: "code", color: "#f87171" }; // red-400

    // --- Data & Config ---
    case "json":
    case "yaml":
    case "yml":
    case "toml":
    case "xml":
      return { icon: "data_object", color: "#a78bfa" }; // violet-400
    case "ini":
    case "env":
    case "conf":
    case "config":
      return { icon: "settings", color: "var(--df-text-muted)" };
    case "sql":
    case "db":
    case "sqlite":
      return { icon: "storage", color: "#94a3b8" }; // slate-400

    // --- Text & Documents ---
    case "md":
    case "mdx":
    case "txt":
    case "rtf":
      return { icon: "article", color: "var(--df-text-dimmed)" };
    case "doc":
    case "docx":
      return { icon: "description", color: "#3b82f6" }; // blue-500
    case "pdf":
      return { icon: "picture_as_pdf", color: "#ef4444" }; // red-500
    case "xls":
    case "xlsx":
    case "csv":
      return { icon: "table_chart", color: "#16a34a" }; // green-600
    case "ppt":
    case "pptx":
      return { icon: "co_present", color: "#ea580c" }; // orange-600

    // --- Media ---
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "svg":
    case "ico":
      return { icon: "image", color: "#ec4899" }; // pink-500
    case "mp4":
    case "mkv":
    case "avi":
    case "mov":
    case "webm":
      return { icon: "movie", color: "#8b5cf6" }; // violet-500
    case "mp3":
    case "wav":
    case "ogg":
    case "flac":
      return { icon: "audio_file", color: "#f59e0b" }; // amber-500

    // --- Archives ---
    case "zip":
    case "rar":
    case "7z":
    case "tar":
    case "gz":
    case "bz2":
    case "xz":
      return { icon: "folder_zip", color: "#f59e0b" }; // amber-500

    // --- Misc ---
    case "exe":
    case "apk":
    case "dmg":
    case "iso":
      return { icon: "apps", color: "#14b8a6" }; // teal-500
    case "lock":
      return { icon: "lock", color: "var(--df-text-muted)" };

    default:
      if (entry.name.startsWith('.')) {
        return { icon: "settings", color: "var(--df-text-muted)" };
      }
      return { icon: "insert_drive_file", color: "var(--df-text-muted)" };
  }
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Remote file browser for active SSH session. Lists dirs/files, supports navigation. */
export default function FileExplorer({ activeSessionId }: FileExplorerProps) {
  const { t } = useTranslation();
  const { showContextMenu } = useApp();
  const toast = useToast();

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [homeDir, setHomeDir] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [pathInputText, setPathInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [renameDialogData, setRenameDialogData] = useState<RenameDialogData | null>(null);
  const [moveDialogData, setMoveDialogData] = useState<MoveDialogData | null>(null);
  const [autoUploadDialogData, setAutoUploadDialogData] = useState<AutoUploadDialogData | null>(null);
  const [propertiesDialogData, setPropertiesDialogData] = useState<PropertiesDialogData | null>(null);
  const [, setAlwaysUploadFiles] = useState<Set<string>>(new Set());

  useEffect(() => {
    const unlisten = listen<{ session_id: string; local_path: string; remote_path: string }>("file-modified", (e) => {
      const { session_id, local_path, remote_path } = e.payload;
      const watchKey = `${session_id}:${local_path}`;

      setAlwaysUploadFiles((prev) => {
        if (prev.has(watchKey)) {
          // File was marked "Always list", just upload silently
          invoke("upload_local_file", {
            sessionId: session_id,
            localPath: local_path,
            remotePath: remote_path,
          }).catch((err) => toast.error(String(err)));
          return prev;
        } else {
          // Trigger the dialog
          setAutoUploadDialogData({ sessionId: session_id, localPath: local_path, remotePath: remote_path });
          return prev;
        }
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const loadDirectory = useCallback(
    async (path: string) => {
      if (!activeSessionId) return;
      setLoading(true);
      setError(null);

      try {
        const entries = await invoke<FileEntry[]>("list_remote_dir", {
          sessionId: activeSessionId,
          path,
        });
        entries.sort((a, b) => {
          if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        setFiles(entries);
        setCurrentPath(path);
      } catch (e) {
        const msg = String(e);
        if (files.length > 0) {
          toast.error(msg);
        } else {
          setError(msg);
        }
      } finally {
        setLoading(false);
      }
    },
    [activeSessionId, files.length],
  );

  useEffect(() => {
    let cancelled = false;
    if (activeSessionId) {
      (async () => {
        try {
          const home = await invoke<string>("get_home_dir", { sessionId: activeSessionId });
          if (cancelled) return;
          setHomeDir(home);
          loadDirectory(home);
        } catch {
          if (cancelled) return;
          loadDirectory("~");
        }
      })();
    } else {
      setFiles([]);
      setCurrentPath("");
      setHomeDir("");
    }
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, loadDirectory]);

  // Move Tauri listeners that do NOT rely on standard React side-effects to the top hook
  useEffect(() => {
    const unlisten = listen<{ session_id: string; local_path: string; remote_path: string }>("file-modified", (e) => {
      const { session_id, local_path, remote_path } = e.payload;
      const watchKey = `${session_id}:${local_path}`;

      setAlwaysUploadFiles((prev) => {
        if (prev.has(watchKey)) {
          invoke("upload_local_file", {
            sessionId: session_id,
            localPath: local_path,
            remotePath: remote_path,
          }).catch((err) => alert(String(err)));
          return prev;
        } else {
          setAutoUploadDialogData({ sessionId: session_id, localPath: local_path, remotePath: remote_path });
          return prev;
        }
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const handleItemClick = (entry: FileEntry) => {
    if (entry.is_dir) {
      const newPath = currentPath === "/" ? `/${entry.name}` : `${currentPath}/${entry.name}`;
      loadDirectory(newPath);
    } else {
      setSelectedFile(entry.name);
    }
  };

  const handleGoUp = () => {
    if (!currentPath || currentPath === "/") return;
    const parts = currentPath.split("/");
    parts.pop();
    loadDirectory(parts.join("/") || "/");
  };

  const getEntryFullPath = (entry: FileEntry) => {
    return currentPath === "/" ? `/${entry.name}` : `${currentPath}/${entry.name}`;
  };

  const handleCopyPath = (entry: FileEntry, mode: "dir" | "name" | "full") => {
    let text = "";
    if (mode === "dir") text = currentPath;
    else if (mode === "name") text = entry.name;
    else text = getEntryFullPath(entry);
    navigator.clipboard.writeText(text);
  };

  const handleSendToTerminal = (entry: FileEntry, mode: "dir" | "name" | "full") => {
    if (!activeSessionId) return;
    let text = "";
    if (mode === "dir") text = currentPath;
    else if (mode === "name") text = entry.name;
    else text = getEntryFullPath(entry);

    invoke("write_to_session", {
      sessionId: activeSessionId,
      data: text,
    });
    emit(`focus-terminal-${activeSessionId}`);
  };

  const handleDelete = async (entry: FileEntry) => {
    if (!activeSessionId) return;
    if (window.confirm(t("fileExplorer.sureDelete", { name: entry.name }))) {
      try {
        setLoading(true);
        await invoke("delete_remote_file", {
          sessionId: activeSessionId,
          path: getEntryFullPath(entry),
        });
        await loadDirectory(currentPath);
      } catch (e) {
        toast.error(String(e));
        setLoading(false);
      }
    }
  };

  const handleDownload = async (entry: FileEntry) => {
    if (!activeSessionId || entry.is_dir) return;
    try {
      const localPath = await saveDialog({ defaultPath: entry.name });
      if (!localPath) return;
      setLoading(true);
      await invoke("download_remote_file", {
        sessionId: activeSessionId,
        remotePath: getEntryFullPath(entry),
        localPath,
      });
      setLoading(false);
    } catch (e) {
      toast.error(String(e));
      setLoading(false);
    }
  };

  const handleUpload = async () => {
    if (!activeSessionId) return;
    try {
      const localPath = await openDialog({ multiple: false, directory: false });
      if (!localPath || typeof localPath !== "string") return;

      const fileName = localPath.split(/[\\/]/).pop() || "uploaded_file";
      const remotePath = currentPath === "/" ? `/${fileName}` : `${currentPath}/${fileName}`;

      setLoading(true);
      await invoke("upload_local_file", {
        sessionId: activeSessionId,
        localPath,
        remotePath,
      });
      await loadDirectory(currentPath);
    } catch (e) {
      toast.error(String(e));
      setLoading(false);
    }
  };

  const handleOpenDefault = async (entry: FileEntry) => {
    if (!activeSessionId || entry.is_dir) return;
    try {
      setLoading(true);
      const tDir = await tempDir();
      const localPath = await join(tDir, "dragonfly", activeSessionId, entry.name);
      await invoke("download_remote_file", {
        sessionId: activeSessionId,
        remotePath: getEntryFullPath(entry),
        localPath,
      });

      // Start watching the file for auto-upload
      await invoke("start_file_watch", {
        sessionId: activeSessionId,
        localPath,
        remotePath: getEntryFullPath(entry),
      });

      await openUrl(localPath);
      setLoading(false);
    } catch (e) {
      toast.error(String(e));
      setLoading(false);
    }
  };

  const displayPath = (() => {
    if (!homeDir || !currentPath) return currentPath || "~";
    if (currentPath === homeDir) return "~";
    if (currentPath.startsWith(`${homeDir}/`)) return `~${currentPath.slice(homeDir.length)}`;
    return currentPath;
  })();

  return (
    <aside
      className="h-full flex flex-col overflow-hidden"
      style={{ backgroundColor: "var(--df-bg-panel)" }}
    >
      <div
        className="p-2 text-[10px] uppercase tracking-wider font-bold border-b flex justify-between items-center"
        style={{ color: "var(--df-text-muted)", borderColor: "var(--df-border)" }}
      >
        <span>{t("panel.fileExplorer")}</span>
        <div className="flex gap-1">
          {activeSessionId && (
            <>
              <span
                className="material-icons text-xs cursor-pointer hover:opacity-80 transition-opacity"
                style={{ color: "var(--df-text-muted)" }}
                onClick={handleGoUp}
                title={t("fileExplorer.goUp")}
              >
                arrow_upward
              </span>
              <span
                className="material-icons text-xs cursor-pointer hover:opacity-80 transition-opacity"
                style={{ color: "var(--df-text-muted)" }}
                onClick={() => loadDirectory(currentPath)}
                title={t("fileExplorer.refresh")}
              >
                refresh
              </span>
            </>
          )}
        </div>
      </div>

      {activeSessionId && (
        <div
          className="px-2 py-1 border-b flex items-center"
          style={{ borderColor: "var(--df-border)", minHeight: "26px" }}
        >
          {isEditingPath ? (
            <input
              autoFocus
              className="w-full text-[10px] font-mono bg-transparent outline-none m-0 p-0"
              style={{ color: "var(--df-text)" }}
              value={pathInputText}
              onChange={(e) => setPathInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  let p = pathInputText.trim();
                  if (p) {
                    if (p.startsWith("~/")) {
                      p = homeDir + p.substring(1);
                    } else if (p === "~") {
                      p = homeDir;
                    }
                    loadDirectory(p);
                  }
                  setIsEditingPath(false);
                } else if (e.key === "Escape") {
                  setIsEditingPath(false);
                }
              }}
              onBlur={() => setIsEditingPath(false)}
            />
          ) : (
            <div
              className="text-[10px] font-mono truncate cursor-text transition-colors flex-1"
              style={{ color: "var(--df-text-dimmed)" }}
              onMouseEnter={(e) => e.currentTarget.style.color = "var(--df-text)"}
              onMouseLeave={(e) => e.currentTarget.style.color = "var(--df-text-dimmed)"}
              onClick={() => {
                setPathInputText(currentPath || homeDir);
                setIsEditingPath(true);
              }}
              title={t("fileExplorer.editPath", "Click to edit path")}
            >
              {displayPath}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2 text-sm terminal-scroll">
        {!activeSessionId ? (
          <div className="text-center py-8 text-xs" style={{ color: "var(--df-text-dimmed)" }}>
            <div className="material-icons text-xl block mb-2">folder_off</div>
            <div className="text-sm block mb-2">{t("fileExplorer.connectToSession")}</div>
          </div>
        ) : loading ? (
          <div className="text-center py-4 text-xs" style={{ color: "var(--df-text-dimmed)" }}>
            {t("fileExplorer.loading")}
          </div>
        ) : error ? (
          <div className="text-center text-red-400 py-4 text-xs">{error}</div>
        ) : files.length === 0 ? (
          <div className="text-center py-4 text-xs" style={{ color: "var(--df-text-dimmed)" }}>
            {t("fileExplorer.emptyDirectory")}
          </div>
        ) : (
          <ul className="space-y-0.5">
            {files.map((entry) => {
              const { icon, color } = getFileIcon(entry);
              const isSelected = selectedFile === entry.name;
              return (
                <li
                  key={entry.name}
                  className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer transition-colors"
                  style={{
                    backgroundColor: isSelected
                      ? "color-mix(in srgb, var(--df-primary) 10%, transparent)"
                      : undefined,
                    color: isSelected ? "var(--df-primary)" : "var(--df-text)",
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) e.currentTarget.style.backgroundColor = "var(--df-bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) e.currentTarget.style.backgroundColor = "";
                  }}
                  onClick={() => handleItemClick(entry)}
                  onDoubleClick={() => {
                    if (!entry.is_dir) {
                      handleOpenDefault(entry);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedFile(entry.name);

                    showContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        { icon: "file_open", label: t("fileExplorer.cmOpen"), onClick: () => handleItemClick(entry) },
                        ...(!entry.is_dir ? [{ icon: "open_in_new", label: t("fileExplorer.cmOpenDefault"), onClick: () => handleOpenDefault(entry) }] : []),
                        { label: "", onClick: () => { }, divider: true },
                        { icon: "refresh", label: t("fileExplorer.cmRefresh"), onClick: () => loadDirectory(currentPath) },
                        { icon: "upload", label: t("fileExplorer.cmUpload"), onClick: () => handleUpload() },
                        ...(!entry.is_dir ? [{ icon: "download", label: t("fileExplorer.cmDownload"), onClick: () => handleDownload(entry) }] : []),
                        { label: "", onClick: () => { }, divider: true },
                        {
                          icon: "edit", label: t("fileExplorer.cmRename"), onClick: () => {
                            if (activeSessionId) setRenameDialogData({ sessionId: activeSessionId, oldPath: getEntryFullPath(entry), name: entry.name, currentDirPath: currentPath });
                          }
                        },
                        {
                          icon: "drive_file_move", label: t("fileExplorer.cmMove"), onClick: () => {
                            if (activeSessionId) setMoveDialogData({ sessionId: activeSessionId, oldPath: getEntryFullPath(entry), name: entry.name });
                          }
                        },
                        { icon: "delete", color: "#f87171", label: t("fileExplorer.cmDelete"), onClick: () => handleDelete(entry) },
                        { label: "", onClick: () => { }, divider: true },
                        { icon: "content_copy", label: t("fileExplorer.cmCopyPath"), onClick: () => handleCopyPath(entry, "full") },
                        { icon: "copy_all", label: t("fileExplorer.cmCopyName"), onClick: () => handleCopyPath(entry, "name") },
                        { icon: "folder_copy", label: t("fileExplorer.cmCopyDirPath"), onClick: () => handleCopyPath(entry, "dir") },
                        { label: "", onClick: () => { }, divider: true },
                        { icon: "keyboard_return", label: t("fileExplorer.cmTerminalPath"), onClick: () => handleSendToTerminal(entry, "full") },
                        { icon: "keyboard_arrow_right", label: t("fileExplorer.cmTerminalName"), onClick: () => handleSendToTerminal(entry, "name") },
                        { icon: "keyboard_double_arrow_right", label: t("fileExplorer.cmTerminalDirPath"), onClick: () => handleSendToTerminal(entry, "dir") },
                        { label: "", onClick: () => { }, divider: true },
                        {
                          icon: "info", label: t("fileExplorer.cmProperties"), onClick: () => {
                            if (activeSessionId) {
                              setPropertiesDialogData({
                                sessionId: activeSessionId,
                                fullPath: getEntryFullPath(entry),
                                name: entry.name,
                                is_dir: entry.is_dir,
                              });
                            }
                          }
                        }
                      ]
                    });
                  }}
                  title={`${entry.permissions} ${formatSize(entry.size)}`}
                >
                  <span
                    className="material-icons text-base"
                    style={{ color: isSelected ? "var(--df-primary)" : color }}
                  >
                    {icon}
                  </span>
                  <span className="flex-1 truncate text-xs">{entry.name}</span>
                  {!entry.is_dir && (
                    <span className="text-[10px]" style={{ color: "var(--df-text-dimmed)" }}>
                      {formatSize(entry.size)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {activeSessionId && !loading && !error && files.length > 0 && (() => {
        const totalItems = files.length;
        const hasFiles = files.some((f) => !f.is_dir);
        const totalSize = files
          .filter((f) => !f.is_dir)
          .reduce((sum, f) => sum + f.size, 0);

        return (
          <div
            className="px-2 py-1.5 text-[10px] border-t flex items-center justify-between shrink-0"
            style={{ color: "var(--df-text-dimmed)", borderColor: "var(--df-border)", backgroundColor: "var(--df-bg-panel)" }}
          >
            <div className="flex gap-4">
              <span>{t("fileExplorer.totalItems", { count: totalItems })}</span>
              {hasFiles && <span>{formatSize(totalSize)}</span>}
            </div>
            <span
              className="material-icons text-sm cursor-pointer hover:opacity-80 transition-opacity flex items-center justify-center p-0.5 rounded"
              style={{ color: "var(--df-text-muted)" }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--df-bg-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "")}
              onClick={() => {
                if (activeSessionId && currentPath) {
                  invoke("write_to_session", {
                    sessionId: activeSessionId,
                    data: `${currentPath}`,
                  });
                  emit(`focus-terminal-${activeSessionId}`);
                }
              }}
              title={t("fileExplorer.sendToTerminal")}
            >
              send
            </span>
          </div>
        );
      })()}

      {renameDialogData && (
        <RenameDialog
          data={renameDialogData}
          onClose={() => setRenameDialogData(null)}
          onSuccess={() => loadDirectory(currentPath)}
        />
      )}

      {moveDialogData && (
        <MoveDialog
          data={moveDialogData}
          onClose={() => setMoveDialogData(null)}
          onSuccess={() => loadDirectory(currentPath)}
        />
      )}

      {autoUploadDialogData && (
        <AutoUploadDialog
          data={autoUploadDialogData}
          onClose={() => setAutoUploadDialogData(null)}
          onAlwaysUpload={(sessionId, localPath) => {
            const key = `${sessionId}:${localPath}`;
            setAlwaysUploadFiles((prev) => new Set([...prev, key]));
          }}
        />
      )}

      {propertiesDialogData && (
        <PropertiesDialog
          data={propertiesDialogData}
          onClose={() => setPropertiesDialogData(null)}
        />
      )}
    </aside >
  );
}
