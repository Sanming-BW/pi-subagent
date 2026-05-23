A fork from [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent).

If you come here, you probably have lost your way.

## session continue

`subagent` supports three context modes:

- `spawn`: start a child with only the task prompt. Without `lineId`, this remains one-shot.
- `fork`: start a child from the current parent session snapshot. Without `lineId`, this remains one-shot.
- `continue`: resume an explicitly named subagent line.

Create a reusable line by passing `lineId` to `spawn` or `fork`:

```json
{ "agent": "writer", "mode": "fork", "lineId": "readme", "task": "Start improving README." }
```

Continue it later with the same agent and line id:

```json
{ "agent": "writer", "mode": "continue", "lineId": "readme", "task": "Continue from the last checkpoint." }
```

Rules:

- `continue` must include `lineId`; no default line is selected.
- Only single mode supports `continue` for now.
- Each agent has its own current-branch recent line list.
- Only the latest 3 visible lines per agent in the current parent branch can be continued.
- Parent session tree rollback changes line visibility: lines created after the rollback point are not visible.
- If the worktree changed since the line checkpoint, the child task is prefixed with a warning to re-read relevant files before editing.
- Same `parentSessionId + agent + lineId` calls are locked; concurrent open/continue on the same line fails instead of queueing.
- Copy-on-write continue for child sessions advanced by sibling branches is planned but not implemented yet.

## tools 语法

`tools` 字段支持一种简单的选择表达式，用来控制子 agent 可用的工具。

### 支持的写法

```yaml
tools: "*"
```

表示启用当前运行时可用的全部工具。

```yaml
tools: "*, -bash"
```

表示启用全部工具，但排除 `bash`。

```yaml
tools: "*, -bash, -write, -edit"
```

表示启用全部工具，但排除多个工具。

```yaml
tools: "*, -[bash, write, edit]"
```

表示启用全部工具，但排除一个列表。

```yaml
tools: "read, bash"
```

表示只启用指定工具。

### 说明

- `*` 表示当前运行时全部可用工具
- `-工具名` 表示排除某个工具
- `-[工具1, 工具2, 工具3]` 表示批量排除
- 如果只写负项，例如 `-bash`，会按 `*, -bash` 处理
- YAML 里建议给 `*` 加引号，例如 `"*"`、`"*, -bash"`
- 禁止递归委托可排除 subagent 工具，例如 `tools: "*, -subagent"`

## License

MIT
