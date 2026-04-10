import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { MdCloudSync } from "react-icons/md";
import ChildWindowHeader from "@/components/layout/ChildWindowHeader";
import { Button } from "@/components/ui/button";
import { parseJsonSearchParam } from "@/lib/utils";

export interface AutoUploadDialogData {
  sessionId: string;
  localPath: string;
  remotePath: string;
}

export default function AutoUploadPage() {
  const { t } = useTranslation();
  const params = new URLSearchParams(window.location.search);
  const dataParam = params.get("data");
  const data = parseJsonSearchParam<AutoUploadDialogData>(dataParam);

  const handleClose = () => getCurrentWindow().close();

  const handleUpload = async (always: boolean) => {
    if (!data) return;

    // We emit an event to the main window to update its 'alwaysUploadFilesRef'
    if (always) {
      await emit("auto-upload-decision", {
        sessionId: data.sessionId,
        localPath: data.localPath,
        remotePath: data.remotePath,
        always,
      });
    }

    try {
      await invoke("upload_local_file", {
        sessionId: data.sessionId,
        localPath: data.localPath,
        remotePath: data.remotePath,
      });
    } catch (e) {
      console.error("Upload failed", e);
    }

    handleClose();
  };

  if (!data) return null;

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden bg-background text-foreground">
      <ChildWindowHeader
        title={t("fileExplorer.fileModified")}
        icon={<MdCloudSync className="text-base" />}
        onClose={handleClose}
      />

      <div className="flex-1 min-h-0 space-y-4 overflow-y-auto p-4 sm:p-5">
        <div className="flex items-center gap-3 pointer-events-none">
          <div
            className="flex items-center justify-center w-8 h-8 rounded-full shrink-0"
            style={{ backgroundColor: "color-mix(in srgb, var(--df-primary) 15%, transparent)" }}
          >
            <MdCloudSync className="text-[1.125rem] text-primary shrink-0" />
          </div>
          <h2 className="min-w-0 text-sm font-semibold">{t("fileExplorer.fileModified")}</h2>
        </div>
        <p className="text-xs leading-relaxed min-w-0 mt-1 pointer-events-none text-muted-foreground">
          {t("fileExplorer.uploadPrompt")}
        </p>
        <div
          className="mt-2 min-w-0 break-all rounded border bg-black/20 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap pointer-events-none"
          style={{ color: "var(--df-text)", borderColor: "var(--df-border)" }}
          title={data.remotePath}
        >
          {data.remotePath}
        </div>
      </div>

      <div className="flex shrink-0 flex-col-reverse gap-2 border-t bg-muted/20 px-4 py-4 sm:flex-row sm:justify-end sm:px-5">
        <Button
          variant="ghost"
          size="sm"
          className="w-full text-xs sm:w-auto"
          onClick={handleClose}
        >
          {t("dialog.cancel")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="w-full text-xs sm:flex-1"
          onClick={() => handleUpload(true)}
        >
          {t("fileExplorer.alwaysUpload")}
        </Button>
        <Button size="sm" className="w-full text-xs sm:flex-1" onClick={() => handleUpload(false)}>
          {t("fileExplorer.uploadOnce")}
        </Button>
      </div>
    </div>
  );
}
