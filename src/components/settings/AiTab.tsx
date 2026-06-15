import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MdAdd, MdDelete, MdExpandLess, MdExpandMore, MdRefresh } from "react-icons/md";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectItem } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useApp } from "@/context/AppContext";
import {
  aiModelIdForCredential,
  aiModelIdForProvider,
  BUILTIN_PROVIDERS,
  getProviderLabel,
  isBuiltinProvider,
  mergeModelDiscoveries,
} from "@/lib/aiSettings";
import { getErrorMessage } from "@/lib/errors";
import { invoke } from "@/lib/invoke";
import type {
  AICustomActionConfig,
  AIModelConfigItem,
  AIModelDiscovery,
  AIProviderCredential,
  AISettings,
} from "@/types/global";
import {
  SettingFieldGrid,
  SettingInput,
  SettingNumberInput,
  SettingRow,
  SettingSection,
  SettingSelect,
  SettingSwitch,
} from "./SettingFormItems";

function updateDefaultModelId(ai: AISettings, models: AIModelConfigItem[]) {
  if (
    ai.default_model_id &&
    models.some((model) => model.enabled && model.id === ai.default_model_id)
  ) {
    return ai.default_model_id;
  }
  return models.find((model) => model.enabled)?.id ?? null;
}

function newCredential(): AIProviderCredential {
  return {
    id: `credential-${crypto.randomUUID()}`,
    name: "",
    provider_kind: "openai_compatible",
    base_url: "",
    api_key: "",
    enabled: true,
  };
}

function newAction(prefix: string): AICustomActionConfig {
  return {
    id: `${prefix}-${crypto.randomUUID()}`,
    name: "自定义 AI 功能",
    prompt: "",
    enabled: true,
  };
}

export function AiGeneralTab() {
  const { t } = useTranslation();
  const { appSettings, updateAppSettings } = useApp();
  const ai = appSettings.ai;
  const update = (patch: Partial<AISettings>) => updateAppSettings({ ai: { ...ai, ...patch } });

  return (
    <div className="space-y-5">
      <SettingSection title={t("ai.general")}>
        <SettingRow label={t("ai.enabled")}>
          <SettingSwitch checked={ai.enabled} onChange={(enabled) => update({ enabled })} />
        </SettingRow>
        <SettingRow label={t("ai.redaction")}>
          <SettingSwitch
            checked={ai.redaction_enabled}
            onChange={(redaction_enabled) => update({ redaction_enabled })}
          />
        </SettingRow>
        <SettingRow label={t("ai.allowSave")}>
          <SettingSwitch
            checked={ai.allow_save_command}
            onChange={(allow_save_command) => update({ allow_save_command })}
          />
        </SettingRow>
        <SettingRow label={t("ai.recordHistory")}>
          <SettingSwitch
            checked={ai.record_history}
            onChange={(record_history) => update({ record_history })}
          />
        </SettingRow>
        <SettingFieldGrid>
          <SettingInput
            label={t("ai.requestUserAgent")}
            desc={t("ai.requestUserAgentDesc")}
            value={ai.request_user_agent}
            onChange={(event) => update({ request_user_agent: event.target.value })}
            fieldClassName="lg:col-span-2"
          />
          <SettingNumberInput
            label={t("ai.contextLineLimit")}
            min={50}
            max={500}
            step={50}
            value={ai.context_line_limit}
            onChange={(context_line_limit) => update({ context_line_limit })}
          />
          <SettingNumberInput
            label={t("ai.timeoutMs")}
            min={5000}
            max={300000}
            step={1000}
            value={ai.timeout_ms}
            onChange={(timeout_ms) => update({ timeout_ms })}
          />
        </SettingFieldGrid>
      </SettingSection>

      <SettingSection title={t("ai.agentSettings")}>
        <SettingFieldGrid>
          <SettingSelect
            label={t("ai.smartAutoExecuteMaxRisk")}
            desc={t("ai.smartAutoExecuteMaxRiskDesc")}
            value={ai.agent_smart_auto_execute_max_risk ?? "low"}
            onValueChange={(agent_smart_auto_execute_max_risk) =>
              update({
                agent_smart_auto_execute_max_risk:
                  agent_smart_auto_execute_max_risk as AISettings["agent_smart_auto_execute_max_risk"],
              })
            }
          >
            <SelectItem value="low">{t("ai.riskLow")}</SelectItem>
            <SelectItem value="medium">{t("ai.riskMedium")}</SelectItem>
            <SelectItem value="high">{t("ai.riskHigh")}</SelectItem>
            <SelectItem value="critical">{t("ai.riskCritical")}</SelectItem>
          </SettingSelect>
        </SettingFieldGrid>
        <SettingFieldGrid>
          <SettingNumberInput
            label={t("ai.agentMaxSteps")}
            min={1}
            max={50}
            step={1}
            value={ai.max_agent_steps ?? 10}
            onChange={(max_agent_steps) => update({ max_agent_steps })}
          />
          <SettingNumberInput
            label={t("ai.agentStepTimeout")}
            min={5000}
            max={120000}
            step={1000}
            value={ai.agent_step_timeout_ms ?? 30000}
            onChange={(agent_step_timeout_ms) => update({ agent_step_timeout_ms })}
          />
          <SettingNumberInput
            label={t("ai.terminalOutputLines")}
            min={0}
            max={100}
            step={1}
            value={ai.terminal_output_lines}
            onChange={(terminal_output_lines) => update({ terminal_output_lines })}
          />
        </SettingFieldGrid>
        <div className="text-xs text-muted-foreground">{t("ai.agentMaxStepsDesc")}</div>
        <div className="text-xs text-muted-foreground">{t("ai.terminalOutputLinesDesc")}</div>
      </SettingSection>
    </div>
  );
}

