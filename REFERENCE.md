# 参考文档：subagent viewer 重构为 active-agent live activity tree

本文档描述当前行为、目标架构、关键文件与函数、建议数据模型、事件流、合并/去重策略、已知限制和测试策略，供实现“Session 下以 active-agent turn 为第一层、subagent 作为其子节点”的重构使用。

## 1. 背景与目标

### 当前问题
现有 viewer 更偏向把 subagent 作为 Session 的主要一层节点来展示，active-agent 的一次次响应轮次没有被显式建模或未成为树的第一层语义中心。这会导致：
- 用户很难快速看出“当前是谁在响应用户消息”。
- active-agent 的每次新响应轮次不容易和上一轮区分开。
- subagent 的出现与归属可能与 active-agent 的实时生命周期脱节。
- 流式更新和重复事件下容易产生错位、重复或状态不一致。

### 目标行为
1. `Session` 下的第一层节点应是 active-agent 的运行/轮次（turn），而不是 subagent。
2. active-agent 每次开始响应一个用户消息时，应创建一个新的 sibling turn 节点。
3. 当前 active-agent turn 必须在 UI 上显示 running / thinking / hourglass 等进行中状态。
4. active-agent 触发 subagent 时，subagent 应立即挂到对应 turn 之下，并在状态变化时实时更新。

## 2. 当前行为的抽象理解

> 说明：以下描述的是当前实现中常见的结构性行为抽象，具体细节以仓库中的实际代码为准。

### 常见现状
- Session 可能是树的根容器，但第一层展示往往被 subagent 或工具调用节点“抢占语义中心”。
- active-agent 的一轮响应可能只表现为某种消息/事件流的一段，而不是独立 turn 节点。
- subagent 的创建与更新可能通过通用节点插入逻辑直接挂在根或不稳定位置。
- 渲染层可能主要依据节点类型和状态字段决定外观，而不是依据“turn / child”层级语义。

### 现有痛点
- 无法天然表达“同一个 active-agent 在不同用户消息下的多轮响应”。
- 新一轮 active-agent 可能被误认为是旧节点的延续。
- subagent 与其父 active-agent 的因果关系需要从上下文中推测，缺少显式结构。

## 3. 目标架构

### 3.1 树形语义
建议采用三层核心语义：
- **Session**：会话容器，保存全局上下文与顶层轮次列表。
- **ActiveAgentTurn**：一次 active-agent 对用户消息的响应轮次，是 Session 的一级子节点。
- **SubagentNode**：active-agent 在该轮次中触发的子代理运行节点，是 turn 的二级或更深层子节点。

结构示意：

```text
Session
├─ ActiveAgentTurn #1  (running / done / failed)
│  ├─ Subagent A
│  ├─ Subagent B
│  └─ Tool/aux nodes (如有)
├─ ActiveAgentTurn #2
│  └─ Subagent C
└─ ActiveAgentTurn #3
```

### 3.2 核心原则
- **第一层语义固定为 turn**：Session 下面永远先表达“轮次”，再表达轮次内的子结构。
- **追加而非复用**：新用户消息触发的新响应应产生新 turn，而非复用旧 turn。
- **即时挂载**：子节点一旦出现，应立即归属到正确的 turn。
- **幂等更新**：同一节点的事件可以多次到达，但树结构不应因此膨胀。
- **状态单向推进**：默认只允许状态向前推进，避免无端回退。

## 4. 相关文件与职责

> 下面按仓库约定的文件划分职责；如果实际函数名略有不同，应优先按“职责”定位。

### `index.ts`
- 插件/扩展入口。
- 负责注册工具、导出能力、连接各层处理逻辑。
- 可能包含 viewer 相关命令、事件订阅或状态入口。
- 重构时应关注：是否需要新增 turn 级别的事件类型或渲染入口。

### `agents.ts`
- 负责 agent 发现、解析、识别。
- 需要区分 active-agent 与 subagent 的身份、角色、名称、层级。
- 重构时可能需要新增辅助判断：
  - 当前事件是否属于 active-agent turn 的开始/结束。
  - 当前节点是否应作为 turn 节点创建。

### `runner.ts`
- 负责 subagent 进程执行、启动、结束和结果回传。
- 很可能是 subagent 节点状态变化的主要事件源。
- 需要确保 runner 发出的事件能携带稳定 ID、父 turn 线索和状态更新。

### `render.ts`
- 负责 TUI 渲染和节点展示。
- 需要实现新的层级视觉：Session -> turn -> subagent。
- 需要在 running 的 turn 上显示 hourglass / loading / thinking 状态。
- 需要支持子节点实时插入和局部刷新，减少整树抖动。

