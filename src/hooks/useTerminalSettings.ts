import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { useEffect } from "react";

export function useTerminalSettings(
  terminalRef: React.MutableRefObject<Terminal | null>,
  fitAddonRef: React.MutableRefObject<FitAddon | null>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  theme: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  appSettings: any,
) {
  // React to theme changes: update terminal colors dynamically
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = { ...theme.colors.terminal };
    }
  }, [theme, terminalRef]);

  // React to appearance settings changes: font family, size, cursor etc
  useEffect(() => {
    if (terminalRef.current) {
      const options = terminalRef.current.options;
      const appearance = appSettings.appearance;
      options.fontFamily = appearance.font_family;
      options.fontSize = appearance.font_size;
      options.cursorBlink = appearance.cursor_blink;
      options.cursorStyle = appearance.cursor_style as "block" | "underline" | "bar";

      // Auto-fit on font size change
      if (fitAddonRef.current) {
        requestAnimationFrame(() => fitAddonRef.current?.fit());
      }
    }
  }, [appSettings.appearance, terminalRef, fitAddonRef]);

  // React to terminal core settings changes: scrollback
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.scrollback = appSettings.terminal.scrollback_lines;
    }
  }, [appSettings.terminal, terminalRef]);

  // React to interaction settings changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.wordSeparator = appSettings.interaction.word_separators;
    }
  }, [appSettings.interaction, terminalRef]);
}
