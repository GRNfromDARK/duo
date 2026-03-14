# 类型系统

## 概述

Duo 的类型系统分布在 5 个文件中，定义了从 CLI adapter 到 God 决策的完整类型体系。

| 文件 | 职责 |
|------|------|
| `src/types/adapter.ts` | CLI adapter 核心接口 |
| `src/types/session.ts` | Session 配置与验证 |
| `src/types/ui.ts` | TUI 层消息与样式 |
| `src/types/god-adapter.ts` | God adapter 接口 |
| `src/types/god-schemas.ts` | God LLM 输出的 Zod schema |

---

## adapter.ts — CLI Adapter 接口

> 源自需求：FR-008 (AC-029, AC-030, AC-031, AC-032, AC-033-new)

定义了 Duo 插件架构的核心抽象，使得不同的 CLI 工具（claude-code、codex、gemini 等）可以通过统一接口接入。

### `ExecOptions`

CLI 执行选项。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cwd` | `string` | 是 | 工作目录 |
| `systemPrompt` | `string` | 否 | 系统提示词 |
| `env` | `Record<string, string>` | 否 | 额外环境变量 |
| `replaceEnv` | `boolean` | 否 | 为 `true` 时 `env` 完全替换 `process.env`，默认为合并模式 |
| `timeout` | `number` | 否 | 超时时间（毫秒） |
| `permissionMode` | `'skip' \| 'safe'` | 否 | `skip` 跳过权限确认（yolo 模式），`safe` 需要用户确认 |
| `disableTools` | `boolean` | 否 | 禁用所有工具（God orchestrator 使用，如 Claude Code 的 `--tools ""`） |

### `OutputChunk`

CLI 输出的流式数据块，是 adapter 向上层传递结果的最小单元。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | 联合类型（见下） | 是 | 数据块类型 |
| `content` | `string` | 是 | 文本内容 |
| `metadata` | `Record<string, unknown>` | 否 | 附加元数据 |
| `timestamp` | `number` | 是 | Unix 时间戳 |

`type` 枚举值：

| 值 | 含义 |
|----|------|
| `text` | 普通文本输出 |
| `code` | 代码块 |
| `tool_use` | 工具调用请求 |
| `tool_result` | 工具调用结果 |
| `error` | 错误信息 |
| `status` | 状态更新 |

### `CLIAdapter`

核心 adapter 接口，每个 CLI 工具必须实现。

| 成员 | 类型 | 说明 |
|------|------|------|
| `name` | `readonly string` | 内部标识名（如 `'claude-code'`） |
| `displayName` | `readonly string` | 显示名称（如 `'Claude Code'`） |
| `version` | `readonly string` | 版本号 |
| `isInstalled()` | `Promise<boolean>` | 检测是否已安装 |
| `getVersion()` | `Promise<string>` | 获取当前版本 |
| `execute(prompt, opts)` | `AsyncIterable<OutputChunk>` | 执行提示词，返回流式 `OutputChunk` 迭代器 |
| `kill()` | `Promise<void>` | 终止运行中的进程 |
| `isRunning()` | `boolean` | 是否正在运行 |

关键设计：`execute()` 返回 `AsyncIterable<OutputChunk>`，支持逐块流式读取 CLI 输出。

### `ParserType`

CLI 输出的解析策略类型。

| 值 | 说明 |
|----|------|
| `stream-json` | 流式 JSON 解析（适用于 claude-code 等） |
| `jsonl` | 逐行 JSON 解析 |
| `text` | 纯文本解析 |

### `CLIRegistryEntry`

CLI 注册表条目，描述一个 CLI 工具的静态配置信息。

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 内部标识名（与 `CLIAdapter.name` 对应） |
| `displayName` | `string` | 显示名称 |
| `command` | `string` | 基础命令名（如 `'claude'`） |
| `detectCommand` | `string` | 检测是否安装的命令（如 `'claude --version'`） |
| `execCommand` | `string` | 执行命令的模板字符串 |
| `outputFormat` | `string` | 输出格式描述 |
| `yoloFlag` | `string` | 跳过权限确认的命令行标志 |
| `parserType` | `ParserType` | 输出解析器类型 |

### `CLIRegistry`

```ts
type CLIRegistry = Record<string, CLIRegistryEntry>;
```

以 CLI 名称为 key 的注册表映射。

---

## session.ts — Session 类型

> 源自需求：FR-001 (AC-001, AC-002, AC-003, AC-004)

### `SessionConfig`

一次协作会话的完整配置，是启动 TUI 所需的最小必要信息。

| 字段 | 类型 | 说明 |
|------|------|------|
| `projectDir` | `string` | 项目目录的绝对路径 |
| `coder` | `string` | Coder 角色使用的 CLI 名称 |
| `reviewer` | `string` | Reviewer 角色使用的 CLI 名称 |
| `god` | `GodAdapterName` | God adapter 标识（来自 `god-adapter.ts`） |
| `task` | `string` | 任务描述 |

### `StartArgs`

从命令行解析出的启动参数，所有字段可选（用户可能只提供部分参数）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `dir` | `string?` | 对应 `--dir` 参数，项目目录 |
| `coder` | `string?` | 对应 `--coder` 参数 |
| `reviewer` | `string?` | 对应 `--reviewer` 参数 |
| `god` | `string?` | 对应 `--god` 参数 |
| `task` | `string?` | 对应 `--task` 参数 |

**`StartArgs` → `SessionConfig` 转换**：`StartArgs` 是用户输入的原始形态（可选字段），经过验证和补全后转化为 `SessionConfig`（必选字段）。`dir` 未提供时默认使用 `process.cwd()`，`god` 未提供时使用默认值。

### `ValidationResult`

参数验证结果。

| 字段 | 类型 | 说明 |
|------|------|------|
| `valid` | `boolean` | `true` 表示验证通过 |
| `errors` | `string[]` | 错误列表（阻止启动） |
| `warnings` | `string[]` | 警告列表（不阻止启动） |

### `StartResult`

`createSessionConfig()` 的返回值。

| 字段 | 类型 | 说明 |
|------|------|------|
| `config` | `SessionConfig \| null` | 验证通过时为完整配置，失败时为 null |
| `validation` | `ValidationResult` | 验证结果详情 |
| `detectedCLIs` | `string[]` | 系统中检测到的可用 CLI 名称列表 |

---

## ui.ts — UI 类型

> 源自需求：FR-014 (AC-048, AC-049, AC-050, AC-051)

### `RoleName`

角色名称的联合类型，定义了 Duo 支持的所有角色标识。

```ts
type RoleName =
  | 'claude-code' | 'codex' | 'gemini' | 'copilot'
  | 'aider' | 'amazon-q' | 'cursor' | 'cline'
  | 'continue' | 'goose' | 'amp' | 'qwen'
  | 'system' | 'user';
