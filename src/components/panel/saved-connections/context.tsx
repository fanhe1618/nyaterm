import { createContext, useContext } from "react";
import type { TFunction } from "i18next";
import type { Group, SavedConnection } from "@/types/global";

// ── Component-local types ─────────────────────────────────────────────────

export interface GroupNode {
  group: Group;
  children: GroupNode[];
  connections: SavedConnection[];
  totalCount: number;
}

export type SortMode = "default" | "name-asc" | "name-desc";

export type DragPosition = "before" | "after" | "inside";

export interface DragTarget {
  id: string | null;
  type: "connection" | "group" | "background";
  position: DragPosition;
}

export const naturalCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

export interface SavedConnectionsContextValue {
  // UI state
  isDragEnabled: boolean;
  dragTarget: DragTarget | null;
  expandedGroups: Set<string>;

  // List actions
  toggleGroup: (id: string) => void;
  handleConnect: (conn: SavedConnection) => void;
  handleCopyConnection: (conn: SavedConnection) => void;
  onEditConnection: (conn: SavedConnection) => void;

  // Dialog triggers
  onNewConnection: (parentGroupId?: string) => void;
  setDeleteTarget: (conn: SavedConnection | null) => void;
  setRenamingConn: (conn: SavedConnection | null) => void;
  setRenameValue: (v: string) => void;
  setDeleteFolderTarget: (g: Group | null) => void;
  openNewFolderDialog: (parentId: string | null) => void;
  openRenameFolderDialog: (g: Group) => void;

  // Drag handlers
  handleDragStart: (e: React.DragEvent, type: "connection" | "group", id: string) => void;
  handleDragEnd: () => void;
  handleDragOverItem: (e: React.DragEvent, id: string, type: "connection" | "group") => void;
  handleDragLeaveItem: (e: React.DragEvent, id: string, type: "connection" | "group") => void;
  handleDropItem: (e: React.DragEvent, id: string, tgtType: "connection" | "group") => Promise<void>;

  t: TFunction;
}

export const SavedConnectionsContext = createContext<SavedConnectionsContextValue | null>(null);

export const useSavedConnectionsContext = () => {
  const ctx = useContext(SavedConnectionsContext);
  if (!ctx) throw new Error("useSavedConnectionsContext must be used within SavedConnectionsContext.Provider");
  return ctx;
};
