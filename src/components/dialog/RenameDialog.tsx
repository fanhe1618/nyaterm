import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

export interface RenameDialogData {
    sessionId: string;
    oldPath: string;
    name: string;
    currentDirPath: string;
}

interface RenameDialogProps {
    data: RenameDialogData;
    onClose: () => void;
    onSuccess: () => void;
}

export default function RenameDialog({ data, onClose, onSuccess }: RenameDialogProps) {
    const { t } = useTranslation();
    const [dialogInput, setDialogInput] = useState(data.name);
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        setDialogInput(data.name);
    }, [data.name]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !isSubmitting) {
                onClose();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [onClose, isSubmitting]);

    const handleRenameSubmit = async () => {
        if (!dialogInput || dialogInput === data.name) {
            onClose();
            return;
        }

        try {
            setIsSubmitting(true);
            const newPath = data.currentDirPath === "/" ? `/${dialogInput}` : `${data.currentDirPath}/${dialogInput}`;
            await invoke("rename_remote_file", {
                sessionId: data.sessionId,
                oldPath: data.oldPath,
                newPath,
            });
            onSuccess();
            onClose();
        } catch (e) {
            alert(String(e));
        } finally {
            setIsSubmitting(false);
        }
    };

    return createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50">
            <div className="rounded shadow-xl p-4 w-80" style={{ backgroundColor: "var(--df-bg-panel)", border: "1px solid var(--df-border)" }}>
                <h3 className="font-bold mb-4">{t("fileExplorer.renameTo", { name: data.name })}</h3>
                <input
                    type="text"
                    className="w-full text-sm p-2 rounded border mb-4 focus:outline-none"
                    style={{ backgroundColor: "var(--df-bg)", borderColor: "var(--df-border)", color: "var(--df-text)" }}
                    value={dialogInput}
                    onChange={(e) => setDialogInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !isSubmitting && handleRenameSubmit()}
                    disabled={isSubmitting}
                    autoFocus
                />
                <div className="flex justify-end gap-2">
                    <button
                        className="px-3 py-1 rounded text-sm hover:opacity-80 transition-opacity"
                        style={{ backgroundColor: "var(--df-bg-hover)" }}
                        onClick={onClose}
                        disabled={isSubmitting}
                    >
                        {t("dialog.cancel")}
                    </button>
                    <button
                        className="px-3 py-1 rounded text-sm hover:opacity-80 transition-opacity flex items-center gap-1"
                        style={{ backgroundColor: "var(--df-primary)", color: "#fff", opacity: isSubmitting ? 0.5 : 1 }}
                        onClick={handleRenameSubmit}
                        disabled={isSubmitting}
                    >
                        {isSubmitting && <span className="material-icons text-[14px] animate-spin">refresh</span>}
                        {t("dialog.save")}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}
