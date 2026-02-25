import { invoke } from "@tauri-apps/api/core";
import { memo, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MdChevronRight, MdHistory } from "react-icons/md";

interface CommandHistoryProps {
  onCommandSend: (command: string) => void;
}

/** Command history list (polled). Double-click sends command to active tab. */
function CommandHistory({ onCommandSend }: CommandHistoryProps) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<string[]>([]);

  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const cmds = await invoke<string[]>("get_command_history");
        setHistory(cmds);
      } catch {
        // Backend might not be ready
      }
    };

    fetchHistory();
    const interval = setInterval(fetchHistory, 3000);
    return () => clearInterval(interval);
  }, []);

  const handleDoubleClick = useCallback(
    (command: string) => {
      onCommandSend(command);
    },
    [onCommandSend],
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div
        className="p-2 text-[10px] uppercase tracking-wider font-bold border-b flex justify-between items-center"
        style={{
          color: "var(--df-text-muted)",
          borderColor: "var(--df-border)",
          backgroundColor: "var(--df-bg-section-header)",
        }}
      >
        <span>{t("panel.commandHistory")}</span>
        <MdHistory
          className="text-sm cursor-pointer hover:opacity-80 transition-opacity"
          style={{ color: "var(--df-text-muted)" }}
        />
      </div>
      <div className="flex-1 overflow-y-auto p-2 text-xs font-mono space-y-0.5 terminal-scroll">
        {history.length === 0 ? (
          <div
            className="text-center py-4 font-display text-[11px]"
            style={{ color: "var(--df-text-dimmed)" }}
          >
            {t("panel.noCommandsYet")}
          </div>
        ) : (
          history.map((cmd, index) => (
            <div
              key={`${cmd}-${index}`}
              className="px-2 py-1.5 rounded cursor-pointer transition-colors truncate flex items-center gap-1.5 group df-hover"
              style={{ color: "var(--df-text)" }}
              title={cmd}
              onDoubleClick={() => handleDoubleClick(cmd)}
            >
              <MdChevronRight
                className="text-[10px] transition-colors"
                style={{ color: "var(--df-text-dimmed)" }}
              />
              <span className="truncate">{cmd}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default memo(CommandHistory);
