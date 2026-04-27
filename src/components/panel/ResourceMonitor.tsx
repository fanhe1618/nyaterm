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

function formatPct(value: number): string {
  return `${Math.round(Math.min(100, Math.max(0, value)))}%`;
}

function formatCores(cores: number): string {
  return `${cores}C`;
}

function ProgressBar({ value, color }: { value: number; color: string }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div
      className="h-2 w-full rounded-full overflow-hidden"
      style={{ backgroundColor: "color-mix(in srgb, var(--df-border) 72%, transparent)" }}
    >
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}

function usageColor(pct: number): string {
  if (pct >= 90) return "#ef4444";
  if (pct >= 80) return "#f59e0b";
  return "var(--df-primary)";
}

function loadColor(loadRatio: number): string {
  if (loadRatio >= 1) return "#ef4444";
  if (loadRatio >= 0.7) return "#f59e0b";
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
        <span className="text-base" style={{ color: "var(--df-text-muted)" }}>
          {icon}
        </span>
        <span className="text-[0.8125rem] font-semibold" style={{ color: "var(--df-text)" }}>
          {title}
        </span>
      </div>
      {children}
    </div>
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
  const loadRatio = stats && stats.cpu.cores > 0 ? stats.load.load1 / stats.cpu.cores : 0;

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
              <div className="space-y-1">
                <div
                  className="truncate text-sm font-semibold"
                  style={{ color: "var(--df-text)" }}
                  title={stats.system.hostname}
                >
                  {stats.system.hostname}
                </div>
                <div
                  className="text-xs leading-relaxed"
                  style={{ color: "var(--df-text-muted)" }}
                  title={`${stats.system.os} · ${stats.system.arch} · ${formatUptime(
                    stats.system.uptime_sec,
                    t,
                  )}`}
                >
                  <span className="break-words">{stats.system.os}</span>
                  <span className="mx-1.5" style={{ color: "var(--df-text-dimmed)" }}>
                    ·
                  </span>
                  <span>{stats.system.arch}</span>
                  <span className="mx-1.5" style={{ color: "var(--df-text-dimmed)" }}>
                    ·
                  </span>
                  <span>{formatUptime(stats.system.uptime_sec, t)}</span>
                </div>
              </div>
            </SectionCard>

            {/* CPU */}
            <SectionCard icon={<LuCpu />} title={t("resourceMonitor.cpu")}>
              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-mono" style={{ color: "var(--df-text)" }}>
                    {stats.cpu.usage.toFixed(1)}%
                  </span>
                  <span className="text-xs" style={{ color: "var(--df-text-muted)" }}>
                    {formatCores(stats.cpu.cores)}
                  </span>
                </div>
                <ProgressBar value={stats.cpu.usage} color={usageColor(stats.cpu.usage)} />
              </div>
            </SectionCard>

            {/* Memory */}
            <SectionCard icon={<FaMemory />} title={t("resourceMonitor.memory")}>
              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs font-mono" style={{ color: "var(--df-text)" }}>
                    {formatBytes(stats.memory.used)} / {formatBytes(memTotal)}
                  </span>
                  <span className="text-sm font-mono" style={{ color: usageColor(memUsedPct) }}>
                    {formatPct(memUsedPct)}
                  </span>
                </div>
                <ProgressBar value={memUsedPct} color={usageColor(memUsedPct)} />
                <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                  <MetricText
                    label={t("resourceMonitor.available")}
                    value={formatBytes(stats.memory.available)}
                  />
                  <MetricText
                    label={t("resourceMonitor.cached")}
                    value={formatBytes(stats.memory.cached)}
                  />
                </div>
              </div>
            </SectionCard>

            {/* System Load */}
            <SectionCard
              icon={<MdOutlineLocalFireDepartment />}
              title={t("resourceMonitor.systemLoad")}
            >
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <span
                    className="text-xs font-medium"
                    style={{ color: loadColor(loadRatio) }}
                    title={`${t("resourceMonitor.Load1")} / ${formatCores(stats.cpu.cores)}`}
                  >
                    {formatPct(loadRatio * 100)}
                  </span>
                  <span className="text-xs" style={{ color: "var(--df-text-muted)" }}>
                    {formatCores(stats.cpu.cores)}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <LoadValue label={t("resourceMonitor.Load1")} value={stats.load.load1} />
                  <LoadValue label={t("resourceMonitor.Load5")} value={stats.load.load5} />
                  <LoadValue label={t("resourceMonitor.Load15")} value={stats.load.load15} />
                </div>
              </div>
            </SectionCard>

            {/* Disk */}
            <SectionCard icon={<MdStorage />} title={t("resourceMonitor.disk")}>
              {stats.disks.length > 0 ? (
                <div>
                  {stats.disks.map((disk) => (
                    <DiskRow
                      key={`${disk.device}-${disk.mount}`}
                      mount={disk.mount}
                      total={disk.total}
                      available={disk.available}
                      availableLabel={t("resourceMonitor.available")}
                      usePercent={disk.use_percent}
                    />
                  ))}
                </div>
              ) : (
                <span className="text-xs" style={{ color: "var(--df-text-dimmed)" }}>
                  -
                </span>
              )}
            </SectionCard>

            {/* Network */}
            <SectionCard icon={<MdSwapVert />} title={t("resourceMonitor.network")}>
              {stats.networks.length > 0 ? (
                <div>
                  {stats.networks.map((net) => (
                    <NetworkRow
                      key={net.nic}
                      nic={net.nic}
                      tx={net.tx_bytes_per_sec}
                      rx={net.rx_bytes_per_sec}
                      txLabel={t("resourceMonitor.send")}
                      rxLabel={t("resourceMonitor.receive")}
                    />
                  ))}
                </div>
              ) : (
                <span className="text-xs" style={{ color: "var(--df-text-dimmed)" }}>
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
      <span className="text-sm" style={{ color: "var(--df-text-muted)" }}>
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
    <div className="min-w-0">
      <span className="text-xs" style={{ color: "var(--df-text-muted)" }}>
        {label}
      </span>
      <span className="ml-1 text-xs font-mono font-medium" style={{ color: "var(--df-text)" }}>
        {value.toFixed(2)}
      </span>
    </div>
  );
}

function MetricText({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="text-[0.6875rem]" style={{ color: "var(--df-text-muted)" }}>
        {label}
      </span>
      <span className="text-[0.6875rem] font-mono" style={{ color: "var(--df-text)" }}>
        {value}
      </span>
    </div>
  );
}

function DiskRow({
  mount,
  total,
  available,
  availableLabel,
  usePercent,
}: {
  mount: string;
  total: number;
  available: number;
  availableLabel: string;
  usePercent: number;
}) {
  return (
    <div
      className="space-y-1.5 border-b py-2 first:pt-0 last:border-b-0 last:pb-0"
      style={{ borderColor: "var(--df-border)" }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span
          className="min-w-0 truncate text-xs font-mono"
          style={{ color: "var(--df-text)" }}
          title={mount}
        >
          {mount}
        </span>
        <span className="shrink-0 text-xs font-mono" style={{ color: usageColor(usePercent) }}>
          {formatPct(usePercent)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="text-[0.6875rem] font-mono" style={{ color: "var(--df-text-muted)" }}>
          {formatBytes(total)}
        </span>
        <MetricText label={availableLabel} value={formatBytes(available)} />
      </div>
      <ProgressBar value={usePercent} color={usageColor(usePercent)} />
    </div>
  );
}

function NetworkRow({
  nic,
  tx,
  rx,
  txLabel,
  rxLabel,
}: {
  nic: string;
  tx: number;
  rx: number;
  txLabel: string;
  rxLabel: string;
}) {
  return (
    <div
      className="space-y-1 border-b py-2 first:pt-0 last:border-b-0 last:pb-0"
      style={{ borderColor: "var(--df-border)" }}
    >
      <div className="truncate text-xs font-mono" style={{ color: "var(--df-text)" }} title={nic}>
        {nic}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <span
          className="min-w-0 truncate text-xs font-mono"
          style={{ color: "var(--df-text-muted)" }}
        >
          ↑ {txLabel} {formatRate(tx)}
        </span>
        <span
          className="min-w-0 truncate text-right text-xs font-mono"
          style={{ color: "var(--df-text-muted)" }}
        >
          ↓ {rxLabel} {formatRate(rx)}
        </span>
      </div>
    </div>
  );
}