### `types.ts`
- 定义共享类型、枚举与辅助函数。
- 应新增或调整与 turn、node、event、status、parent relation 相关的类型。
- 建议把“状态优先级”“节点身份”“事件类型”等基础语义集中定义在这里。

### `README.md`
- 用户文档。
- 如果行为对用户可见，应同步更新使用说明、概念解释和示意图。

## 5. 建议数据模型

下面是推荐的概念模型，可按项目现状拆分为具体接口。

### 5.1 节点身份
#### `NodeKind`
建议至少包含：
- `session`
- `active-agent-turn`
- `subagent`
- `tool` / `auxiliary`（如项目中已有）

### 5.2 通用节点字段
建议所有树节点具备：
- `id`: 稳定唯一标识
- `kind`: 节点类型
- `name` / `label`: 展示名
- `status`: `pending | running | streaming | done | failed | cancelled` 等
- `createdAt` / `startedAt` / `endedAt`
- `parentId`
- `childrenIds`
- `sourceEventIds` 或 `revision`
- `orderKey`：用于稳定排序
- `sessionId`

### 5.3 ActiveAgentTurn 专属字段
- `turnIndex`：Session 内第几轮 active-agent 响应
- `userMessageId`：该轮响应对应的用户消息
- `previousTurnId`：前一轮 sibling turn，便于串联
- `current` / `isCurrent`: 是否为正在运行的当前 turn
- `summary` / `preview`（可选）
- `streamingText`（如有流式输出）

### 5.4 SubagentNode 专属字段
- `parentTurnId`: 所属 active-agent turn
- `triggerReason`：为何被触发（如“工具请求”“并行分工”等）
- `runnerState`：runner 层实际状态
- `inheritance` 信息（可选）：可用于展示与父 turn 的关联

### 5.5 状态映射建议
建议将渲染状态与执行状态分离：
- **执行状态**：后端/事件源真实状态
- **展示状态**：UI 上的映射状态

推荐规则：
- 只要 turn 尚未收到明确结束事件，即保持 `running` 或 `streaming`。
- 子节点在创建后先显示 `pending/running`，收到完成事件后再变为 `done`。
- 失败/取消状态优先级高于普通完成态。

## 6. 事件流设计

### 6.1 典型流程
1. 用户发送消息。
2. active-agent 开始处理该用户消息。
3. viewer 创建一个新的 `ActiveAgentTurn` 节点，设为 `running`。
4. active-agent 处理中可持续流式更新 turn 的内容/状态。
5. active-agent 调用 subagent 时，立即创建/更新对应 `SubagentNode`，并挂到当前 turn 下。
6. subagent 状态变化时，局部更新子节点状态。
7. active-agent 完成该轮响应时，将 turn 置为 `done`/`failed`/`cancelled`。
8. 下一次用户消息到来，重复创建新的 sibling turn。

### 6.2 事件分类建议
可将事件分为三类：
- **Session 级事件**：会话开始、结束、重置、切换。
- **Turn 级事件**：active-agent start/stream/update/end。
- **Subagent 级事件**：subagent spawn/update/output/end/error。

### 6.3 路由策略
- 有明确 `parentTurnId` 的 subagent 事件，直接路由到该 turn。
- 若没有显式父 ID，但存在当前活动 turn，可按上下文推断挂载到最近活动 turn。
- 如果 turn 尚未创建但子事件先到达，可先进入 pending bucket，待父 turn 确认后再归位。

## 7. 合并与去重策略

### 7.1 为什么需要去重
流式输出、重放、补发、日志回放、异步事件乱序都会导致同一节点事件重复到达。如果没有幂等策略，会出现：
- 同一 turn 被创建多次；
- 同一 subagent 被重复挂载；
- 状态在 running/done 之间来回闪烁；
- 子节点顺序不稳定。

### 7.2 建议去重维度
优先级从高到低：
1. **稳定节点 ID**：同 ID 只更新，不重复创建。
2. **源事件 ID**：同事件只消费一次。
3. **语义键**：`sessionId + turnIndex`、`sessionId + parentTurnId + subagentName + triggerAt` 等。
4. **时间窗口辅助**：仅用于无法获得稳定 ID 的兜底。

### 7.3 合并规则
- 节点已存在：仅更新字段，不重建对象。
- `running -> streaming -> done/failed/cancelled` 可推进，不允许默认反向回退。
- 子节点列表按 `orderKey` 稳定插入；若已有同 ID 子节点，合并其最新状态与输出。
- 对父 turn 的更新不能意外清空已挂载的子节点。

### 7.4 Pending 节点处理
当子事件先于父 turn 到达时：
- 先进入 `pendingChildrenBySession` 或 `pendingChildrenByTurnKey`。
- 一旦父 turn 创建并可识别，立刻批量归位。
- pending 也必须支持去重，避免重复回填。

