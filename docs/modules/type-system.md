# 类型系统

## 概述

Duo 的类型系统分布在 9 个文件中，定义了从 CLI adapter 到 God 决策的完整类型体系。经过简化重构后，God actions 从 11 种精简为 5 种，任务类型从 6 种精简为 4 种，决策信封移除了 Authority 和 AutonomousResolution 等复杂结构。

| 文件 | 职责 |
|------|------|
| `src/types/adapter.ts` | CLI adapter 核心接口 |
| `src/types/session.ts` | Session 配置与验证 |
| `src/types/ui.ts` | TUI 层消息与样式 |
| `src/types/god-adapter.ts` | God adapter 接口 |
| `src/types/god-schemas.ts` | God LLM 任务分析 schema（4 种 TaskType + GodTaskAnalysis） |
| `src/types/god-actions.ts` | Hand / GodAction 结构化动作目录（5 种 action） |
| `src/types/god-envelope.ts` | GodDecisionEnvelope 简化决策信封（无 Authority） |
| `src/types/observation.ts` | Observation 归一化类型系统（6 种观测类型） |
| `src/types/degradation.ts` | 向后兼容保留的最小错误类型 |

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
| `model` | `string` | 否 | model override，传递给 CLI 工具（如 `'claude-sonnet-4-6'`） |

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

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | 是 | 内部标识名（与 `CLIAdapter.name` 对应） |
| `displayName` | `string` | 是 | 显示名称 |
| `command` | `string` | 是 | 基础命令名（如 `'claude'`） |
| `detectCommand` | `string` | 是 | 检测是否安装的命令（如 `'claude --version'`） |
| `execCommand` | `string` | 是 | 执行命令的模板字符串 |
| `outputFormat` | `string` | 是 | 输出格式描述 |
| `yoloFlag` | `string` | 是 | 跳过权限确认的命令行标志 |
| `parserType` | `ParserType` | 是 | 输出解析器类型 |
| `modelFlag` | `string` | 否 | 指定 model 的 CLI 参数名（如 `'--model'`），undefined 表示不支持 |

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

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectDir` | `string` | 是 | 项目目录的绝对路径 |
| `coder` | `string` | 是 | Coder 角色使用的 CLI 名称 |
| `reviewer` | `string` | 是 | Reviewer 角色使用的 CLI 名称 |
| `god` | `GodAdapterName` | 是 | God adapter 标识（来自 `god-adapter.ts`） |
| `task` | `string` | 是 | 任务描述 |
| `coderModel` | `string` | 否 | Coder adapter 的 model override（如 `'sonnet'`、`'gpt-5.4'`） |
| `reviewerModel` | `string` | 否 | Reviewer adapter 的 model override |
| `godModel` | `string` | 否 | God adapter 的 model override（如 `'opus'`、`'gemini-2.5-pro'`） |

### `StartArgs`

从命令行解析出的启动参数，所有字段可选（用户可能只提供部分参数）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `dir` | `string?` | 对应 `--dir` 参数，项目目录 |
| `coder` | `string?` | 对应 `--coder` 参数 |
| `reviewer` | `string?` | 对应 `--reviewer` 参数 |
| `god` | `string?` | 对应 `--god` 参数 |
| `task` | `string?` | 对应 `--task` 参数 |
| `coderModel` | `string?` | 对应 `--coder-model` 参数 |
| `reviewerModel` | `string?` | 对应 `--reviewer-model` 参数 |
| `godModel` | `string?` | 对应 `--god-model` 参数 |

**`StartArgs` -> `SessionConfig` 转换**：`StartArgs` 是用户输入的原始形态（可选字段），经过验证和补全后转化为 `SessionConfig`（必选字段 + 可选 model override）。`dir` 未提供时默认使用 `process.cwd()`，`god` 未提供时使用默认值。

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
type RoleName = 'claude-code' | 'codex' | 'gemini' | 'system' | 'user';
```

共 5 个值：3 个 CLI 工具角色 + `system`（系统消息）+ `user`（用户输入）。

### `RoleStyle`

角色的视觉样式定义。

| 字段 | 类型 | 说明 |
|------|------|------|
| `displayName` | `string` | 在 TUI 中显示的角色名称 |
| `color` | `string` | 文字颜色，支持 Ink 颜色名（如 `'blue'`）或十六进制值（如 `'#FFA500'`） |
| `border` | `string` | 消息左侧边框字符，用于视觉区分不同角色 |

