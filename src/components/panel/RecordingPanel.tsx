import { listen } from "@tauri-apps/api/event";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MdSave, MdSearch, MdStop } from "react-icons/md";
import { PiRecordFill } from "react-icons/pi";
import PanelHeader from "@/components/layout/PanelHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { invoke } from "@/lib/invoke";
import type { SessionInfo } from "@/types/global";

interface RecordingPanelProps {
  activeSessionId: string | null;
  recordingSessions: Set<string>;
  onSessionClick: (sessionId: string) => void;
  onToggleRecording: (session: SessionInfo) => Promise<void> | void;
  onSaveTranscript: (session: SessionInfo) => Promise<void> | void;
}

function shortSessionId(sessionId: string) {
  return sessionId.length <= 8 ? sessionId : sessionId.slice(0, 8);
}

function RecordingPanel({
  activeSessionId,
  recordingSessions,
  onSessionClick,
  onToggleRecording,
  onSaveTranscript,
}: RecordingPanelProps) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [search, setSearch] = useState("");
  const [busyActions, setBusyActions] = useState<Record<string, "record" | "save">>({});

  const fetchSessions = useCallback(async () => {
    try {
      const sess = await invoke<SessionInfo[]>("list_sessions");
      sess.sort(
        (a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
          a.session_type.localeCompare(b.session_type),
      );
      setSessions(sess);
    } catch {
      // Backend might not be ready yet.
    }
  }, []);

  useEffect(() => {
    fetchSessions();
    const unlisten = listen("sessions-changed", () => {
      fetchSessions();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [fetchSessions]);

  const runAction = useCallback(
    async (session: SessionInfo, action: "record" | "save") => {
      setBusyActions((prev) => ({ ...prev, [session.id]: action }));
      try {
        if (action === "record") {
          await onToggleRecording(session);
        } else {
          await onSaveTranscript(session);
        }
      } finally {
        setBusyActions((prev) => {
          const next = { ...prev };
          delete next[session.id];
          return next;
        });
      }
    },
    [onSaveTranscript, onToggleRecording],
  );

  const query = search.trim().toLowerCase();
  const filteredSessions = useMemo(
    () =>
      query
        ? sessions.filter((session) =>
            `${session.name} ${session.session_type} ${session.id}`.toLowerCase().includes(query),
          )
        : sessions,
    [query, sessions],
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <PanelHeader
        title={t("recording.panelTitle")}
        actions={
          <span className="text-[0.6875rem]" style={{ color: "var(--df-text-dimmed)" }}>
            {query ? `${filteredSessions.length}/${sessions.length}` : sessions.length}
          </span>
        }
      />

      <div
        className="nyaterm-wallpaper-transparent-surface border-b px-2 py-1.5"
        style={{ borderColor: "var(--df-border)", backgroundColor: "var(--df-bg-panel)" }}
      >
        <div className="relative shrink-0">
          <MdSearch
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[0.875rem]"
            style={{ color: "var(--df-text-dimmed)" }}
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("recording.searchPlaceholder")}
            className="h-7 border-0 pl-7 text-xs shadow-none placeholder:text-[var(--df-text-dimmed)] text-[var(--df-text)] bg-[var(--df-bg-hover)] focus-visible:ring-1 focus-visible:ring-[var(--df-primary)] focus-visible:bg-transparent"
          />
        </div>
      </div>

      <div className="terminal-scroll flex-1 overflow-y-auto p-2 text-xs space-y-1">
        {sessions.length === 0 ? (
          <div
            className="text-center py-4 text-[0.6875rem]"
            style={{ color: "var(--df-text-dimmed)" }}
          >
            {t("panel.noActiveSessions")}
          </div>
        ) : filteredSessions.length === 0 ? (
          <div
            className="text-center py-4 text-[0.6875rem]"
            style={{ color: "var(--df-text-dimmed)" }}
          >
            {t("activeSessions.noMatches")}
          </div>
        ) : (
          filteredSessions.map((session) => {
            const isCurrent = activeSessionId === session.id;
            const isRecording = recordingSessions.has(session.id);
            return (
              <div
                key={session.id}
                className={`flex items-center gap-2 rounded-md p-2 transition-colors df-hover ${
                  isCurrent ? "ring-1 ring-[var(--df-primary)]/45" : ""
                }`}
                onClick={() => onSessionClick(session.id)}
              >
                <div
                  className={`w-2 h-2 rounded-full shrink-0 ${isRecording ? "animate-pulse" : ""}`}
                  style={{ backgroundColor: isRecording ? "#ef4444" : "#22c55e" }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate" style={{ color: "var(--df-text)" }}>
                      {session.name}
                    </span>
                    <span
                      className="rounded px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wide"
                      style={{
                        color: "var(--df-text-dimmed)",
                        backgroundColor: "var(--df-bg-hover)",
                      }}
                    >
                      {session.session_type}
                    </span>
                  </div>
                  <div
                    className="flex min-w-0 items-center gap-1.5 font-mono text-[0.625rem]"
                    title={session.id}
                  >
                    <span className="truncate" style={{ color: "var(--df-text-dimmed)" }}>
                      {shortSessionId(session.id)}
                    </span>

                    {isRecording && (
                      <span
                        className="shrink-0 rounded px-1.5 py-0.5"
                        style={{
                          color: "var(--df-danger, #ef4444)",
                          backgroundColor:
                            "color-mix(in srgb, var(--df-danger, #ef4444) 14%, transparent)",
                        }}
                      >
                        ● {t("recording.recording")}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <TooltipProvider delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground disabled:opacity-40"
                          disabled={!!busyActions[session.id]}
                          onClick={(event) => {
                            event.stopPropagation();
                            void runAction(session, "record");
                          }}
                          aria-label={isRecording ? t("recording.stop") : t("recording.start")}
                        >
                          {isRecording ? (
                            <MdStop className="h-4 w-4" />
                          ) : (
                            <PiRecordFill className="h-4 w-4" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {isRecording ? t("recording.stop") : t("recording.start")}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <TooltipProvider delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground disabled:opacity-40"
                          disabled={!!busyActions[session.id]}
                          onClick={(event) => {
                            event.stopPropagation();
                            void runAction(session, "save");
                          }}
                          aria-label={t("recording.saveTranscript")}
                        >
                          <MdSave className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("recording.saveTranscript")}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default memo(RecordingPanel);