## 8. 关键交互/渲染要求

### 8.1 Session 一级展示
- 一级只展示 active-agent turn 的列表语义。
- turn 的顺序应与用户消息驱动的响应顺序一致。
- 最新运行中的 turn 应在视觉上可识别。

### 8.2 进行中状态
建议对当前运行 turn 使用清晰状态标识，例如：
- hourglass
- spinner
- `thinking`
- `streaming`

要求：
- 在 turn 未结束前持续可见。
- 状态变化不应被子节点更新覆盖掉。

### 8.3 子节点即时显示
- subagent 一旦创建即显示在所属 turn 下。
- subagent 的 running/done/error 应同步到节点行。
- 不应等待 turn 完全结束后才显示 subagent。

### 8.4 稳定排序
建议排序优先级：
1. turn 的创建顺序（turnIndex / createdAt）
2. 子节点的 orderKey / createdAt
3. 相同时间下的稳定 ID 比较

## 9. 具体实现建议（按层）

### 9.1 事件接收层
- 给每条事件补足：`eventId`、`sessionId`、`timestamp`、`kind`、`nodeId`、`parentId`（如有）。
- 对来源不完整的事件做轻量标准化。
- 统一入口做去重后再进入树更新器。

### 9.2 树更新层
- 维护 `session -> turns -> children` 的索引。
- turn 创建与子节点挂载分离处理，避免耦合。
- 使用局部更新而不是全量重建。
- 更新后输出“脏节点集合”供渲染层局部刷新。

### 9.3 渲染层
- Session 下只消费 turn 列表。
- turn 组件内部递归渲染其子节点。
- 以状态优先而非类型字符串拼接来决定徽标与文案。
- 尽可能保留展开状态、焦点、滚动锚点。

## 10. 已知限制与取舍

- 如果上游事件没有稳定 ID，去重质量会依赖语义键与时间窗口，不能完全保证零重复。
- 在极端乱序下，pending 回填可能造成短暂“后出现的父节点补位”现象。
- 若历史数据不含 parent turn 信息，旧 Session 的回放可能无法完美还原层级。
- 为了保证实时性，局部刷新可能优先于复杂重排，因此某些瞬时过渡态是可接受的。

## 11. 测试策略

### 11.1 单元测试
建议覆盖：
- 新 active-agent turn 创建逻辑。
- turn sibling 串联顺序。
- subagent 挂载到正确 turn 的逻辑。
- 去重：同 ID 重复事件只更新不新增。
- 状态迁移：running -> done / failed / cancelled。
- pending 子节点回填。

### 11.2 集成测试
建议构造事件序列：
1. 用户消息 A -> active-agent turn #1 -> subagent X -> subagent Y -> turn #1 done。
2. 用户消息 B -> active-agent turn #2 -> subagent Z -> turn #2 running 中持续更新。
3. 重复注入相同 subagent 事件，验证不重复挂载。
4. 子事件先到、父 turn 后到，验证回填正确。

### 11.3 视觉/手工验证
建议手工检查：
- Session 第一层是否只显示 turn。
- 当前 active-agent 是否有明显的进行中状态。
- 子 agent 是否实时出现在对应 turn 下。
- 展开/折叠时是否仍能稳定看到节点。

### 11.4 回归测试重点
- 旧的 Session 直挂 subagent 视图是否已退出主路径。
- 流式输出期间是否会闪烁或重复节点。
- 长会话下 turn 数量增长是否仍保持顺序与性能可接受。

## 12. 实施时的注意事项

- 不要把“显示层需要简化”误解为“删除真实层级信息”；应保持层级真实且渲染简洁。
- 不要依赖单一时间戳排序解决一切问题；要结合稳定 ID 与父子关系。
- 不要让状态更新覆盖结构更新，或者结构更新覆盖状态更新；两者应合并。
- 不要把兼容旧数据的逻辑写成主路径，避免新架构被旧结构拖回去。

## 13. 建议的最小落地版本
如果希望先做一个可用版本，再逐步强化，推荐顺序：
1. 先实现 active-agent turn 作为 Session 第一层。
2. 再实现 subagent 的即时挂载与状态刷新。
3. 再补去重、pending、乱序回填。
4. 最后优化视觉状态、滚动体验与边界兼容。

## 14. 结论
重构的核心不是“增加一种节点类型”，而是把 viewer 的语义中心从“subagent 的罗列”切换为“active-agent 每轮响应的活动树”。只要坚持以下原则：
- Session 第一层 = active-agent turn
- turn 内挂载 subagent
- 事件幂等合并
- 当前 turn 明确显示进行中状态

就能得到一个更符合真实执行过程、也更易读的 live activity tree 视图。