### `DEFAULT_ROLE_STYLE` 常量

未知角色的回退样式：

```ts
const DEFAULT_ROLE_STYLE: RoleStyle = { displayName: 'Agent', color: 'gray', border: '│' };
```

### `ROLE_STYLES` 常量

`Record<RoleName, RoleStyle>` 类型的预定义样式映射表：

| RoleName | displayName | color | border |
|----------|-------------|-------|--------|
| `claude-code` | Claude | `#7dcfff` | `┃` |
| `codex` | Codex | `green` | `║` |
| `gemini` | Gemini | `#FFA500` | `│` |
| `system` | System | `yellow` | `·` |
| `user` | You | `white` | `>` |

### `getRoleStyle(role: string): RoleStyle`

安全查找函数。传入角色名称，返回对应的 `RoleStyle`；未知角色返回 `DEFAULT_ROLE_STYLE`。内部通过 `as RoleName` 断言后查找 `ROLE_STYLES`，使用 `??` 运算符回退。

### `MessageMetadata`

消息的附加元数据，用于控制不同显示模式下的行为。

| 字段 | 类型 | 说明 |
|------|------|------|
| `cliCommand` | `string?` | 调用 CLI 的命令字符串（verbose 模式显示） |
| `tokenCount` | `number?` | 该消息的 token 数（verbose 模式显示） |
| `isRoutingEvent` | `boolean?` | 标记为路由/内部事件（minimal 模式隐藏） |

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
type GodAdapterName = 'claude-code' | 'codex' | 'gemini';
```

当前支持的 3 种 God adapter 名称。被 `SessionConfig.god` 字段引用。

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

God adapter 的执行选项。相比 `ExecOptions` 更严格，核心字段均为必填。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cwd` | `string` | 是 | 工作目录 |
| `systemPrompt` | `string` | 是 | 系统提示词 |
| `timeoutMs` | `number` | 是 | 超时时间（毫秒） |
| `model` | `string` | 否 | God adapter 的 model override（如 `'claude-opus-4-6'`） |

**与 `ExecOptions` 的差异**：`GodExecOptions` 不支持 `env`、`replaceEnv`、`permissionMode`、`disableTools` 字段，且 `systemPrompt` 和 `timeoutMs` 均为必填。新增 `model` 可选字段用于 model override。

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
| `clearSession()` | `void` (可选方法) | 清除会话状态，强制下一次 execute 使用新会话 |

**与 `CLIAdapter` 的对比**：

| 差异点 | `CLIAdapter` | `GodAdapter` |
|--------|-------------|-------------|
| 执行选项 | `ExecOptions` | `GodExecOptions` |
| 工具策略 | 无 | `toolUsePolicy` |
| 超时下限 | 无 | `minimumTimeoutMs` |
| 会话清除 | 无 | `clearSession()` |
| 输出类型 | `AsyncIterable<OutputChunk>` | `AsyncIterable<OutputChunk>`（共享） |

---

## god-schemas.ts — God LLM 任务分析 Schema

本文件定义任务类型枚举和 God 的任务意图解析结构。使用 Zod 定义 schema，同时导出 Zod schema 对象（用于运行时校验）和推断的 TypeScript 类型（用于编译时类型检查）。

### `TaskTypeSchema` / `DispatchTypeSchema`

4 种任务类型枚举（简化前为 6 种，移除了 `review` 和 `compound`）：

| 值 | 含义 |
|----|------|
| `explore` | 探索性任务 |
| `code` | 编码任务 |
| `debug` | 调试任务 |
| `discuss` | 讨论任务 |

`DispatchTypeSchema` 与 `TaskTypeSchema` 使用相同枚举值，语义上用于 `SendToCoder` action 的 `dispatchType` 字段。

### `GodTaskAnalysis` — 任务意图解析

God 对用户任务的分析结果。

| 字段 | 类型 | 说明 |
|------|------|------|
| `taskType` | `TaskType` | 任务类型（4 种之一） |
| `reasoning` | `string` | 推理过程 |
| `confidence` | `number` (0-1) | 分析置信度 |

