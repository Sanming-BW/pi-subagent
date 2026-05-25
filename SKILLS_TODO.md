# Skills TODO

## Phase 1: Add `skills.ts`

- [ ] 新增 `skills.ts`，集中实现本地 skill discovery、resolution、reading、injection 和 cache。
- [ ] 实现 `normalizeSkillInput`，支持 `string`、`string[]`、JSON array string、`false` 和 `undefined`。
- [ ] 实现 `discoverAvailableSkills`，扫描项目、用户和 package 来源。
- [ ] 实现 `resolveSkillPath`，根据 skill name 解析具体 skill 文件。
- [ ] 实现 `resolveSkills`，返回 `resolved` 和 `missing`。
- [ ] 实现 `resolveSkillsWithFallback`，保持与 Pi 核心 fallback 语义一致。
- [ ] 实现 `readSkill`，读取 markdown 内容并返回 `name`、`path`、`source`、`content`。
- [ ] 实现 `stripSkillFrontmatter`，注入前移除 YAML frontmatter。
- [ ] 实现 `buildSkillInjection`，生成 `<skill name="...">...</skill>` prompt 片段。
- [ ] 实现 `clearSkillCache`，供 tests 和调试使用。
- [ ] 实现 discovery cache：key 为 `cwd + agentDir`，TTL 为 5s。
- [ ] 实现 content cache：key 为 `path + mtime`，最多 50 条。
- [ ] 确保 `pi-subagents` 被识别为 reserved skill，并阻止传递给 child subagents。

## Phase 2: Agent config parsing

- [ ] 更新 `agents.ts`，从 agent markdown frontmatter 中解析 `skills`。
- [ ] 支持 `skill` 作为 `skills` 的 singular alias。
- [ ] 支持 `skills` 为 comma-separated string。
- [ ] 支持 `skills` 为 string array。
- [ ] 支持 `skills: false` 表示禁用 agent 默认 skills。
- [ ] 更新 `agents.ts`，解析 `inheritSkills`，默认 `false`。
- [ ] 保持现有 tools/frontmatter 解析行为不回归。
- [ ] 更新 `AgentConfig`，使 `agent.skills` 和 `agent.inheritSkills` 可被 `runner.ts` 使用。
- [ ] 添加 agent frontmatter parsing tests，覆盖有 skills、无 skills、空 skills、`skill` alias 和 `inheritSkills`。

## Phase 3: Tool schema/argument normalization

- [ ] 更新 `index.ts` 的 single tool schema，增加可选 `skills` 参数。
- [ ] 明确 `options.skills ?? agent.skills ?? []` 的覆盖语义。
- [ ] 支持 `skills: false` 显式禁用 agent 默认 skills。
- [ ] 支持 `skills: []` 显式禁用 agent 默认 skills。
- [ ] 使用 shared normalization，避免在 `index.ts` 中复制 skill 清洗逻辑。
- [ ] 为 single path 建立小 helper，把 tool 参数转换为 `RunAgentOptions`。
- [ ] 保持 single vs parallel shape validation 不回归。
- [ ] 确保无 `skills` 参数时现有行为保持兼容。
- [ ] 为参数 normalization 增加 tests。

## Phase 4: Runner injection

- [ ] 更新 `runner.ts` 的 `RunAgentOptions`，加入可选 `skillOverride?: string[] | false`。
- [ ] 在 `runAgent` 附近计算 effective skills，保持 skill resolution 接近实际 child prompt 构造。
- [ ] 调用 `resolveSkillsWithFallback` 解析 effective skills。
- [ ] 调用 `buildSkillInjection` 构造 prompt injection。
- [ ] 把 skill injection 拼接到 child system prompt。
- [ ] 缺失 skill 生成 `skillsWarning`，并写入 result details。
- [ ] `pi-subagents` 生成明确错误或 blocked warning。
- [ ] 不把完整 skill body 写入 result metadata。
- [ ] 保持 child `pi` CLI args 构造逻辑不回归。
- [ ] 添加 runner injection tests，验证 prompt 中包含 `<skill name="...">` 且不含 frontmatter。

## Phase 5: CLI inheritance/isolation

- [ ] 检查 `runner-cli.js` 当前是否会把 parent `--skill` / `--no-skills` 透传给 child。
- [ ] 将 inherited skill CLI flags 与其他 proxy args 分离。
- [ ] 默认 `inheritSkills: false` 时，不继承 parent `--skill` args，并给 child 加 `--no-skills`。
- [ ] `inheritSkills: true` 时，允许继承 parent skill CLI flags。
- [ ] 确认 `--no-skills` 不能单独作为隔离保证，因为显式 `--skill` 可能仍会加载。
- [ ] 确认 `pi-subagents` 不会通过 CLI inheritance 进入 child subagent。
- [ ] 如需新增 CLI 参数，保持最小化并记录在 `README.md`。
- [ ] 添加 isolation tests 或 manual validation，确认 child prompt 可预测。

## Phase 6: Rendering/types

