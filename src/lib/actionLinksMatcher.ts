import {
  ensureGlobalRegex,
  isValidArchiveName,
  isValidHostPort,
  isValidIPv4,
  shellQuote,
} from "@/lib/utils";
import type {
  ActionContext,
  ActionDefinition,
  ActionMatcher,
  ArchiveMatcherOptions,
  CommonMatcherOptions,
  HostPortMatcherOptions,
  IPv4MatcherOptions,
  MatchInput,
  MatchResult,
  RegexMatcherOptions,
} from "./actionLinksAddon";

function defaultTooltip(ctx: ActionContext, defaultAction?: ActionDefinition): string {
  const lines = [
    `Type: ${ctx.kind}`,
    `Value: ${ctx.value}`,
    `Ctrl/Cmd + Click to execute default action`,
    `Alt + Click to view more actions`,
  ];

  if (defaultAction) {
    const cmd = defaultAction.buildCommand(ctx);
    if (cmd) {
      lines.push(`Default: ${cmd}`);
    }
  }

  return lines.join("\n");
}

function chooseDefaultActionId(
  actions: ActionDefinition[],
  preferredId?: string,
): string | undefined {
  if (!actions.length) return undefined;
  if (preferredId && actions.some((a) => a.id === preferredId)) {
    return preferredId;
  }
  const declaredDefault = actions.find((a) => a.isDefault);
  if (declaredDefault) return declaredDefault.id;
  return actions[0].id;
}

function finalizeDefaultAction(
  actions: ActionDefinition[],
  preferredId?: string,
): ActionDefinition[] {
  const defaultId = chooseDefaultActionId(actions, preferredId);
  return actions.map((action) => ({
    ...action,
    isDefault: action.id === defaultId,
  }));
}

function buildMatchResult(
  matchText: string,
  match: RegExpExecArray,
  options: RegexMatcherOptions,
): MatchResult {
  const value = options.normalize ? options.normalize(matchText, match) : matchText;
  const data = options.mapData ? options.mapData(matchText, match) : {};

  return {
    text: matchText,
    startIndex: match.index,
    endIndex: match.index + matchText.length,
    kind: options.kind ?? "custom",
    value,
    data,
    priority: options.priority,
  };
}

export function createRegexMatcher(options: RegexMatcherOptions): ActionMatcher {
  const regex = ensureGlobalRegex(options.regex);

  return {
    id: options.id,
    label: options.label,
    priority: options.priority,
    prefilter: options.prefilter,

    match(input: MatchInput): MatchResult[] {
      const results: MatchResult[] = [];

      if (options.prefilter && !options.prefilter(input)) {
        return results;
      }

      const localRegex = ensureGlobalRegex(regex);
      let match = localRegex.exec(input.text);

      while (match) {
        const matchText = match[0];
        if (!matchText) {
          // Prevent zero-width match from causing infinite loop
          localRegex.lastIndex += 1;
          match = localRegex.exec(input.text);
          continue;
        }

        if (options.validate && !options.validate(matchText, match)) {
          match = localRegex.exec(input.text);
          continue;
        }

        results.push(buildMatchResult(matchText, match, options));
        match = localRegex.exec(input.text);
      }

      return results;
    },

    getActions(ctx: ActionContext): ActionDefinition[] {
      return options.getActions(ctx);
    },

    getTooltip: options.getTooltip,
  };
}

function makeCommonTooltip(
  customTooltip: CommonMatcherOptions["tooltip"],
  fallbackActions: ActionDefinition[],
): (ctx: ActionContext) => string {
  return (ctx: ActionContext) => {
    if (customTooltip) {
      return customTooltip(ctx);
    }
    const defaultAction = fallbackActions.find((a) => a.isDefault) ?? fallbackActions[0];
    return defaultTooltip(ctx, defaultAction);
  };
}

export function createIPv4Matcher(options: IPv4MatcherOptions = {}): ActionMatcher {
  const enabled = new Set(options.actions ?? ["ping", "traceroute", "ssh", "curl-http"]);

  const actions: ActionDefinition[] = [];

  if (enabled.has("ping")) {
    actions.push({
      id: "ping",
      label: "Ping",
      buildCommand: (ctx) => `ping ${ctx.value}`,
    });
  }

  if (enabled.has("traceroute")) {
    actions.push({
      id: "traceroute",
      label: "Traceroute",
      buildCommand: (ctx) => `traceroute ${ctx.value}`,
    });
  }

  if (enabled.has("ssh")) {
    actions.push({
      id: "ssh",
      label: "SSH",
      buildCommand: (ctx) => `ssh ${ctx.value}`,
    });
  }

  if (enabled.has("curl-http")) {
    actions.push({
      id: "curl-http",
      label: "curl http://",
      buildCommand: (ctx) => `curl http://${ctx.value}`,
    });
  }

  const finalizedActions = finalizeDefaultAction(actions, options.defaultAction);

  return createRegexMatcher({
    id: "builtin-ipv4",
    label: options.label ?? "IPv4",
    kind: "ip",
    priority: options.priority ?? 100,
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    validate: (text) => isValidIPv4(text),
    getActions: () => finalizedActions,
    getTooltip: makeCommonTooltip(options.tooltip, finalizedActions),
    prefilter: (input) => input.text.includes("."),
  });
}

