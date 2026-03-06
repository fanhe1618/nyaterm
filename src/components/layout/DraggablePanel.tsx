import { type ReactNode, useCallback, useRef, useState } from "react";
import { MdDragIndicator } from "react-icons/md";
import type { PanelId } from "@/types/global";

type DropPosition = "before" | "after";

interface DraggablePanelProps {
  panelId: PanelId;
  sidebar: "left" | "right";
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onPanelDrop: (
    draggedId: PanelId,
    fromSidebar: "left" | "right",
    targetId: PanelId,
    targetSidebar: "left" | "right",
    position: DropPosition,
  ) => void;
}

const MIME = "application/x-dragonfly-panel";

export default function DraggablePanel({
  panelId,
  sidebar,
  children,
  className = "",
  style,
  onPanelDrop,
}: DraggablePanelProps) {
  const [dropIndicator, setDropIndicator] = useState<DropPosition | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData(MIME, JSON.stringify({ panelId, sidebar }));
      e.dataTransfer.effectAllowed = "move";
    },
    [panelId, sidebar],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const y = e.clientY - rect.top;
      setDropIndicator(y < rect.height / 2 ? "before" : "after");
    },
    [],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (
      containerRef.current &&
      !containerRef.current.contains(e.relatedTarget as Node)
    ) {
      setDropIndicator(null);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDropIndicator(null);
      const raw = e.dataTransfer.getData(MIME);
      if (!raw) return;
      try {
        const { panelId: draggedId, sidebar: fromSidebar } = JSON.parse(raw) as {
          panelId: PanelId;
          sidebar: "left" | "right";
        };
        if (draggedId === panelId && fromSidebar === sidebar) return;

        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const y = e.clientY - rect.top;
        const position: DropPosition = y < rect.height / 2 ? "before" : "after";

        onPanelDrop(draggedId, fromSidebar, panelId, sidebar, position);
      } catch { /* malformed data */ }
    },
    [panelId, sidebar, onPanelDrop],
  );

  const indicatorStyle: React.CSSProperties = {
    position: "absolute",
    left: 4,
    right: 4,
    height: 2,
    backgroundColor: "var(--df-accent, #3b82f6)",
    borderRadius: 1,
    zIndex: 50,
    pointerEvents: "none",
  };

  return (
    <div
      ref={containerRef}
      className={`relative group/panel ${className}`}
      style={style}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dropIndicator === "before" && (
        <div style={{ ...indicatorStyle, top: 0 }} />
      )}

      {/* Drag handle - visible on header hover */}
      <div
        draggable
        onDragStart={handleDragStart}
        className="absolute top-0 left-0 z-10 h-[26px] w-[18px] flex items-center justify-center
          opacity-0 group-hover/panel:opacity-60 hover:!opacity-100 cursor-grab active:cursor-grabbing transition-opacity"
        style={{ color: "var(--df-text-muted)" }}
        title="Drag to reorder"
      >
        <MdDragIndicator className="text-xs" />
      </div>

      {children}

      {dropIndicator === "after" && (
        <div style={{ ...indicatorStyle, bottom: 0 }} />
      )}
    </div>
  );
}
