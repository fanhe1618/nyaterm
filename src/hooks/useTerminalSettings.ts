import type { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef } from "react";
import { isTerminalTransparencyEnabled } from "@/lib/backgroundImage";
import type { TerminalColors } from "@/lib/themes";
import type { AppSettings } from "@/types/global";

export function useTerminalSettings(
  terminalRef: React.RefObject<Terminal | null>,
  fitAddonRef: React.RefObject<FitAddon | null>,
  terminalThemeColors: TerminalColors,
  appearance: AppSettings["appearance"],
  terminalSettings: AppSettings["terminal"],
  interaction: AppSettings["interaction"],
  rendererVisible = true,
) {
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const webglFailedRef = useRef(false);
  const textureRefreshFrameRef = useRef<number | null>(null);
  const terminalTransparencyEnabled = isTerminalTransparencyEnabled(appearance);

  const scheduleTextureRefresh = useCallback(() => {
    if (textureRefreshFrameRef.current !== null) return;
    textureRefreshFrameRef.current = requestAnimationFrame(() => {
      textureRefreshFrameRef.current = null;
      const terminal = terminalRef.current;
      if (!terminal) return;
      terminal.clearTextureAtlas();
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    });
  }, [terminalRef]);

  // React to hardware acceleration settings changes
  useEffect(() => {
    if (!terminalRef.current) return;

    if (
      terminalSettings.hardware_acceleration &&
      rendererVisible &&
      !terminalTransparencyEnabled &&
      !webglFailedRef.current
    ) {
      if (!webglAddonRef.current) {
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => {
            webgl.dispose();
            webglAddonRef.current = null;
            webglFailedRef.current = true;
          });
          terminalRef.current.loadAddon(webgl);
          webglAddonRef.current = webgl;
        } catch {
          // Fallback to DOM renderer if WebGL initialization fails
          webglFailedRef.current = true;
        }
      }
    } else {
      if (webglAddonRef.current) {
        webglAddonRef.current.dispose();
        webglAddonRef.current = null;
      }
    }

    return () => {
      if (textureRefreshFrameRef.current !== null) {
        cancelAnimationFrame(textureRefreshFrameRef.current);
        textureRefreshFrameRef.current = null;
      }
      if (webglAddonRef.current) {
        webglAddonRef.current.dispose();
        webglAddonRef.current = null;
      }
    };
  }, [
    terminalSettings.hardware_acceleration,
    terminalTransparencyEnabled,
    rendererVisible,
    terminalRef,
  ]);
  // React to terminal theme changes: update terminal colors dynamically
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = { ...terminalThemeColors };
      scheduleTextureRefresh();
    }
  }, [terminalThemeColors, terminalRef, scheduleTextureRefresh]);

  // React to appearance settings changes: font family, size, cursor etc
  useEffect(() => {
    if (terminalRef.current) {
      const options = terminalRef.current.options;
      options.fontFamily = appearance.font_family;
      options.fontSize = appearance.font_size;
      options.cursorBlink = appearance.cursor_blink;
      options.cursorStyle = appearance.cursor_style as "block" | "underline" | "bar";

      // Auto-fit on font size change
      if (fitAddonRef.current) {
        requestAnimationFrame(() => fitAddonRef.current?.fit());
      }
    }
  }, [appearance, terminalRef, fitAddonRef]);

  // React to terminal core settings changes: scrollback
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.scrollback = terminalSettings.scrollback_lines;
    }
  }, [terminalSettings.scrollback_lines, terminalRef]);

  // React to interaction settings changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.wordSeparator = interaction.word_separators;
    }
  }, [interaction.word_separators, terminalRef]);
}
