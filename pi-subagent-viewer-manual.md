# Subagent Viewer 手动检验手册

## 更新内容

### V1.0 版本更新

1. **新增 Subagent Viewer 功能**
   - 添加了专门的子代理查看器，无需依赖 Pi 的全局工具输出展开（Ctrl+O）
   - 支持从快捷键和 `/subagents` 命令打开

2. **新增配置系统**
   - 支持用户配置文件：`~/.pi/agent/subagent.json`
   - 支持项目配置文件：`.pi/subagent.json`
   - 配置优先级：默认 < 用户配置 < 项目配置
   - 支持 `viewerKey: "none"` 禁用快捷键

3. **新增树形结构显示**
   - 单子代理调用显示为代理节点
   - 并行子代理调用显示为父节点，包含子代理节点
   - 支持计算节点状态：运行中、成功、错误、混合

4. **新增详细视图**
   - 支持显示代理信息、任务、工具调用、输出、使用情况等
   - 支持滚动浏览详细内容

5. **新增键盘导航**
   - 树形模式：↑↓←→ Home End Enter Esc q
   - 详细模式：↑↓ PageUp PageDown Home End Esc q

6. **修改默认快捷键**
   - 默认快捷键改为 Ctrl+Shift+M

### 文件变更

**新增文件：**
- `config.ts` - 配置加载和合并逻辑
- `subagent-view-data.ts` - 数据模型和树构建
- `subagent-tree-view.ts` - TUI 组件和视图逻辑
- `test/subagent-view-data.test.mjs` - 数据模型测试

**修改文件：**
- `index.ts` - 集成配置加载和查看器打开逻辑
- `package.json` - 添加新文件到发布列表
- `README.md` - 添加 Subagent Viewer 文档

---

## 快速开始

### 基本使用

1. **打开查看器**
   - 按 `Ctrl+Shift+M`（默认快捷键）
   - 或输入 `/subagents` 命令

2. **导航树形结构**
   - `↑`/`↓`：选择上一个/下一个可见节点
   - `←`：选择父节点
   - `→`：选择第一个子节点
   - `Home`/`End`：跳转到第一个/最后一个节点
   - `Enter`：打开选中的子代理详情
   - `Esc`/`q`：关闭查看器

3. **查看详细信息**
   - `↑`/`↓`：向上/向下滚动
   - `PageUp`/`PageDown`：按页滚动
   - `Home`/`End`：跳转到顶部/底部
   - `Esc`：返回树形模式
   - `q`：关闭查看器

---

## 配置说明

### 默认配置

```json
{
  "viewerKey": "ctrl+shift+m"
}
```

### 用户配置

创建文件：`~/.pi/agent/subagent.json`

示例：
```json
{
  "viewerKey": "ctrl+shift+o"
}
```

### 项目配置

创建文件：`.pi/subagent.json`（在项目根目录）

示例：
```json
{
  "viewerKey": "ctrl+m"
}
```

### 禁用快捷键

```json
{
  "viewerKey": "none"
}
```

**注意：** 即使禁用快捷键，`/subagents` 命令仍然可用。

### 配置生效

配置更改后需要：
- 重启 Pi，或
- 输入 `/reload` 命令

---

## 功能详解

### 树形结构显示

**单子代理调用：**
```
Session
└─ #1 worker ✓
```

**并行子代理调用：**
```
Session
└─ #2 parallel ✓
   ├─ plan ✓
   ├─ worker ✓
   └─ tester ✗
```

**多次调用：**
```
Session
├─ #1 worker ✓
├─ #2 parallel ✓
│  ├─ plan ✓
│  └─ worker ✗
└─ #3 oracle ⏳
```

### 状态图标

- ✓：成功（绿色）
- ✗：错误（红色）
- ⏳：运行中（黄色）
- ◐：混合状态（黄色）

### 详细信息内容

详细视图包含：
- 代理名称和来源
- 委托模式（spawn/fork/continue）
- 状态和停止原因
- 模型信息
- 子会话信息
- 工作树漂移警告
- 任务描述
- 工具调用列表
- 最终输出
- 使用情况统计

---

## 手动检验步骤

### 1. 配置测试

