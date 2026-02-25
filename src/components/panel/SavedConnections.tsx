import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MdDelete,
  MdEdit,
  MdExpandMore,
  MdFolder,
  MdFolderOpen,
  MdLan,
  MdRefresh,
} from "react-icons/md";
import { toast } from "sonner";
import { useApp } from "../../context/AppContext";
import { invoke } from "../../lib/invoke";
import { logger } from "../../lib/logger";
import type { Group, SavedConnection, SessionType } from "../../types";

interface SavedConnectionsProps {
  onEditConnection: (connection: SavedConnection) => void;
  onSessionCreated: (
    sessionId: string,
    name: string,
    type: SessionType,
    connectionId?: string,
  ) => void;
}

interface HoverInfo {
  conn: SavedConnection;
  top: number;
  right: number;
}

/** Grouped saved SSH connections. Connect, edit, delete. Hover shows detail panel. */
export default function SavedConnections({
  onEditConnection,
  onSessionCreated,
}: SavedConnectionsProps) {
  const { savedConnections, savedGroups, refreshConnections } = useApp();
  const { t } = useTranslation();
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);

  // Build grouped view: use savedGroups order, include empty groups
  const { groups, ungrouped } = useMemo(() => {
    const connByGroup: Record<string, SavedConnection[]> = {};
    const noGroup: SavedConnection[] = [];

    savedConnections.forEach((conn) => {
      if (conn.group) {
        if (!connByGroup[conn.group]) connByGroup[conn.group] = [];
        connByGroup[conn.group].push(conn);
      } else {
        noGroup.push(conn);
      }
    });

    const sortedGroups = [...savedGroups].sort((a, b) => a.sort_order - b.sort_order);
    const result: [Group, SavedConnection[]][] = sortedGroups.map((g) => [
      g,
      connByGroup[g.name] || [],
    ]);

    return { groups: result, ungrouped: noGroup };
  }, [savedConnections, savedGroups]);

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const handleConnect = async (conn: SavedConnection) => {
    if (connectingId) return;
    setConnectingId(conn.id);
    try {
      const sessionId = await invoke<string>("create_ssh_session", { connectionId: conn.id });
      onSessionCreated(sessionId, conn.name, "SSH", conn.id);
    } catch (e) {
      logger.error(`SSH connection failed for "${conn.name}"`, e);
      toast.error(t("savedConnections.connectionFailed", { error: e }));
      onEditConnection(conn);
    } finally {
      setConnectingId(null);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await invoke("delete_connection", { id });
      refreshConnections();
    } catch (e) {
      toast.error(t("savedConnections.deleteFailed", { error: e }));
    }
  };

  const handleEdit = (e: React.MouseEvent, conn: SavedConnection) => {
    e.stopPropagation();
    onEditConnection(conn);
  };

  const handleMouseEnter = useCallback((e: React.MouseEvent, conn: SavedConnection) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setHoverInfo({
      conn,
      top: rect.top,
      right: rect.left,
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoverInfo(null);
  }, []);

  const renderConnectionItem = (conn: SavedConnection, indented: boolean) => (
    <div
      key={conn.id}
      className={`group/item relative flex items-center gap-2 py-1.5 px-2 rounded cursor-pointer transition-colors df-hover ${indented ? "ml-4" : ""}`}
      onDoubleClick={() => handleConnect(conn)}
      onMouseEnter={(e) => handleMouseEnter(e, conn)}
      onMouseLeave={handleMouseLeave}
    >
      <MdLan className="text-emerald-500/70 text-sm shrink-0" />
      <span
        className="flex-1 min-w-0 truncate text-[11px] font-medium pr-16"
        style={{ color: "var(--df-text)" }}
      >
        {conn.name}
      </span>
      {connectingId === conn.id && (
        <MdRefresh
          className="animate-spin text-xs shrink-0"
          style={{ color: "var(--df-primary)" }}
        />
      )}
      <div
        className="absolute right-2 top-1/2 -translate-y-1/2 hidden group-hover/item:flex items-center gap-0.5 shrink-0 backdrop-blur-sm rounded px-1"
        style={{ backgroundColor: "var(--df-bg-hover)" }}
      >
        <button
          className="p-0.5 transition-colors hover:opacity-80"
          style={{ color: "var(--df-text-dimmed)" }}
          title={t("savedConnections.edit")}
          onClick={(e) => handleEdit(e, conn)}
        >
          <MdEdit className="text-sm" />
        </button>
        <button
          className="p-0.5 hover:text-red-400 transition-colors"
          style={{ color: "var(--df-text-dimmed)" }}
          title={t("savedConnections.delete")}
          onClick={(e) => handleDelete(e, conn.id)}
        >
          <MdDelete className="text-sm" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div
        className="p-2 text-[10px] uppercase tracking-wider font-bold border-b flex justify-between items-center"
        style={{
          color: "var(--df-text-muted)",
          borderColor: "var(--df-border)",
          backgroundColor: "var(--df-bg-section-header)",
        }}
      >
        <span>{t("panel.savedConnections")}</span>
        <span className="text-[10px] font-normal" style={{ color: "var(--df-text-dimmed)" }}>
          {savedConnections.length}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5 text-xs space-y-0.5 terminal-scroll">
        {savedConnections.length === 0 ? (
          <div className="text-center py-4 text-[11px]" style={{ color: "var(--df-text-dimmed)" }}>
            {t("panel.noSavedConnections")}
          </div>
        ) : (
          <>
            {groups.map(([grp, conns]) => {
              const collapsed = !expandedGroups.has(grp.id);
              return (
                <div key={grp.id}>
                  <div
                    className="flex items-center gap-1.5 py-1.5 px-2 rounded cursor-pointer transition-colors select-none df-hover"
                    onClick={() => toggleGroup(grp.id)}
                  >
                    <MdExpandMore
                      className="text-xs transition-transform"
                      style={{
                        color: "var(--df-text-dimmed)",
                        transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
                      }}
                    />
                    {collapsed ? (
                      <MdFolder className="text-sm text-amber-500/70" />
                    ) : (
                      <MdFolderOpen className="text-sm text-amber-500/70" />
                    )}
                    <span
                      className="text-[11px] font-medium flex-1 truncate"
                      style={{ color: "var(--df-text-muted)" }}
                    >
                      {grp.name}
                    </span>
                    <span
                      className="text-[9px] tabular-nums"
                      style={{ color: "var(--df-text-dimmed)" }}
                    >
                      {conns.length}
                    </span>
                  </div>
                  {!collapsed && (
                    <div className="mb-1">
                      {conns.map((conn) => renderConnectionItem(conn, true))}
                    </div>
                  )}
                </div>
              );
            })}

            {ungrouped.length > 0 && groups.length > 0 && (
              <div
                className="mt-1 pt-1 border-t"
                style={{ borderColor: "color-mix(in srgb, var(--df-border) 50%, transparent)" }}
              />
            )}
            {ungrouped.map((conn) => renderConnectionItem(conn, false))}
          </>
        )}
      </div>

      {/* Hover detail panel */}
      {hoverInfo && (
        <div
          className="fixed z-50 pointer-events-none"
          style={{ top: hoverInfo.top, left: hoverInfo.right }}
        >
          <div className="relative -translate-x-full -translate-y-1">
            {/* Arrow */}
            <div
              className="absolute top-3 -right-1.5 w-3 h-3 border-r border-t rotate-45"
              style={{ backgroundColor: "var(--df-bg-panel)", borderColor: "var(--df-border)" }}
            />
            {/* Panel body */}
            <div
              className="mr-1 border rounded-lg shadow-xl p-3 min-w-[200px] max-w-[260px]"
              style={{ backgroundColor: "var(--df-bg-panel)", borderColor: "var(--df-border)" }}
            >
              <div
                className="text-xs font-semibold mb-2 truncate"
                style={{ color: "var(--df-text)" }}
              >
                {hoverInfo.conn.name}
              </div>
              <div className="space-y-1.5 text-[10px]">
                <div className="flex items-center gap-2">
                  <span className="w-12 shrink-0" style={{ color: "var(--df-text-dimmed)" }}>
                    {t("savedConnections.host")}
                  </span>
                  <span className="truncate" style={{ color: "var(--df-text)" }}>
                    {hoverInfo.conn.host}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-12 shrink-0" style={{ color: "var(--df-text-dimmed)" }}>
                    {t("savedConnections.port")}
                  </span>
                  <span style={{ color: "var(--df-text)" }}>{hoverInfo.conn.port}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-12 shrink-0" style={{ color: "var(--df-text-dimmed)" }}>
                    {t("savedConnections.user")}
                  </span>
                  <span className="truncate" style={{ color: "var(--df-text)" }}>
                    {hoverInfo.conn.username}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-12 shrink-0" style={{ color: "var(--df-text-dimmed)" }}>
                    {t("savedConnections.auth")}
                  </span>
                  <span className="capitalize" style={{ color: "var(--df-text)" }}>
                    {hoverInfo.conn.auth_type}
                  </span>
                </div>
                {hoverInfo.conn.group && (
                  <div className="flex items-center gap-2">
                    <span className="w-12 shrink-0" style={{ color: "var(--df-text-dimmed)" }}>
                      {t("savedConnections.group")}
                    </span>
                    <span className="truncate" style={{ color: "var(--df-text)" }}>
                      {hoverInfo.conn.group}
                    </span>
                  </div>
                )}
                {hoverInfo.conn.description && (
                  <div
                    className="pt-1.5 mt-1.5 border-t"
                    style={{ borderColor: "color-mix(in srgb, var(--df-border) 60%, transparent)" }}
                  >
                    <span style={{ color: "var(--df-text-muted)" }} className="leading-relaxed">
                      {hoverInfo.conn.description}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