简化说明：移除了旧版的 `phases` 字段和 `Phase` 子结构。不再支持 `compound` 任务类型拆分为多阶段。

### 导出的 TypeScript 类型

```ts
type TaskType = z.infer<typeof TaskTypeSchema>;
type DispatchType = z.infer<typeof DispatchTypeSchema>;
type GodTaskAnalysis = z.infer<typeof GodTaskAnalysisSchema>;
```

---

## god-actions.ts — GodAction 结构化动作目录

定义 Sovereign God Runtime 中 Hand 可执行的所有结构化动作。经过简化，从 11 种精简为 5 种核心 action。

### 5 种 Action Schema

所有 action schema 使用 Zod `z.object()` 定义，通过 `type` 字段的 literal 值实现 discriminated union。

#### `SendToCoder`

向 Coder 发送消息/指令。

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'send_to_coder'` | 动作类型标识 |
| `dispatchType` | `DispatchType` | 派发类型（`explore` / `code` / `debug` / `discuss`） |
| `message` | `string` | 发送给 Coder 的消息内容 |

#### `SendToReviewer`

向 Reviewer 发送消息/指令。

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'send_to_reviewer'` | 动作类型标识 |
| `message` | `string` | 发送给 Reviewer 的消息内容 |

#### `AcceptTask`

接受/完成任务。

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'accept_task'` | 动作类型标识 |
| `summary` | `string` | 完成摘要 |

#### `Wait`

等待一段时间后再继续。

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'wait'` | 动作类型标识 |
| `reason` | `string` | 等待原因 |
| `estimatedSeconds` | `number?` | 预估等待秒数 |

#### `RequestUserInput`

