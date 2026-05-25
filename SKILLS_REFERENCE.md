# Skills Reference

## Overview

本文记录本仓库计划实现的本地 skill 管理行为，用于让 `pi-subagent` 在启动子 subagent 时，能够按 Pi 的常见约定解析、加载并注入 skills。

目标：

- 在 `runAgent` 附近完成 skill 解析和 prompt 注入。
- 与 `/tmp/pi-subagents/src/agents/skills.ts` 的行为尽量保持兼容。
- 支持 agent frontmatter、tool 参数覆盖、项目级和用户级 skill 搜索路径。
- 保持 single 与 parallel 调用的 skill 语义一致。

核心参考函数：

- `normalizeSkillInput`
- `resolveSkills`
- `resolveSkillsWithFallback`
- `resolveSkillPath`
- `readSkill`
- `stripSkillFrontmatter`
- `buildSkillInjection`
- `discoverAvailableSkills`
- `clearSkillCache`

## Why local resolver is needed

当前仓库通过 `runner.ts` 中的 `runAgent` 启动子 `pi` CLI 进程，并手动构造 child system prompt。由于 Pi 没有暴露“按 skill 名称解析完整 skill 内容”的 API，本扩展需要在本地完成 skill resolution，并把已解析的 skill 内容显式注入到子 agent 的 system prompt。

本地 resolver 的必要性：

- 子 subagent 需要可重复、可解释的 skill 注入行为。
- tool 参数中的 `skills` 需要覆盖 agent 默认配置。
- 缺失 skill 需要在结果或 metadata 中提示，而不是静默忽略。
- `pi-subagents` 作为保留 skill 不应传递给子 subagents。
- single 与 parallel 调用应共享同一套解析规则，避免行为漂移。

## Skill file conventions

Skill 文件发现规则与 Pi 核心保持一致：

| 形式 | Skill name | 内容来源 |
| --- | --- | --- |
| `directory/SKILL.md` | `directory` 的 basename | `SKILL.md` |
| `*.md` 文件 | 文件 basename，不含 `.md` | 该 markdown 文件 |

示例：

```text
.agents/skills/playwright-cli/SKILL.md -> playwright-cli
.agents/skills/code-review.md          -> code-review
```

Skill markdown 可以包含 YAML frontmatter：

```markdown
---
description: Automate browser interactions.
---

# Playwright CLI

...
```

注入到 system prompt 前，应移除 YAML frontmatter，只保留正文。

## Discovery/search paths and priority table

Skill 搜索应按优先级从高到低进行。高优先级命中会覆盖低优先级同名 skill。

| Priority | Source | Path / Mechanism | Notes |
| ---: | --- | --- | --- |
| 700 | `project` | `<cwd>/.pi/skills`, `<cwd>/.agents/skills` | 项目级 skills |
| 650 | `project-settings` | `<cwd>/.pi/settings.json` 的 `skills[]` | 项目显式配置 |
| 600 | `project-package` | `<cwd>/.pi/npm/node_modules` 中 package `package.json` 的 `pi.skills[]` | 项目本地安装的 skill packages |
| 300 | `user` | `~/.pi/agent/skills`, `~/.agents/skills` | 用户级 skills |
| 250 | `user-settings` | `~/.pi/agent/settings.json` 的 `skills[]` | 用户显式配置 |
| 200 | `user-package` | `~/.pi/agent/npm/node_modules`, `npm root -g` 中 package `package.json` 的 `pi.skills[]` | 用户/全局 packages |
| 150 | `extension` | reserved | 预留 |
| 100 | `builtin` | reserved | 预留 |

实现时应保留 source 信息，便于 metadata、debug、warning 和 render 展示。

## Deduplication

同名 skill 的去重规则：

1. 最高优先级 wins。
2. 同一优先级内，最早 discovery 的结果 wins。
3. 后续同名结果应被忽略。

示例：

```text
project .agents/skills/playwright-cli/SKILL.md
user ~/.agents/skills/playwright-cli/SKILL.md
```

最终应选择 project 版本。

## Frontmatter/content handling

读取 skill 时应执行以下处理：

1. 读取 markdown 文件内容。
2. 解析可选 YAML frontmatter。
3. 提取 `description`，用于 discovery metadata。
4. 调用 `stripSkillFrontmatter` 移除 frontmatter。
5. 对正文做最小必要 trim，避免注入空白噪声。
6. 保留原文件路径、mtime 和解析后的 name/source。

frontmatter 仅作为 metadata，不应注入到 child prompt。

## Input normalization

`normalizeSkillInput` 应把 tool 参数、agent config 或内部调用中的 skill 输入规范化为统一结构。

建议支持：

- `undefined`：不覆盖，继续使用 agent 默认值。
- `false`：显式禁用 skills。
- `string`：单个 skill，或逗号分隔列表。
- `string[]`：多个 skills。
- JSON array string：例如 `'["research","audit"]'`。

规范化目标：

- trim 空白。
- 去重。
- 过滤空值。
- 保持输入顺序，便于 warning 和 prompt injection 可预测。
- `true` 不建议表示启用默认值；应视为 `undefined` 或无效输入，具体由 schema 决定。

## Effective skill resolution

有效 skill 列表来源：

```ts
const effectiveSkills = options.skills ?? agent.skills ?? [];
```

语义：

- `options.skills` 存在时，覆盖 agent frontmatter 中的 `skills`。
- `options.skills` 不存在时，使用 agent frontmatter 中的 `skills`。
- 两者都不存在时，不注入额外 skills。
- `skills: false` 或 `skills: []` 表示显式禁用 agent 默认 skills。

解析流程：

