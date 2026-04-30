import type { TFunction } from "i18next";
import type { ComponentProps, ReactNode } from "react";
import { MdClose, MdTerminal } from "react-icons/md";
import AboutDialog from "@/components/dialog/app/AboutDialog";
import { isMacOS } from "@/lib/platform";
import LockScreen from "@/components/dialog/app/LockScreen";
import QuitConfirmDialog from "@/components/dialog/app/QuitConfirmDialog";
import UpdateDialog from "@/components/dialog/app/UpdateDialog";
import type { HostKeyVerifyRequest } from "@/components/dialog/connections/HostKeyVerifyDialog";
import { HostKeyVerifyDialog } from "@/components/dialog/connections/HostKeyVerifyDialog";
import type { OtpRequest } from "@/components/dialog/connections/OtpDialog";
import { OtpDialog } from "@/components/dialog/connections/OtpDialog";
import SyncGroupDialog from "@/components/dialog/terminal/SyncGroupDialog";
import ActivityBar from "@/components/layout/ActivityBar";
import Header from "@/components/layout/Header";
import ResizeHandle from "@/components/layout/ResizeHandle";
import QuickCommands from "@/components/panel/QuickCommands";
import SerialSendPanel from "@/components/panel/SendCommandPanel";
import TabWindowsWorkspace from "@/components/terminal/TabWindowsWorkspace";
import { Toaster } from "@/components/ui/sonner";
import type { UpdateInfo } from "@/lib/updater";
import type { UiConfig } from "@/types/global";

type HeaderProps = ComponentProps<typeof Header>;
type ActivityBarProps = ComponentProps<typeof ActivityBar>;
type WorkspaceProps = ComponentProps<typeof TabWindowsWorkspace>;
type ActivityBarSideProps = Omit<ActivityBarProps, "side" | "zone">;

interface AppLayoutProps {
  t: TFunction;
  uiConfig: UiConfig;
  header: Omit<HeaderProps, "onToggleLeft" | "onToggleRight">;
  mobile: {
    leftOpen: boolean;
    rightOpen: boolean;
    setLeftOpen: (open: boolean) => void;
    setRightOpen: (open: boolean) => void;
  };
  leftActivityBar: ActivityBarSideProps;
  rightActivityBar: ActivityBarSideProps;
  onLeftResize: (delta: number) => void;
  onRightResize: (delta: number) => void;
  panelContent: (panelId: string | null) => ReactNode;
  workspace: WorkspaceProps;
  tabsCount: number;
  bottomPanel: {
    activePanel: "quickCmdBar" | "serialSend" | null;
    quickCmdHeight: number;
    serialSendHeight: number;
    activeSerialSessionId: string | null;
    activeShellSessionIds: string[];
    onQuickCmdResize: (delta: number) => void;
    onSerialSendResize: (delta: number) => void;
    onCommandSend: (command: string, execute?: boolean) => void;
    onSendToAllSessions: (command: string) => void;
  };
  dialogs: {
    aboutOpen: boolean;
    onAboutOpenChange: (open: boolean) => void;
    syncGroupOpen: boolean;
    onSyncGroupOpenChange: (open: boolean) => void;
    updateOpen: boolean;
    onUpdateOpenChange: (open: boolean) => void;
    onUpdateFound: (info: UpdateInfo) => void;
    quitConfirmOpen: boolean;
    onQuitConfirmOpenChange: (open: boolean) => void;
    onQuitConfirm: () => void;
    otpRequest: OtpRequest | null;
    onOtpDone: () => void;
    hostKeyVerifyRequest: HostKeyVerifyRequest | null;
    onHostKeyVerifyDone: () => void;
    modalChildWindowCount: number;
    locked: boolean;
    hasMasterPassword: boolean;
    onUnlock: () => void;
  };
}

