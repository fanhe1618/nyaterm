import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MdAdd, MdDelete, MdEdit, MdFolderOpen } from "react-icons/md";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SshKey } from "@/types/global";

export function KeyManagementTab() {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editKeyFilePath, setEditKeyFilePath] = useState("");
  const [editKeyFileName, setEditKeyFileName] = useState("");
  const [editPassphrase, setEditPassphrase] = useState("");
  const [editHasKeyData, setEditHasKeyData] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [deletingKey, setDeletingKey] = useState<SshKey | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      const result = await invoke<SshKey[]>("get_ssh_keys");
      setKeys(result);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const resetEdit = () => {
    setEditingId(null);
    setEditName("");
    setEditKeyFilePath("");
    setEditKeyFileName("");
    setEditPassphrase("");
    setEditHasKeyData(false);
    setIsNew(false);
  };

  const handleAdd = () => {
    resetEdit();
    setEditingId("__new__");
    setIsNew(true);
  };

  const handleEdit = (key: SshKey) => {
    setEditingId(key.id);
    setEditName(key.name);
    setEditKeyFilePath("");
    setEditKeyFileName("");
    setEditPassphrase("");
    setEditHasKeyData(key.has_key_data || false);
    setIsNew(false);
  };

  const handleSave = async () => {
    if (!editName.trim()) return;
    if (isNew && !editKeyFilePath) return;
    try {
      await invoke("save_ssh_key", {
        key: {
          id: isNew ? "" : editingId,
          name: editName.trim(),
          key_file_path: editKeyFilePath || undefined,
          passphrase: editPassphrase || undefined,
        },
      });
      resetEdit();
      await loadKeys();
    } catch { /* ignore */ }
  };

  const handleDeleteConfirm = async () => {
    if (!deletingKey) return;
    try {
      await invoke("delete_ssh_key", { id: deletingKey.id });
      await loadKeys();
    } catch { /* ignore */ }
    setDeletingKey(null);
  };

  const handlePickFile = async () => {
    const selected = await openFileDialog({
      multiple: false,
      title: t("settings.selectKeyFileTitle"),
    });
    if (selected) {
      setEditKeyFilePath(selected);
      const parts = selected.replace(/\\/g, "/").split("/");
      setEditKeyFileName(parts[parts.length - 1]);
      setEditHasKeyData(false);
    }
  };

  const KeyForm = ({ isEditing }: { isEditing: boolean }) => (
    <div className="p-3 border-b space-y-2.5 bg-accent/30">
      <Input
        placeholder={t("settings.keyNamePlaceholder")}
        className="text-xs h-8"
        value={editName}
        onChange={(e) => setEditName(e.target.value)}
        autoFocus
      />
      <div className="flex items-center w-full rounded-md border overflow-hidden bg-transparent">
        <div
          className={`flex-1 px-3 py-2 text-xs truncate ${editKeyFileName || (isEditing && editHasKeyData) ? "text-foreground" : "text-muted-foreground opacity-50"}`}
        >
          {editKeyFileName ||
            (isEditing && editHasKeyData ? t("settings.keyFileLoaded") : t("settings.selectKeyFile"))}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="rounded-none border-l h-auto py-2 px-3"
          onClick={handlePickFile}
        >
          <MdFolderOpen className="text-base" />
        </Button>
      </div>
      <Input
        type="password"
        placeholder={t("settings.passphrase")}
        className="text-xs h-8"
        value={editPassphrase}
        onChange={(e) => setEditPassphrase(e.target.value)}
      />
      <div className="flex justify-end gap-1.5 pt-0.5">
        <Button variant="outline" size="sm" className="h-7 px-3 text-xs" onClick={resetEdit}>
          {t("common.cancel")}
        </Button>
        <Button
          size="sm"
          className="h-7 px-3 text-xs"
          onClick={handleSave}
          disabled={!editName.trim() || (!isEditing && !editKeyFilePath)}
        >
          {t("common.save")}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="font-medium text-sm">{t("settings.keyManagement")}</Label>
          <Button
            variant="ghost"
            size="sm"
            className="text-primary h-7 px-2 text-xs"
            onClick={handleAdd}
            disabled={editingId !== null}
          >
            <MdAdd className="text-base mr-1" /> {t("settings.addKey")}
          </Button>
        </div>

        <div className="border rounded-md overflow-hidden">
          {/* Inline form for new key */}
          {isNew && editingId === "__new__" && <KeyForm isEditing={false} />}

          {/* Existing keys */}
          {keys.map((key) => (
            <div key={key.id}>
              {editingId === key.id && !isNew ? (
                <KeyForm isEditing={true} />
              ) : (
                <div className="flex items-center gap-2 px-3 py-2.5 border-b last:border-0 hover:bg-accent transition-colors">
                  <span className="flex-1 text-xs truncate">{key.name}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleEdit(key)}
                    disabled={editingId !== null}
                  >
                    <MdEdit className="text-base" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:bg-destructive/10"
                    onClick={() => setDeletingKey(key)}
                    disabled={editingId !== null}
                  >
                    <MdDelete className="text-base" />
                  </Button>
                </div>
              )}
            </div>
          ))}

          {keys.length === 0 && !isNew && (
            <div className="text-center py-6 text-xs text-muted-foreground">
              {t("settings.noKeys")}
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={deletingKey !== null} onOpenChange={(v) => !v && setDeletingKey(null)}>
        <DialogContent showCloseButton={false} className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("settings.deleteKey")}</DialogTitle>
            <DialogDescription>
              {t("settings.deleteKeyConfirm", { name: deletingKey?.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingKey(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={handleDeleteConfirm}>
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
