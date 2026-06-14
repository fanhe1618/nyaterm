import { listen } from "@tauri-apps/api/event";
import type { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  normalizeCommandSuggestionMaxChars,
  normalizeCommandSuggestionMinChars,
} from "@/lib/interactionSettings";
import { invoke } from "@/lib/invoke";
import { getTrackedCommand, type TerminalInputState } from "@/lib/terminalInputTracker";
import type { SuggestionCursorPosition } from "@/lib/terminalSuggestionPosition";
import type { FuzzyResult } from "@/types/global";

interface XTermCoreWithRenderDimensions {
  _core?: {
    _renderService?: {
      dimensions?: {
        css: {
          cell: {
            height: number;
            width: number;
          };
        };
      };
    };
  };
}

export function useCommandHistory(
  terminalRef: React.RefObject<Terminal | null>,
  inputStateRef: React.RefObject<TerminalInputState>,
  applySuggestion: (command: string, execute: boolean) => void,
  canShowSuggestions: () => boolean,
  enabled: boolean,
  minCommandLength: number,
  maxCommandLength: number,
) {
  const [suggestions, setSuggestions] = useState<FuzzyResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [cursorPosition, setCursorPosition] = useState<SuggestionCursorPosition>({
    top: 0,
    left: 0,
  });

  const suggestionsRef = useRef<FuzzyResult[]>([]);
  const selectedIndexRef = useRef(-1);
  const showSuggestionsRef = useRef(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabledRef = useRef(enabled);
  const minCommandLengthRef = useRef(normalizeCommandSuggestionMinChars(minCommandLength));
  const maxCommandLengthRef = useRef(normalizeCommandSuggestionMaxChars(maxCommandLength));
  const searchRequestIdRef = useRef(0);
  const deletedHistoryCommandsRef = useRef(new Set<string>());
  const deletedHistoryCommandTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const getCursorViewportPosition = useCallback((): SuggestionCursorPosition => {
    try {
      const terminal = terminalRef.current;
      if (!terminal) return { top: 0, left: 0 };
      const core = (terminal as Terminal & XTermCoreWithRenderDimensions)._core;
      const dims = core?._renderService?.dimensions;
      if (!dims) return { top: 0, left: 0 };
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
        lineTop: screenRect.top + cursorY * cellHeight,
      };
    } catch {
      return { top: 0, left: 0 };
    }
  }, [terminalRef]);

  const dismissSuggestions = useCallback(() => {
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    searchRequestIdRef.current += 1;
    if (
      !showSuggestionsRef.current &&
      suggestionsRef.current.length === 0 &&
      selectedIndexRef.current === -1
    ) {
      return;
    }
    showSuggestionsRef.current = false;
    suggestionsRef.current = [];
    selectedIndexRef.current = -1;
    setSuggestions([]);
    setSelectedIndex(-1);
    setShowSuggestions(false);
  }, []);

  useEffect(() => {
    if (!enabled) {
      dismissSuggestions();
    }
  }, [enabled, dismissSuggestions]);

  useEffect(() => {
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
      for (const timer of deletedHistoryCommandTimersRef.current.values()) {
        clearTimeout(timer);
      }
      deletedHistoryCommandTimersRef.current.clear();
    };
  }, []);

  const triggerSearch = useCallback(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    const requestId = ++searchRequestIdRef.current;

    if (!enabledRef.current) {
      dismissSuggestions();
      return;
    }

    if (!canShowSuggestions()) {
      dismissSuggestions();
      return;
    }

    searchTimerRef.current = setTimeout(async () => {
      if (requestId !== searchRequestIdRef.current) {
        return;
      }

      if (!enabledRef.current) {
        dismissSuggestions();
        return;
      }

      const pattern = getTrackedCommand(inputStateRef.current);
      if (!pattern.trim() || !canShowSuggestions()) {
        dismissSuggestions();
        return;
      }
      try {
        // Parallel search across all suggestion providers.
        // To add a new provider, append another invoke() call here.
        const [historyResults, commandResults] = await Promise.all([
          invoke<FuzzyResult[]>("fuzzy_search_history", {
            pattern,
            limit: 8,
            minCommandLength: minCommandLengthRef.current,
            maxCommandLength: maxCommandLengthRef.current,
          }),
          invoke<FuzzyResult[]>("fuzzy_search_commands", { pattern, limit: 8 }),
        ]);
        if (requestId !== searchRequestIdRef.current) {
          return;
        }

        // Merge, sort by score descending, and cap total
        const merged = [...historyResults, ...commandResults]
          .filter(
            (result) =>
              result.source !== "history" || !deletedHistoryCommandsRef.current.has(result.command),
          )
          .sort((a, b) => b.score - a.score)
          .slice(0, 12);

        if (!enabledRef.current) {
          dismissSuggestions();
          return;
        }

        suggestionsRef.current = merged;
        selectedIndexRef.current = -1;
        showSuggestionsRef.current = merged.length > 0;
        setSuggestions(merged);
        setSelectedIndex(-1);
        setShowSuggestions(merged.length > 0);

        if (merged.length > 0) {
          setCursorPosition(getCursorViewportPosition());
        }
      } catch {
        // Ignore errors
      }
    }, 80);
  }, [canShowSuggestions, dismissSuggestions, getCursorViewportPosition, inputStateRef]);

  useEffect(() => {
    minCommandLengthRef.current = normalizeCommandSuggestionMinChars(
      minCommandLength,
      maxCommandLength,
    );
    maxCommandLengthRef.current = normalizeCommandSuggestionMaxChars(
      maxCommandLength,
      minCommandLengthRef.current,
    );

    if (!enabledRef.current) return;
    if (!canShowSuggestions()) {
      dismissSuggestions();
      return;
    }

    triggerSearch();
  }, [canShowSuggestions, dismissSuggestions, maxCommandLength, minCommandLength, triggerSearch]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: inputStateRef is a stable ref object; .current is read inside the event callback.
  useEffect(() => {
    const refreshSuggestions = () => {
      if (!enabledRef.current) return;
      const tracked = getTrackedCommand(inputStateRef.current).trim();
      if (!showSuggestionsRef.current && !tracked) return;
      if (!canShowSuggestions()) return;
      triggerSearch();
    };

    const historyListener = listen("command-history-changed", refreshSuggestions);
    const quickCommandsListener = listen("quick-commands-changed", refreshSuggestions);

    return () => {
      historyListener.then((unlisten) => unlisten());
      quickCommandsListener.then((unlisten) => unlisten());
    };
  }, [canShowSuggestions, triggerSearch]);

  const handleSelectSuggestion = useCallback(
    (command: string) => {
      applySuggestion(command, false);
      dismissSuggestions();
      terminalRef.current?.focus();
    },
    [applySuggestion, dismissSuggestions, terminalRef],
  );

  const handleDeleteSuggestion = useCallback(
    (command: string) => {
      deletedHistoryCommandsRef.current.add(command);
      const existingTimer = deletedHistoryCommandTimersRef.current.get(command);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }
      const cleanupTimer = setTimeout(() => {
        deletedHistoryCommandsRef.current.delete(command);
        deletedHistoryCommandTimersRef.current.delete(command);
      }, 5000);
      deletedHistoryCommandTimersRef.current.set(command, cleanupTimer);

      const nextSuggestions = suggestionsRef.current.filter(
        (suggestion) => suggestion.source !== "history" || suggestion.command !== command,
      );
      suggestionsRef.current = nextSuggestions;

      const nextSelectedIndex =
        selectedIndexRef.current >= nextSuggestions.length
          ? nextSuggestions.length - 1
          : selectedIndexRef.current;
      selectedIndexRef.current = Math.max(-1, nextSelectedIndex);

      showSuggestionsRef.current = nextSuggestions.length > 0;
      setSuggestions(nextSuggestions);
      setSelectedIndex(selectedIndexRef.current);
      setShowSuggestions(nextSuggestions.length > 0);

      void invoke("delete_command_history", { command }).catch(() => {});
      terminalRef.current?.focus();
    },
    [terminalRef],
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
    handleDeleteSuggestion,
  };
}