```

共 14 个值：12 个 CLI 工具角色 + `system`（系统消息）+ `user`（用户输入）。

### `RoleStyle`

角色的视觉样式定义。

| 字段 | 类型 | 说明 |
|------|------|------|
| `displayName` | `string` | 在 TUI 中显示的角色名称 |
| `color` | `string` | 文字颜色，支持 Ink 颜色名（如 `'blue'`）或十六进制值（如 `'#FFA500'`） |
| `border` | `string` | 消息左侧边框字符，用于视觉区分不同角色 |

### `ROLE_STYLES` 常量

`Record<RoleName, RoleStyle>` 类型的预定义样式映射表：

| RoleName | displayName | color | border |
|----------|-------------|-------|--------|
| `claude-code` | Claude | `blue` | `┃` |
| `codex` | Codex | `green` | `║` |
| `gemini` | Gemini | `#FFA500` | `│` |
| `copilot` | Copilot | `#6e40c9` | `│` |
| `aider` | Aider | `#00cc66` | `│` |
| `amazon-q` | Amazon Q | `#FF9900` | `│` |
| `cursor` | Cursor | `#00b4d8` | `│` |
| `cline` | Cline | `#e06c75` | `│` |
| `continue` | Continue | `#be4bdb` | `│` |
| `goose` | Goose | `#fab005` | `│` |
| `amp` | Amp | `#20c997` | `│` |
| `qwen` | Qwen | `#7048e8` | `│` |
| `system` | System | `yellow` | `·` |
| `user` | You | `white` | `>` |

