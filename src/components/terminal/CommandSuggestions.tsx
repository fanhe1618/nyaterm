import { memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { MdChevronRight, MdHistory } from "react-icons/md";
import type { FuzzyResult } from "../../types";

interface CommandSuggestionsProps {
  suggestions: FuzzyResult[];
  visible: boolean;
  selectedIndex: number;
  cursorPosition: { top: number; left: number };
  onSelect: (command: string) => void;
  onDismiss: () => void;
}

/** Render a single suggestion with matched characters highlighted. */
function HighlightedCommand({ command, indices }: { command: string; indices: number[] }) {
  const indexSet = new Set(indices);
  const parts: { text: string; highlighted: boolean }[] = [];

  let i = 0;
  while (i < command.length) {
    const isHighlighted = indexSet.has(i);
    let j = i + 1;
    while (j < command.length && indexSet.has(j) === isHighlighted) {
      j++;
    }
    parts.push({ text: command.slice(i, j), highlighted: isHighlighted });
    i = j;
  }

  return (
    <span className="font-mono text-[12px]">
      {parts.map((part, idx) =>
        part.highlighted ? (
          <span key={idx} className="font-semibold" style={{ color: "var(--df-accent)" }}>
            {part.text}
          </span>
        ) : (
          <span key={idx} style={{ color: "var(--df-text)" }}>
            {part.text}
          </span>
        ),
      )}
    </span>
  );
}

/** Popup list of fuzzy-matched history suggestions. Arrow keys, Enter, Tab, Esc. */
function CommandSuggestions({
  suggestions,
  visible,
  selectedIndex,
  cursorPosition,
  onSelect,
  onDismiss: _onDismiss,
}: CommandSuggestionsProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  // Scroll the selected item into view
  useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: "nearest" });
    }
  }, []);

  if (!visible || suggestions.length === 0) {
    return null;
  }

  // Clamp left so the popup doesn't overflow the right edge of the viewport
  const popupWidth = 380;
  const clampedLeft = Math.max(
    4,
    Math.min(cursorPosition.left, window.innerWidth - popupWidth - 8),
  );

  return (
    <div
      className="fixed z-[9999] w-[380px] max-h-[240px] overflow-y-auto rounded-lg border backdrop-blur-sm shadow-2xl terminal-scroll"
      ref={listRef}
      style={{
        top: cursorPosition.top,
        left: clampedLeft,
        backgroundColor: "color-mix(in srgb, var(--df-bg-panel) 95%, transparent)",
        borderColor: "var(--df-border)",
      }}
      onMouseDown={(e) => {
        // Prevent the terminal from losing focus
        e.preventDefault();
      }}
    >
      <div
        className="px-2 py-1.5 text-[10px] uppercase tracking-wider border-b flex items-center gap-1.5"
        style={{ color: "var(--df-text-dimmed)", borderColor: "var(--df-border)" }}
      >
        <MdHistory className="text-[12px]" />
        <span>{t("suggestions.history")}</span>
        <span className="ml-auto" style={{ color: "var(--df-text-dimmed)" }}>
          {suggestions.length}{" "}
          {suggestions.length !== 1 ? t("suggestions.matches") : t("suggestions.match")}
        </span>
      </div>

      {suggestions.map((result, index) => (
        <div
          key={`${result.command}-${index}`}
          ref={index === selectedIndex ? selectedRef : null}
          className={`px-3 py-1.5 cursor-pointer flex items-center gap-2 transition-colors border-l-2 ${
            index === selectedIndex ? "" : "border-transparent"
          } ${index !== selectedIndex ? "df-hover" : ""}`}
          style={{
            backgroundColor:
              index === selectedIndex
                ? "color-mix(in srgb, var(--df-primary) 20%, transparent)"
                : undefined,
            borderLeftColor: index === selectedIndex ? "var(--df-primary)" : "transparent",
          }}
          onClick={() => onSelect(result.command)}
        >
          <MdChevronRight
            className="text-[12px] shrink-0"
            style={{
              color: index === selectedIndex ? "var(--df-accent)" : "var(--df-text-dimmed)",
            }}
          />
          <HighlightedCommand command={result.command} indices={result.indices} />
        </div>
      ))}

      <div
        className="px-2 py-1 border-t flex items-center gap-3 text-[10px]"
        style={{ borderColor: "var(--df-border)", color: "var(--df-text-dimmed)" }}
      >
        <span>
          <kbd
            className="px-1 py-0.5 rounded text-[9px]"
            style={{ backgroundColor: "var(--df-bg-hover)", color: "var(--df-text-muted)" }}
          >
            ↑↓
          </kbd>{" "}
          {t("suggestions.select")}
        </span>
        <span>
          <kbd
            className="px-1 py-0.5 rounded text-[9px]"
            style={{ backgroundColor: "var(--df-bg-hover)", color: "var(--df-text-muted)" }}
          >
            Enter
          </kbd>{" "}
          {t("suggestions.execute")}
        </span>
        <span>
          <kbd
            className="px-1 py-0.5 rounded text-[9px]"
            style={{ backgroundColor: "var(--df-bg-hover)", color: "var(--df-text-muted)" }}
          >
            Tab
          </kbd>{" "}
          {t("suggestions.fill")}
        </span>
        <span>
          <kbd
            className="px-1 py-0.5 rounded text-[9px]"
            style={{ backgroundColor: "var(--df-bg-hover)", color: "var(--df-text-muted)" }}
          >
            Esc
          </kbd>{" "}
          {t("suggestions.dismiss")}
        </span>
      </div>
    </div>
  );
}

export default memo(CommandSuggestions);