- [ ] 更新 `types.ts`，为 `SingleResult` 增加 `skills?: string[]`。
- [ ] 更新 `types.ts`，为 `SingleResult` 增加 `skillsWarning?: string`。
- [ ] 如需要更完整 metadata，再增加 `skillDetails` 或类似结构。
- [ ] 更新 `render.ts`，展示 missing skill warnings。
- [ ] 更新 `render.ts`，展示 blocked skill warnings。
- [ ] 更新 `render.ts`，用简短摘要展示 resolved skills。
- [ ] 确保 render 不输出完整 skill body。
- [ ] 确保 JSON result 和 TUI render 信息一致。
- [ ] 添加 render tests 或 snapshot tests。

## Phase 7: Tests

- [ ] 新增 `test/skills.test.mjs` 覆盖 `skills.ts` discovery conventions。
- [ ] 测试 `directory/SKILL.md -> directory basename`。
- [ ] 测试 direct `*.md -> file basename`。
- [ ] 测试 YAML frontmatter description 解析。
- [ ] 测试 `stripSkillFrontmatter` 注入前移除 frontmatter。
- [ ] 测试 priority：project paths 高于 user paths。
- [ ] 测试 package discovery：`package.json` 中的 `pi.skills[]`。
- [ ] 测试 dedup：高优先级 wins，同级 earliest discovery wins。
- [ ] 测试 discovery cache TTL 和 `clearSkillCache`。
- [ ] 测试 content cache 使用 `path + mtime`，并限制最多 50 条。
- [ ] 测试 `options.skills ?? agent.skills ?? []` 覆盖语义。
- [ ] 测试 `skills: false` 和 `skills: []` 显式禁用默认 skills。
- [ ] 测试 missing skill warning。
- [ ] 测试 `pi-subagents` blocked。
- [ ] 测试 `runner.ts` prompt injection 格式。
- [ ] 测试 `index.ts` single 参数 schema 与 validation。
- [ ] 后续在 parallel 决策完成后补充 per-task skills tests。

## Phase 8: README/docs

- [ ] 更新 `README.md`，说明 agent frontmatter 中的 `skills`。
- [ ] 更新 `README.md`，说明 `inheritSkills`，默认 `false`。
- [ ] 更新 `README.md`，说明 tool 参数中的 `skills` 覆盖 agent 默认配置。
- [ ] 记录 `skills: false` / `skills: []` 表示显式禁用默认 skills。
- [ ] 记录 skill discovery paths 和优先级概要。
- [ ] 记录 reserved skill：`pi-subagents` 不会传递给 child subagents。
- [ ] 记录 missing skill warning 行为。
- [ ] 添加最小示例：agent markdown frontmatter 使用 `skills`。
- [ ] 添加最小示例：single tool call 使用 `skills` override。
- [ ] 更新 `package.json`，如有 `files` 白名单则加入 `skills.ts`。
- [ ] 确认 npm package 发布内容包含新增 `skills.ts` 或编译产物。

## Phase 9: Manual validation

- [ ] 运行 `npm install`。
- [ ] 运行现有 test suite。
- [ ] 如尚无 test script，至少运行 TypeScript/build/lint 相关检查。
- [ ] 运行 `npm pack --dry-run`，确认发布内容正确。
- [ ] 运行 `npm publish --dry-run --access public`，确认 npm 发布预检通过。
- [ ] 使用 `pi -e .` 手动加载本地 extension。
- [ ] 创建项目级 `.agents/skills/example/SKILL.md`，验证 single subagent 可注入。
- [ ] 创建同名 user skill，验证 project skill 优先。
- [ ] 使用带 frontmatter 的 skill，验证 frontmatter 不进入 prompt。
- [ ] 请求缺失 skill，验证 warning 可见。
- [ ] 请求 `pi-subagents`，验证 blocked 行为。
- [ ] 使用 agent frontmatter skills，验证默认生效。
- [ ] 使用 tool 参数 `skills`，验证覆盖 agent 默认值。
- [ ] 使用 `skills: false` / `skills: []`，验证不注入 agent 默认 skills。

## Phase 10: Parallel follow-up/open questions

- [ ] 等 parallel handling 决策完成后，再最终确定 `tasks[]` 中 per-task `skills` 的 schema。
- [ ] 保持 parallel-specific skill plumbing 为待协调事项，不在当前阶段声明为完成。
- [ ] 设计 shared helper 构造 `RunAgentOptions`，供 `executeSingle` 和 `executeParallel` 复用。
- [ ] 确保 single 与 per-task parallel item 的 skill override 语义一致。
- [ ] 避免在 `executeSingle` 和 `executeParallel` 中复制 normalization 逻辑。
- [ ] 保持 skill resolution near `runAgent`，让 single 和 parallel 最终都走同一 resolution 入口。
- [ ] 确认 parallel task-level `skills` 是否覆盖 agent defaults。
- [ ] 确认 parallel 是否需要 batch-level shared `skills`。
- [ ] 确认 batch-level `skills` 与 per-task `skills` 同时存在时的优先级。
- [ ] 决策完成后补充 parallel tests，覆盖 per-task symmetry。
- [ ] 更新 `README.md` parallel 示例，避免与 single 语义不一致。
