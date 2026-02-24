import { useEffect, useRef } from "react";
import { useApp } from "../../context/AppContext";

export default function GlobalContextMenu() {
    const { contextMenu, hideContextMenu } = useApp();
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                hideContextMenu();
            }
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                hideContextMenu();
            }
        };

        // Use capture phase so we close it *before* other clicks register
        if (contextMenu) {
            window.addEventListener("click", handleClick, true);
            window.addEventListener("contextmenu", handleClick, true);
            window.addEventListener("keydown", handleKeyDown, true);
        }

        return () => {
            window.removeEventListener("click", handleClick, true);
            window.removeEventListener("contextmenu", handleClick, true);
            window.removeEventListener("keydown", handleKeyDown, true);
        };
    }, [contextMenu, hideContextMenu]);

    if (!contextMenu) return null;

    // Simple bounds checking so the menu doesn't overflow screen edges
    const maxW = window.innerWidth;
    const maxH = window.innerHeight;
    const menuWidth = 200; // approximate
    const menuHeight = contextMenu.items.length * 36; // approximate per item

    let { x, y } = contextMenu;
    if (x + menuWidth > maxW) x = maxW - menuWidth - 10;
    if (y + menuHeight > maxH) y = maxH - menuHeight - 10;

    return (
        <div
            ref={menuRef}
            className="fixed z-[10000] py-1 rounded shadow-2xl border text-xs"
            style={{
                left: x,
                top: y,
                backgroundColor: "var(--df-bg-panel)",
                borderColor: "var(--df-border)",
                color: "var(--df-text)",
                minWidth: "180px",
            }}
            // Prevent propagating clicks inside the menu to avoid immediately closing it,
            // though our custom capture event handler handles outside clicks already.
            onClick={(e) => e.stopPropagation()}
        >
            {contextMenu.items.map((item, idx) => {
                if (item.divider) {
                    return (
                        <div
                            key={`div-${idx}`}
                            className="border-b my-1"
                            style={{ borderColor: "var(--df-border)" }}
                        />
                    );
                }

                return (
                    <div
                        key={`item-${idx}`}
                        className="px-3 py-1.5 cursor-pointer flex items-center gap-2 transition-colors"
                        style={{ color: item.color || "inherit" }}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--df-bg-hover)")}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "")}
                        onClick={(e) => {
                            e.stopPropagation();
                            hideContextMenu();
                            item.onClick();
                        }}
                    >
                        {item.icon && <span className="material-icons text-[14px]">{item.icon}</span>}
                        {item.label}
                    </div>
                );
            })}
        </div>
    );
}
