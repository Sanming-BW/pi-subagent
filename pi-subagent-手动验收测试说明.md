# pi-subagent 手动验收测试说明

本文档用于指导你在本机手动验证 `pi-subagent` 的新增能力，尤其是：

- `continue` 模式
- `lineId` session 复用
- 当前 branch 最近 3 条 line 规则
- parent session tree rollback 行为
- copy-on-write continue
- worktree drift 提醒
- line 锁
- `tools` 选择表达式

> 当前仓库结构说明：本文档位于仓库根目录。当前 npm 包目录是：
>
> ```bash
> /home/capybarr/Projects/pi-subagent-develop/pi-subagent
> ```

---

## 1. 测试目标

本轮改动的核心目标是让 `subagent` 支持可显式复用的 child session：

```json
{
  "agent": "writer",
  "mode": "spawn",
  "lineId": "readme",
  "task": "Start working on README."
}
```

之后可以通过同一个 `agent + lineId` 继续：

```json
{
  "agent": "writer",
  "mode": "continue",
  "lineId": "readme",
  "task": "Continue working on README."
}
```

需要重点确认：

1. 普通 `spawn` / `fork` 不带 `lineId` 时行为保持原样。
2. `continue` 必须显式指定 `lineId`。
3. 带 `lineId` 的 `spawn` / `fork` 会创建可继续 line。
4. 当前 parent branch 下，每个 agent 独立只保留最近 3 条可见 line。
5. parent session tree 回滚后，line 可见性跟随当前 active branch。
6. child session 被其他 branch 推进后，继续旧 checkpoint 会触发 copy-on-write。
7. 工作区文件变化后继续 line，会提示 subagent 重新读取文件。
8. 同一 `parentSessionId + agent + lineId` 并发 open/continue 会被锁拒绝。
9. `tools` 表达式解析符合预期。

---

## 2. 基础自动验证

先进入包目录：

```bash
cd /home/capybarr/Projects/pi-subagent-develop/pi-subagent
```

执行自动测试：

```bash
node --test
```

期望结果：

```text
pass > 0
fail 0
```

当前预期应类似：

```text
41 pass
0 fail
```

检查 npm 打包内容：

```bash
npm pack --dry-run
```

期望输出中包含以下新增或关键文件：

- `index.ts`
- `runner.ts`
- `runner-events.js`
- `types.ts`
- `line-history.ts`
- `line-lock.ts`
- `session-checkpoint.ts`
- `tool-selection.ts`
- `worktree-fingerprint.ts`
- `render.ts`
- `README.md`

如果准备发布，还可以执行：

```bash
npm publish --dry-run --access public
```

---

## 3. 准备手动测试项目

建议不要直接在真实项目中测试，先创建临时目录：

```bash
mkdir -p /tmp/pi-subagent-manual/.pi/agents
cd /tmp/pi-subagent-manual
```

初始化 git 仓库，用于测试 worktree fingerprint：

```bash
git init
printf "initial\n" > note.txt
git add note.txt
git commit -m "Initial test project"
```

如果 git 提示缺少用户名邮箱，先设置本仓库局部配置：

```bash
git config user.email "test@example.com"
git config user.name "Test User"
git add note.txt
git commit -m "Initial test project"
```

---

## 4. 创建测试 agents

### 4.1 writer agent

```bash
cat > .pi/agents/writer.md <<'EOF'
---
name: writer
description: Test writer agent for subagent continue mode.
tools: "read, bash, edit, write"
---

You are a test writer agent.
When asked to remember something, repeat it exactly in later answers.
Before editing files, always read the file first.
EOF
```

### 4.2 reviewer agent

用于测试每个 agent 独立维护最近 3 条 line：

```bash
cat > .pi/agents/reviewer.md <<'EOF'
---
name: reviewer
description: Test reviewer agent.
tools: "read, bash"
---

You are a test reviewer agent.
EOF
```

---

## 5. 启动本地扩展

在测试项目目录启动 Pi，并加载本地包：

```bash
cd /tmp/pi-subagent-manual
pi -e /home/capybarr/Projects/pi-subagent-develop/pi-subagent
```

期望启动后看到类似提示：

```text
Found 2 subagent(s):
  - writer (project)
  - reviewer (project)
```

如果没有看到 agents：

1. 确认当前目录是 `/tmp/pi-subagent-manual`。
2. 确认 `.pi/agents/writer.md` 和 `.pi/agents/reviewer.md` 存在。
3. 确认 frontmatter 中 `name` / `description` 不为空。

