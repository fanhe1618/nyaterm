import {
  MdContentCopy,
  MdDelete,
  MdDriveFileRenameOutline,
  MdEdit,
  MdLan,
  MdLink,
} from "react-icons/md";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { SavedConnection } from "@/types/global";
import { CONNECTION_ICONS } from "../../icons";
import { useSavedConnectionsContext } from "./context";

interface ConnectionItemProps {
  conn: SavedConnection;
  indented: boolean;
  depth?: number;
}

export default function ConnectionItem({ conn, indented, depth = 0 }: ConnectionItemProps) {
  const {
    isDragEnabled,
    dragTarget,
    handleConnect,
    handleCopyConnection,
    onEditConnection,
    setDeleteTarget,
    setRenamingConn,
    setRenameValue,
    handleDragStart,
    handleDragEnd,
    handleDragOverItem,
    handleDragLeaveItem,
    handleDropItem,
    t,
  } = useSavedConnectionsContext();

  const isTarget = dragTarget?.id === conn.id && dragTarget.type === "connection";
  const showBefore = isTarget && dragTarget.position === "before";
  const showAfter = isTarget && dragTarget.position === "after";
  const iconDef = conn.icon ? CONNECTION_ICONS[conn.icon] : null;
  const ConnIcon = iconDef ? iconDef.icon : MdLan;
  const iconStyle = iconDef ? { color: iconDef.color } : undefined;
  const indentLeft = indented ? `${8 + depth * 16 + 16}px` : "0.5rem";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="relative"
          draggable={isDragEnabled}
          onDragStart={isDragEnabled ? (e) => handleDragStart(e, "connection", conn.id) : undefined}
          onDragOver={isDragEnabled ? (e) => handleDragOverItem(e, conn.id, "connection") : undefined}
          onDragLeave={isDragEnabled ? (e) => handleDragLeaveItem(e, conn.id, "connection") : undefined}
          onDrop={isDragEnabled ? (e) => handleDropItem(e, conn.id, "connection") : undefined}
          onDragEnd={isDragEnabled ? handleDragEnd : undefined}
        >
          {showBefore && (
            <div className="absolute top-0 right-2 h-0.5 rounded-full z-10" style={{ backgroundColor: "var(--df-primary)", left: indentLeft }} />
          )}
          <div
            className={`group/item relative flex items-center gap-2 py-1.5 px-2 rounded cursor-pointer transition-colors df-hover ${isTarget && dragTarget.position === "inside" ? "ring-1 ring-primary/60" : ""}`}
            style={indented ? { paddingLeft: `${8 + depth * 16 + 16}px` } : undefined}
            onDoubleClick={() => handleConnect(conn)}
          >
            <ConnIcon
              className={`text-sm shrink-0${iconDef ? "" : " text-emerald-500/70"}`}
              style={iconStyle}
            />
            <span
              className="flex-1 min-w-0 truncate text-xs font-medium pr-16"
              style={{ color: "var(--df-text)" }}
            >
              {conn.name}
            </span>
            <div
              className="absolute right-2 top-1/2 -translate-y-1/2 hidden group-hover/item:flex items-center gap-0.5 shrink-0 backdrop-blur-sm rounded px-1"
              style={{ backgroundColor: "var(--df-bg-hover)" }}
            >
              <button
                className="p-0.5 cursor-pointer transition-colors hover:opacity-80"
                style={{ color: "var(--df-text-dimmed)" }}
                title={t("savedConnections.connect")}
                onClick={(e) => { e.stopPropagation(); handleConnect(conn); }}
              >
                <MdLink className="text-sm cursor-pointer" />
              </button>
              <button
                className="p-0.5 cursor-pointer transition-colors hover:opacity-80"
                style={{ color: "var(--df-text-dimmed)" }}
                title={t("savedConnections.edit")}
                onClick={(e) => { e.stopPropagation(); onEditConnection(conn); }}
              >
                <MdEdit className="text-sm cursor-pointer" />
              </button>
              <button
                className="p-0.5 cursor-pointer hover:text-red-400 transition-colors"
                style={{ color: "var(--df-text-dimmed)" }}
                title={t("savedConnections.delete")}
                onClick={(e) => { e.stopPropagation(); setDeleteTarget(conn); }}
              >
                <MdDelete className="text-sm cursor-pointer" />
              </button>
            </div>
          </div>
          {showAfter && (
            <div className="absolute bottom-0 right-2 h-0.5 rounded-full z-10" style={{ backgroundColor: "var(--df-primary)", left: indentLeft }} />
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[160px]">
        <ContextMenuItem onClick={() => handleConnect(conn)}>
          <MdLink className="text-[0.875rem] text-muted-foreground mr-2" />
          {t("savedConnections.connect")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => { setRenameValue(conn.name); setRenamingConn(conn); }}>
          <MdDriveFileRenameOutline className="text-[0.875rem] text-muted-foreground mr-2" />
          {t("savedConnections.rename")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => handleCopyConnection(conn)}>
          <MdContentCopy className="text-[0.875rem] text-muted-foreground mr-2" />
          {t("savedConnections.copy")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-red-400" onClick={() => setDeleteTarget(conn)}>
          <MdDelete className="text-[0.875rem] mr-2" />
          {t("savedConnections.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
