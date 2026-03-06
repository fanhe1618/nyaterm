import { memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { MdFlashOn, MdHistory, MdTipsAndUpdates } from "react-icons/md";
import type { FuzzyResult } from "@/types/global";

interface CommandSuggestionsProps {
  suggestions: FuzzyResult[];
  visible: boolean;
  selectedIndex: number;
  cursorPosition: { top: number; left: number };
  onSelect: (command: string) => void;
  onDismiss: () => void;
}

/** Per-source icon used as a prefix to distinguish item origins. */
const SOURCE_ICON: Record<string, React.ElementType> = {
  history: MdHistory,
  quickCommand: MdFlashOn,
};

/** Render a single suggestion with matched characters highlighted. */
function HighlightedCommand({ text, indices }: { text: string; indices: number[] }) {
  const indexSet = new Set(indices);
  const parts: { text: string; highlighted: boolean }[] = [];

  let i = 0;
  while (i < text.length) {
    const isHighlighted = indexSet.has(i);
    let j = i + 1;
    while (j < text.length && indexSet.has(j) === isHighlighted) {
      j++;
    }
    parts.push({ text: text.slice(i, j), highlighted: isHighlighted });
    i = j;
  }

  return (
    <span className="font-mono text-[0.75rem]">
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

/** Popup list of fuzzy-matched suggestions from multiple providers. */
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
  }, [selectedIndex]);

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
      {/* Unified header */}
      <div
        className="px-2 py-1.5 text-[0.625rem] uppercase tracking-wider border-b flex items-center gap-1.5"
        style={{ color: "var(--df-text-dimmed)", borderColor: "var(--df-border)" }}
      >
        <MdTipsAndUpdates className="text-[0.75rem]" />
        <span>{t("suggestions.title")}</span>
        <span className="ml-auto" style={{ color: "var(--df-text-dimmed)" }}>
          {suggestions.length}{" "}
          {suggestions.length !== 1 ? t("suggestions.matches") : t("suggestions.match")}
        </span>
      </div>

      {/* Items — prefix icon distinguishes source */}
      {suggestions.map((result, index) => {
        const Icon = SOURCE_ICON[result.source] ?? MdHistory;
        return (
          <div
            key={`${result.source}-${result.display}-${index}`}
            ref={index === selectedIndex ? selectedRef : null}
            className={`px-3 py-1.5 cursor-pointer flex items-center gap-2 transition-colors border-l-2 ${index === selectedIndex ? "" : "border-transparent"
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
            <Icon
              className="text-[0.75rem] shrink-0"
              style={{
                color: index === selectedIndex ? "var(--df-accent)" : "var(--df-text-dimmed)",
              }}
            />
            <HighlightedCommand text={result.display} indices={result.indices} />
          </div>
        );
      })}

      <div
        className="px-2 py-1 border-t flex items-center gap-3 text-[0.625rem]"
        style={{ borderColor: "var(--df-border)", color: "var(--df-text-dimmed)" }}
      >
        <span>
          <kbd
            className="px-1 py-0.5 rounded text-[0.5625rem]"
            style={{ backgroundColor: "var(--df-bg-hover)", color: "var(--df-text-muted)" }}
          >
            ↑↓
          </kbd>{" "}
          {t("suggestions.select")}
        </span>
        <span>
          <kbd
            className="px-1 py-0.5 rounded text-[0.5625rem]"
            style={{ backgroundColor: "var(--df-bg-hover)", color: "var(--df-text-muted)" }}
          >
            Enter
          </kbd>{" "}
          {t("suggestions.execute")}
        </span>
        <span>
          <kbd
            className="px-1 py-0.5 rounded text-[0.5625rem]"
            style={{ backgroundColor: "var(--df-bg-hover)", color: "var(--df-text-muted)" }}
          >
            Tab
          </kbd>{" "}
          {t("suggestions.fill")}
        </span>
        <span>
          <kbd
            className="px-1 py-0.5 rounded text-[0.5625rem]"
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