**测试默认配置：**
1. 不创建任何配置文件
2. 启动 Pi
3. 按 `Ctrl+Shift+M`
4. 验证查看器打开

**测试用户配置：**
1. 创建 `~/.pi/agent/subagent.json`：
   ```json
   {
     "viewerKey": "ctrl+shift+o"
   }
   ```
2. 重启 Pi 或输入 `/reload`
3. 按 `Ctrl+Shift+O`
4. 验证查看器打开

**测试项目配置：**
1. 在项目目录创建 `.pi/subagent.json`：
   ```json
   {
     "viewerKey": "ctrl+m"
   }
   ```
2. 重启 Pi 或输入 `/reload`
3. 按 `Ctrl+M`
4. 验证查看器打开（项目配置应覆盖用户配置）

**测试禁用快捷键：**
1. 创建配置文件：
   ```json
   {
     "viewerKey": "none"
   }
   ```
2. 重启 Pi 或输入 `/reload`
3. 按 `Ctrl+Shift+M` 或其他快捷键
4. 验证查看器不打开
5. 输入 `/subagents`
6. 验证查看器打开

### 2. 树形导航测试

**空会话测试：**
1. 启动新会话
2. 打开查看器
3. 验证显示"No subagent records in the current session branch."

**单子代理测试：**
1. 执行一个子代理调用：
   ```
   让子代理 worker 执行任务：写一个简单的 hello world 程序
   ```
2. 打开查看器
3. 验证显示：
   ```
   Session
   └─ #1 worker ✓
   ```
4. 验证导航：
   - `↑`/`↓`：选择节点
   - `Enter`：打开详情
   - `Esc`：返回树形模式
   - `q`：关闭查看器

**并行子代理测试：**
1. 执行并行子代理调用：
   ```
   让子代理 worker 执行任务：写 hello world
   让子代理 tester 执行任务：测试程序
   ```
2. 打开查看器
3. 验证显示：
   ```
   Session
   └─ #1 parallel ✓
      ├─ worker ✓
      └─ tester ✓
   ```
4. 验证导航：
   - `←`：选择父节点
   - `→`：选择第一个子节点
   - `Enter`：打开并行调用详情

### 3. 详细视图测试

**单子代理详情测试：**
1. 执行单子代理调用
2. 打开查看器
3. 选择节点并按 `Enter`
4. 验证显示：
   - 代理名称和状态
   - 任务描述
   - 工具调用列表
   - 最终输出
   - 使用情况统计

**并行调用详情测试：**
1. 执行并行子代理调用
2. 打开查看器
3. 选择并行节点并按 `Enter`
4. 验证显示所有子代理的摘要信息

**滚动测试：**
1. 执行一个产生大量输出的子代理任务
2. 打开详情视图
3. 验证滚动功能：
   - `↑`/`↓`：逐行滚动
   - `PageUp`/`PageDown`：按页滚动
   - `Home`/`End`：跳转到顶部/底部

### 4. 边界情况测试

**多个子代理调用测试：**
1. 执行多个子代理调用
2. 验证显示：
   ```
   Session
   ├─ #1 worker ✓
   ├─ #2 parallel ✓
   │  ├─ plan ✓
   │  └─ worker ✗
   └─ #3 oracle ⏳
   ```
3. 验证树形导航正确

**运行中状态测试：**
1. 启动一个长时间运行的子代理
2. 立即打开查看器
3. 验证显示⏳图标
4. 等待子代理完成
5. 刷新查看器
6. 验证状态更新为✓或✗

**错误状态测试：**
1. 执行一个会失败的子代理任务
2. 打开查看器
3. 验证显示✗图标
4. 打开详情视图
5. 验证显示错误信息

### 5. 命令测试

**`/subagents` 命令测试：**
1. 输入 `/subagents`
2. 验证查看器打开
3. 输入 `/subagents`（当查看器已打开）
4. 验证不会打开第二个查看器

**快捷键冲突测试：**
1. 配置一个与现有快捷键冲突的快捷键
2. 验证系统给出警告
3. 验证快捷键可能不工作

---

## 故障排除

### 常见问题

**问题：查看器不打开**
- 检查配置文件是否有效
- 检查快捷键是否被禁用
- 检查是否有语法错误
- 尝试使用 `/subagents` 命令