向用户请求输入/确认。

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'request_user_input'` | 动作类型标识 |
| `question` | `string` | 向用户提出的问题 |

### 已移除的 Action（简化前为 11 种）

以下 6 种 action 在简化重构中被移除：

| 旧 Action | 说明 |
|-----------|------|
| `stop_role` | 停止指定角色执行 |
| `retry_role` | 重试指定角色执行 |
| `switch_adapter` | 切换角色的 adapter |
| `set_phase` | 设置 compound 任务阶段 |
| `resume_after_interrupt` | 中断恢复策略选择 |
| `emit_summary` | 输出摘要 |

### `GodAction` — Discriminated Union

```ts
type GodAction = z.infer<typeof GodActionSchema>;
```

5 种 action 的 discriminated union 类型，以 `type` 字段为判别器。`GodActionSchema` 使用 `z.discriminatedUnion('type', [...])` 构建，运行时通过 `type` 字段自动路由到对应的 schema 进行校验。

### 导出的 TypeScript 类型

```ts
type SendToCoder = z.infer<typeof SendToCoderSchema>;
type SendToReviewer = z.infer<typeof SendToReviewerSchema>;
type AcceptTask = z.infer<typeof AcceptTaskSchema>;
type Wait = z.infer<typeof WaitSchema>;
type RequestUserInput = z.infer<typeof RequestUserInputSchema>;
type GodAction = z.infer<typeof GodActionSchema>;
```

---

## god-envelope.ts — GodDecisionEnvelope 简化决策信封

> **架构设计**：将 God 的所有决策统一为单一信封格式。核心设计原则：**action 与 message 分离，状态变化仅通过 Hand（action）执行**。

简化后移除了 `Authority`、`AutonomousResolution` 和 `superRefine` 语义约束。信封结构更加扁平直接。

### `Diagnosis` — 情境诊断

God 对当前状态的分析判断。

| 字段 | 类型 | 说明 |
|------|------|------|
| `summary` | `string` | 当前情况摘要 |
| `currentGoal` | `string` | 当前目标 |
| `notableObservations` | `string[]` | 值得关注的观测记录 |

简化说明：移除了旧版的 `currentPhaseId` 字段（与 compound 任务阶段系统一并移除）。

### `EnvelopeMessageTarget`

```ts
type EnvelopeMessageTarget = 'coder' | 'reviewer' | 'user' | 'system_log';
```

消息目标：发送给 Coder、Reviewer、用户或写入系统日志。

### `EnvelopeMessage` — 信封消息

Envelope 内嵌的消息条目。与 `GodAction` 不同，消息不触发状态变更，仅用于传递信息。

| 字段 | 类型 | 说明 |
|------|------|------|
| `target` | `EnvelopeMessageTarget` | 消息目标 |
| `content` | `string` | 消息内容 |

### `GodDecisionEnvelope` — 统一决策信封

God 每次决策的完整输出结构。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `diagnosis` | `Diagnosis` | 是 | 情境诊断 |
| `actions` | `GodAction[]` | 是 | 要执行的动作列表（来自 `god-actions.ts`，5 种 action） |
| `messages` | `EnvelopeMessage[]` | 是 | 附带的消息列表 |

### 已移除的结构（简化前）

| 旧结构 | 说明 |
|--------|------|
| `Authority` | 权限声明（`userConfirmation` / `reviewerOverride` / `acceptAuthority`） |
| `AutonomousResolution` | God 代理决策记录（`question` / `choice` / `reflection` / `finalChoice`） |
| `superRefine` 约束 | 4 条权限语义约束（override 必须留下审计记录等） |

### 导出的 TypeScript 类型

```ts
type Diagnosis = z.infer<typeof DiagnosisSchema>;
type EnvelopeMessage = z.infer<typeof EnvelopeMessageSchema>;
type EnvelopeMessageTarget = z.infer<typeof EnvelopeMessageTargetSchema>;
type GodDecisionEnvelope = z.infer<typeof GodDecisionEnvelopeSchema>;
```

---

## observation.ts — Observation 归一化类型系统

定义 Sovereign God Runtime 的观测事件归一化类型。所有来自 Coder、Reviewer、Human 和 Runtime 的事件均被统一为 `Observation` 结构，作为 God 决策的输入。

简化后观测类型从 13 种精简为 6 种，移除了 Classifier 相关类型，仅保留运行时实际产生的观测类型。

### `OBSERVATION_TYPES` 常量

6 种观测类型的 `as const` 数组，作为 `ObservationTypeSchema` 的基础。

### `ObservationType` — 6 种观测类型

```ts
type ObservationType = typeof OBSERVATION_TYPES[number];
```

| 值 | 含义 | 典型来源 |
|----|------|----------|
| `work_output` | 工作产出（Coder 的代码输出） | coder |
| `review_output` | 审查产出（Reviewer 的反馈） | reviewer |
| `human_message` | 用户消息 | human |
| `human_interrupt` | 用户中断 | human |
| `runtime_error` | 运行时错误 | runtime |
| `phase_progress_signal` | 阶段进度信号 | runtime |

### 已移除的观测类型（简化前为 13 种）

| 旧类型 | 说明 |
|--------|------|
| `quota_exhausted` | API 配额耗尽 |
| `auth_failed` | 认证失败 |
| `adapter_unavailable` | Adapter 不可用 |
| `empty_output` | 空输出 |
| `meta_output` | 元信息输出 |
| `tool_failure` | 工具调用失败 |
| `clarification_answer` | 用户澄清回答 |
| `runtime_invariant_violation` | 运行时不变量违规 |

### `ObservationSource` — 观测来源

```ts
type ObservationSource = 'coder' | 'reviewer' | 'god' | 'human' | 'runtime';
```

| 值 | 说明 |
|----|------|
| `coder` | 来自 Coder adapter |
| `reviewer` | 来自 Reviewer adapter |
| `god` | 来自 God 自身 |
| `human` | 来自用户操作 |
| `runtime` | 来自运行时系统 |

### `ObservationSeverity` — 严重程度

```ts
type ObservationSeverity = 'info' | 'warning' | 'error' | 'fatal';
```

4 级严重程度，schema 中默认值为 `'info'`。

### `Observation` — 归一化观测事件

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `source` | `ObservationSource` | 是 | 观测来源 |
| `type` | `ObservationType` | 是 | 观测类型（6 种之一） |
| `summary` | `string` | 是 | 事件摘要 |
| `rawRef` | `string` | 否 | 原始数据引用（文件路径或 ID） |
| `severity` | `ObservationSeverity` | 否 | 严重程度（默认 `'info'`） |
| `timestamp` | `string` | 是 | ISO 时间戳 |
| `adapter` | `string` | 否 | 产生该观测的 adapter 名称 |

简化说明：移除了旧版的 `phaseId` 字段（与 compound 任务阶段系统一并移除）。

### `isWorkObservation(obs: Observation): boolean`

Type guard 函数。判断一个 Observation 是否为工作产出类型：仅 `work_output` 和 `review_output` 返回 `true`，其余 4 种类型均返回 `false`。

---

## degradation.ts — 向后兼容错误类型

> 保留最小类型定义以兼容已保存的 session 数据。旧 session 中可能存在的 `degradationState` 字段会被静默忽略。

### `GodErrorKind`

```ts
type GodErrorKind = 'process_exit' | 'timeout' | 'parse_failure' | 'schema_validation';
```

God 运行时可能遇到的 4 种错误类型：

| 值 | 含义 |
|----|------|
| `process_exit` | God 进程异常退出 |
| `timeout` | God 调用超时 |
| `parse_failure` | God 输出解析失败 |
| `schema_validation` | God 输出 schema 校验失败 |

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
                   ┌─────────────────────┐
                   │  RoleName            │
                   │  RoleStyle           │
                   │  ROLE_STYLES         │
                   │  getRoleStyle()      │
                   │  MessageMetadata     │
                   │  Message             │
                   │  ScrollState         │
                   └─────────────────────┘

              god-schemas.ts                    god-actions.ts
           ┌─────────────────────┐     ┌──────────────────────────┐
           │  TaskTypeSchema (4种) │     │  SendToCoderSchema        │
           │  DispatchTypeSchema  │     │  SendToReviewerSchema     │
           │  GodTaskAnalysis     │     │  AcceptTaskSchema         │
           └─────────────────────┘     │  WaitSchema               │
                                       │  RequestUserInputSchema   │
              god-envelope.ts          │                            │
           ┌─────────────────────┐     │  GodActionSchema (5种)    │
           │  DiagnosisSchema     │     └──────────────────────────┘
           │  EnvelopeMessageSchema│
           │  GodDecisionEnvelope─┼──(actions)──► GodActionSchema
           └─────────────────────┘

              observation.ts                  degradation.ts
           ┌─────────────────────┐     ┌─────────────────────────┐
           │  ObservationType (6种) │     │  GodErrorKind           │
           │  ObservationSource   │     └─────────────────────────┘
           │  ObservationSeverity │
           │  Observation         │
           │  isWorkObservation() │
           └─────────────────────┘
```