---

## 6. 测试普通 spawn / fork 行为不变

### 6.1 普通 spawn

让主 agent 调用 subagent 工具：

```json
{
  "agent": "writer",
  "mode": "spawn",
  "task": "Reply exactly: spawn ok"
}
```

期望：

- 正常返回 `spawn ok`。
- 不需要 `lineId`。
- 不应登记为可继续 line。

### 6.2 普通 fork

```json
{
  "agent": "writer",
  "mode": "fork",
  "task": "Reply exactly: fork ok"
}
```

期望：

- 正常返回 `fork ok`。
- 不需要 `lineId`。
- 不应登记为可继续 line。

---

## 7. 测试 continue 必须指定 lineId

调用：

```json
{
  "agent": "writer",
  "mode": "continue",
  "task": "Continue something."
}
```

期望报错：

- 明确说明 `mode="continue"` requires `lineId`。
- 不会自动选择最近 line。
- 不会自动新建 line。

---

## 8. 测试 unknown lineId 报错

在尚未创建对应 line 的情况下调用：

```json
{
  "agent": "writer",
  "mode": "continue",
  "lineId": "does-not-exist",
  "task": "Try to continue."
}
```

期望：

- 报错说明当前 branch 下没有该 line，或者它不在最近 3 条可见 line 中。
- 输出当前 branch 下该 agent 可用的最近 line 列表。
- 不会自动新建 line。

---

## 9. 测试创建 line 并 continue

### 9.1 创建可继续 line

```json
{
  "agent": "writer",
  "mode": "spawn",
  "lineId": "memory-test",
  "task": "Remember this exact token: BANANA-123. Reply only: remembered BANANA-123."
}
```

期望：

- 正常完成。
- tool result details 中应记录 line metadata。
- UI 渲染中应能看到类似：

```text
line:memory-test <childSessionId>@<childLeafId>
```

### 9.2 继续该 line

```json
{
  "agent": "writer",
  "mode": "continue",
  "lineId": "memory-test",
  "task": "What exact token did I ask you to remember?"
}
```

期望：

- 能恢复之前的 child session。
- 输出中应包含 `BANANA-123`。
- UI 中仍显示 `line:memory-test` 和 checkpoint 信息。

---

## 10. 测试 fork + lineId

创建一条基于 parent context 的 line：

```json
{
  "agent": "writer",
  "mode": "fork",
  "lineId": "fork-memory",
  "task": "Remember this fork token: FORK-456. Reply only: remembered FORK-456."
}
```

继续：

```json
{
  "agent": "writer",
  "mode": "continue",
  "lineId": "fork-memory",
  "task": "What fork token do you remember?"
}
```

期望：

- 返回中包含 `FORK-456`。
- 说明 `fork` 带 `lineId` 也会登记为可继续 checkpoint。

---

## 11. 测试最近 3 条规则

连续创建 4 条 `writer` line：

```json
{ "agent": "writer", "mode": "spawn", "lineId": "line-1", "task": "Reply exactly: line 1" }
```

```json
{ "agent": "writer", "mode": "spawn", "lineId": "line-2", "task": "Reply exactly: line 2" }
```

```json
{ "agent": "writer", "mode": "spawn", "lineId": "line-3", "task": "Reply exactly: line 3" }
```

```json
{ "agent": "writer", "mode": "spawn", "lineId": "line-4", "task": "Reply exactly: line 4" }
```

尝试继续最旧的 `line-1`：

```json
{
  "agent": "writer",
  "mode": "continue",
  "lineId": "line-1",
  "task": "Continue line 1."
}
```

期望：

- `line-1` 被拒绝。
- 报错列表中应该包含最近 3 条：
  - `line-4`
  - `line-3`
  - `line-2`
- 不应该包含 `line-1`。

继续最新 line：

```json
{
  "agent": "writer",
  "mode": "continue",
  "lineId": "line-4",
  "task": "Continue line 4. Reply exactly: continued line 4"
}
```

期望：

- 成功继续。
- 输出 `continued line 4`。

---

## 12. 测试每个 agent 独立计数

创建 reviewer 的 3 条 line：

```json
{ "agent": "reviewer", "mode": "spawn", "lineId": "review-1", "task": "Reply exactly: review 1" }
```

```json
{ "agent": "reviewer", "mode": "spawn", "lineId": "review-2", "task": "Reply exactly: review 2" }
```

