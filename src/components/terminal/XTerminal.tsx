import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/context/AppContext";
import { useTheme } from "@/context/ThemeContext";
import { useCommandHistory } from "@/hooks/useCommandHistory";
import { useShellIntegration } from "@/hooks/useShellIntegration";
import { useTerminalSearch } from "@/hooks/useTerminalSearch";
import { useTerminalSettings } from "@/hooks/useTerminalSettings";
import CommandSuggestions from "./CommandSuggestions";
import TerminalContextMenu from "./TerminalContextMenu";
import TerminalSearchBar from "./TerminalSearchBar";
import "@xterm/xterm/css/xterm.css";

interface XTerminalProps {
  sessionId: string;
  active: boolean;
}

/**
 * xterm.js terminal for a session. Handles OSC 133 shell integration (or fallback prompt
 * detection), fuzzy command history suggestions, and resize/fit. Key props: sessionId, active.
 */
export default function XTerminal({ sessionId, active }: XTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const { theme } = useTheme();
  const { t } = useTranslation();
  const { appSettings } = useApp();

  const currentLineRef = useRef("");
  const appSettingsRef = useRef(appSettings);

  useEffect(() => {
    appSettingsRef.current = appSettings;
  }, [appSettings]);

  // Search Addon state and handlers
  const {
    searchAddonRef,
    showSearchBar,
    setShowSearchBar,
    searchQuery,
    setSearchQuery,
    handleSearchNext,
    handleSearchPrev,
    handleCloseSearch,
  } = useTerminalSearch(terminalRef);

  // Appearance, theme, and interaction settings sync
  useTerminalSettings(terminalRef, fitAddonRef, theme, appSettings);

  // Shell integration state & reading commands
  const { shellIntegrationRef, readCommandFromBuffer, readBetweenMarkerAndCursor } =
    useShellIntegration(terminalRef, currentLineRef);

  // Command history & fuzzy search UI
  const {
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
  } = useCommandHistory(
    sessionId,
    terminalRef,
    currentLineRef,
    shellIntegrationRef,
    readCommandFromBuffer,
  );

  // Create and setup terminal
  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      scrollback: appSettings.terminal.scrollback_lines,
      cursorBlink: appSettings.appearance.cursor_blink,
      cursorStyle: appSettings.appearance.cursor_style as "block" | "underline" | "bar",
      fontSize: appSettings.appearance.font_size,
      fontFamily: appSettings.appearance.font_family,
      wordSeparator: appSettings.interaction.word_separators,
      theme: { ...theme.colors.terminal },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      event.preventDefault();
      openUrl(uri).catch((err: unknown) => console.error("Failed to open link:", err));
    });
    const searchAddon = new SearchAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.loadAddon(searchAddon);
    terminal.open(containerRef.current);

    searchAddonRef.current = searchAddon;

    // Initial fit
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const oscDisposable = terminal.parser.registerOscHandler(133, (data) => {
      const si = shellIntegrationRef.current;

      if (data.startsWith("A")) {
        si.enabled = true;
        si.promptStartMarker?.dispose();
        si.promptStartMarker = terminal.registerMarker(0);
        return false;
      }

      if (data.startsWith("B")) {
        si.enabled = true;
        si.commandStartMarker?.dispose();
        si.commandStartMarker = terminal.registerMarker(0);
        si.commandStartX = terminal.buffer.active.cursorX;
        return false;
      }

      if (data.startsWith("C")) {
        si.enabled = true;
        if (si.commandStartMarker) {
          const command = readBetweenMarkerAndCursor(
            terminal,
            si.commandStartMarker,
            si.commandStartX,
          ).trim();
          if (command) {
            invoke("add_command_history", { sessionId, command }).catch(() => { });
          }
        }
        currentLineRef.current = "";
        dismissSuggestions();
        return false;
      }

      if (data.startsWith("D")) {
        si.enabled = true;
        return false;
      }

      return false;
    });

    const writeParsedDisposable = terminal.onWriteParsed(() => {
      const si = shellIntegrationRef.current;
      if (si.enabled) return;

      if (si.fallbackNeedsDetection) {
        si.fallbackPromptEndX = terminal.buffer.active.cursorX;
      }
    });

    let outputUnlisten: UnlistenFn | null = null;
    let closedUnlisten: UnlistenFn | null = null;
    let focusUnlisten: UnlistenFn | null = null;

    const setupListeners = async () => {
      outputUnlisten = await listen<string>(`terminal-output-${sessionId}`, (event) => {
        terminal.write(event.payload);

        if (event.payload.includes("\n")) {
          const si = shellIntegrationRef.current;
          currentLineRef.current = "";
          if (!si.enabled) {
            si.fallbackNeedsDetection = true;
          }
          dismissSuggestions();
        }
      });

      closedUnlisten = await listen<void>(`session-closed-${sessionId}`, () => {
        terminal.write(`\r\n\x1b[31m[${t("terminal.sessionDisconnected")}]\x1b[0m\r\n`);
      });

      focusUnlisten = await listen<void>(`focus-terminal-${sessionId}`, () => {
        terminal.focus();
      });

      await invoke("attach_session", { sessionId });
    };
    setupListeners();

    const dataDisposable = terminal.onData((data) => {
      if (showSuggestionsRef.current && suggestionsRef.current.length > 0) {
        if (data === "\t" && selectedIndexRef.current >= 0) {
          const selected = suggestionsRef.current[selectedIndexRef.current];
          if (selected) {
            const actualCmd = readCommandFromBuffer();
            const eraseChars = "\x7f".repeat(actualCmd.length);
            invoke("write_to_session", {
              sessionId,
              data: eraseChars + selected.command,
            }).catch(() => { });
            currentLineRef.current = selected.command;
            dismissSuggestions();
          }
          return;
        }

        if (data === "\x1b[A") {
          const cur = selectedIndexRef.current;
          const newIdx = cur === -1 ? suggestionsRef.current.length - 1 : cur === 0 ? -1 : cur - 1;
          selectedIndexRef.current = newIdx;
          setSelectedIndex(newIdx);
          return;
        }

        if (data === "\x1b[B") {
          const cur = selectedIndexRef.current;
          const newIdx = cur === -1 ? 0 : cur === suggestionsRef.current.length - 1 ? -1 : cur + 1;
          selectedIndexRef.current = newIdx;
          setSelectedIndex(newIdx);
          return;
        }

        if (data === "\x1b") {
          dismissSuggestions();
          return;
        }

        if (data === "\r" && selectedIndexRef.current >= 0) {
          const selected = suggestionsRef.current[selectedIndexRef.current];
          if (selected) {
            const actualCmd = readCommandFromBuffer();
            const eraseChars = "\x7f".repeat(actualCmd.length);
            invoke("write_to_session", {
              sessionId,
              data: `${eraseChars + selected.command}\r`,
            }).catch(() => { });
            if (!shellIntegrationRef.current.enabled) {
              invoke("add_command_history", {
                sessionId,
                command: selected.command,
              }).catch(() => { });
            }
            currentLineRef.current = "";
            shellIntegrationRef.current.fallbackNeedsDetection = true;
            dismissSuggestions();
          }
          return;
        }
      }

      const si = shellIntegrationRef.current;

      if (data === "\r") {
        if (!si.enabled) {
          const bufCmd = readCommandFromBuffer().trim();
          const cmd = bufCmd || currentLineRef.current.trim();
          if (cmd) {
            invoke("add_command_history", { sessionId, command: cmd });
          }
        }
        currentLineRef.current = "";
        si.fallbackNeedsDetection = true;
        dismissSuggestions();
      } else if (data === "\u007f" || data === "\b") {
        currentLineRef.current = currentLineRef.current.slice(0, -1);
        triggerSearch();
      } else if (data === "\t") {
        triggerSearch();
      } else if (!/[\x00-\x1f\x7f]/.test(data)) {
        if (!si.enabled && si.fallbackNeedsDetection) {
          si.fallbackPromptEndX = terminal.buffer.active.cursorX;
          si.fallbackNeedsDetection = false;
        }
        currentLineRef.current += data;
        triggerSearch();
      } else if (data.startsWith("\x1b")) {
        if (!si.enabled && si.fallbackNeedsDetection) {
          si.fallbackPromptEndX = terminal.buffer.active.cursorX;
          si.fallbackNeedsDetection = false;
        }
        currentLineRef.current = "";
        dismissSuggestions();
      } else {
        currentLineRef.current = "";
        si.fallbackNeedsDetection = true;
        dismissSuggestions();
      }

      invoke("write_to_session", { sessionId, data }).catch(() => { });
    });

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      invoke("resize_session", { sessionId, cols, rows }).catch(() => { });
    });

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        fitAddon.fit();
      });
    });
    observer.observe(containerRef.current);

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (appSettingsRef.current?.interaction?.copy_on_select) {
        const text = terminal.getSelection();
        if (text) {
          navigator.clipboard.writeText(text).catch(() => { });
        }
      }
    });

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

      const si = shellIntegrationRef.current;
      si.promptStartMarker?.dispose();
      si.commandStartMarker?.dispose();
      si.promptStartMarker = null;
      si.commandStartMarker = null;

      oscDisposable.dispose();
      writeParsedDisposable.dispose();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      selectionDisposable.dispose();

      observer.disconnect();
      if (outputUnlisten) outputUnlisten();
      if (closedUnlisten) closedUnlisten();
      if (focusUnlisten) focusUnlisten();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Re-fit and focus when tab becomes active
  useEffect(() => {
    if (active && fitAddonRef.current && terminalRef.current) {
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
        terminalRef.current?.focus();
      });
    }
  }, [active]);

  const doFind = useCallback(
    (selection?: string) => {
      if (selection) {
        setSearchQuery(selection);
        setTimeout(() => searchAddonRef.current?.findNext(selection), 50);
      }
      setShowSearchBar(true);
      terminalRef.current?.focus();
    },
    [setShowSearchBar, setSearchQuery, searchAddonRef],
  );

  return (
    <div className="h-full w-full relative" style={{ display: active ? "block" : "none" }}>
      <TerminalContextMenu
        sessionId={sessionId}
        terminalRef={terminalRef}
        onFind={doFind}
        readCommandFromBuffer={readCommandFromBuffer}
      >
        <div ref={containerRef} className="h-full w-full" />
      </TerminalContextMenu>

      <TerminalSearchBar
        show={showSearchBar}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        onNext={handleSearchNext}
        onPrev={handleSearchPrev}
        onClose={handleCloseSearch}
      />

      <CommandSuggestions
        suggestions={suggestions}
        visible={showSuggestions}
        selectedIndex={selectedIndex}
        cursorPosition={cursorPosition}
        onSelect={handleSelectSuggestion}
        onDismiss={dismissSuggestions}
      />
    </div>
  );
}
