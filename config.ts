import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { KeyId } from "@mariozechner/pi-tui";

export interface SubagentExtensionConfig {
  viewerKey: KeyId | "none";
}

export const DEFAULT_SUBAGENT_CONFIG: SubagentExtensionConfig = {
  viewerKey: "ctrl+k",
};

const VALID_KEY_RE = /^(none|(?:ctrl|shift|alt|super)(?:\+(?:ctrl|shift|alt|super))*\+[a-z0-9]|[a-z0-9]|enter|return|escape|tab|space|backspace|delete|home|end|up|down|left|right|pageup|pagedown)$/i;

function warn(message: string): void {
  console.warn(`[pi-subagent] ${message}`);
}

function normalizeConfig(raw: unknown, source: string): Partial<SubagentExtensionConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warn(`Ignoring ${source}: expected a JSON object.`);
    return {};
  }

  const input = raw as { viewerKey?: unknown };
  const result: Partial<SubagentExtensionConfig> = {};
  if (input.viewerKey !== undefined) {
    if (typeof input.viewerKey !== "string") {
      warn(`Ignoring ${source} viewerKey: expected a string.`);
    } else {
      const key = input.viewerKey.trim().toLowerCase();
      if (!VALID_KEY_RE.test(key)) {
        warn(`Ignoring ${source} viewerKey="${input.viewerKey}": invalid key format.`);
      } else {
        result.viewerKey = key === "pageup"
          ? "pageUp"
          : key === "pagedown"
            ? "pageDown"
            : key as KeyId | "none";
      }
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