```json
{ "agent": "reviewer", "mode": "spawn", "lineId": "review-3", "task": "Reply exactly: review 3" }
```

然后继续 writer 的最近 line，例如：

```json
{
  "agent": "writer",
  "mode": "continue",
  "lineId": "line-4",
  "task": "Reply exactly: writer still available"
}
```

期望：

- reviewer 的 line 不会挤掉 writer 的最近 3 条。
- 每个 agent 独立计算最近 3 条。

---

## 13. 测试 parent session tree rollback

这个测试需要使用 Pi 的 `/tree`。

### 13.1 创建 rollback line

```json
{
  "agent": "writer",
  "mode": "spawn",
  "lineId": "rollback-test",
  "task": "Remember rollback token ROLL-1. Reply exactly: remembered ROLL-1."
}
```

### 13.2 确认可继续

```json
{
  "agent": "writer",
  "mode": "continue",
  "lineId": "rollback-test",
  "task": "What rollback token do you remember?"
}
```

期望返回 `ROLL-1`。

### 13.3 回滚 parent tree

在 Pi 中执行：

```text
/tree
```

选择回到创建 `rollback-test` 之前的节点。

### 13.4 再尝试 continue

```json
{
  "agent": "writer",
  "mode": "continue",
  "lineId": "rollback-test",
  "task": "Try to continue rollback-test."
}
```

期望：

- 报错当前 branch 下不存在该 line。
- 说明 line 可见性跟随当前 active branch。

---

## 14. 测试 copy-on-write continue

copy-on-write 用来避免 sibling parent branch 推进 child session 后，旧 branch 继续时污染同一个 child session。

推荐流程：

### 14.1 创建 line

```json
{
  "agent": "writer",
  "mode": "spawn",
  "lineId": "cow-test",
  "task": "Remember checkpoint C0. Reply exactly: C0."
}
```

### 14.2 继续一次，让 child session 前进

```json
{
  "agent": "writer",
  "mode": "continue",
  "lineId": "cow-test",
  "task": "Advance this line and remember checkpoint C1. Reply exactly: C1."
}
```

### 14.3 回到旧 parent checkpoint

用 `/tree` 回到第 14.1 步之后、第 14.2 步之前的 parent 节点。

### 14.4 从旧 checkpoint 再继续

```json
{
  "agent": "writer",
  "mode": "continue",
  "lineId": "cow-test",
  "task": "Continue from the visible old checkpoint. Reply exactly: safe continue."
}
```

期望：

- 不直接复用已经被 sibling branch 推进过的 child head。
- 自动 materialize 一个新的 child session。
- UI 中应看到 `copy-on-write` 标记。
- 当前 branch 的 `cow-test` line 应指向新的 child checkpoint。

---

## 15. 测试 worktree drift warning

### 15.1 创建 drift line

```json
{
  "agent": "writer",
  "mode": "spawn",
  "lineId": "drift-test",
  "task": "Read note.txt and remember its content. Reply with the content."
}
```

期望返回 `initial`。

### 15.2 修改工作区

在另一个 shell 中执行：

```bash
cd /tmp/pi-subagent-manual
printf "changed after checkpoint\n" > note.txt
```

不要提交。

### 15.3 继续 drift line

回到 Pi，调用：

```json
{
  "agent": "writer",
  "mode": "continue",
  "lineId": "drift-test",
  "task": "Append the line 'from drift test' to note.txt."
}
```

期望：

- UI/render 中出现 worktree drift warning。
- child task 被注入提醒：不要依赖旧记忆，应重新读取相关文件。
- agent 应该先读取 `note.txt`，再编辑。

检查文件：

```bash
cat /tmp/pi-subagent-manual/note.txt
```

期望包含：

```text
changed after checkpoint
from drift test
```

---

## 16. 测试 line 锁

自动测试已经覆盖 line lock 核心逻辑。手动测试可选。

如果要手动测试：

1. 开两个 Pi 实例，尽量加载同一个 parent session。
2. 同时对同一个 `agent + lineId` 调用 `continue`。
3. 例如两个窗口都调用：

```json
{
  "agent": "writer",
  "mode": "continue",
  "lineId": "memory-test",
  "task": "Wait a bit, then reply."
}
```

期望：

- 一个成功运行。
- 另一个失败，类似：

```text
Subagent line is already running
```

注意：如果任务完成太快，很难撞上并发锁。可以让其中一个任务执行较慢的操作，例如让 agent 用 `bash` 执行 `sleep 10`。

---

## 17. 测试 tools 表达式

