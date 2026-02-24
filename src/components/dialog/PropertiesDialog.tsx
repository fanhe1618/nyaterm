import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

export interface PropertiesDialogData {
    sessionId: string;
    fullPath: string;
    name: string;
    is_dir: boolean;
}

interface FileProperties {
    size: number;
    permissions: string;
    owner: string;
    group: string;
    uid: string;
    gid: string;
    mtime: number;
    atime: number;
}

interface PropertiesDialogProps {
    data: PropertiesDialogData;
    onClose: () => void;
}

const inputStyle: React.CSSProperties = {
    backgroundColor: "var(--df-bg-input)",
    borderColor: "var(--df-border)",
    color: "var(--df-text)",
};

function formatSize(bytes: number): string {
    if (bytes === 0) return "0 Bytes";
    if (bytes < 1024) return `${bytes} Bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(unix: number): string {
    if (!unix) return "-";
    const d = new Date(unix * 1000);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parsePermissionsToOctal(perms: string): string {
    if (!perms || perms.length < 10) return "0644";
    let special = 0, u = 0, g = 0, o = 0;
    const p = perms.split('');

    if (p[1] === 'r') u |= 4;
    if (p[2] === 'w') u |= 2;
    if (p[3] === 'x') u |= 1;
    else if (p[3] === 's') { u |= 1; special |= 4; }
    else if (p[3] === 'S') { special |= 4; }

    if (p[4] === 'r') g |= 4;
    if (p[5] === 'w') g |= 2;
    if (p[6] === 'x') g |= 1;
    else if (p[6] === 's') { g |= 1; special |= 2; }
    else if (p[6] === 'S') { special |= 2; }

    if (p[7] === 'r') o |= 4;
    if (p[8] === 'w') o |= 2;
    if (p[9] === 'x') o |= 1;
    else if (p[9] === 't') { o |= 1; special |= 1; }
    else if (p[9] === 'T') { special |= 1; }

    return `${special}${u}${g}${o}`;
}

export default function PropertiesDialog({ data, onClose }: PropertiesDialogProps) {
    const { t } = useTranslation();
    const [properties, setProperties] = useState<FileProperties | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [octal, setOctal] = useState<string>("0644");
    const [isSaving, setIsSaving] = useState(false);
    const initialOctal = properties ? parsePermissionsToOctal(properties.permissions) : "0644";

    useEffect(() => {
        let isMounted = true;
        setLoading(true);
        invoke("get_file_properties", {
            sessionId: data.sessionId,
            path: data.fullPath
        }).then((props: any) => {
            if (isMounted) {
                setProperties(props);
                setOctal(parsePermissionsToOctal(props.permissions));
            }
        }).catch(e => {
            if (isMounted) setError(String(e));
        }).finally(() => {
            if (isMounted) setLoading(false);
        });
        return () => { isMounted = false; };
    }, [data.sessionId, data.fullPath]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !isSaving) {
                onClose();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [onClose, isSaving]);

    const handleSave = async () => {
        if (octal === initialOctal) {
            onClose();
            return;
        }
        setIsSaving(true);
        try {
            await invoke("chmod_remote_file", {
                sessionId: data.sessionId,
                path: data.fullPath,
                mode: octal,
            });
            onClose();
        } catch (e) {
            alert(String(e));
        } finally {
            setIsSaving(false);
        }
    };

    const updateBit = (index: number, bit: number, checked: boolean) => {
        const chars = octal.split('');
        for (let i = 0; i < 4; i++) {
            if (!chars[i]) chars[i] = '0';
        }
        let val = parseInt(chars[index], 8);
        if (isNaN(val)) val = 0;
        if (checked) val |= bit;
        else val &= ~bit;
        chars[index] = val.toString(8);
        setOctal(chars.join(''));
    };

    const hasBit = (index: number, bit: number) => {
        const val = parseInt(octal[index] || '0', 8);
        return (val & bit) === bit;
    };

    const getFileType = () => {
        if (data.is_dir) return t("fileExplorer.folder", "Folder");
        const ext = data.name.split('.').pop()?.toLowerCase();
        if (ext === "sh" || ext === "bash") return t("fileExplorer.shellScript", "Shell Script");
        return t("fileExplorer.file", "File");
    };

    const getLocation = () => {
        const idx = data.fullPath.lastIndexOf('/');
        if (idx <= 0) return '/';
        return data.fullPath.substring(0, idx + 1);
    };

    return createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 backdrop-blur-sm transition-opacity">
            <div
                className="rounded-lg w-[420px] shadow-2xl border flex flex-col"
                style={{ backgroundColor: "var(--df-bg-panel)", borderColor: "var(--df-border)" }}
            >
                {/* Header */}
                <div
                    className="flex items-center justify-between px-5 py-3 border-b select-none"
                    style={{ borderColor: "var(--df-border)" }}
                >
                    <div className="flex items-center gap-2">
                        <span className="material-icons text-lg" style={{ color: data.is_dir ? "#eab308" : "var(--df-primary)" }}>
                            {data.is_dir ? 'folder' : 'insert_drive_file'}
                        </span>
                        <h2 className="text-sm font-semibold truncate max-w-[300px]" style={{ color: "var(--df-text)" }} title={data.name}>
                            {t("fileExplorer.propertiesOf", { name: data.name })}
                        </h2>
                    </div>
                    <span
                        className="material-icons text-base cursor-pointer transition-opacity hover:opacity-70"
                        style={{ color: "var(--df-text-muted)" }}
                        onClick={onClose}
                    >
                        close
                    </span>
                </div>

                {/* Body */}
                <div className="p-5 overflow-y-auto max-h-[75vh] terminal-scroll space-y-5 relative min-h-[250px]">
                    {loading ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center space-y-2 text-[var(--df-text-muted)]">
                            <span className="material-icons animate-spin text-3xl">refresh</span>
                            <span className="text-xs">{t("fileExplorer.loading", "Loading...")}</span>
                        </div>
                    ) : error ? (
                        <div className="absolute inset-0 flex items-center justify-center text-red-500 text-xs px-5 text-center">
                            {error}
                        </div>
                    ) : properties ? (
                        <>
                            {/* General Information Section */}
                            <div>
                                <h3 className="text-xs font-semibold mb-3 tracking-wider uppercase" style={{ color: "var(--df-text-muted)" }}>
                                    {t("fileExplorer.general", "General")}
                                </h3>
                                <div className="space-y-2.5 text-xs text-left" style={{ color: "var(--df-text)" }}>
                                    <div className="flex items-start">
                                        <span className="w-24 shrink-0" style={{ color: "var(--df-text-muted)" }}>{t("fileExplorer.type", "Type")}:</span>
                                        <span>{getFileType()}</span>
                                    </div>
                                    <div className="flex items-start">
                                        <span className="w-24 shrink-0" style={{ color: "var(--df-text-muted)" }}>{t("fileExplorer.location", "Location")}:</span>
                                        <span className="truncate break-all select-all font-mono" title={getLocation()}>{getLocation()}</span>
                                    </div>
                                    <div className="flex items-start">
                                        <span className="w-24 shrink-0" style={{ color: "var(--df-text-muted)" }}>{t("fileExplorer.size", "Size")}:</span>
                                        <span>{formatSize(properties.size)}</span>
                                    </div>
                                    <div className="flex items-start">
                                        <span className="w-24 shrink-0" style={{ color: "var(--df-text-muted)" }}>{t("fileExplorer.mtime", "Modified")}:</span>
                                        <span className="font-mono">{formatTime(properties.mtime)}</span>
                                    </div>
                                    <div className="flex items-start">
                                        <span className="w-24 shrink-0" style={{ color: "var(--df-text-muted)" }}>{t("fileExplorer.atime", "Accessed")}:</span>
                                        <span className="font-mono">{formatTime(properties.atime)}</span>
                                    </div>
                                    <div className="flex items-start">
                                        <span className="w-24 shrink-0" style={{ color: "var(--df-text-muted)" }}>{t("fileExplorer.owner", "Owner")}:</span>
                                        <span>{properties.owner} <span className="font-mono opacity-70">[{properties.uid}]</span></span>
                                    </div>
                                    <div className="flex items-start">
                                        <span className="w-24 shrink-0" style={{ color: "var(--df-text-muted)" }}>{t("fileExplorer.group", "Group")}:</span>
                                        <span>{properties.group} <span className="font-mono opacity-70">[{properties.gid}]</span></span>
                                    </div>
                                </div>
                            </div>

                            <div className="border-t" style={{ borderColor: "var(--df-border)" }} />

                            {/* Permissions Section */}
                            <div>
                                <h3 className="text-xs font-semibold mb-3 tracking-wider uppercase" style={{ color: "var(--df-text-muted)" }}>
                                    {t("fileExplorer.permissions", "Permissions")}
                                </h3>
                                <div className="rounded border overflow-hidden" style={{ borderColor: "var(--df-border)", backgroundColor: "var(--df-bg)" }}>
                                    <table className="w-full text-xs text-left select-none">
                                        <thead style={{ backgroundColor: "color-mix(in srgb, var(--df-border) 20%, transparent)", color: "var(--df-text-muted)" }}>
                                            <tr>
                                                <th className="font-normal px-3 py-2 w-16"></th>
                                                <th className="font-normal px-2 py-2 text-center w-14">R</th>
                                                <th className="font-normal px-2 py-2 text-center w-14">W</th>
                                                <th className="font-normal px-2 py-2 text-center w-14">X</th>
                                                <th className="font-normal px-2 py-2 text-center">{t("fileExplorer.special", "Special")}</th>
                                            </tr>
                                        </thead>
                                        <tbody style={{ color: "var(--df-text)" }}>
                                            <tr className="border-t" style={{ borderColor: "var(--df-border)", backgroundColor: "color-mix(in srgb, var(--df-bg-input) 50%, transparent)" }}>
                                                <td className="px-3 py-2" style={{ color: "var(--df-text-muted)" }}>{t("fileExplorer.permUser", "User")}</td>
                                                <td className="px-2 py-2 text-center"><input type="checkbox" className="accent-[var(--df-primary)] cursor-pointer" checked={hasBit(1, 4)} onChange={(e) => updateBit(1, 4, e.target.checked)} /></td>
                                                <td className="px-2 py-2 text-center"><input type="checkbox" className="accent-[var(--df-primary)] cursor-pointer" checked={hasBit(1, 2)} onChange={(e) => updateBit(1, 2, e.target.checked)} /></td>
                                                <td className="px-2 py-2 text-center"><input type="checkbox" className="accent-[var(--df-primary)] cursor-pointer" checked={hasBit(1, 1)} onChange={(e) => updateBit(1, 1, e.target.checked)} /></td>
                                                <td className="px-2 py-2 text-center"><label className="flex items-center justify-center gap-1.5 cursor-pointer text-[10px]"><input type="checkbox" className="accent-[var(--df-primary)] cursor-pointer" checked={hasBit(0, 4)} onChange={(e) => updateBit(0, 4, e.target.checked)} /> UID</label></td>
                                            </tr>
                                            <tr className="border-t" style={{ borderColor: "var(--df-border)" }}>
                                                <td className="px-3 py-2" style={{ color: "var(--df-text-muted)" }}>{t("fileExplorer.permGroup", "Group")}</td>
                                                <td className="px-2 py-2 text-center"><input type="checkbox" className="accent-[var(--df-primary)] cursor-pointer" checked={hasBit(2, 4)} onChange={(e) => updateBit(2, 4, e.target.checked)} /></td>
                                                <td className="px-2 py-2 text-center"><input type="checkbox" className="accent-[var(--df-primary)] cursor-pointer" checked={hasBit(2, 2)} onChange={(e) => updateBit(2, 2, e.target.checked)} /></td>
                                                <td className="px-2 py-2 text-center"><input type="checkbox" className="accent-[var(--df-primary)] cursor-pointer" checked={hasBit(2, 1)} onChange={(e) => updateBit(2, 1, e.target.checked)} /></td>
                                                <td className="px-2 py-2 text-center"><label className="flex items-center justify-center gap-1.5 cursor-pointer text-[10px]"><input type="checkbox" className="accent-[var(--df-primary)] cursor-pointer" checked={hasBit(0, 2)} onChange={(e) => updateBit(0, 2, e.target.checked)} /> GID</label></td>
                                            </tr>
                                            <tr className="border-t" style={{ borderColor: "var(--df-border)", backgroundColor: "color-mix(in srgb, var(--df-bg-input) 50%, transparent)" }}>
                                                <td className="px-3 py-2" style={{ color: "var(--df-text-muted)" }}>{t("fileExplorer.permOther", "Other")}</td>
                                                <td className="px-2 py-2 text-center"><input type="checkbox" className="accent-[var(--df-primary)] cursor-pointer" checked={hasBit(3, 4)} onChange={(e) => updateBit(3, 4, e.target.checked)} /></td>
                                                <td className="px-2 py-2 text-center"><input type="checkbox" className="accent-[var(--df-primary)] cursor-pointer" checked={hasBit(3, 2)} onChange={(e) => updateBit(3, 2, e.target.checked)} /></td>
                                                <td className="px-2 py-2 text-center"><input type="checkbox" className="accent-[var(--df-primary)] cursor-pointer" checked={hasBit(3, 1)} onChange={(e) => updateBit(3, 1, e.target.checked)} /></td>
                                                <td className="px-2 py-2 text-center"><label className="flex items-center justify-center gap-1.5 cursor-pointer text-[10px]"><input type="checkbox" className="accent-[var(--df-primary)] cursor-pointer" checked={hasBit(0, 1)} onChange={(e) => updateBit(0, 1, e.target.checked)} /> {t("fileExplorer.permSticky", "Sticky")}</label></td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>

                                <div className="flex items-center justify-between mt-4">
                                    <span className="text-xs" style={{ color: "var(--df-text-muted)" }}>{t("fileExplorer.octal", "Octal Mode")}:</span>
                                    <div className="flex items-center">
                                        <span className="text-xs font-mono mr-2 opacity-50">0</span>
                                        <input
                                            type="text"
                                            className="w-[60px] rounded px-2 py-1 text-center font-mono text-xs border focus:outline-none transition-colors"
                                            style={{ ...inputStyle, letterSpacing: '2px' }}
                                            value={octal.substring(1)}
                                            onChange={(e) => {
                                                let val = e.target.value.replace(/[^0-7]/g, '');
                                                if (val.length > 3) val = val.substring(0, 3);
                                                // Keeping Special bit intact when typing the 3 digits
                                                setOctal(octal[0] + val.padStart(3, '0'));
                                            }}
                                        />
                                    </div>
                                </div>
                            </div>
                        </>
                    ) : null}
                </div>

                {/* Footer */}
                <div
                    className="flex justify-end gap-2 px-5 py-3 border-t bg-black/5"
                    style={{ borderColor: "var(--df-border)", borderRadius: "0 0 8px 8px" }}
                >
                    <button
                        className="px-4 py-1.5 text-xs rounded transition-colors hover:opacity-70 border bg-transparent"
                        style={{ color: "var(--df-text-muted)", borderColor: "var(--df-border)" }}
                        onClick={onClose}
                        disabled={isSaving}
                    >
                        {t("dialog.cancel", "Cancel")}
                    </button>
                    <button
                        className="px-4 py-1.5 text-xs text-white rounded transition-colors disabled:opacity-50 flex items-center gap-1.5"
                        style={{ backgroundColor: "var(--df-primary)" }}
                        onClick={handleSave}
                        disabled={isSaving || loading || !!error}
                    >
                        {isSaving && <span className="material-icons text-[14px] animate-spin">refresh</span>}
                        {t("dialog.save", "Save Changes")}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}
