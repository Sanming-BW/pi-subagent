import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { KeyId } from "@mariozechner/pi-tui";

export interface SubagentExtensionConfig {
  viewerKey: KeyId | "none";
  cycleAgentKey: KeyId | "none";
  defaultAgent?: string;
}

export const DEFAULT_SUBAGENT_CONFIG: SubagentExtensionConfig = {
  viewerKey: "ctrl+k",
  cycleAgentKey: "ctrl+h",
};

const VALID_KEY_RE = /^(none|(?:ctrl|shift|alt|super)(?:\+(?:ctrl|shift|alt|super))*\+[a-z0-9]|[a-z0-9]|enter|return|escape|tab|space|backspace|delete|home|end|up|down|left|right|pageup|pagedown)$/i;

function warn(message: string): void {
  console.warn(`[pi-subagent] ${message}`);
}

type ConfigKeyName = "viewerKey" | "cycleAgentKey";

function normalizeKey(
  raw: unknown,
  source: string,
  keyName: ConfigKeyName,
): KeyId | "none" | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    warn(`Ignoring ${source} ${keyName}: expected a string.`);
    return undefined;
  }

  const key = raw.trim().toLowerCase();
  if (!VALID_KEY_RE.test(key)) {
    warn(`Ignoring ${source} ${keyName}="${raw}": invalid key format.`);
    return undefined;
  }

  return key === "pageup"
    ? "pageUp"
    : key === "pagedown"
      ? "pageDown"
      : key as KeyId | "none";
}

function normalizeConfig(raw: unknown, source: string): Partial<SubagentExtensionConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warn(`Ignoring ${source}: expected a JSON object.`);
    return {};
  }

  const input = raw as { viewerKey?: unknown; cycleAgentKey?: unknown; defaultAgent?: unknown };
  const result: Partial<SubagentExtensionConfig> = {};

  const viewerKey = normalizeKey(input.viewerKey, source, "viewerKey");
  if (viewerKey !== undefined) result.viewerKey = viewerKey;

  const cycleAgentKey = normalizeKey(input.cycleAgentKey, source, "cycleAgentKey");
  if (cycleAgentKey !== undefined) result.cycleAgentKey = cycleAgentKey;

  if (input.defaultAgent !== undefined) {
    if (typeof input.defaultAgent !== "string") {
      warn(`Ignoring ${source} defaultAgent: expected a string.`);
    } else {
      const defaultAgent = input.defaultAgent.trim();
      if (defaultAgent) result.defaultAgent = defaultAgent;
    }
  }
  return result;
}

function readJsonConfig(file: string, source: string): Partial<SubagentExtensionConfig> {
  if (!fs.existsSync(file)) return {};
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(file, "utf8")), source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`Ignoring ${source} config at ${file}: ${message}`);
    return {};
  }
}

export function findProjectConfig(cwd: string): string | null {
  let current = path.resolve(cwd || process.cwd());
  while (true) {
    const candidate = path.join(current, ".pi", "subagent.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function loadSubagentConfig(cwd: string): SubagentExtensionConfig {
  const userPath = path.join(os.homedir(), ".pi", "agent", "subagent.json");
  const projectPath = findProjectConfig(cwd);

  const userConfig = readJsonConfig(userPath, "user");
  const projectConfig = projectPath ? readJsonConfig(projectPath, "project") : {};

  return {
    ...DEFAULT_SUBAGENT_CONFIG,
    ...userConfig,
    ...projectConfig,
  };
}

export function resolveStartupAgentName(
  cliAgent: unknown,
  config: SubagentExtensionConfig,
  isRootSession: boolean,
): string | undefined {
  if (typeof cliAgent === "string") {
    const trimmed = cliAgent.trim();
    if (trimmed) return trimmed;
  }
  if (isRootSession) return config.defaultAgent?.trim() || undefined;
  return undefined;
}