下面测试需要在 `/tmp/pi-subagent-manual/.pi/agents` 创建额外 agents，然后重启 Pi。

### 17.1 tools: "*"

```bash
cat > .pi/agents/alltools.md <<'EOF'
---
name: alltools
description: Agent with all tools.
tools: "*"
---

You can use all tools.
EOF
```

调用：

```json
{
  "agent": "alltools",
  "task": "Run bash pwd and report the result."
}
```

期望：

- `bash` 可用。
- 能返回当前目录。

### 17.2 tools: "-bash"

```bash
cat > .pi/agents/nobash.md <<'EOF'
---
name: nobash
description: Agent without bash.
tools: "-bash"
---

Bash should not be available to you.
EOF
```

调用：

```json
{
  "agent": "nobash",
  "task": "Try to run bash pwd."
}
```

期望：

- `bash` 不在子 agent 可用工具中。
- agent 不应成功调用 bash。

### 17.3 tools: "*, -[bash, write, edit]"

```bash
cat > .pi/agents/readonly.md <<'EOF'
---
name: readonly
description: Read-only-ish agent.
tools: "*, -[bash, write, edit]"
---

You should be able to read files, but not bash/write/edit.
EOF
```

调用：

```json
{
  "agent": "readonly",
  "task": "Read note.txt, then try to edit it."
}
```

期望：

- 可以读取文件。
- 不应该能使用 `bash` / `write` / `edit`。

### 17.4 tools: ""

```bash
cat > .pi/agents/notools.md <<'EOF'
---
name: notools
description: Agent with explicit empty tool set.
tools: ""
---

You have no tools.
EOF
```

调用：

```json
{
  "agent": "notools",
  "task": "Try to read note.txt."
}
```

期望：

- 子 agent 以 `--no-tools` 启动。
- 不应回退到父级默认工具。
- 不能读取 `note.txt`。

### 17.5 tools: "*, -subagent"

用于禁止递归委托：

```bash
cat > .pi/agents/nodelegate.md <<'EOF'
---
name: nodelegate
description: Agent that cannot delegate to subagents.
tools: "*, -subagent"
---

You should not have access to the subagent tool.
EOF
```

调用：

```json
{
  "agent": "nodelegate",
  "task": "Try to delegate work to another subagent."
}
```

期望：

- `subagent` 工具不应出现在该 child agent 可用工具中。
- 不应发生递归委托。

---

## 18. 常见问题排查

### 18.1 没发现 project agents

检查：

```bash
pwd
find .pi/agents -maxdepth 1 -type f -name '*.md' -print
```

确认你是在 `/tmp/pi-subagent-manual` 启动 Pi。

### 18.2 continue 报 checkpoint missing childSessionFile

可能原因：

- 该 line 是旧版本创建的，没有记录 child session file。
- child session 文件被删除。

处理：

- 用同一个 `lineId` 重新 `spawn` 或 `fork` 创建 checkpoint。

### 18.3 copy-on-write 没出现

可能原因：

- 没有真正回滚 parent tree。
- child session 当前 head 没有越过当前 branch 可见 checkpoint。

建议重新按第 14 节步骤测试，尤其确认 `/tree` 回到了第二次 continue 之前。

### 18.4 worktree drift 没出现

可能原因：

- 创建 line 后工作区没有变化。
- 测试目录不是 git 仓库。
- 文件变化刚好没有影响 `git status` / `git diff`。

检查：

```bash
cd /tmp/pi-subagent-manual
git status --porcelain
git diff
```

如果两者都为空，则 drift 不会触发。

---

## 19. 推荐最小手动验收清单

如果时间有限，至少做以下 6 项：

1. `spawn` / `fork` 不带 `lineId` 正常。
2. `continue` 缺 `lineId` 正确报错。
3. 带 `lineId` 的 `spawn` 可以被 `continue`。
4. 最近 3 条规则正确拒绝 older-than-3 line。
5. worktree drift 会产生 warning 并要求重新读取文件。
6. `tools: ""` 确实让子 agent 无工具，不回退到父级默认工具。

如果要完整验收，再追加：

7. `/tree` rollback 后 line 可见性变化。
8. copy-on-write continue 出现 `copy-on-write` 标记。
9. `tools: "*, -subagent"` 禁止递归委托。
10. npm dry-run 确认发布文件完整。

---

## 20. 清理测试目录

测试完成后可删除临时目录：

```bash
rm -rf /tmp/pi-subagent-manual
```