### 关键依赖关系

- **session.ts -> god-adapter.ts**：`SessionConfig.god` 字段的类型为 `GodAdapterName`
- **god-adapter.ts -> adapter.ts**：`GodAdapter.execute()` 返回 `AsyncIterable<OutputChunk>`（共享 `OutputChunk` 类型）
- **god-envelope.ts -> god-actions.ts**：`GodDecisionEnvelopeSchema.actions` 引用 `GodActionSchema`
- **god-actions.ts -> god-schemas.ts**：`SendToCoderSchema.dispatchType` 引用 `DispatchTypeSchema`
- **god-schemas.ts**：仅依赖外部库 `zod`
- **observation.ts**：独立于其他类型文件，仅依赖外部库 `zod`
- **degradation.ts**：完全独立，无外部依赖
- **ui.ts**：独立于其他类型文件，无跨文件类型依赖

### 核心数据流向

1. **启动阶段**：`StartArgs` -> 验证 -> `SessionConfig`（含 `GodAdapterName` + 可选 model override）-> 传入 `App`
2. **恢复阶段**：持久化数据 -> 重建 `SessionConfig` -> `sanitizeGodAdapterForResume()` 校验 God adapter -> 传入 `App`
3. **运行阶段**：`CLIAdapter.execute()` / `GodAdapter.execute()` 产生 `OutputChunk` 流 -> 转化为 `Message` 显示在 TUI
4. **观测归一化**：CLI 原始输出 / Runtime 事件 / 用户操作 -> 归一化为 `Observation`（6 种类型）-> 作为 God 决策输入
5. **God 决策**：`Observation` -> God LLM -> `GodDecisionEnvelope`（含 `Diagnosis` + `GodAction[]` + `EnvelopeMessage[]`）
6. **动作执行**：`GodAction[]`（5 种 action）-> Hand 逐一执行 -> 状态变更（发送消息、接受任务、等待、请求输入）
7. **展示阶段**：`Message.role`（`RoleName`）-> `getRoleStyle()` -> `RoleStyle` 视觉样式；`ScrollState` 管理滚动