未知角色回退到 `DEFAULT_ROLE_STYLE`：`{ displayName: 'Agent', color: 'gray', border: '│' }`。

### `getRoleStyle(role: string): RoleStyle`

安全查找函数。传入角色名称，返回对应的 `RoleStyle`；未知角色返回默认样式。

### `MessageMetadata`

消息的附加元数据，用于控制不同显示模式下的行为。

| 字段 | 类型 | 说明 |
|------|------|------|
| `cliCommand` | `string?` | 调用 CLI 的命令字符串（verbose 模式显示） |
| `tokenCount` | `number?` | 该消息的 token 数（verbose 模式显示） |
| `isRoutingEvent` | `boolean?` | 标记为路由/内部事件（minimal 模式隐藏） |
| `isRoundSummary` | `boolean?` | 标记为 round 总结分隔线 |

### `Message`

TUI 中显示的消息实体。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 唯一标识 |
| `role` | `RoleName` | 角色标识，通过 `ROLE_STYLES` 查找视觉样式 |
| `roleLabel` | `string?` | 上下文角色标签（如 `"Coder"`、`"Reviewer"`），同一 CLI 在不同会话中可能扮演不同角色 |
| `content` | `string` | 消息文本内容 |
| `timestamp` | `number` | Unix 时间戳 |
| `isStreaming` | `boolean?` | `true` 表示正在流式输出中，内容可能尚不完整 |
| `metadata` | `MessageMetadata?` | 附加元数据 |

### `ScrollState`

终端消息区域的滚动状态。

| 字段 | 类型 | 说明 |
|------|------|------|
| `offset` | `number` | 当前滚动偏移量（行数） |
| `viewportHeight` | `number` | 可视区域高度（行数） |
| `totalLines` | `number` | 消息区域总行数 |
| `autoFollow` | `boolean` | 为 `true` 时自动滚动到最新消息，用户手动滚动时置为 `false` |

---

## god-adapter.ts — God Adapter 接口

定义 God orchestrator 的 adapter 抽象层。God 是 Duo 的决策核心，负责任务分析、路由决策和收敛判断。

### `GodAdapterName`

```ts
type GodAdapterName = 'claude-code' | 'codex';
```

当前支持的 God adapter 名称。被 `SessionConfig.god` 字段引用。

### `GodToolUsePolicy`

```ts
type GodToolUsePolicy = 'forbid' | 'allow-readonly';
```

God adapter 的工具使用策略：

| 值 | 说明 |
|----|------|
| `'forbid'` | 完全禁止工具调用 |
| `'allow-readonly'` | 允许只读工具（如文件读取、搜索） |

### `GodExecOptions`

God adapter 的执行选项。相比 `ExecOptions` 更严格，所有字段均为必填。

| 字段 | 类型 | 说明 |
|------|------|------|
| `cwd` | `string` | 工作目录 |
| `systemPrompt` | `string` | 系统提示词（必填） |
| `timeoutMs` | `number` | 超时时间（毫秒，必填） |

**与 `ExecOptions` 的差异**：`GodExecOptions` 不支持 `env`、`replaceEnv`、`permissionMode`、`disableTools` 字段，且 `systemPrompt` 和 `timeoutMs` 均为必填。

### `GodAdapter`

God orchestrator 的 adapter 接口。

| 成员 | 类型 | 说明 |
|------|------|------|
| `name` | `readonly string` | 内部标识名 |
| `displayName` | `readonly string` | 显示名称 |
| `version` | `readonly string` | 版本号 |
| `toolUsePolicy` | `readonly GodToolUsePolicy?` | 工具使用策略 |
| `minimumTimeoutMs` | `readonly number?` | 最小超时时间（低于此值的 timeout 将被提升） |
| `isInstalled()` | `Promise<boolean>` | 检测是否已安装 |
| `getVersion()` | `Promise<string>` | 获取版本号 |
| `execute(prompt, opts)` | `AsyncIterable<OutputChunk>` | 执行并流式返回输出 |
| `kill()` | `Promise<void>` | 终止进程 |
| `isRunning()` | `boolean` | 是否正在运行 |

**与 `CLIAdapter` 的对比**：

