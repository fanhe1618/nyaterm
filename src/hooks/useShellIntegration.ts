import type { IMarker, Terminal } from "@xterm/xterm";
import { useRef } from "react";

export interface ShellIntegrationState {
  enabled: boolean;
  promptStartMarker: IMarker | null;
  commandStartMarker: IMarker | null;
  commandStartX: number;
  fallbackPromptEndX: number;
  fallbackNeedsDetection: boolean;
}

export function useShellIntegration(
  terminalRef: React.MutableRefObject<Terminal | null>,
  currentLineRef: React.MutableRefObject<string>,
) {
  const shellIntegrationRef = useRef<ShellIntegrationState>({
    enabled: false,
    promptStartMarker: null,
    commandStartMarker: null,
    commandStartX: 0,
    fallbackPromptEndX: 0,
    fallbackNeedsDetection: true,
  });

  const readBetweenMarkerAndCursor = (
    terminal: Terminal,
    startMarker: IMarker,
    startX: number,
  ): string => {
    try {
      const buf = terminal.buffer.active;
      const startRow = startMarker.line;
      const endRow = buf.baseY + buf.cursorY;

      if (startRow === endRow) {
        const line = buf.getLine(startRow);
        return line?.translateToString(true, startX) ?? "";
      }

      let result = "";
      for (let row = startRow; row <= endRow; row++) {
        const line = buf.getLine(row);
        if (!line) continue;
        if (row === startRow) {
          result += line.translateToString(true, startX);
        } else if (line.isWrapped) {
          result += line.translateToString(true);
        } else {
          result += `\n${line.translateToString(true)}`;
        }
      }
      return result;
    } catch {
      return "";
    }
  };

  const readCommandFromBuffer = (): string => {
    const terminal = terminalRef.current;
    if (!terminal) return currentLineRef.current;
    const si = shellIntegrationRef.current;

    try {
      if (si.enabled && si.commandStartMarker) {
        return readBetweenMarkerAndCursor(terminal, si.commandStartMarker, si.commandStartX);
      }

      const buf = terminal.buffer.active;
      const row = buf.baseY + buf.cursorY;
      const line = buf.getLine(row);
      if (!line) return currentLineRef.current;
      return line.translateToString(true, si.fallbackPromptEndX);
    } catch {
      return currentLineRef.current;
    }
  };

  return {
    shellIntegrationRef,
    readCommandFromBuffer,
    readBetweenMarkerAndCursor,
  };
}
