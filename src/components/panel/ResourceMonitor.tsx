import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaMemory } from "react-icons/fa6";
import { LuCpu } from "react-icons/lu";
import {
  MdComputer,
  MdMonitorHeart,
  MdOutlineLocalFireDepartment,
  MdRefresh,
  MdStorage,
  MdSwapVert,
} from "react-icons/md";
import PanelHeader from "@/components/layout/PanelHeader";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApp } from "@/context/AppContext";
import { invoke } from "@/lib/invoke";
import type { RemoteStats } from "@/types/global";

const MAX_CONSECUTIVE_FAILURES = 3;

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / 1024 ** i;
  return `${val < 10 ? val.toFixed(2) : val < 100 ? val.toFixed(1) : val.toFixed(0)} ${units[i]}`;
}

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.min(Math.floor(Math.log(bytesPerSec) / Math.log(1024)), units.length - 1);
  const val = bytesPerSec / 1024 ** i;
  return `${val < 10 ? val.toFixed(1) : val.toFixed(0)} ${units[i]}`;
}

function formatUptime(
  seconds: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const days = Math.floor(seconds / 86400);
  return t(days === 1 ? "resourceMonitor.day" : "resourceMonitor.days", { count: days });
}

function ProgressBar({ value, color }: { value: number; color: string }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div
      className="h-1.5 w-full rounded-full overflow-hidden"
      style={{ backgroundColor: "var(--df-bg)" }}
    >
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}

function usageColor(pct: number): string {
  if (pct > 80) return "#ef4444";
  if (pct > 50) return "#f59e0b";
  return "#22c55e";
}

