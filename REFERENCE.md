# REFERENCE — Default active agent config

This document defines the intended behavior for adding a `defaultAgent` configuration option to the Pi subagent extension.

## Problem

The extension already supports selecting a main-session active agent using:

```bash
pi --agent plan
```

and switching interactively with:

```text
/agent plan
```

However, repeatedly typing `--agent plan` is inconvenient when a user wants the same agent to be active every time they enter a project or start Pi.

## Goal

Allow users to configure a default active agent once, then start Pi normally.

Example desired flow:

```json
// .pi/subagent.json
{
  "defaultAgent": "plan"
}
```

Then:

```bash
pi
```

starts with `plan` already active.

## Config files

Reuse the existing subagent extension config files.

### User config

```text
~/.pi/agent/subagent.json
```

Applies globally unless overridden by project config.

### Project config

```text
.pi/subagent.json
```

Discovered by walking upward from the current working directory.

Project config overrides user config.

## Config shape

Extend the existing config shape from:

```ts
interface SubagentExtensionConfig {
  viewerKey: KeyId | "none";
}
```

to:

```ts
interface SubagentExtensionConfig {
  viewerKey: KeyId | "none";
  defaultAgent?: string;
}
```

`viewerKey` behavior must remain unchanged.

## Example configs

### Project-local default active agent

```json
{
  "viewerKey": "ctrl+k",
  "defaultAgent": "plan"
}
```

### User-global default active agent

```json
{
  "defaultAgent": "plan"
}
```

### Disable viewer shortcut while keeping default agent

```json
{
  "viewerKey": "none",
  "defaultAgent": "plan"
}
```

## Startup precedence

Startup active-agent selection should use this precedence:

1. CLI flag `--agent <name>`
2. Project config `.pi/subagent.json` `defaultAgent`
3. User config `~/.pi/agent/subagent.json` `defaultAgent`
4. No active agent

This means CLI always wins:

```bash
pi --agent worker
```

should activate `worker` even if config says:

```json
{
  "defaultAgent": "plan"
}
```

## Exact-name rule

`defaultAgent` is an exact-name operation.

It should resolve against the full discovered agent set, including hidden agents.

Examples:

```json
{
  "defaultAgent": "oracle"
}
```

should work even if the `oracle` agent has:

```yaml
hidden: true
```

## Missing agent behavior

If `defaultAgent` is configured but the agent does not exist:

- show a warning
- continue without an active agent
- do not crash startup

Suggested warning:

```text
Unknown default agent: plan
```

or, if sharing logic with `--agent`:

```text
Unknown agent: plan
```

## Empty or invalid config values

### Empty string

Ignore empty strings after trimming:

```json
{
  "defaultAgent": ""
}
```

This should behave as if no default agent was configured.

### Non-string value

Warn and ignore:

```json
{
  "defaultAgent": true
}
```

Suggested warning:

```text
Ignoring project defaultAgent: expected a string.
```

## Relationship to hidden agents

Hidden agents are excluded from discovery-oriented UI, such as:

- `/agent` selector
- `/agent` completions
- cycle order
- startup visible-agent notification
- prompt-level visible-agent list

But hidden agents remain callable by exact name.

`defaultAgent` follows exact-name behavior, so it may activate hidden agents.

## Relationship to child subagents

This feature applies to the **main Pi session**.

Child subagents already use their own agent markdown files as their execution config.

Important intended behavior:

- `--agent <name>` must not be forwarded to child subagent processes.
- `defaultAgent` should not conceptually alter child subagent execution.

Because `defaultAgent` lives in `.pi/subagent.json`, child Pi processes running in the same cwd may also load the extension config. If that causes unintended active-agent injection inside child sessions, implementation should prevent it by one of these approaches:

1. Ignore `defaultAgent` when `PI_SUBAGENT_DEPTH > 0`.
2. Or skip applying `defaultAgent` when running in child subagent mode.
3. Or document that child active-agent state is harmless because child prompts already receive their own agent config.

Recommended behavior: **ignore `defaultAgent` for child subagent processes** so parent convenience config does not affect child behavior.

## Recommended implementation detail

During `session_start`:

```ts
const config = loadSubagentConfig(ctx.cwd);
const cliAgent = pi.getFlag("agent");
const requestedAgent =
  typeof cliAgent === "string" && cliAgent.trim()
    ? cliAgent.trim()
    : config.defaultAgent;
```

Then resolve `requestedAgent` by exact name from all discovered agents.

To avoid affecting child subagent runs, apply config default only when current delegation depth is root:

```ts
const isRootSession = currentDepth === 0;
const requestedAgent = cliAgent || (isRootSession ? config.defaultAgent : undefined);
```

CLI `--agent` should still work wherever explicitly supplied, but parent `--agent` is already stripped from child processes.

## Acceptance criteria

A correct implementation satisfies all of the following:

- `defaultAgent` can be configured in `~/.pi/agent/subagent.json`.
- `defaultAgent` can be configured in `.pi/subagent.json`.
- Project config overrides user config.
- `pi` starts with the configured default agent active.
- `pi --agent worker` overrides configured `defaultAgent: "plan"`.
- Hidden agents can be activated by `defaultAgent` exact name.
- Invalid or missing default agent warns and continues.
- Existing `viewerKey` behavior is unchanged.
- Child subagent execution is not altered by the parent convenience default.

## Non-goals

This feature should not change:

- agent discovery precedence
- hidden-agent visibility rules
- `/agent` command behavior
- cycle switching behavior
- subagent tool invocation shape
- child subagent markdown config handling
