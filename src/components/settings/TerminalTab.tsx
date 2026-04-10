import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MdAdd, MdDelete, MdExpandLess, MdExpandMore } from "react-icons/md";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useApp } from "@/context/AppContext";
import { useTheme } from "@/context/ThemeContext";
import { getBuiltinRules, hexLuminance } from "@/lib/keywordHighlightPresets";
import type { KeywordHighlightRule } from "@/types/global";
import { SettingNumberInput, SettingRow, SettingSwitch } from "./SettingFormItems";

const DEFAULT_ACTION_LINK_MATCHERS = {
  ipv4: true,
  archive: true,
  host_port: true,
} as const;

export function TerminalTab() {
  const { t } = useTranslation();
  const { appSettings, updateAppSettings, updateUi } = useApp();
  const { terminalTheme } = useTheme();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Derive dark/light from the terminal theme background luminance.
  const isDark = useMemo(
    () => hexLuminance(terminalTheme.colors.terminal.background) < 0.5,
    [terminalTheme.colors.terminal.background],
  );

  const builtinRules = useMemo(() => getBuiltinRules(isDark), [isDark]);
  const userRules = appSettings.terminal.keyword_highlights ?? [];
  const actionLinksEnabled = appSettings.terminal.action_links_enabled ?? true;
  const actionLinkMatchers =
    appSettings.terminal.action_links_matchers ?? DEFAULT_ACTION_LINK_MATCHERS;

  function updateRules(next: KeywordHighlightRule[]) {
    updateAppSettings({ terminal: { ...appSettings.terminal, keyword_highlights: next } });
  }

  function addRule() {
    const id = `kh-${Date.now()}`;
    const next: KeywordHighlightRule = {
      id,
      name: t("settings.keywordHighlightNewRule"),
      patterns: [],
      color_dark: "#79c0ff",
      color_light: "#0969da",
      enabled: true,
    };
    updateRules([...userRules, next]);
    setExpandedId(id);
  }

  function deleteRule(id: string) {
    updateRules(userRules.filter((r) => r.id !== id));
    if (expandedId === id) setExpandedId(null);
  }

  function patchRule(id: string, patch: Partial<KeywordHighlightRule>) {
    updateRules(userRules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  const ringClass = isDark ? "ring-white/20" : "ring-black/20";

  return (
    <div className="space-y-4">
      <SettingNumberInput
        label={t("settings.scrollbackLines")}
        desc={t("settings.scrollbackLinesDesc")}
        min={100}
        max={100000}
        step={100}
        value={appSettings.terminal.scrollback_lines}
        onChange={(v) =>
          updateAppSettings({ terminal: { ...appSettings.terminal, scrollback_lines: v || 5000 } })
        }
      />

      <SettingNumberInput
        label={t("settings.keepAliveInterval")}
        desc={t("settings.keepAliveIntervalDesc")}
        min={0}
        max={600}
        step={5}
        value={appSettings.terminal.keep_alive_interval}
        onChange={(v) =>
          updateAppSettings({ terminal: { ...appSettings.terminal, keep_alive_interval: v || 0 } })
        }
      />

      <SettingRow
        label={t("settings.hardwareAcceleration")}
        desc={t("settings.hardwareAccelerationDesc")}
      >
        <SettingSwitch
          checked={appSettings.terminal.hardware_acceleration}
          onChange={(v) =>
            updateAppSettings({ terminal: { ...appSettings.terminal, hardware_acceleration: v } })
          }
        />
      </SettingRow>

      <SettingRow label={t("settings.showRemoteStats")} desc={t("settings.showRemoteStatsDesc")}>
        <SettingSwitch
          checked={appSettings.ui.show_remote_stats ?? false}
          onChange={(v) => updateUi({ show_remote_stats: v })}
        />
      </SettingRow>

      {appSettings.ui.show_remote_stats && (
        <SettingNumberInput
          label={t("settings.remoteStatsInterval")}
          desc={t("settings.remoteStatsIntervalDesc")}
          min={1}
          max={60}
          step={1}
          value={appSettings.ui.remote_stats_interval ?? 3}
          onChange={(v) => updateUi({ remote_stats_interval: v || 3 })}
        />
      )}

      {/* ── Action Links ─────────────────────────────────────────────────── */}
      <div className="space-y-3 pt-2 border-t">
        <SettingRow label={t("settings.actionLinks")} desc={t("settings.actionLinksDesc")}>
          <SettingSwitch
            checked={actionLinksEnabled}
            onChange={(v) =>
              updateAppSettings({
                terminal: { ...appSettings.terminal, action_links_enabled: v },
              })
            }
          />
        </SettingRow>

        <div
          className={`space-y-1 transition-opacity ${
            actionLinksEnabled ? "" : "opacity-50 pointer-events-none"
          }`}
        >
          <Label className="font-medium text-sm">{t("settings.actionLinksMatchers")}</Label>
          <div className="border rounded-md overflow-hidden divide-y">
            {(
              [
                {
                  key: "ipv4" as const,
                  label: t("settings.actionLinksMatcherIpv4"),
                  example: "192.168.1.1",
                  desc: t("settings.actionLinksMatcherIpv4Desc"),
                },
                {
                  key: "host_port" as const,
                  label: t("settings.actionLinksMatcherHostPort"),
                  example: "localhost:8080",
                  desc: t("settings.actionLinksMatcherHostPortDesc"),
                },
                {
                  key: "archive" as const,
                  label: t("settings.actionLinksMatcherArchive"),
                  example: "backup.tar.gz",
                  desc: t("settings.actionLinksMatcherArchiveDesc"),
                },
              ] as const
            ).map(({ key, label, example, desc }) => (
              <div
                key={key}
                className="flex flex-col gap-2 bg-muted/20 px-3 py-3 sm:flex-row sm:items-center"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{label}</span>
                    <span className="text-[11px] font-mono text-muted-foreground/70 bg-muted px-1.5 py-0.5 rounded">
                      {example}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
                </div>
                <Switch
                  checked={actionLinkMatchers[key]}
                  onCheckedChange={(v) =>
                    updateAppSettings({
                      terminal: {
                        ...appSettings.terminal,
                        action_links_matchers: {
                          ...actionLinkMatchers,
                          [key]: v,
                        },
                      },
                    })
                  }
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Keyword Highlighting ──────────────────────────────────────────── */}
      <div className="space-y-3 pt-2 border-t">
        <SettingRow
          label={t("settings.keywordHighlightingExperimental")}
          desc={t("settings.keywordHighlightingExperimentalDesc")}
        >
          <SettingSwitch
            checked={appSettings.terminal.keyword_highlights_enabled ?? true}
            onChange={(v) =>
              updateAppSettings({
                terminal: { ...appSettings.terminal, keyword_highlights_enabled: v },
              })
            }
          />
        </SettingRow>

        <SettingRow
          label={t("settings.keywordHighlightWrappedLines")}
          desc={t("settings.keywordHighlightWrappedLinesDesc")}
        >
          <SettingSwitch
            disabled={!appSettings.terminal.keyword_highlights_enabled}
            checked={appSettings.terminal.keyword_highlights_across_wrapped_lines ?? false}
            onChange={(v) =>
              updateAppSettings({
                terminal: {
                  ...appSettings.terminal,
                  keyword_highlights_across_wrapped_lines: v,
                },
              })
            }
          />
        </SettingRow>

        {/* ── Built-in rules (read-only preview) ── */}
        <div className="space-y-1">
          <Label className="font-medium text-sm">
            {t("settings.keywordHighlightBuiltinRules")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("settings.keywordHighlightBuiltinNote")}
          </p>
          <div className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-2">
            {builtinRules.map((rule) => (
              <div key={rule.id} className="flex min-w-0 items-center gap-2 bg-muted/30 px-3 py-2">
                <span
                  className={`w-3 h-3 rounded-full shrink-0 ring-1 ring-inset ${ringClass}`}
                  style={{ backgroundColor: rule.color }}
                />
                <span className="w-20 shrink-0 text-sm text-muted-foreground">{rule.name}</span>
                <span className="flex-1 text-xs text-muted-foreground/60 font-mono truncate">
                  {rule.patterns.slice(0, 3).join(", ")}
                  {rule.patterns.length > 3 && ` +${rule.patterns.length - 3}`}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ── User rules ── */}
        <div
          className={`space-y-1 transition-opacity ${appSettings.terminal.keyword_highlights_enabled ? "" : "opacity-50 pointer-events-none"}`}
        >
          <div className="flex items-center justify-between">
            <Label className="font-medium text-sm">{t("settings.keywordHighlightRules")}</Label>
            <Button variant="ghost" size="xs" className="text-primary" onClick={addRule}>
              <MdAdd className="text-[0.875rem]" />
              {t("common.add")}
            </Button>
          </div>

          <div className="border rounded-md overflow-hidden">
            {userRules.length === 0 && (
              <p className="text-center text-xs text-muted-foreground py-5">
                {t("settings.keywordHighlightNoRules")}
              </p>
            )}

            {userRules.map((rule) => {
              const isOpen = expandedId === rule.id;
              const patternCount = rule.patterns.filter((p) => p.trim()).length;

              return (
                <div key={rule.id} className="border-b last:border-0">
                  {/* Collapsed row */}
                  <div
                    className="cursor-pointer select-none px-3 py-2 transition-colors hover:bg-accent/50"
                    onClick={() => setExpandedId(isOpen ? null : rule.id)}
                  >
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span
                          className={`h-3 w-3 shrink-0 rounded-full ring-1 ring-inset ${ringClass}`}
                          style={{ backgroundColor: isDark ? rule.color_dark : rule.color_light }}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {rule.name}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {t("settings.keywordHighlightPatternCount", { count: patternCount })}
                        </span>

                        <Switch
                          checked={rule.enabled}
                          onCheckedChange={(v) => patchRule(rule.id, { enabled: v })}
                          onClick={(e) => e.stopPropagation()}
                        />

                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0 text-destructive hover:bg-destructive/10"
                          title={t("common.delete")}
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteRule(rule.id);
                          }}
                        >
                          <MdDelete className="text-[1rem]" />
                        </Button>

                        {isOpen ? (
                          <MdExpandLess className="shrink-0 text-base text-muted-foreground" />
                        ) : (
                          <MdExpandMore className="shrink-0 text-base text-muted-foreground" />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Expanded edit form */}
                  {isOpen && (
                    <div
                      className="px-3 pb-3 pt-2 space-y-3 bg-accent/20 border-t"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {/* Rule name + dark/light colors on the same row */}
                      <div className="flex flex-col gap-4 xl:flex-row xl:items-end">
                        <div className="min-w-0 flex-1 space-y-1 xl:max-w-[16rem]">
                          <Label className="text-xs text-muted-foreground">
                            {t("settings.keywordHighlightRuleName")}
                          </Label>
                          <Input
                            className="text-sm h-8"
                            value={rule.name}
                            placeholder={t("settings.keywordHighlightRuleNamePlaceholder")}
                            onChange={(e) => patchRule(rule.id, { name: e.target.value })}
                          />
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2 xl:flex">
                          {[
                            {
                              field: "color_dark" as const,
                              labelKey: "keywordHighlightDarkPalette",
                              swatchRing: "ring-white/20",
                            },
                            {
                              field: "color_light" as const,
                              labelKey: "keywordHighlightLightPalette",
                              swatchRing: "ring-black/20",
                            },
                          ].map(({ field, labelKey, swatchRing }) => (
                            <div key={field} className="min-w-0 space-y-1">
                              <Label className="block text-xs text-muted-foreground">
                                {t(`settings.${labelKey}`)}
                              </Label>
                              <div className="flex items-center gap-2">
                                <div
                                  className={`relative h-8 w-8 shrink-0 overflow-hidden rounded-md border ring-1 ring-inset ${swatchRing}`}
                                  style={{ backgroundColor: rule[field] }}
                                >
                                  <input
                                    type="color"
                                    className="absolute inset-[-10px] h-[200%] w-[200%] cursor-pointer opacity-0"
                                    value={
                                      rule[field] && rule[field].length === 7
                                        ? rule[field]
                                        : "#000000"
                                    }
                                    onChange={(e) =>
                                      patchRule(rule.id, { [field]: e.target.value })
                                    }
                                  />
                                </div>
                                <Input
                                  className="h-8 w-full font-mono text-xs sm:w-[7.5rem]"
                                  value={rule[field]}
                                  maxLength={7}
                                  placeholder="#rrggbb"
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    if (/^#[0-9a-fA-F]{0,6}$/.test(v)) {
                                      patchRule(rule.id, { [field]: v });
                                    }
                                  }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Patterns */}
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">
                          {t("settings.keywordHighlightRulePatterns")}
                        </Label>
                        <Textarea
                          className="text-sm font-mono min-h-[80px] max-h-[160px] resize-y overflow-y-auto"
                          value={rule.patterns.join("\n")}
                          placeholder={t("settings.keywordHighlightRulePatternsPlaceholder")}
                          onChange={(e) =>
                            patchRule(rule.id, { patterns: e.target.value.split("\n") })
                          }
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