export function createArchiveMatcher(options: ArchiveMatcherOptions = {}): ActionMatcher {
  const enabled = new Set(options.actions ?? ["extract", "list"]);
  const actions: ActionDefinition[] = [];

  if (enabled.has("extract")) {
    actions.push({
      id: "extract",
      label: "Extract",
      buildCommand: (ctx) => {
        const f = shellQuote(ctx.value);

        if (/\.zip$/i.test(ctx.value)) return `unzip ${f}`;
        if (/\.rar$/i.test(ctx.value)) return `unrar x ${f}`;
        if (/\.7z$/i.test(ctx.value)) return `7z x ${f}`;
        if (/\.(tar\.gz|tgz)$/i.test(ctx.value)) return `tar -xzvf ${f}`;
        if (/\.(tar\.bz2|tbz2)$/i.test(ctx.value)) return `tar -xjf ${f}`;
        if (/\.(tar\.xz|txz)$/i.test(ctx.value)) return `tar -xJf ${f}`;

        return null;
      },
    });
  }

  if (enabled.has("list")) {
    actions.push({
      id: "list",
      label: "List contents",
      buildCommand: (ctx) => {
        const f = shellQuote(ctx.value);

        if (/\.zip$/i.test(ctx.value)) return `unzip -l ${f}`;
        if (/\.rar$/i.test(ctx.value)) return `unrar l ${f}`;
        if (/\.7z$/i.test(ctx.value)) return `7z l ${f}`;
        if (/\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i.test(ctx.value)) {
          return `tar -tf ${f}`;
        }

        return null;
      },
    });
  }

  const finalizedActions = finalizeDefaultAction(actions, options.defaultAction);

  return createRegexMatcher({
    id: "builtin-archive",
    label: options.label ?? "Archive",
    kind: "archive",
    priority: options.priority ?? 80,
    regex: /\b(?:[^\s"'`<>|]+?\.(?:zip|rar|7z|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz))\b/gi,
    validate: (text) => isValidArchiveName(text),
    getActions: () => finalizedActions,
    getTooltip: makeCommonTooltip(options.tooltip, finalizedActions),
    prefilter: (input) => input.text.includes("."),
  });
}

export function createHostPortMatcher(options: HostPortMatcherOptions = {}): ActionMatcher {
  const enabled = new Set(options.actions ?? ["curl-http", "curl-https", "nc", "telnet"]);
  const actions: ActionDefinition[] = [];

  if (enabled.has("curl-http")) {
    actions.push({
      id: "curl-http",
      label: "curl http://",
      buildCommand: (ctx) => `curl http://${ctx.value}`,
    });
  }

  if (enabled.has("curl-https")) {
    actions.push({
      id: "curl-https",
      label: "curl https://",
      buildCommand: (ctx) => `curl https://${ctx.value}`,
    });
  }

  if (enabled.has("nc")) {
    actions.push({
      id: "nc",
      label: "nc -vz",
      buildCommand: (ctx) => {
        const host = ctx.data.host ?? ctx.value.split(":")[0];
        const port = ctx.data.port ?? ctx.value.split(":")[1];
        return `nc -vz ${host} ${port}`;
      },
    });
  }

  if (enabled.has("telnet")) {
    actions.push({
      id: "telnet",
      label: "Telnet",
      buildCommand: (ctx) => {
        const host = ctx.data.host ?? ctx.value.split(":")[0];
        const port = ctx.data.port ?? ctx.value.split(":")[1];
        return `telnet ${host} ${port}`;
      },
    });
  }

  const finalizedActions = finalizeDefaultAction(actions, options.defaultAction);

  return createRegexMatcher({
    id: "builtin-host-port",
    label: options.label ?? "Host:Port",
    kind: "hostPort",
    priority: options.priority ?? 110,
    regex:
      /\b((?:localhost|(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)|(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63})):(\d{1,5})\b/g,
    validate: (text) => isValidHostPort(text),
    mapData: (_text, match) => ({
      host: match[1] ?? "",
      port: match[2] ?? "",
    }),
    getActions: () => finalizedActions,
    getTooltip: makeCommonTooltip(options.tooltip, finalizedActions),
    prefilter: (input) => input.text.includes(":"),
  });
}
