# README

A fork from [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent).

If you come here, you probably have lost your way.

## Active agent mode

This extension supports a main-session **active agent** that changes the model, thinking level, tools, and system prompt for future turns only.

When an active agent is selected, its prompt becomes the primary system prompt for future turns. Pi's default coding-agent persona is replaced by the active agent's identity and instructions, while operational context is rebuilt from Pi's structured prompt options: selected tool descriptions, guidelines, visible subagent instructions, project context files, skills when the `read` tool is active, current date, and current working directory.

Explicit custom system prompts and appended system prompts are preserved as additional instructions after the active-agent prompt. If no active agent is selected, prompt behavior is unchanged: Pi builds its normal system prompt and this extension appends the available-subagents section as before.

### Start with an agent

```bash
pi -e . --agent Plan
```

If the agent exists, it becomes active at startup. Hidden agents can also be selected this way.

### Set a default active agent

You can configure a default agent once and have Pi start with it automatically.

User config:

```text
~/.pi/agent/subagent.json
```

Project config:

```text
.pi/subagent.json
```

Project config overrides user config. CLI `--agent <name>` always wins over config.

Example:

```json
{
  "viewerKey": "ctrl+k",
  "cycleAgentKey": "alt+shift+f",
  "defaultAgent": "Plan"
}
```

`defaultAgent` is matched by exact agent name, so hidden agents can also be selected this way.

If the configured agent does not exist, Pi shows a warning and continues without an active agent.

### Switch agents in the TUI

- `/agent` opens a selector with visible agents only
- `/agent <name>` switches by exact name, including hidden agents
- `/agent none` or `/agent clear` clears the active agent
- `Alt+Shift+F` cycles through visible agents and then back to none by default

The viewer shortcut is `ctrl+k` by default. Configure the cycle shortcut with `cycleAgentKey` in the same user or project config files. It uses the same key format as `viewerKey`; set it to `"none"` to disable only the shortcut while keeping `/agent` available.

### Subagent viewer

- `/subagents` opens the recorded subagent viewer
- The viewer now shows an **active-agent live activity tree**:
  - `Session` → active-agent turn → subagent
  - each user message / agent run is shown as a separate top-level turn
  - running turns keep their live `running` / `streaming` state visible
- The viewer prefers the live activity store when available, and falls back to branch replay for historical sessions
- Legacy parallel records are ignored
- Nested single subagent results still render as grandchildren
- Known limitation: if upstream events arrive heavily out of order or without stable IDs, branch replay may briefly recover a turn before live updates settle it

### Hidden agents

Add `hidden: true` in an agent frontmatter to hide it from discovery-oriented UI:

```yaml
---
name: oracle
hidden: true
---
```

Hidden agents are excluded from:

- `/agent` selector
- `/agent` completions
- startup discovery notifications
- system-prompt agent lists
- cycle order

They still work when addressed exactly, for example `/agent oracle` or `subagent({ agent: "oracle", ... })`.

## session continue

`subagent` supports three context modes:

- `spawn`: start a child with only the task prompt. Without `lineId`, this remains one-shot.
- `fork`: start a child from the current session state.
- `continue`: resume a previously created line checkpoint.