export default function AppLayout({
  t,
  uiConfig,
  header,
  mobile,
  leftActivityBar,
  rightActivityBar,
  onLeftResize,
  onRightResize,
  panelContent,
  workspace,
  tabsCount,
  bottomPanel,
  dialogs,
}: AppLayoutProps) {
  return (
    <div
      className="font-display h-full min-h-0 flex flex-col overflow-hidden"
      style={{ backgroundColor: "var(--df-bg)", color: "var(--df-text)" }}
    >
      <Header
        {...header}
        onToggleLeft={() => mobile.setLeftOpen(!mobile.leftOpen)}
        onToggleRight={() => mobile.setRightOpen(!mobile.rightOpen)}
      />

      <main className="flex-1 flex overflow-hidden relative">
        {!isMacOS && (mobile.leftOpen || mobile.rightOpen) && (
          <div
            className="absolute inset-0 bg-black/50 z-40 lg:hidden"
            onClick={() => {
              mobile.setLeftOpen(false);
              mobile.setRightOpen(false);
            }}
          />
        )}

        <ActivityBar
          {...leftActivityBar}
          side="left"
          zone={{ top: "left_top", bottom: "left_bottom" }}
        />

        {uiConfig.active_left_panel && (
          <>
            <div
              style={{ width: uiConfig.left_width, backgroundColor: "var(--df-bg-panel)" }}
              className={
                isMacOS
                  ? "relative flex flex-col"
                  : `
                    fixed inset-y-0 left-10 z-40 flex flex-col shadow-xl transition-transform duration-200
                    lg:relative lg:left-0 lg:translate-x-0 lg:z-0 lg:shadow-none
                    ${
                      mobile.leftOpen
                        ? "translate-x-0"
                        : "-translate-x-[calc(100%+2.5rem)] lg:translate-x-0"
                    }
                  `
              }
            >
              {!isMacOS && (
                <div
                  className="lg:hidden h-10 flex items-center justify-end px-2 border-b shrink-0"
                  style={{ borderColor: "var(--df-border)" }}
                >
                  <button
                    onClick={() => mobile.setLeftOpen(false)}
                    style={{ color: "var(--df-text-muted)" }}
                  >
                    <MdClose />
                  </button>
                </div>
              )}

              <div className="flex-1 min-h-0 overflow-hidden">
                {panelContent(uiConfig.active_left_panel)}
              </div>
            </div>
            <ResizeHandle
              direction="horizontal"
              onResize={onLeftResize}
              className={isMacOS ? "" : "hidden lg:block"}
            />
          </>
        )}

        <section
          className="flex-1 flex flex-col relative min-w-0 origin-top-left"
          style={{
            backgroundColor: "var(--df-bg-terminal)",
          }}
        >
          <div className="flex-1 relative overflow-hidden">
            {tabsCount === 0 ? (
              <div className="flex items-center justify-center h-full text-slate-500">
                <div className="text-center space-y-3">
                  <MdTerminal className="text-4xl mx-auto" />
                  <p className="text-sm">{t("app.noActiveSessions")}</p>
                  <button
                    className="px-4 py-2 text-xs bg-primary hover:bg-primary/80 text-white rounded transition-colors"
                    onClick={header.onNewSession}
                  >
                    {t("app.newConnection")}
                  </button>
                </div>
              </div>
            ) : workspace.layout ? (
              <TabWindowsWorkspace {...workspace} />
            ) : (
              <div className="flex items-center justify-center h-full text-slate-500">
                <div className="text-center space-y-3">
                  <MdTerminal className="text-4xl mx-auto" />
                  <p className="text-sm">{t("common.loading")}</p>
                </div>
              </div>
            )}
          </div>

          {bottomPanel.activePanel === "quickCmdBar" && (
            <>
              <ResizeHandle direction="vertical" onResize={bottomPanel.onQuickCmdResize} />
              <div
                style={{ height: bottomPanel.quickCmdHeight }}
                className="shrink-0 overflow-hidden"
              >
                <QuickCommands
                  onSend={bottomPanel.onCommandSend}
                  onSendToAll={bottomPanel.onSendToAllSessions}
                />
              </div>
            </>
          )}

          {bottomPanel.activePanel === "serialSend" && (
            <>
              <ResizeHandle direction="vertical" onResize={bottomPanel.onSerialSendResize} />
              <div
                style={{ height: bottomPanel.serialSendHeight }}
                className="shrink-0 overflow-hidden"
              >
                <SerialSendPanel
                  serialSessionId={bottomPanel.activeSerialSessionId}
                  shellSessionIds={bottomPanel.activeShellSessionIds}
                />
              </div>
            </>
          )}
        </section>

        {uiConfig.active_right_panel && (
          <>
            <ResizeHandle
              direction="horizontal"
              onResize={onRightResize}
              className={isMacOS ? "" : "hidden md:block"}
            />
            <aside
              style={{
                width: uiConfig.right_width,
                backgroundColor: "var(--df-bg-panel)",
                borderColor: "var(--df-border)",
              }}
              className={
                isMacOS
                  ? "relative flex flex-col border-l"
                  : `
                    fixed inset-y-0 right-10 z-50 flex flex-col shadow-xl transition-transform duration-200 border-l
                    md:relative md:right-0 md:translate-x-0 md:z-0 md:shadow-none
                    ${
                      mobile.rightOpen
                        ? "translate-x-0"
                        : "translate-x-[calc(100%+2.5rem)] md:translate-x-0"
                    }
                  `
              }
            >
              {!isMacOS && (
                <div
                  className="md:hidden h-10 flex items-center justify-end px-2 border-b shrink-0"
                  style={{ borderColor: "var(--df-border)" }}
                >
                  <button
                    onClick={() => mobile.setRightOpen(false)}
                    style={{ color: "var(--df-text-muted)" }}
                  >
                    <MdClose />
                  </button>
                </div>
              )}

              <div className="flex-1 min-h-0 overflow-hidden">
                {panelContent(uiConfig.active_right_panel)}
              </div>
            </aside>
          </>
        )}

        <ActivityBar
          {...rightActivityBar}
          side="right"
          zone={{ top: "right_top", bottom: "right_bottom" }}
        />
      </main>

      <AboutDialog open={dialogs.aboutOpen} onClose={() => dialogs.onAboutOpenChange(false)} />

      <SyncGroupDialog
        open={dialogs.syncGroupOpen}
        onClose={() => dialogs.onSyncGroupOpenChange(false)}
      />

      <UpdateDialog
        open={dialogs.updateOpen}
        onClose={() => dialogs.onUpdateOpenChange(false)}
        onUpdateFound={dialogs.onUpdateFound}
      />

      <QuitConfirmDialog
        open={dialogs.quitConfirmOpen}
        onOpenChange={dialogs.onQuitConfirmOpenChange}
        onConfirm={dialogs.onQuitConfirm}
      />

      <OtpDialog request={dialogs.otpRequest} onDone={dialogs.onOtpDone} />
      <HostKeyVerifyDialog
        request={dialogs.hostKeyVerifyRequest}
        onDone={dialogs.onHostKeyVerifyDone}
      />

      <Toaster position="bottom-right" />

      {dialogs.modalChildWindowCount > 0 && (
        <div
          className="fixed inset-0 z-[9998]"
          style={{
            backgroundColor: "rgba(0, 0, 0, 0.3)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
          }}
        />
      )}

      {dialogs.locked && (
        <LockScreen hasPassword={dialogs.hasMasterPassword} onUnlock={dialogs.onUnlock} />
      )}
    </div>
  );
}