| 差异点 | `CLIAdapter` | `GodAdapter` |
|--------|-------------|-------------|
| 执行选项 | `ExecOptions` | `GodExecOptions` |
| 工具策略 | 无 | `toolUsePolicy` |
| 超时下限 | 无 | `minimumTimeoutMs` |
| 输出类型 | `AsyncIterable<OutputChunk>` | `AsyncIterable<OutputChunk>`（共享） |

---

## god-schemas.ts — God LLM 输出 Schema

> 源自需求：AR-002, OQ-002, OQ-003。Schema 字段名遵循 Card A.1 spec。

使用 Zod 定义 God LLM 各决策点的输出结构。每个 schema 同时导出 Zod schema 对象（用于运行时校验）和推断的 TypeScript 类型（用于编译时类型检查）。

### `TaskTypeSchema`

6 种任务类型枚举：

| 值 | 含义 |
|----|------|
| `explore` | 探索性任务 |
| `code` | 编码任务 |
| `discuss` | 讨论任务 |
| `review` | 审查任务 |
| `debug` | 调试任务 |
| `compound` | 复合任务（包含多个子阶段） |

### `GodTaskAnalysis` — 任务意图解析

God 对用户任务的分析结果。来源：FR-001。

| 字段 | 类型 | 说明 |
|------|------|------|
| `taskType` | `TaskType` | 任务类型（6 种之一） |
| `reasoning` | `string` | 推理过程 |
| `phases` | `Phase[] \| null \| undefined` | 子阶段列表 |
| `confidence` | `number` (0-1) | 分析置信度 |
| `suggestedMaxRounds` | `number` (1-20, 整数) | 建议最大轮次 |
| `terminationCriteria` | `string[]` | 终止条件列表 |

`Phase` 结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 阶段 ID |
| `name` | `string` | 阶段名称 |
| `type` | `TaskType` | 阶段任务类型 |
| `description` | `string` | 阶段描述 |

**Refinement 约束**：当 `taskType` 为 `'compound'` 时，`phases` 必须为非空数组。

### `GodPostCoderDecision` — Coder 输出后路由

God 在 Coder 完成后的路由决策。来源：FR-004。

| 字段 | 类型 | 说明 |
|------|------|------|
| `action` | `'continue_to_review' \| 'retry_coder'` | 路由动作 |
| `reasoning` | `string` | 推理过程 |
| `retryHint` | `string?` | 重试提示（`retry_coder` 时提供，指导 Coder 改进方向） |

### `GodPostReviewerDecision` — Reviewer 输出后路由

God 在 Reviewer 完成后的路由决策。来源：FR-004。

| 字段 | 类型 | 说明 |
|------|------|------|
| `action` | `'route_to_coder' \| 'converged' \| 'phase_transition' \| 'loop_detected'` | 路由动作 |
| `reasoning` | `string` | 推理过程 |
| `unresolvedIssues` | `string[]?` | 未解决问题列表 |
| `confidenceScore` | `number` (0-1) | 收敛置信度 |
| `progressTrend` | `'improving' \| 'stagnant' \| 'declining'` | 进展趋势 |
| `nextPhaseId` | `string?` | 下一阶段 ID（`phase_transition` 时指定目标阶段） |

**Refinement 约束**：当 `action` 为 `'route_to_coder'` 时，`unresolvedIssues` 必须为非空数组。

`action` 枚举值：

| 值 | 含义 |
|----|------|
| `route_to_coder` | 路由回 Coder 修复未解决问题 |
| `converged` | 已收敛，任务完成 |
| `phase_transition` | 进入下一个 phase（compound 任务） |
| `loop_detected` | 检测到循环，需要介入 |

### `GodConvergenceJudgment` — 收敛判断

God 对 session 收敛状态的综合判断。来源：FR-005。

| 字段 | 类型 | 说明 |
|------|------|------|
| `classification` | `'approved' \| 'changes_requested' \| 'needs_discussion'` | 分类结果 |
| `shouldTerminate` | `boolean` | 是否应终止 session |
| `reason` | `string \| null` | 原因说明 |
| `blockingIssueCount` | `number` (>=0, 整数) | 阻塞问题数量 |
| `criteriaProgress` | `{ criterion: string; satisfied: boolean }[]` | 各终止条件的达成情况 |
| `reviewerVerdict` | `string` | Reviewer 的综合评价 |

