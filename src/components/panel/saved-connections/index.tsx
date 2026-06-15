import { type ComponentProps, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BiExport, BiImport } from "react-icons/bi";
import {
  MdAdd,
  MdClose,
  MdCreateNewFolder,
  MdDeleteSweep,
  MdLink,
  MdMoreVert,
  MdSearch,
  MdSort,
  MdSortByAlpha,
} from "react-icons/md";
import { toast } from "sonner";
import ClearAllDialog from "@/components/dialog/connections/ClearAllDialog";
import DeleteConnectionDialog from "@/components/dialog/connections/DeleteConnectionDialog";
import DeleteFolderDialog from "@/components/dialog/connections/DeleteFolderDialog";
import FolderDialog from "@/components/dialog/connections/FolderDialog";
import ImportDialog from "@/components/dialog/connections/ImportDialog";
import OpenGroupConnectionsDialog from "@/components/dialog/connections/OpenGroupConnectionsDialog";
import RenameConnectionDialog from "@/components/dialog/connections/RenameConnectionDialog";
import PanelHeader from "@/components/layout/PanelHeader";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApp } from "@/context/AppContext";
import { useConfigTransfer } from "@/hooks/useConfigTransfer";
import { getErrorMessage, shouldPromptConnectionEditOnFailure } from "@/lib/errors";
import { invoke } from "@/lib/invoke";
import { logger } from "@/lib/logger";
import type { NewSessionTarget } from "@/lib/windowManager";
import type { Group, SavedConnection } from "@/types/global";
import ConnectionItem from "./ConnectionItem";
import type { SavedConnectionsContextValue } from "./context";
import {
  type DragTarget,
  type GroupNode,
  naturalCompare,
  SavedConnectionsContext,
  type SortMode,
} from "./context";
import GroupNodeItem from "./GroupNodeItem";

interface SavedConnectionsProps {
  onNewConnection: (parentGroupId?: string) => void;
  onEditConnection: (
    connection: SavedConnection,
    autoConnect?: boolean,
    target?: NewSessionTarget,
  ) => void;
}

type HeaderActionButtonProps = ComponentProps<typeof Button> & {
  tooltip: string;
};

const SAVED_CONNECTIONS_DRAG_MIME = "application/x-nyaterm-saved-connections";

