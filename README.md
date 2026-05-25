# README

A fork from [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent).

If you come here, you probably have lost your way.

## Active agent mode

This extension supports a main-session **active agent** that changes the model, thinking level, tools, and system prompt for future turns only.

When an active agent is selected, its prompt becomes the primary system prompt for future turns. Pi's default coding-agent persona is replaced by the active agent's identity and instructions, while operational context is rebuilt from Pi's structured prompt options: selected tool descriptions, guidelines, visible subagent instructions, project context files, skills when the `read` tool is active, current date, and current working directory.

Explicit custom system prompts and appended system prompts are preserved as additional instructions after the active-agent prompt. If no active agent is selected, prompt behavior is unchanged: Pi builds its normal system prompt and this extension appends the available-subagents section as before.

### Start with an agent

```bash
pi -e . --agent plan
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
  "viewerKey": "ctrl+shift+o",
  "cycleAgentKey": "alt+shift+f",
  "defaultAgent": "plan"
}
```

`defaultAgent` is matched by exact agent name, so hidden agents can also be selected this way.

If the configured agent does not exist, Pi shows a warning and continues without an active agent.

### Switch agents in the TUI

- `/agent` opens a selector with visible agents only
- `/agent <name>` switches by exact name, including hidden agents
- `/agent none` or `/agent clear` clears the active agent
- `Alt+Shift+F` cycles through visible agents and then back to none by default

Configure the cycle shortcut with `cycleAgentKey` in the same user or project config files. It uses the same key format as `viewerKey`; set it to `"none"` to disable only the shortcut while keeping `/agent` available.

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