function SectionCard({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-lg border p-3 space-y-2"
      style={{ borderColor: "var(--df-border)", backgroundColor: "var(--df-bg)" }}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-sm" style={{ color: "var(--df-text-muted)" }}>
          {icon}
        </span>
        <span className="text-xs font-semibold" style={{ color: "var(--df-text)" }}>
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function InfoRow({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[0.6875rem] shrink-0" style={{ color: "var(--df-text-muted)" }}>
        {label}
      </span>
      <span
        className="text-[0.6875rem] font-mono truncate text-right"
        style={{ color: valueColor ?? "var(--df-primary)" }}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function MemoryDonut({ used, available }: { used: number; available: number }) {
  const total = used + available;
  if (total <= 0) return null;
  const radius = 36;
  const stroke = 8;
  const circumference = 2 * Math.PI * radius;

  const usedPct = used / total;
  const usedLen = usedPct * circumference;

  return (
    <svg width="80" height="80" viewBox="0 0 96 96" aria-hidden="true">
      {/* Available (green) - full ring background */}
      <circle
        cx="48"
        cy="48"
        r={radius}
        fill="none"
        stroke="#22c55e"
        strokeWidth={stroke}
        strokeDasharray={`${circumference} 0`}
        strokeDashoffset={0}
        transform="rotate(-90 48 48)"
        strokeLinecap="round"
      />
      {/* Used (red) - overwrites from start */}
      <circle
        cx="48"
        cy="48"
        r={radius}
        fill="none"
        stroke="#ef4444"
        strokeWidth={stroke}
        strokeDasharray={`${usedLen} ${circumference - usedLen}`}
        strokeDashoffset={0}
        transform="rotate(-90 48 48)"
        strokeLinecap="round"
        className="transition-all duration-500"
      />
    </svg>
  );
}

interface ResourceMonitorProps {
  activeSessionId: string | null;
}

export default function ResourceMonitor({ activeSessionId }: ResourceMonitorProps) {
  const { t } = useTranslation();
  const { appSettings } = useApp();
  const [stats, setStats] = useState<RemoteStats | null>(null);
  const [error, setError] = useState(false);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchingRef = useRef(false);
  const failCountRef = useRef(0);

  const enabled = appSettings.ui.show_remote_stats ?? false;
  const pollIntervalMs = Math.max(1, appSettings.ui.remote_stats_interval ?? 3) * 1000;

  const fetchStats = useCallback(async (sessionId: string, manual = false) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    if (manual) setIsManualRefreshing(true);

    try {
      const data = await invoke<RemoteStats>("get_remote_stats", { sessionId });
      setStats(data);
      setError(false);
      failCountRef.current = 0;
    } catch {
      failCountRef.current += 1;
      setError(true);
      if (failCountRef.current >= MAX_CONSECUTIVE_FAILURES) {
        setStats(null);
      }
    } finally {
      fetchingRef.current = false;
      if (manual) setIsManualRefreshing(false);
    }
  }, []);

  const handleRefresh = useCallback(() => {
    if (!enabled || !activeSessionId) return;
    void fetchStats(activeSessionId, true);
  }, [activeSessionId, enabled, fetchStats]);

  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    if (!enabled || !activeSessionId) {
      setStats(null);
      setError(false);
      failCountRef.current = 0;
      return;
    }

    fetchStats(activeSessionId);
    pollRef.current = setInterval(() => fetchStats(activeSessionId), pollIntervalMs);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [enabled, activeSessionId, pollIntervalMs, fetchStats]);

  const memTotal = stats ? stats.memory.used + stats.memory.available : 0;
  const memUsedPct = memTotal > 0 ? (stats!.memory.used / memTotal) * 100 : 0;

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: "var(--df-bg-panel)" }}>
      <PanelHeader
        title={t("panel.resourceMonitor")}
        actions={
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground disabled:opacity-40"
                onClick={handleRefresh}
                disabled={!enabled || !activeSessionId || isManualRefreshing}
                aria-label={t("resourceMonitor.refresh")}
              >
                <MdRefresh className={`h-4 w-4 ${isManualRefreshing ? "animate-spin" : ""}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t("resourceMonitor.refresh")}</TooltipContent>
          </Tooltip>
        }
      />

      <div className="flex-1 overflow-y-auto p-3 terminal-scroll">
        {!activeSessionId ? (
          <EmptyState icon={<MdMonitorHeart />} text={t("panel.resourceMonitorNoSession")} />
        ) : !enabled ? (
          <EmptyState icon={<MdMonitorHeart />} text={t("panel.resourceMonitorDisabled")} />
        ) : error && !stats ? (
          <EmptyState icon={<MdMonitorHeart />} text={t("panel.resourceMonitorError")} />
        ) : stats ? (
          <div className="space-y-3">
            {/* System */}
            <SectionCard icon={<MdComputer />} title={t("resourceMonitor.system")}>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <InfoRow
                  label={`${t("resourceMonitor.hostname")}:`}
                  value={stats.system.hostname}
                />
                <InfoRow
                  label={`${t("resourceMonitor.uptime")}:`}
                  value={formatUptime(stats.system.uptime_sec, t)}
                />
                <InfoRow label={`${t("resourceMonitor.os")}:`} value={stats.system.os} />
                <InfoRow label={`${t("resourceMonitor.arch")}:`} value={stats.system.arch} />
              </div>
            </SectionCard>

            {/* System Load */}
            <SectionCard
              icon={<MdOutlineLocalFireDepartment />}
              title={t("resourceMonitor.systemLoad")}
            >
              <div className="flex items-center justify-between gap-2">
                <LoadValue label={t("resourceMonitor.Load1")} value={stats.load.load1} />
                <LoadValue label={t("resourceMonitor.Load5")} value={stats.load.load5} />
                <LoadValue label={t("resourceMonitor.Load15")} value={stats.load.load15} />
              </div>
            </SectionCard>

            {/* CPU */}
            <SectionCard icon={<LuCpu />} title={t("resourceMonitor.cpu")}>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="text-[0.6875rem] font-mono"
                    style={{ color: "var(--df-text-muted)" }}
                  >
                    {stats.cpu.cores}
                  </span>
                  <div className="flex-1 mx-2">
                    <ProgressBar value={stats.cpu.usage} color={usageColor(stats.cpu.usage)} />
                  </div>
                  <span
                    className="text-[0.6875rem] font-mono shrink-0"
                    style={{ color: "var(--df-text)" }}
                  >
                    {stats.cpu.usage.toFixed(1)}%
                  </span>
                </div>
              </div>
            </SectionCard>

            {/* Memory */}
            <SectionCard icon={<FaMemory />} title={t("resourceMonitor.memory")}>
              <div className="flex items-center gap-3">
                <div className="flex-1 space-y-1">
                  <div className="text-xs font-mono" style={{ color: "var(--df-text)" }}>
                    <span style={{ color: usageColor(memUsedPct) }}>
                      {formatBytes(stats.memory.used)}
                    </span>
                    {" / "}
                    {formatBytes(memTotal)}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                    <LegendDot
                      color="#ef4444"
                      label={t("resourceMonitor.used")}
                      value={formatBytes(stats.memory.used)}
                    />
                    <LegendDot
                      color="#22c55e"
                      label={t("resourceMonitor.available")}
                      value={formatBytes(stats.memory.available)}
                    />
                    <LegendDot
                      color="#6b7280"
                      label={t("resourceMonitor.cached")}
                      value={formatBytes(stats.memory.cached)}
                    />
                  </div>
                </div>
                <div className="shrink-0">
                  <MemoryDonut used={stats.memory.used} available={stats.memory.available} />
                </div>
              </div>
            </SectionCard>

            {/* Network */}
            <SectionCard icon={<MdSwapVert />} title={t("resourceMonitor.network")}>
              <div className="space-y-1.5">
                <div className="grid grid-cols-3 gap-1">
                  <span className="text-[0.625rem]" style={{ color: "var(--df-text-dimmed)" }}>
                    {t("resourceMonitor.nic")}
                  </span>
                  <span
                    className="text-[0.625rem] text-center"
                    style={{ color: "var(--df-text-dimmed)" }}
                  >
                    {t("resourceMonitor.send")}
                  </span>
                  <span
                    className="text-[0.625rem] text-right"
                    style={{ color: "var(--df-text-dimmed)" }}
                  >
                    {t("resourceMonitor.receive")}
                  </span>
                </div>
                {stats.networks.map((net) => (
                  <div key={net.nic} className="grid grid-cols-3 gap-1">
                    <span
                      className="text-[0.6875rem] font-mono truncate"
                      style={{ color: "var(--df-text)" }}
                    >
                      {net.nic}
                    </span>
                    <span
                      className="text-[0.6875rem] font-mono text-center"
                      style={{ color: "var(--df-text)" }}
                    >
                      {formatRate(net.tx_bytes_per_sec)}
                    </span>
                    <span
                      className="text-[0.6875rem] font-mono text-right"
                      style={{ color: "var(--df-text)" }}
                    >
                      {formatRate(net.rx_bytes_per_sec)}
                    </span>
                  </div>
                ))}
                {stats.networks.length === 0 && (
                  <span className="text-[0.625rem]" style={{ color: "var(--df-text-dimmed)" }}>
                    -
                  </span>
                )}
              </div>
            </SectionCard>

            {/* Disk */}
            <SectionCard icon={<MdStorage />} title={t("resourceMonitor.disk")}>
              {stats.disks.length > 0 ? (
                <div className="space-y-1.5">
                  <div className="grid grid-cols-4 gap-1">
                    <span className="text-[0.625rem]" style={{ color: "var(--df-text-dimmed)" }}>
                      {t("resourceMonitor.mountPath")}
                    </span>
                    <span
                      className="text-[0.625rem] text-center"
                      style={{ color: "var(--df-text-dimmed)" }}
                    >
                      {t("resourceMonitor.totalSize")}
                    </span>
                    <span
                      className="text-[0.625rem] text-center"
                      style={{ color: "var(--df-text-dimmed)" }}
                    >
                      {t("resourceMonitor.availSpace")}
                    </span>
                    <span
                      className="text-[0.625rem] text-right"
                      style={{ color: "var(--df-text-dimmed)" }}
                    >
                      {t("resourceMonitor.usagePercent")}
                    </span>
                  </div>
                  {stats.disks.map((disk) => (
                    <div key={`${disk.device}-${disk.mount}`} className="space-y-1">
                      <div className="grid grid-cols-4 gap-1 items-center">
                        <span
                          className="text-[0.6875rem] font-mono truncate"
                          style={{ color: "var(--df-text)" }}
                          title={disk.mount}
                        >
                          {disk.mount}
                        </span>
                        <span
                          className="text-[0.6875rem] font-mono text-center"
                          style={{ color: "var(--df-text)" }}
                        >
                          {formatBytes(disk.total)}
                        </span>
                        <span
                          className="text-[0.6875rem] font-mono text-center"
                          style={{ color: "var(--df-text)" }}
                        >
                          {formatBytes(disk.available)}
                        </span>
                        <div className="flex items-center justify-end gap-1">
                          <div className="flex-1 max-w-[3rem]">
                            <ProgressBar
                              value={disk.use_percent}
                              color={usageColor(disk.use_percent)}
                            />
                          </div>
                          <span
                            className="text-[0.625rem] font-mono shrink-0"
                            style={{ color: usageColor(disk.use_percent) }}
                          >
                            {disk.use_percent}%
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-[0.625rem]" style={{ color: "var(--df-text-dimmed)" }}>
                  -
                </span>
              )}
            </SectionCard>
          </div>
        ) : (
          <LoadingSpinner label={t("common.loading")} />
        )}
      </div>
    </div>
  );
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center gap-2 px-4">
      <span className="text-2xl" style={{ color: "var(--df-text-dimmed)" }}>
        {icon}
      </span>
      <span className="text-xs" style={{ color: "var(--df-text-muted)" }}>
        {text}
      </span>
    </div>
  );
}

function LoadingSpinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-full">
      <svg
        className="animate-spin w-5 h-5"
        style={{ color: "var(--df-text-dimmed)" }}
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <title>{label}</title>
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
    </div>
  );
}

function LoadValue({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[0.6875rem]" style={{ color: "var(--df-text-muted)" }}>
        {label}
      </span>
      <span
        className="text-[0.6875rem] font-mono font-medium"
        style={{ color: "var(--df-primary)" }}
      >
        {value.toFixed(2)}
      </span>
    </div>
  );
}

function LegendDot({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1">
      <span
        className="inline-block w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: color }}
      />
      <span className="text-[0.625rem]" style={{ color: "var(--df-text-muted)" }}>
        {label}
      </span>
      <span className="text-[0.625rem] font-mono" style={{ color: "var(--df-text)" }}>
        {value}
      </span>
    </div>
  );
}