function HeaderActionButton({ tooltip, children, ...props }: HeaderActionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button aria-label={tooltip} type="button" {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** Grouped saved SSH connections panel. Delegates rendering to sub-components via context. */
export default function SavedConnections({
  onNewConnection,
  onEditConnection,
}: SavedConnectionsProps) {
  const {
    savedConnections,
    savedGroups,
    refreshConnections,
    addPendingTab,
    updateTabSession,
    markTabConnectionFailed,
    hasTab,
    appSettings,
    updateUi,
    recordRecentConnection,
  } = useApp();
  const { t } = useTranslation();
  const { handleExport, passwordAlert } = useConfigTransfer();

  // ── UI state ──────────────────────────────────────────────────────────────
  // Tracks in-flight connections to prevent duplicate invocations (not shown in UI)
  const connectingIdsRef = useRef<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [selectedConnectionIds, setSelectedConnectionIds] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState("");
  const searchExpandedBaseRef = useRef<Set<string> | null>(null);
  const searchAutoExpandedGroupIdsRef = useRef<Set<string>>(new Set());
  const previousKeywordRef = useRef("");
  const lastSelectedConnectionIdRef = useRef<string | null>(null);
  const sortMode = (appSettings.ui.saved_connections_sort_mode || "default") as SortMode;

  // ── Dialog state ──────────────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<SavedConnection | null>(null);
  const [renamingConn, setRenamingConn] = useState<SavedConnection | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<Group | null>(null);
  const [showClearAllDialog, setShowClearAllDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [openGroupTarget, setOpenGroupTarget] = useState<{
    groupName: string;
    connections: SavedConnection[];
  } | null>(null);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderDialogName, setFolderDialogName] = useState("");
  const [folderDialogParentId, setFolderDialogParentId] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);

  // ── Drag state ────────────────────────────────────────────────────────────
  const [dragTarget, _setDragTarget] = useState<DragTarget | null>(null);
  const dragTargetRef = useRef<DragTarget | null>(null);
  const dragSourceRef = useRef<{ type: "connection" | "group"; id: string } | null>(null);
  const connectionsRef = useRef(savedConnections);
  const groupsRef = useRef(savedGroups);
  connectionsRef.current = savedConnections;
  groupsRef.current = savedGroups;

  const keyword = filterText.trim().toLowerCase();
  const isDragEnabled = sortMode === "default";
  const connectionById = useMemo(
    () => new Map(savedConnections.map((connection) => [connection.id, connection])),
    [savedConnections],
  );

  // ── Derived tree ──────────────────────────────────────────────────────────
  const { rootNodes, ungrouped } = useMemo(() => {
    const filtered = keyword
      ? savedConnections.filter(
          (c) =>
            c.name.toLowerCase().includes(keyword) ||
            (c.host ?? "").toLowerCase().includes(keyword) ||
            (c.username ?? "").toLowerCase().includes(keyword),
        )
      : savedConnections;

    const sortConns = (list: SavedConnection[]) => {
      if (sortMode === "name-asc") return [...list].sort((a, b) => naturalCompare(a.name, b.name));
      if (sortMode === "name-desc") return [...list].sort((a, b) => naturalCompare(b.name, a.name));
      return [...list].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    };

    const sortGroups = (list: Group[]) => {
      if (sortMode === "name-asc") return [...list].sort((a, b) => naturalCompare(a.name, b.name));
      if (sortMode === "name-desc") return [...list].sort((a, b) => naturalCompare(b.name, a.name));
      return [...list].sort((a, b) => a.sort_order - b.sort_order);
    };

    const sorted = sortConns(filtered);
    const connByGroup: Record<string, SavedConnection[]> = {};
    const noGroup: SavedConnection[] = [];

    sorted.forEach((conn) => {
      if (conn.group_id) {
        if (!connByGroup[conn.group_id]) connByGroup[conn.group_id] = [];
        connByGroup[conn.group_id].push(conn);
      } else {
        noGroup.push(conn);
      }
    });

    const map: Record<string, GroupNode> = {};
    const sortedGroups = sortGroups(savedGroups);
    for (const g of sortedGroups) {
      map[g.id] = { group: g, children: [], connections: connByGroup[g.id] || [], totalCount: 0 };
    }

    const roots: GroupNode[] = [];
    for (const g of sortedGroups) {
      const node = map[g.id];
      if (g.parent_id && map[g.parent_id]) map[g.parent_id].children.push(node);
      else roots.push(node);
    }

    const computeTotal = (node: GroupNode): number => {
      node.totalCount =
        node.connections.length + node.children.reduce((s, c) => s + computeTotal(c), 0);
      return node.totalCount;
    };
    roots.forEach(computeTotal);

    const prune = (node: GroupNode): boolean => {
      node.children = node.children.filter(prune);
      return node.connections.length > 0 || node.children.length > 0;
    };

    return { rootNodes: keyword ? roots.filter(prune) : roots, ungrouped: noGroup };
  }, [savedConnections, savedGroups, keyword, sortMode]);

  useEffect(() => {
    const previousKeyword = previousKeywordRef.current;

    if (!keyword) {
      if (previousKeyword && searchExpandedBaseRef.current) {
        setExpandedGroups(searchExpandedBaseRef.current);
      }
      searchExpandedBaseRef.current = null;
      searchAutoExpandedGroupIdsRef.current = new Set();
      previousKeywordRef.current = "";
      return;
    }

    if (!previousKeyword) {
      searchExpandedBaseRef.current = new Set(expandedGroups);
    }
    if (previousKeyword !== keyword) {
      searchAutoExpandedGroupIdsRef.current = new Set();
    }
    previousKeywordRef.current = keyword;

    const matchingGroupIds = new Set<string>();
    const appendNodeIds = (node: GroupNode) => {
      matchingGroupIds.add(node.group.id);
      node.children.forEach(appendNodeIds);
    };
    rootNodes.forEach(appendNodeIds);

    const groupIdsToOpen = Array.from(matchingGroupIds).filter(
      (id) => !searchAutoExpandedGroupIdsRef.current.has(id),
    );
    if (groupIdsToOpen.length === 0) return;

    searchAutoExpandedGroupIdsRef.current = new Set([
      ...searchAutoExpandedGroupIdsRef.current,
      ...groupIdsToOpen,
    ]);
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      let changed = false;
      groupIdsToOpen.forEach((id) => {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [keyword, rootNodes]);

  const visibleConnectionIds = useMemo(() => {
    const ids: string[] = [];

    const appendNodeConnections = (node: GroupNode) => {
      if (!expandedGroups.has(node.group.id)) return;

      node.children.forEach(appendNodeConnections);
      node.connections.forEach((connection) => {
        ids.push(connection.id);
      });
    };

    rootNodes.forEach(appendNodeConnections);
    ungrouped.forEach((connection) => {
      ids.push(connection.id);
    });

    return ids;
  }, [expandedGroups, rootNodes, ungrouped]);

  const visibleConnectionIdSet = useMemo(
    () => new Set(visibleConnectionIds),
    [visibleConnectionIds],
  );

  const selectedConnections = useMemo(() => {
    const orderedVisible = visibleConnectionIds
      .map((id) => connectionById.get(id))
      .filter(
        (connection): connection is SavedConnection =>
          !!connection && selectedConnectionIds.has(connection.id),
      );

    const hiddenSelected = Array.from(selectedConnectionIds)
      .filter((id) => !visibleConnectionIdSet.has(id))
      .map((id) => connectionById.get(id))
      .filter((connection): connection is SavedConnection => !!connection);

    return [...orderedVisible, ...hiddenSelected];
  }, [connectionById, selectedConnectionIds, visibleConnectionIdSet, visibleConnectionIds]);

  useEffect(() => {
    const validIds = new Set(savedConnections.map((connection) => connection.id));

    setSelectedConnectionIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });

    if (lastSelectedConnectionIdRef.current && !validIds.has(lastSelectedConnectionIdRef.current)) {
      lastSelectedConnectionIdRef.current = null;
    }
  }, [savedConnections]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const getConnectionRangeSelection = (
    anchorId: string,
    targetId: string,
    baseSelection = new Set<string>(),
    additive = false,
  ) => {
    const anchorIndex = visibleConnectionIds.indexOf(anchorId);
    const targetIndex = visibleConnectionIds.indexOf(targetId);

    if (anchorIndex < 0 || targetIndex < 0) {
      return additive ? new Set(baseSelection) : new Set<string>();
    }

    const [start, end] =
      anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    const next = additive ? new Set(baseSelection) : new Set<string>();

    for (let index = start; index <= end; index += 1) {
      next.add(visibleConnectionIds[index]);
    }

    return next;
  };

  const handleConnectionSelectionStart = (conn: SavedConnection, event: React.MouseEvent) => {
    if (event.button !== 0) return;

    const additive = event.ctrlKey || event.metaKey;
    setSelectedConnectionIds((prev) => {
      const hasRangeAnchor = event.shiftKey && !!lastSelectedConnectionIdRef.current;
      const anchor = hasRangeAnchor ? (lastSelectedConnectionIdRef.current ?? conn.id) : conn.id;
      const baseSelection = additive ? new Set(prev) : new Set<string>();
      let next: Set<string>;

      if (hasRangeAnchor) {
        next = getConnectionRangeSelection(anchor, conn.id, baseSelection, additive);
      } else if (additive) {
        next = new Set(prev);
        if (next.has(conn.id)) {
          next.delete(conn.id);
        } else {
          next.add(conn.id);
        }
      } else {
        next = new Set([conn.id]);
      }

      lastSelectedConnectionIdRef.current = conn.id;
      return next;
    });
  };

  const handleConnectionContextMenu = (conn: SavedConnection, _event: React.MouseEvent) => {
    setSelectedConnectionIds((prev) => {
      if (prev.has(conn.id)) {
        return prev;
      }

      lastSelectedConnectionIdRef.current = conn.id;
      return new Set([conn.id]);
    });
  };

  const connectConnection = async (conn: SavedConnection) => {
    if (connectingIdsRef.current.has(conn.id)) return;
    connectingIdsRef.current.add(conn.id);
    const typeMap: Record<string, import("@/types/global").SessionType> = {
      ssh: "SSH",
      local_terminal: "Local",
      telnet: "Telnet",
      serial: "Serial",
    };
    const sessionType = typeMap[conn.type] || "SSH";
    const { tabId, createRequestId } = addPendingTab(conn.name, sessionType, conn.id);

    try {
      let sessionId: string;
      switch (conn.type) {
        case "local_terminal":
          sessionId = await invoke<string>("create_local_session", {
            connectionId: conn.id,
            createRequestId,
          });
          break;
        case "telnet":
          sessionId = await invoke<string>("create_telnet_session", {
            connectionId: conn.id,
            createRequestId,
          });
          break;
        case "serial":
          sessionId = await invoke<string>("create_serial_session", {
            connectionId: conn.id,
            createRequestId,
          });
          break;
        default:
          sessionId = await invoke<string>("create_ssh_session", {
            connectionId: conn.id,
            createRequestId,
          });
          break;
      }
      if (!hasTab(tabId)) {
        try {
          await invoke("close_session", { sessionId });
        } catch (error) {
          logger.error({
            domain: "session.lifecycle",
            event: "session.stale_close_failed",
            message: "Failed to close stale created session",
            ids: { session_id: sessionId },
            error,
          });
        }
        return;
      }
      updateTabSession(tabId, sessionId);
      recordRecentConnection(conn.id);
    } catch (e) {
      const errorMessage = getErrorMessage(e);
      if (errorMessage.toLowerCase().includes("session creation cancelled") || !hasTab(tabId)) {
        return;
      }
      logger.error({
        domain: "session.lifecycle",
        event: "connection.open_failed",
        message: "Connection failed",
        ids: { connection_id: conn.id },
        error: e,
      });
      toast.error(t("savedConnections.connectionFailed", { error: errorMessage }));
      markTabConnectionFailed(tabId, errorMessage);
      if (shouldPromptConnectionEditOnFailure(conn, errorMessage)) {
        onEditConnection(conn, true, { sourceTabId: tabId });
      }
    } finally {
      connectingIdsRef.current.delete(conn.id);
    }
  };

  const openConnections = (connections: SavedConnection[]) => {
    connections.forEach((connection) => {
      void connectConnection(connection);
    });
  };

  const handleConnectSelected = () => {
    if (selectedConnections.length === 0) return;
    openConnections(selectedConnections);
  };

  const handleConnectOnly = (conn: SavedConnection) => {
    openConnections([conn]);
  };

  const handleConnect = (conn: SavedConnection) => {
    if (selectedConnectionIds.has(conn.id) && selectedConnectionIds.size > 1) {
      handleConnectSelected();
      return;
    }

    openConnections([conn]);
  };

  const handleCopyConnection = async (conn: SavedConnection) => {
    try {
      await invoke("save_connection", {
        connection: { ...conn, id: "", name: `${conn.name} (copy)`, password: undefined },
      });
      refreshConnections();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    try {
      await invoke("delete_connection", { id: deleteTarget.id });
      refreshConnections();
    } catch (e) {
      toast.error(t("savedConnections.deleteFailed", { error: e }));
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleRenameConnection = async () => {
    if (!renamingConn || !renameValue.trim()) return;
    try {
      await invoke("save_connection", {
        connection: { ...renamingConn, name: renameValue.trim() },
      });
      refreshConnections();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setRenamingConn(null);
    }
  };

  // ── Folder actions ────────────────────────────────────────────────────────
  const openNewFolderDialog = (parentId: string | null) => {
    setEditingGroup(null);
    setFolderDialogName("");
    setFolderDialogParentId(parentId);
    setFolderDialogOpen(true);
  };

  const openRenameFolderDialog = (group: Group) => {
    setEditingGroup(group);
    setFolderDialogName(group.name);
    setFolderDialogParentId(group.parent_id || null);
    setFolderDialogOpen(true);
  };

  const handleFolderDialogSubmit = async () => {
    if (!folderDialogName.trim()) return;
    try {
      if (editingGroup) {
        await invoke("save_group", { group: { ...editingGroup, name: folderDialogName.trim() } });
      } else {
        await invoke("save_group", {
          group: {
            id: "",
            name: folderDialogName.trim(),
            parent_id: folderDialogParentId || null,
            sort_order: savedGroups.length,
          },
        });
      }
      refreshConnections();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setFolderDialogOpen(false);
    }
  };

  const handleDeleteFolder = async () => {
    if (!deleteFolderTarget) return;
    try {
      await invoke("delete_group", { id: deleteFolderTarget.id });
      refreshConnections();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDeleteFolderTarget(null);
    }
  };

  const handleClearAll = async () => {
    try {
      await invoke("clear_all_connections");
      refreshConnections();
      toast.success(t("savedConnections.clearAllSuccess"));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setShowClearAllDialog(false);
    }
  };

  const collectGroupConnections = (groupId: string): SavedConnection[] => {
    const groupIds = new Set<string>([groupId]);
    let changed = true;

    while (changed) {
      changed = false;
      savedGroups.forEach((group) => {
        if (group.parent_id && groupIds.has(group.parent_id) && !groupIds.has(group.id)) {
          groupIds.add(group.id);
          changed = true;
        }
      });
    }

    return savedConnections.filter(
      (connection) => connection.group_id && groupIds.has(connection.group_id),
    );
  };

  const requestOpenGroupConnections = (node: GroupNode) => {
    const connections = collectGroupConnections(node.group.id);
    if (connections.length === 0) return;

    setOpenGroupTarget({
      groupName: node.group.name,
      connections,
    });
  };

  const handleConfirmOpenGroupConnections = () => {
    if (!openGroupTarget) return;
    openConnections(openGroupTarget.connections);
    setOpenGroupTarget(null);
  };

  // ── Drag & Drop ───────────────────────────────────────────────────────────
  const setDragTarget = (val: DragTarget | null) => {
    dragTargetRef.current = val;
    _setDragTarget(val);
  };

  const resolveDragSource = (dataTransfer: DataTransfer | null) => {
    if (dragSourceRef.current) {
      return dragSourceRef.current;
    }

    const customPayload = dataTransfer?.getData(SAVED_CONNECTIONS_DRAG_MIME);
    if (customPayload) {
      try {
        const parsed = JSON.parse(customPayload) as { type: string; id: string };
        if ((parsed.type === "connection" || parsed.type === "group") && parsed.id) {
          const source = {
            type: parsed.type,
            id: parsed.id,
          } as const;
          dragSourceRef.current = source;
          return source;
        }
      } catch {
        // Ignore malformed drag payloads from prior versions.
      }
    }

    const textPayload = dataTransfer?.getData("text/plain");
    if (!textPayload) {
      return null;
    }

    const separatorIndex = textPayload.indexOf(":");
    if (separatorIndex <= 0) {
      return null;
    }

    const type = textPayload.slice(0, separatorIndex);
    const id = textPayload.slice(separatorIndex + 1);
    if ((type === "connection" || type === "group") && id) {
      const source = { type, id } as const;
      dragSourceRef.current = source;
      return source;
    }

    return null;
  };

  const canDropOnItem = (
    source: { type: "connection" | "group"; id: string },
    targetId: string,
    targetType: "connection" | "group",
  ) => {
    if (source.type === targetType && source.id === targetId) {
      return false;
    }
    if (source.type === "group" && targetType === "group" && isDescendant(targetId, source.id)) {
      return false;
    }
    if (source.type === "group" && targetType === "connection") {
      return false;
    }
    return true;
  };

  const isDescendant = (groupId: string, ancestorId: string): boolean => {
    let cur: string | undefined = groupId;
    while (cur) {
      if (cur === ancestorId) return true;
      cur = groupsRef.current.find((g) => g.id === cur)?.parent_id;
    }
    return false;
  };

  const computeDropPosition = (
    e: React.DragEvent,
    itemType: "connection" | "group",
    srcType: "connection" | "group",
  ): DragTarget["position"] => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (itemType === "group") {
      if (srcType === "connection") return "inside";
      if (y < rect.height * 0.25) return "before";
      if (y > rect.height * 0.75) return "after";
      return "inside";
    }
    return y < rect.height * 0.5 ? "before" : "after";
  };

  const handleDragStart = (e: React.DragEvent, type: "connection" | "group", id: string) => {
    e.stopPropagation();
    // WebKit-based runtimes may ignore HTML5 drops unless the drag carries real data.
    e.dataTransfer.setData(SAVED_CONNECTIONS_DRAG_MIME, JSON.stringify({ type, id }));
    e.dataTransfer.setData("text/plain", `${type}:${id}`);
    e.dataTransfer.effectAllowed = "move";
    dragSourceRef.current = { type, id };
  };

  const handleDragEnd = () => {
    setDragTarget(null);
    dragSourceRef.current = null;
  };

  const updateItemDragTarget = (e: React.DragEvent, id: string, type: "connection" | "group") => {
    e.preventDefault();
    e.stopPropagation();
    const source = resolveDragSource(e.dataTransfer);
    if (!source) return;
    if (!canDropOnItem(source, id, type)) {
      e.dataTransfer.dropEffect = "none";
      return;
    }
    e.dataTransfer.dropEffect = "move";
    const position = computeDropPosition(e, type, source.type);
    const prev = dragTargetRef.current;
    if (prev?.id === id && prev.type === type && prev.position === position) return;
    setDragTarget({ id, type, position });
  };

  const handleDragEnterItem = (e: React.DragEvent, id: string, type: "connection" | "group") => {
    updateItemDragTarget(e, id, type);
  };

  const handleDragOverItem = (e: React.DragEvent, id: string, type: "connection" | "group") => {
    updateItemDragTarget(e, id, type);
  };

  const handleDragLeaveItem = (e: React.DragEvent, id: string, type: "connection" | "group") => {
    const related = e.relatedTarget as Node | null;
    if (related && (e.currentTarget as HTMLElement).contains(related)) return;
    const cur = dragTargetRef.current;
    if (cur?.id === id && cur.type === type) setDragTarget(null);
  };

  const handleDropItem = async (
    e: React.DragEvent,
    id: string,
    tgtType: "connection" | "group",
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const source = resolveDragSource(e.dataTransfer);
    setDragTarget(null);
    dragSourceRef.current = null;
    if (!source || !canDropOnItem(source, id, tgtType)) return;

    const connections = connectionsRef.current;
    const groups = groupsRef.current;
    const { id: srcId, type: srcType } = source;
    const position = computeDropPosition(e, tgtType, srcType);

    try {
      if (position === "inside" && tgtType === "group") {
        if (srcType === "connection") {
          const conn = connections.find((c) => c.id === srcId);
          if (conn && conn.group_id !== id) {
            const groupConns = connections
              .filter((c) => c.group_id === id && c.id !== srcId)
              .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
            groupConns.push({ ...conn, group_id: id });
            await invoke("save_connection", { connection: { ...conn, group_id: id } });
            await invoke("reorder_items", {
              connections: groupConns.map((c, i) => ({ id: c.id, sort_order: i })),
              groups: [],
            });
            refreshConnections();
          }
        } else {
          const grp = groups.find((g) => g.id === srcId);
          if (grp && grp.parent_id !== id) {
            const groupChildren = groups
              .filter((g) => g.parent_id === id && g.id !== srcId)
              .sort((a, b) => a.sort_order - b.sort_order);
            groupChildren.push({ ...grp, parent_id: id });
            await invoke("save_group", { group: { ...grp, parent_id: id } });
            await invoke("reorder_items", {
              connections: [],
              groups: groupChildren.map((g, i) => ({ id: g.id, sort_order: i })),
            });
            refreshConnections();
          }
        }
        return;
      }

      const targetParentId: string | null =
        tgtType === "connection"
          ? (connections.find((c) => c.id === id)?.group_id ?? null)
          : (groups.find((g) => g.id === id)?.parent_id ?? null);

      const srcConn = srcType === "connection" ? connections.find((c) => c.id === srcId) : null;
      const srcGrp = srcType === "group" ? groups.find((g) => g.id === srcId) : null;

      if (srcConn && (srcConn.group_id ?? null) !== targetParentId)
        await invoke("save_connection", { connection: { ...srcConn, group_id: targetParentId } });
      if (srcGrp && (srcGrp.parent_id ?? null) !== targetParentId)
        await invoke("save_group", { group: { ...srcGrp, parent_id: targetParentId } });

      const connsUpdates: { id: string; sort_order: number }[] = [];
      const groupsUpdates: { id: string; sort_order: number }[] = [];

      if (srcType === "connection" && tgtType === "connection") {
        const siblings = connections
          .filter((c) => (c.group_id ?? null) === targetParentId)
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
        const list = siblings.filter((c) => c.id !== srcId);
        const tgtIdx = list.findIndex((c) => c.id === id);
        if (tgtIdx >= 0 && srcConn)
          list.splice(position === "before" ? tgtIdx : tgtIdx + 1, 0, srcConn);
        list.forEach((c, i) => {
          connsUpdates.push({ id: c.id, sort_order: i });
        });
      } else if (srcType === "group" && tgtType === "group") {
        const siblings = groups
          .filter((g) => (g.parent_id ?? null) === targetParentId)
          .sort((a, b) => a.sort_order - b.sort_order);
        const list = siblings.filter((g) => g.id !== srcId);
        const tgtIdx = list.findIndex((g) => g.id === id);
        if (tgtIdx >= 0 && srcGrp)
          list.splice(position === "before" ? tgtIdx : tgtIdx + 1, 0, srcGrp);
        list.forEach((g, i) => {
          groupsUpdates.push({ id: g.id, sort_order: i });
        });
      } else {
        if (srcType === "connection" && srcConn) {
          const siblings = connections
            .filter((c) => (c.group_id ?? null) === targetParentId && c.id !== srcId)
            .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
          siblings.push(srcConn);
          siblings.forEach((c, i) => {
            connsUpdates.push({ id: c.id, sort_order: i });
          });
        } else if (srcType === "group" && srcGrp) {
          const siblings = groups
            .filter((g) => (g.parent_id ?? null) === targetParentId && g.id !== srcId)
            .sort((a, b) => a.sort_order - b.sort_order);
          siblings.push(srcGrp);
          siblings.forEach((g, i) => {
            groupsUpdates.push({ id: g.id, sort_order: i });
          });
        }
      }

      if (connsUpdates.length > 0 || groupsUpdates.length > 0)
        await invoke("reorder_items", { connections: connsUpdates, groups: groupsUpdates });
      refreshConnections();
    } catch (err) {
      logger.error({
        domain: "ui.error",
        event: "saved_connections.drag_drop_failed",
        message: "Drag drop failed",
        error: err,
      });
    }
  };

  const handleDragOverBg = (e: React.DragEvent) => {
    e.preventDefault();
    const source = resolveDragSource(e.dataTransfer);
    if (!source) return;
    const isAtRoot =
      source.type === "connection"
        ? !connectionsRef.current.find((c) => c.id === source.id)?.group_id
        : !groupsRef.current.find((g) => g.id === source.id)?.parent_id;
    if (isAtRoot) {
      e.dataTransfer.dropEffect = "none";
      if (dragTargetRef.current !== null) setDragTarget(null);
      return;
    }
    e.dataTransfer.dropEffect = "move";
    if (dragTargetRef.current?.type !== "background")
      setDragTarget({ id: null, type: "background", position: "inside" });
  };

  const handleDropBg = async (e: React.DragEvent) => {
    e.preventDefault();
    const source = resolveDragSource(e.dataTransfer);
    setDragTarget(null);
    dragSourceRef.current = null;
    if (!source) return;
    try {
      if (source.type === "connection") {
        const conn = connectionsRef.current.find((c) => c.id === source.id);
        if (conn?.group_id) {
          await invoke("save_connection", { connection: { ...conn, group_id: null } });
          const siblings = connectionsRef.current
            .filter((c) => !c.group_id && c.id !== source.id)
            .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
          siblings.push(conn);
          await invoke("reorder_items", {
            connections: siblings.map((c, i) => ({ id: c.id, sort_order: i })),
            groups: [],
          });
          refreshConnections();
        }
      } else {
        const grp = groupsRef.current.find((g) => g.id === source.id);
        if (grp?.parent_id) {
          await invoke("save_group", { group: { ...grp, parent_id: null } });
          const siblings = groupsRef.current
            .filter((g) => !g.parent_id && g.id !== source.id)
            .sort((a, b) => a.sort_order - b.sort_order);
          siblings.push(grp);
          await invoke("reorder_items", {
            connections: [],
            groups: siblings.map((g, i) => ({ id: g.id, sort_order: i })),
          });
          refreshConnections();
        }
      }
    } catch (err) {
      logger.error({
        domain: "ui.error",
        event: "saved_connections.drop_to_root_failed",
        message: "Drop to root failed",
        error: err,
      });
    }
  };

  // ── Sort button helpers ───────────────────────────────────────────────────
  const cycleSortMode = () => {
    const next =
      sortMode === "default" ? "name-asc" : sortMode === "name-asc" ? "name-desc" : "default";
    updateUi({ saved_connections_sort_mode: next });
  };
  const sortTitle =
    sortMode === "default"
      ? t("savedConnections.sortDefault")
      : sortMode === "name-asc"
        ? t("savedConnections.sortNameAsc")
        : t("savedConnections.sortNameDesc");
  const SortIcon = sortMode === "default" ? MdSort : MdSortByAlpha;
  const sortActive = sortMode !== "default";

  // ── Context value ─────────────────────────────────────────────────────────
  const ctxValue: SavedConnectionsContextValue = {
    isDragEnabled,
    dragTarget,
    expandedGroups,
    selectedConnectionIds,
    toggleGroup,
    handleConnect,
    handleConnectOnly,
    handleConnectSelected,
    handleCopyConnection,
    handleConnectionSelectionStart,
    handleConnectionContextMenu,
    onEditConnection,
    onNewConnection,
    setDeleteTarget,
    setRenamingConn,
    setRenameValue,
    setDeleteFolderTarget,
    openNewFolderDialog,
    openRenameFolderDialog,
    requestOpenGroupConnections,
    handleDragStart,
    handleDragEnd,
    handleDragEnterItem,
    handleDragOverItem,
    handleDragLeaveItem,
    handleDropItem,
    t,
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <SavedConnectionsContext.Provider value={ctxValue}>
      <div className="h-full flex flex-col overflow-hidden">
        <PanelHeader
          title={t("panel.savedConnections")}
          actions={
            savedConnections.length > 0 ? (
              <span className="text-[0.6875rem]" style={{ color: "var(--df-text-dimmed)" }}>
                {savedConnections.length}
              </span>
            ) : null
          }
        />

        <div
          className="nyaterm-wallpaper-transparent-surface flex items-center gap-1.5 px-2 py-1.5 shrink-0 border-b"
          style={{
            borderColor: "color-mix(in srgb, var(--df-border) 40%, transparent)",
            backgroundColor: "var(--df-bg-section-header)",
          }}
        >
          <div className="relative flex-1 min-w-0 transition-colors focus-within:text-[var(--df-primary)] text-[var(--df-text-dimmed)]">
            <MdSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[0.875rem] pointer-events-none" />
            <input
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder={t("savedConnections.filter")}
              className="w-full pl-8 pr-7 py-1 h-7 text-xs rounded-md bg-[var(--df-bg-hover)] border border-transparent outline-none transition-all placeholder:text-[var(--df-text-dimmed)] focus:bg-transparent focus:border-[var(--df-primary)] focus:ring-1 focus:ring-[var(--df-primary)] text-[var(--df-text)]"
            />
            {filterText && (
              <button
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded transition-colors hover:text-[var(--df-text)] text-[var(--df-text-dimmed)]"
                onClick={() => setFilterText("")}
              >
                <MdClose className="text-xs" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-0.5 shrink-0">
            <HeaderActionButton
              variant="ghost"
              size="icon-sm"
              className="shrink-0 h-6 w-6 rounded-md p-0 transition-colors hover:bg-[var(--df-bg-hover)]"
              style={{ color: sortActive ? "var(--df-primary)" : "var(--df-text-muted)" }}
              tooltip={sortTitle}
              onClick={cycleSortMode}
            >
              <SortIcon
                className="text-xs"
                style={{ transform: sortMode === "name-desc" ? "scaleY(-1)" : undefined }}
              />
            </HeaderActionButton>

            <HeaderActionButton
              variant="ghost"
              size="icon-sm"
              className="shrink-0 h-6 w-6 rounded-md p-0 transition-colors hover:bg-[var(--df-bg-hover)]"
              style={{ color: "var(--df-text-muted)" }}
              tooltip={t("savedConnections.newFolder")}
              onClick={() => openNewFolderDialog(null)}
            >
              <MdCreateNewFolder className="text-[1rem]" />
            </HeaderActionButton>

            <HeaderActionButton
              variant="ghost"
              size="icon-sm"
              className="shrink-0 h-6 w-6 rounded-md p-0 transition-colors hover:bg-[var(--df-bg-hover)]"
              style={{ color: "var(--df-text-muted)" }}
              tooltip={t("savedConnections.newConnection")}
              onClick={() => onNewConnection()}
            >
              <MdAdd className="text-[1.125rem]" />
            </HeaderActionButton>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 h-6 w-6 rounded-md p-0 transition-colors outline-none hover:bg-[var(--df-bg-hover)] data-[state=open]:bg-[var(--df-bg-hover)]"
                  style={{ color: "var(--df-text-muted)" }}
                  aria-label="More"
                >
                  <MdMoreVert className="text-[1.125rem]" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="text-xs w-40">
                <DropdownMenuItem
                  onClick={handleExport}
                  className="cursor-pointer gap-2 py-1.5 focus:bg-[var(--df-bg-hover)]"
                >
                  <BiExport className="text-sm text-[var(--df-text-muted)]" />
                  {t("settings.exportConfig")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setShowImportDialog(true)}
                  className="cursor-pointer gap-2 py-1.5 focus:bg-[var(--df-bg-hover)]"
                >
                  <BiImport className="text-sm text-[var(--df-text-muted)]" />
                  {t("settings.importConfig")}
                </DropdownMenuItem>
                {savedConnections.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => setShowClearAllDialog(true)}
                      className="cursor-pointer gap-2 py-1.5 focus:bg-[var(--df-bg-hover)] text-red-500 focus:text-red-500"
                    >
                      <MdDeleteSweep className="text-sm" />
                      {t("savedConnections.clearAll")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* List */}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              className={`flex-1 overflow-x-auto overflow-y-auto p-1.5 text-xs space-y-0.5 terminal-scroll ${dragTarget?.type === "background" ? "ring-inset ring-2 ring-primary/20" : ""}`}
              onMouseDown={(event) => {
                if (event.button !== 0 || event.target !== event.currentTarget) return;
                setSelectedConnectionIds(new Set());
                lastSelectedConnectionIdRef.current = null;
              }}
              onDragEnter={isDragEnabled ? (e) => e.preventDefault() : undefined}
              onDragOver={isDragEnabled ? handleDragOverBg : undefined}
              onDrop={isDragEnabled ? handleDropBg : undefined}
            >
              {savedConnections.length === 0 && savedGroups.length === 0 ? (
                <div
                  className="text-center py-4 text-xs"
                  style={{ color: "var(--df-text-dimmed)" }}
                >
                  {t("panel.noSavedConnections")}
                </div>
              ) : rootNodes.length === 0 && ungrouped.length === 0 ? (
                <div
                  className="text-center py-4 text-xs"
                  style={{ color: "var(--df-text-dimmed)" }}
                >
                  {t("savedConnections.noResults")}
                </div>
              ) : (
                <>
                  {rootNodes.map((node) => (
                    <GroupNodeItem key={node.group.id} node={node} depth={0} />
                  ))}
                  {ungrouped.length > 0 && rootNodes.length > 0 && (
                    <div
                      className="mt-1 pt-1 border-t"
                      style={{
                        borderColor: "color-mix(in srgb, var(--df-border) 50%, transparent)",
                      }}
                    />
                  )}
                  {ungrouped.map((conn) => (
                    <ConnectionItem key={conn.id} conn={conn} indented={false} />
                  ))}
                </>
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-[160px]">
            {selectedConnections.length > 0 && (
              <ContextMenuItem onClick={handleConnectSelected}>
                <MdLink className="text-[0.875rem] text-muted-foreground mr-2" />
                {selectedConnections.length > 1
                  ? t("savedConnections.connectSelected")
                  : t("savedConnections.connect")}
              </ContextMenuItem>
            )}
            {selectedConnections.length > 0 && <ContextMenuSeparator />}
            <ContextMenuItem onClick={() => onNewConnection()}>
              <MdAdd className="text-[0.875rem] text-muted-foreground mr-2" />
              {t("savedConnections.newConnection")}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => openNewFolderDialog(null)}>
              <MdCreateNewFolder className="text-[0.875rem] text-muted-foreground mr-2" />
              {t("savedConnections.newFolder")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => setShowImportDialog(true)}>
              <BiImport className="text-[0.875rem] text-muted-foreground mr-2" />
              {t("settings.importConfig")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {/* Dialogs */}
        <DeleteConnectionDialog
          open={!!deleteTarget}
          connectionName={deleteTarget?.name}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
        <DeleteFolderDialog
          open={!!deleteFolderTarget}
          folderName={deleteFolderTarget?.name}
          onConfirm={handleDeleteFolder}
          onCancel={() => setDeleteFolderTarget(null)}
        />
        <FolderDialog
          open={folderDialogOpen}
          isEditing={!!editingGroup}
          name={folderDialogName}
          onNameChange={setFolderDialogName}
          onSubmit={handleFolderDialogSubmit}
          onCancel={() => setFolderDialogOpen(false)}
        />
        <RenameConnectionDialog
          open={!!renamingConn}
          value={renameValue}
          onValueChange={setRenameValue}
          onSubmit={handleRenameConnection}
          onCancel={() => setRenamingConn(null)}
        />
        <ClearAllDialog
          open={showClearAllDialog}
          onConfirm={handleClearAll}
          onCancel={() => setShowClearAllDialog(false)}
        />
        <OpenGroupConnectionsDialog
          open={!!openGroupTarget}
          folderName={openGroupTarget?.groupName}
          count={openGroupTarget?.connections.length}
          onConfirm={handleConfirmOpenGroupConnections}
          onCancel={() => setOpenGroupTarget(null)}
        />
        <ImportDialog open={showImportDialog} onClose={() => setShowImportDialog(false)} />
        {passwordAlert}
      </div>
    </SavedConnectionsContext.Provider>
  );
}