1. 从 `runAgent` 接收 `RunAgentOptions`。
2. 计算 `effectiveSkills`。
3. 调用 `resolveSkillsWithFallback`。
4. 收集 resolved skills 与 missing skills。
5. 对 resolved skills 调用 `readSkill`。
6. 调用 `buildSkillInjection` 生成 prompt 片段。
7. 拼接到 child system prompt。
8. 把 resolved/missing metadata 写入 result details。

## Prompt injection format

Skill 内容应以稳定 XML-like 格式注入 system prompt：

```xml
<skill name="playwright-cli">
...skill body without frontmatter...
</skill>
```

多个 skills 按有效输入顺序注入：

```xml
<skill name="skill-a">
...
</skill>

<skill name="skill-b">
...
</skill>
```

要求：

- 注入内容不包含 YAML frontmatter。
- `name` 使用解析后的 canonical skill name。
- 缺失 skill 不生成空标签。
- reserved skill 不应注入。
- 如没有 resolved skills，不添加空 section。

## Reserved skills

`pi-subagents` 是保留 skill。

规则：

- 不传递给 child subagents。
- 如果用户或 agent 配置显式请求 `pi-subagents`，应 fail 或 blocked。
- blocked 信息应出现在 warning 或 result metadata 中。
- 不应尝试从磁盘读取或注入 `pi-subagents`。

原因：

- 防止子 subagent 再次获得 orchestration skill，导致递归、循环或权限扩大。
- 与 `/tmp/pi-subagents` 的行为保持一致。

## Caching

本地 resolver 应实现轻量缓存，匹配 Pi 核心行为：

| Cache | Key | Policy |
| --- | --- | --- |
| Discovery cache | `cwd + agentDir` | TTL 5s |
| Content cache | `path + mtime` | 最多 50 条 |

建议函数：

- `discoverAvailableSkills`
- `readSkill`
- `clearSkillCache`

缓存要求：

- 文件 mtime 变化时内容缓存失效。
- discovery cache TTL 到期后重新扫描。
- tests 可调用 `clearSkillCache` 保证隔离。
- 不缓存 blocked/reserved 注入结果为成功结果。

## Integration points in this repository

当前仓库主要文件职责：

| File | Current role | Planned skill integration |
| --- | --- | --- |
| `index.ts` | 注册 `subagent` tool，校验 single vs parallel 参数，调用 `executeSingle` / `executeParallel` | 解析 tool-level `skills` 参数；使用共享 normalization；传入 `RunAgentOptions` |
| `agents.ts` | 解析 agent markdown frontmatter 和 tools 配置 | 解析 agent-level `skills` / `inheritSkills` frontmatter |
| `runner.ts` | `runAgent` 构造 child `pi` CLI args、system prompt，spawn 子进程并解析 JSON events | 在 `runAgent` 附近完成 effective skill resolution、prompt injection、warnings |
| `runner-cli.js` | 子进程 CLI 参数继承/过滤 | 防止 parent `--skill` 泄漏；按 `inheritSkills` 决定是否继承 |
| `types.ts` | 定义 `SingleResult`、`SubagentDetails` 等共享类型 | 增加 skill resolved/missing/blocked metadata |
| `render.ts` | 渲染 tool call/result | 展示 skill warning、missing、blocked 或 resolved 摘要 |
| `README.md` | 用户文档 | 说明 agent frontmatter 和 tool 参数中的 skills 用法 |
| `package.json` | 包配置 | 若有 files 白名单，加入 `skills.ts` |
| `test/` | 测试目录 | 增加 resolver、runner injection、render metadata 测试 |

建议新增：

```text
skills.ts
```

该文件承载 discovery、normalization、resolution、reading、injection 和 cache helper。

## Result/render metadata

`runAgent` 和 tool result 应携带足够的 skill metadata，便于 debugging 与 render。

建议 metadata：

```ts
interface SkillResolutionMetadata {
  requested: string[];
  resolved: Array<{
    name: string;
    path: string;
    source: string;
  }>;
  missing: string[];
  blocked: string[];
  warnings: string[];
}
```

展示原则：

- 成功解析的 skills 可简短展示。
- `missing` 应显示 warning。
- `blocked` 应显示明确错误或 warning，尤其是 `pi-subagents`。
- 不把完整 skill body 放入 result metadata，避免输出过长。
- JSON result 与 TUI render 应保持信息一致。

## Parallel considerations

当前仓库已有 single 与 parallel 两条路径：

- `index.ts` 中的 `executeSingle`
- `index.ts` 中的 `executeParallel`
- parallel 使用 `tasks[]` 和 `mapConcurrent`
- 每个 parallel task 最终也会调用 `runAgent`

计划原则：

- parallel-specific skill plumbing 暂作为待协调事项，不在本阶段过度实现。
- single 与 per-task parallel item 应共享 skill override 语义。
- 推荐通过共享 normalization 和一个小 helper 构造 `RunAgentOptions`，避免复制逻辑。
- 一旦 parallel 参数结构最终确定，per-task `skills` 应与 single `skills` 对称。
- `runAgent` 应尽量保持最终 resolution 入口，确保 single 和 parallel 行为自然一致。

## Compatibility notes

实现应优先兼容 Pi 核心行为：

- 遵循 `/tmp/pi-subagents/src/agents/skills.ts` 的 discovery conventions。
- 保持 priority、dedup、frontmatter stripping、cache policy 一致。
- 保留 `resolveSkillsWithFallback` 的 fallback 语义。
- 不把 `pi-subagents` 注入 child subagents。
- 缺失 skills 产生 warning，而不是静默失败。
- `skills: false` 或 `skills: []` 表示显式禁用 agent 默认 skills。
- 路径、package 和 settings 行为应尽量与 Pi 保持一致，避免用户在主 Pi 与 `pi-subagent` 中看到不同结果。