### `GodAutoDecision` — God 自主决策

God 在 `GOD_DECIDING` 状态下的自主决策。来源：FR-008。

| 字段 | 类型 | 说明 |
|------|------|------|
| `action` | `'accept' \| 'continue_with_instruction'` | 决策动作 |
| `reasoning` | `string` (max 2000 字符) | 推理过程 |
| `instruction` | `string?` | 附加指令（`continue_with_instruction` 时提供） |

常量 `MAX_REASONING_LENGTH = 2000`，限制 `reasoning` 字段长度以防止 UI 溢出。

### 导出的 TypeScript 类型

每个 Zod schema 均通过 `z.infer<>` 导出对应的 TypeScript 类型：

```ts
type GodTaskAnalysis = z.infer<typeof GodTaskAnalysisSchema>;
type GodPostCoderDecision = z.infer<typeof GodPostCoderDecisionSchema>;
type GodPostReviewerDecision = z.infer<typeof GodPostReviewerDecisionSchema>;
type GodConvergenceJudgment = z.infer<typeof GodConvergenceJudgmentSchema>;
type GodAutoDecision = z.infer<typeof GodAutoDecisionSchema>;
```

---

## 类型关系图

```
                    adapter.ts
                   ┌─────────────────────┐
                   │  ExecOptions          │
                   │  OutputChunk          │◄──────────────────┐
                   │  CLIAdapter           │                    │
                   │  CLIRegistryEntry     │                    │
                   │  CLIRegistry          │                    │
                   │  ParserType           │                    │
                   └─────────────────────┘                    │
                                                              │ (引用 OutputChunk)
                   session.ts                                 │
                   ┌─────────────────────┐             god-adapter.ts
                   │  StartArgs           │            ┌─────────────────────┐
                   │  SessionConfig ──────┼──(god)───► │  GodAdapterName      │
                   │  ValidationResult    │            │  GodToolUsePolicy    │
                   │  StartResult         │            │  GodExecOptions      │
                   └─────────────────────┘            │  GodAdapter          │
                                                      └─────────────────────┘
                      ui.ts
                   ┌─────────────────────┐             god-schemas.ts
                   │  RoleName            │            ┌─────────────────────────┐
                   │  RoleStyle           │            │  TaskTypeSchema          │
                   │  ROLE_STYLES         │            │  GodTaskAnalysis         │
                   │  getRoleStyle()      │            │  GodPostCoderDecision    │
                   │  MessageMetadata     │            │  GodPostReviewerDecision │
                   │  Message             │            │  GodConvergenceJudgment  │
                   │  ScrollState         │            │  GodAutoDecision         │
                   └─────────────────────┘            │  MAX_REASONING_LENGTH    │
                                                      └─────────────────────────┘
```

### 关键依赖关系

- **session.ts → god-adapter.ts**：`SessionConfig.god` 字段的类型为 `GodAdapterName`
- **god-adapter.ts → adapter.ts**：`GodAdapter.execute()` 返回 `AsyncIterable<OutputChunk>`（共享 `OutputChunk` 类型）
- **god-schemas.ts**：独立于其他类型文件，仅依赖外部库 `zod`
- **ui.ts**：独立于其他类型文件，无跨文件类型依赖

### 核心数据流向

1. **启动阶段**：`StartArgs` → 验证 → `SessionConfig`（含 `GodAdapterName`）→ 传入 `App`
2. **恢复阶段**：持久化数据 → 重建 `SessionConfig` → `sanitizeGodAdapterForResume()` 校验 God adapter → 传入 `App`
3. **运行阶段**：`CLIAdapter.execute()` / `GodAdapter.execute()` 产生 `OutputChunk` 流 → 转化为 `Message` 显示在 TUI
4. **God 决策**：God LLM 原始输出 → Zod schema 校验 → 类型安全的决策对象（`GodTaskAnalysis`、`GodPostCoderDecision` 等）
5. **展示阶段**：`Message.role`（`RoleName`）→ `getRoleStyle()` → `RoleStyle` 视觉样式；`ScrollState` 管理滚动