interface ModelGroup {
  groupKey: string;
  label: string;
  credential?: AIProviderCredential;
  models: AIModelConfigItem[];
}

function groupKeyForCredential(credential: AIProviderCredential) {
  return isBuiltinProvider(credential.id) ? credential.provider_kind : credential.id;
}

function groupModels(
  models: AIModelConfigItem[],
  credentials: AIProviderCredential[],
): ModelGroup[] {
  const credentialMap = new Map<string, AIProviderCredential>();
  const groups = new Map<string, AIModelConfigItem[]>();
  for (const credential of credentials) {
    const key = groupKeyForCredential(credential);
    credentialMap.set(key, credential);
    if (!groups.has(key)) groups.set(key, []);
  }
  for (const model of models) {
    const key = model.credential_id ?? model.provider_kind ?? "unknown";
    const list = groups.get(key);
    if (list) list.push(model);
    else groups.set(key, [model]);
  }
  return Array.from(groups.entries()).map(([groupKey, items]) => {
    const cred = credentialMap.get(groupKey);
    const label =
      cred && !isBuiltinProvider(cred.id)
        ? cred.name || "Custom Provider"
        : getProviderLabel(groupKey);
    return { groupKey, label, credential: cred, models: items };
  });
}

export function AiModelsTab() {
  const { t } = useTranslation();
  const { appSettings, updateAppSettings } = useApp();
  const ai = appSettings.ai;
  const [query, setQuery] = useState("");
  const [manualModelNames, setManualModelNames] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const update = (patch: Partial<AISettings>) => updateAppSettings({ ai: { ...ai, ...patch } });

  const enabledCredentials = useMemo(
    () => ai.provider_credentials.filter((credential) => credential.enabled),
    [ai.provider_credentials],
  );

  const enabledProviderKinds = useMemo(() => {
    const kinds = new Set<string>();
    for (const c of ai.provider_credentials) {
      if (c.enabled) kinds.add(isBuiltinProvider(c.id) ? c.provider_kind : c.id);
    }
    return kinds;
  }, [ai.provider_credentials]);

  const visibleModels = useMemo(() => {
    return ai.models.filter((model) => {
      if (model.credential_id) return enabledProviderKinds.has(model.credential_id);
      if (model.provider_kind) return enabledProviderKinds.has(model.provider_kind);
      return false;
    });
  }, [ai.models, enabledProviderKinds]);

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return visibleModels;
    return visibleModels.filter((model) => model.name.toLowerCase().includes(q));
  }, [visibleModels, query]);

  const rawGroupedModels = useMemo(
    () => groupModels(filteredModels, enabledCredentials),
    [filteredModels, enabledCredentials],
  );

  const sortOrderRef = useRef<Map<string, string[]>>(new Map());

  const groupedModels = useMemo(() => {
    const prevOrder = sortOrderRef.current;
    const nextOrder = new Map<string, string[]>();

    const sorted = rawGroupedModels.map((group) => {
      const prevIds = prevOrder.get(group.groupKey);
      const currentIds = group.models.map((m) => m.id);
      const currentIdSet = new Set(currentIds);
      const sameSet =
        prevIds !== undefined &&
        prevIds.length === currentIds.length &&
        prevIds.every((id) => currentIdSet.has(id));

      if (sameSet && prevIds) {
        const modelMap = new Map(group.models.map((m) => [m.id, m]));
        const orderedModels = prevIds
          .map((id) => modelMap.get(id))
          .filter((m): m is AIModelConfigItem => m !== undefined);
        nextOrder.set(group.groupKey, prevIds);
        return { ...group, models: orderedModels };
      }

      const freshSorted = [...group.models].sort((a, b) => Number(b.enabled) - Number(a.enabled));
      nextOrder.set(
        group.groupKey,
        freshSorted.map((m) => m.id),
      );
      return { ...group, models: freshSorted };
    });

    sortOrderRef.current = nextOrder;
    return sorted;
  }, [rawGroupedModels]);

  const toggleGroupCollapsed = (groupKey: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }));
  };

  const updateModels = (models: AIModelConfigItem[]) => {
    update({ models, default_model_id: updateDefaultModelId(ai, models) });
  };

  const hasCustomCredentials = ai.provider_credentials.some(
    (c) => !isBuiltinProvider(c.id) && c.enabled,
  );

  const refreshModels = async () => {
    setRefreshing(true);
    try {
      const discoveries = await invoke<AIModelDiscovery[]>("list_ai_model_names");
      const models = mergeModelDiscoveries(ai.models, discoveries);
      updateModels(models);
      toast.success(t("ai.modelsRefreshed"));
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setRefreshing(false);
    }
  };

  const updateModel = (id: string, patch: Partial<AIModelConfigItem>) => {
    const models = ai.models.map((model) => {
      if (model.id !== id) return model;
      const next = { ...model, ...patch };
      if (next.source === "manual") {
        next.id = next.credential_id
          ? aiModelIdForCredential(next.credential_id, next.name)
          : aiModelIdForProvider(next.provider_kind ?? "openai_compatible", next.name);
      }
      return next;
    });
    updateModels(models);
  };

  const addManualModel = (credential: AIProviderCredential) => {
    const groupKey = groupKeyForCredential(credential);
    const name = (manualModelNames[groupKey] ?? "").trim();
    if (!name || !credential) return;

    const builtin = isBuiltinProvider(credential.id);
    const id = builtin
      ? aiModelIdForProvider(credential.provider_kind, name)
      : aiModelIdForCredential(credential.id, name);
    const existing = ai.models.find((model) => model.id === id);

    if (existing?.enabled) {
      toast.info(t("ai.manualModelExists", { model: name }));
      return;
    }

    if (existing) {
      const models = ai.models.map((model) =>
        model.id === id
          ? {
              ...model,
              name,
              provider_kind: credential.provider_kind,
              credential_id: builtin ? null : credential.id,
              enabled: true,
            }
          : model,
      );
      updateModels(models);
      setManualModelNames((prev) => ({ ...prev, [groupKey]: "" }));
      toast.success(t("ai.manualModelAdded", { model: name }));
      return;
    }

    const model: AIModelConfigItem = {
      id,
      name,
      provider_kind: credential.provider_kind,
      credential_id: builtin ? null : credential.id,
      enabled: true,
      source: "manual",
      last_seen_at: null,
    };
    const models = [model, ...ai.models];
    update({
      models,
      default_model_id:
        ai.default_model_id &&
        models.some((item) => item.enabled && item.id === ai.default_model_id)
          ? ai.default_model_id
          : model.id,
    });
    setManualModelNames((prev) => ({ ...prev, [groupKey]: "" }));
    toast.success(t("ai.manualModelAdded", { model: name }));
  };

  const removeManualModel = (id: string) => {
    const model = ai.models.find((item) => item.id === id);
    if (model?.source !== "manual") return;
    const models = ai.models.filter((item) => item.id !== id);
    update({
      models,
      default_model_id: updateDefaultModelId(ai, models),
    });
    toast.success(t("ai.manualModelDeleted", { model: model.name }));
  };

  const updateCredential = (id: string, patch: Partial<AIProviderCredential>) => {
    const nextCredentials = ai.provider_credentials.map((credential) =>
      credential.id === id ? { ...credential, ...patch } : credential,
    );
    const nextCredential = nextCredentials.find((credential) => credential.id === id);
    let nextModels = ai.models.map((model) =>
      model.credential_id === id && nextCredential
        ? { ...model, provider_kind: nextCredential.provider_kind }
        : model,
    );

    if (nextCredential && isBuiltinProvider(id) && "enabled" in patch) {
      const providerKind = nextCredential.provider_kind;
      const builtinInfo = BUILTIN_PROVIDERS[providerKind];
      if (builtinInfo) {
        if (patch.enabled) {
          const existingIds = new Set(nextModels.map((m) => m.id));
          for (const name of builtinInfo.models) {
            const modelId = aiModelIdForProvider(providerKind, name);
            if (!existingIds.has(modelId)) {
              nextModels.push({
                id: modelId,
                name,
                provider_kind: providerKind,
                credential_id: null,
                enabled: false,
                source: "rust-genai",
                last_seen_at: null,
              });
            }
          }
        } else {
          nextModels = nextModels.filter(
            (m) => m.provider_kind !== providerKind || m.credential_id != null,
          );
        }
      }
    }

    update({
      provider_credentials: nextCredentials,
      models: nextModels,
      default_model_id: updateDefaultModelId(ai, nextModels),
    });
  };

  const addCredential = () => {
    update({ provider_credentials: [newCredential(), ...ai.provider_credentials] });
  };

  const removeCredential = (id: string) => {
    const models = ai.models.filter((model) => model.credential_id !== id);
    update({
      provider_credentials: ai.provider_credentials.filter((credential) => credential.id !== id),
      models,
      default_model_id: updateDefaultModelId(ai, models),
    });
  };

  return (
    <div className="space-y-5">
      <SettingSection title={t("ai.modelList")}>
        <div className="flex items-center gap-2">
          <Input
            value={query}
            placeholder={t("ai.searchModels")}
            className="flex-1 text-sm"
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button
            size="icon-sm"
            variant="outline"
            disabled={refreshing || !hasCustomCredentials}
            onClick={() => void refreshModels()}
            title={t("ai.refreshModels")}
          >
            <MdRefresh className={refreshing ? "animate-spin" : ""} />
          </Button>
        </div>
        <div className="max-h-[22rem] overflow-auto rounded-md border border-border/70 terminal-scroll">
          {groupedModels.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              {visibleModels.length === 0 ? t("ai.noModels") : t("ai.noModelMatches")}
            </div>
          ) : (
            groupedModels.map((group) => {
              const isCollapsed = collapsedGroups[group.groupKey] ?? false;
              const enabledCount = group.models.filter((m) => m.enabled).length;
              return (
                <div key={group.groupKey}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 text-left text-xs font-semibold hover:bg-muted/50"
                    onClick={() => toggleGroupCollapsed(group.groupKey)}
                  >
                    {isCollapsed ? (
                      <MdExpandMore className="shrink-0 text-sm" />
                    ) : (
                      <MdExpandLess className="shrink-0 text-sm" />
                    )}
                    <span className="flex-1 truncate">{group.label}</span>
                    <span className="shrink-0 text-[0.625rem] font-normal text-muted-foreground">
                      {enabledCount}/{group.models.length}
                    </span>
                  </button>
                  {!isCollapsed ? (
                    <>
                      {group.credential ? (
                        <div className="border-b border-border/60 px-3 py-2 pl-8">
                          <div className="flex h-8 overflow-hidden rounded-md border border-border/60 bg-muted/12 transition-colors focus-within:border-primary/45 focus-within:bg-background/70 focus-within:ring-1 focus-within:ring-primary/15">
                            <Input
                              value={manualModelNames[group.groupKey] ?? ""}
                              placeholder={t("ai.manualModelPlaceholder")}
                              className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-3 font-mono text-xs shadow-none placeholder:text-muted-foreground/55 focus-visible:border-transparent focus-visible:ring-0"
                              onChange={(event) =>
                                setManualModelNames((prev) => ({
                                  ...prev,
                                  [group.groupKey]: event.target.value,
                                }))
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter" && group.credential) {
                                  event.preventDefault();
                                  addManualModel(group.credential);
                                }
                              }}
                            />
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={!manualModelNames[group.groupKey]?.trim()}
                              title={t("common.add")}
                              className="h-full rounded-none border-l border-border/60 px-3 text-xs text-muted-foreground hover:bg-primary/10 hover:text-primary disabled:opacity-35"
                              onClick={() => group.credential && addManualModel(group.credential)}
                            >
                              <MdAdd />
                              {t("common.add")}
                            </Button>
                          </div>
                        </div>
                      ) : null}
                      {group.models.map((model) => (
                        <div
                          key={model.id}
                          className="flex items-center gap-3 border-b border-border/60 px-3 py-2 pl-8 last:border-b-0"
                        >
                          <div className="flex min-w-0 flex-1 items-center gap-2">
                            <div className="min-w-0 truncate text-xs">{model.name}</div>
                            {model.source === "manual" ? (
                              <Badge
                                variant="outline"
                                className="h-5 border-border/70 px-1.5 text-[0.625rem] font-normal text-muted-foreground"
                              >
                                {t("ai.manualModelBadge")}
                              </Badge>
                            ) : null}
                          </div>
                          <SettingSwitch
                            checked={model.enabled}
                            onChange={(enabled) => updateModel(model.id, { enabled })}
                          />
                          {model.source === "manual" ? (
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              title={t("ai.deleteManualModel")}
                              onClick={() => removeManualModel(model.id)}
                            >
                              <MdDelete />
                            </Button>
                          ) : null}
                        </div>
                      ))}
                    </>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
        {enabledCredentials.length === 0 ? (
          <div className="text-xs text-muted-foreground">{t("ai.manualModelNoProvider")}</div>
        ) : null}
        {visibleModels.every((model) => !model.enabled) ? (
          <div className="text-xs text-amber-600">{t("ai.enableOneModelHint")}</div>
        ) : null}
      </SettingSection>

      <SettingSection
        title={t("ai.apiKeys")}
        action={
          <Button size="sm" variant="outline" onClick={addCredential}>
            <MdAdd />
            {t("common.add")}
          </Button>
        }
        contentClassName="space-y-4"
      >
        {ai.provider_credentials.map((credential) => {
          const builtin = isBuiltinProvider(credential.id);
          return (
            <div
              key={credential.id}
              className="rounded-md border border-border/70 bg-background/75 p-4"
            >
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="min-w-0 truncate text-sm font-medium">{credential.name}</div>
                <div className="flex items-center gap-2">
                  <SettingSwitch
                    checked={credential.enabled}
                    onChange={(enabled) => updateCredential(credential.id, { enabled })}
                  />
                  {!builtin ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => removeCredential(credential.id)}
                    >
                      <MdDelete />
                    </Button>
                  ) : null}
                </div>
              </div>
              {builtin ? (
                <SettingInput
                  label={t("settings.apiKey")}
                  type="password"
                  placeholder={credential.api_key === "__SET__" ? "__SET__" : "sk-..."}
                  value={credential.api_key ?? ""}
                  onChange={(event) =>
                    updateCredential(credential.id, { api_key: event.target.value })
                  }
                />
              ) : (
                <SettingFieldGrid>
                  <SettingInput
                    label={t("ai.profileName")}
                    value={credential.name}
                    onChange={(event) =>
                      updateCredential(credential.id, { name: event.target.value })
                    }
                  />
                  <SettingInput
                    label={t("ai.baseUrl")}
                    placeholder="https://api.openai.com/v1/"
                    value={credential.base_url ?? ""}
                    onChange={(event) =>
                      updateCredential(credential.id, { base_url: event.target.value })
                    }
                  />
                  <SettingInput
                    label={t("settings.apiKey")}
                    type="password"
                    placeholder={credential.api_key === "__SET__" ? "__SET__" : "sk-..."}
                    value={credential.api_key ?? ""}
                    onChange={(event) =>
                      updateCredential(credential.id, { api_key: event.target.value })
                    }
                  />
                </SettingFieldGrid>
              )}
            </div>
          );
        })}
      </SettingSection>
    </div>
  );
}

function ActionListEditor({
  title,
  actions,
  onChange,
}: {
  title: string;
  actions: AICustomActionConfig[];
  onChange: (actions: AICustomActionConfig[]) => void;
}) {
  const { t } = useTranslation();

  const updateAction = (id: string, patch: Partial<AICustomActionConfig>) => {
    onChange(actions.map((action) => (action.id === id ? { ...action, ...patch } : action)));
  };

  return (
    <SettingSection
      title={title}
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => onChange([...actions, newAction("ai-action")])}
        >
          <MdAdd />
          {t("common.add")}
        </Button>
      }
      contentClassName="space-y-4"
    >
      {actions.map((action) => (
        <div key={action.id} className="rounded-md border border-border/70 bg-background/75 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0 truncate text-sm font-medium">{action.name}</div>
            <div className="flex items-center gap-2">
              <SettingSwitch
                checked={action.enabled}
                onChange={(enabled) => updateAction(action.id, { enabled })}
              />
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={() => onChange(actions.filter((item) => item.id !== action.id))}
              >
                <MdDelete />
              </Button>
            </div>
          </div>
          <div className="space-y-3">
            <Input
              value={action.name}
              className="text-sm"
              placeholder={t("ai.actionName")}
              onChange={(event) => updateAction(action.id, { name: event.target.value })}
            />
            <Textarea
              value={action.prompt}
              className="min-h-20 resize-y text-sm"
              placeholder={t("ai.actionPrompt")}
              onChange={(event) => updateAction(action.id, { prompt: event.target.value })}
            />
          </div>
        </div>
      ))}
    </SettingSection>
  );
}

export function AiRulesTab() {
  const { t } = useTranslation();
  const { appSettings, updateAppSettings } = useApp();
  const ai = appSettings.ai;
  const update = (patch: Partial<AISettings>) => updateAppSettings({ ai: { ...ai, ...patch } });
  const MB = 1024 * 1024;

  return (
    <div className="space-y-5">
      <SettingSection title={t("ai.rules")}>
        <SettingNumberInput
          label={`${t("ai.maxAiFileSize")} (MB)`}
          desc={t("ai.maxAiFileSizeDesc")}
          min={1}
          max={256}
          step={1}
          value={Math.max(1, Math.round(ai.max_ai_file_size_bytes / MB))}
          onChange={(value) => update({ max_ai_file_size_bytes: value * MB })}
        />
      </SettingSection>
      <ActionListEditor
        title={t("ai.terminalActions")}
        actions={ai.terminal_ai_actions}
        onChange={(terminal_ai_actions) => update({ terminal_ai_actions })}
      />
      <ActionListEditor
        title={t("ai.fileActions")}
        actions={ai.file_ai_actions}
        onChange={(file_ai_actions) => update({ file_ai_actions })}
      />
    </div>
  );
}

export function AiTab() {
  return <AiGeneralTab />;
}