**问题：显示空内容**
- 确保已执行子代理任务
- 检查是否在正确的会话分支
- 尝试刷新会话

**问题：导航不工作**
- 检查终端是否支持所需按键
- 尝试使用不同的快捷键
- 检查是否有其他程序捕获按键

**问题：配置不生效**
- 确保 JSON 语法正确
- 检查文件路径和权限
- 重启 Pi 或使用 `/reload`

### 调试信息

**查看日志：**
1. 启动 Pi 时添加调试标志
2. 检查控制台输出
3. 查找 `[pi-subagent]` 相关消息

**验证配置加载：**
1. 在配置文件中添加错误语法
2. 启动 Pi
3. 检查是否显示警告消息

---

## 技术细节

### 数据模型

**SubagentTreeNode：**
```typescript
interface SubagentTreeNode {
  id: string;
  kind: "root" | "call" | "agent";
  label: string;
  status: "running" | "success" | "error" | "mixed";
  callIndex?: number;
  resultIndex?: number;
  mode?: "single" | "parallel";
  delegationMode?: DelegationMode;
  result?: SingleResult;
  children: SubagentTreeNode[];
}
```

**配置加载优先级：**
1. 默认配置
2. 用户配置（`~/.pi/agent/subagent.json`）
3. 项目配置（`.pi/subagent.json`）

**快捷键匹配：**
- 使用 `matchesKey()` 函数
- 支持修饰键组合：Ctrl、Shift、Alt、Meta
- 支持特殊键：enter、escape、tab 等

### TUI 组件

**SubagentViewerComponent：**
- 树形模式：显示子代理调用树
- 详细模式：显示选中节点的详细信息
- 支持键盘导航和滚动
- 自动换行和截断

**渲染逻辑：**
- 使用 `ctx.ui.custom()` 打开覆盖层
- 自动适应终端宽度
- 支持主题颜色

---

## 性能考虑

### 内存使用
- 树结构在内存中构建
- 大量子代理调用可能占用较多内存
- 建议定期清理会话

### 渲染性能
- 缓存渲染结果
- 仅在状态变化时重新渲染
- 支持大宽度终端

### 配置加载
- 同步读取配置文件
- 缓存配置结果
- 配置变更需要重启生效

---

## 安全考虑

### 配置文件权限
- 用户配置文件应受保护
- 项目配置文件可能被版本控制
- 避免在配置中存储敏感信息

### 快捷键冲突
- 避免与系统快捷键冲突
- 避免与其他扩展冲突
- 提供清晰的配置文档

### 错误处理
- 无效配置优雅降级
- 快捷键失败安全处理
- 查看器崩溃不影响主会话

---

## 未来改进

### V2 计划功能
- 嵌套子代理支持
- 搜索和过滤
- 实时更新
- 复制/导出功能
- 更多详细信息部分

### 性能优化
- 增量加载
- 虚拟滚动
- 异步配置加载

### 用户体验
- 自定义主题
- 可调整大小
- 书签功能
- 导出为文件

---

## 参考资料

### 相关文档
- [SUBAGENT_VIEWER_PLAN.md](pi-subagent/SUBAGENT_VIEWER_PLAN.md) - 实现计划
- [TODO.md](TODO.md) - 任务清单
- [README.md](README.md) - 项目文档

### 相关文件
- `config.ts` - 配置管理
- `subagent-view-data.ts` - 数据模型
- `subagent-tree-view.ts` - TUI 组件
- `index.ts` - 扩展集成

### 测试文件
- `test/subagent-view-data.test.mjs` - 数据模型测试

---

## 更新日志

### V1.1 (当前版本)
- 修改默认快捷键为 Ctrl+Shift+M
- 创建完整手动检验手册

### V1.0
- 初始版本发布
- 实现基本功能
- 添加配置系统
- 添加树形视图
- 添加详细视图
- 添加键盘导航
- 添加命令支持
- 添加文档
- 添加测试

---

## 支持与反馈

如有问题或建议，请：
1. 查看故障排除部分
2. 检查相关文档
3. 提交 issue 到项目仓库

感谢使用 Subagent Viewer！
