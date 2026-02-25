import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import { useCallback, useRef, useState } from "react";
import type { ShellIntegrationState } from "@/hooks/useShellIntegration";
import type { FuzzyResult } from "@/types";

export function useCommandHistory(
  sessionId: string,
  terminalRef: React.MutableRefObject<Terminal | null>,
  currentLineRef: React.MutableRefObject<string>,
  shellIntegrationRef: React.MutableRefObject<ShellIntegrationState>,
  readBufferCommand: () => string,
) {
  const [suggestions, setSuggestions] = useState<FuzzyResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [cursorPosition, setCursorPosition] = useState({ top: 0, left: 0 });

  const suggestionsRef = useRef<FuzzyResult[]>([]);
  const selectedIndexRef = useRef(-1);
  const showSuggestionsRef = useRef(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getCursorViewportPosition = (): { top: number; left: number } => {
    try {
      const terminal = terminalRef.current;
      if (!terminal) return { top: 0, left: 0 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const core = (terminal as any)._core;
      const dims = core._renderService.dimensions;
      const cellHeight: number = dims.css.cell.height;
      const cellWidth: number = dims.css.cell.width;

      const cursorY = terminal.buffer.active.cursorY;
      const cursorX = terminal.buffer.active.cursorX;

      const screenEl = terminal.element?.querySelector(".xterm-screen");
      if (!screenEl) return { top: 0, left: 0 };

      const screenRect = screenEl.getBoundingClientRect();

      return {
        top: screenRect.top + (cursorY + 1) * cellHeight,
        left: screenRect.left + cursorX * cellWidth,
      };
    } catch {
      return { top: 0, left: 0 };
    }
  };

  const dismissSuggestions = useCallback(() => {
    showSuggestionsRef.current = false;
    suggestionsRef.current = [];
    selectedIndexRef.current = -1;
    setSuggestions([]);
    setSelectedIndex(-1);
    setShowSuggestions(false);
  }, []);

  const triggerSearch = useCallback(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    if (currentLineRef.current.length === 0) {
      dismissSuggestions();
      return;
    }

    searchTimerRef.current = setTimeout(async () => {
      const pattern = readBufferCommand();
      if (!pattern.trim()) {
        dismissSuggestions();
        return;
      }
      try {
        const results = await invoke<FuzzyResult[]>("fuzzy_search_history", {
          pattern,
          limit: 8,
        });
        suggestionsRef.current = results;
        selectedIndexRef.current = -1;
        showSuggestionsRef.current = results.length > 0;
        setSuggestions(results);
        setSelectedIndex(-1);
        setShowSuggestions(results.length > 0);

        if (results.length > 0) {
          setCursorPosition(getCursorViewportPosition());
        }
      } catch {
        // Ignore errors
      }
    }, 80);
  }, [readBufferCommand, dismissSuggestions, currentLineRef]);

  const handleSelectSuggestion = useCallback(
    (command: string) => {
      const actualCmd = readBufferCommand();
      const eraseChars = "\x7f".repeat(actualCmd.length);
      invoke("write_to_session", {
        sessionId,
        data: `${eraseChars + command}\r`,
      }).catch(() => {});
      invoke("add_command_history", { sessionId, command }).catch(() => {});
      currentLineRef.current = "";
      shellIntegrationRef.current.fallbackNeedsDetection = true;

      dismissSuggestions();
      terminalRef.current?.focus();
    },
    [
      sessionId,
      readBufferCommand,
      dismissSuggestions,
      currentLineRef,
      shellIntegrationRef,
      terminalRef,
    ],
  );

  return {
    suggestions,
    selectedIndex,
    setSelectedIndex,
    showSuggestions,
    cursorPosition,
    suggestionsRef,
    selectedIndexRef,
    showSuggestionsRef,
    searchTimerRef,
    triggerSearch,
    dismissSuggestions,
    handleSelectSuggestion,
  };
}
