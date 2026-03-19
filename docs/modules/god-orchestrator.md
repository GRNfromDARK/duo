# God LLM 编排器模块

## 1. 模块概述

### God LLM 的角色

God LLM 是 Duo 系统中的编排层。在 Coder/Reviewer 双方协作模式之上，God 作为**路由决策者**，通过 **Observe -> Decide -> Act** 管线驱动运行时：

- **路由决策**：通过 `GodDecisionService.makeDecision(observations, context)` 单入口生成 `GodDecisionEnvelope`
- **5 种 Action**：`send_to_coder`、`send_to_reviewer`、`accept_task`、`wait`、`request_user_input` —— 无 rule engine 校验，直接执行
- **dispatchType 路由**：`send_to_coder` 携带 `dispatchType`（explore/code/debug/discuss），控制 Coder 的工作模式
- **消息分发**：自然语言消息通道将 envelope 中的 messages 路由到 coder/reviewer/user/system_log，不触发状态变化
- **观察工厂**：Worker/Human/Runtime 输出通过 `observation-factory.ts` 创建为 `Observation`，God 直接解读内容，无预分类
- **可靠性**：WatchdogService 实现 retry + backoff + pause，God 不可用时系统暂停而非降级

### 简化要点（相对旧架构）

| 移除项 | 说明 |
|--------|------|
| phases/compound 任务 | 不再有 phase plan、phase 切换、compound task type |
| authority 字段 | envelope 无 `authority`，无 `reviewerOverride`/`acceptAuthority`/`userConfirmation` |
| autonomousResolutions | 无 God 代理决策的三步反思流程 |
| rule engine 集成 | Hand executor 不再调用 rule engine（rule-engine.ts 独立存在但不在 action 执行路径上） |
| observation-classifier | regex 预分类删除，由 observation-factory.ts 替代，God 直接解读原始内容 |
| task-init | 任务分类初始化流程删除 |
| god-system-prompt.ts | 专用 TASK_INIT system prompt 删除 |
| interrupt-clarifier | 人类中断意图分类删除 |
| observation-integration | 集成层删除 |
| 11 种 action | 简化为 5 种（移除 stop_role/retry_role/switch_adapter/set_phase/resume_after_interrupt/emit_summary） |

### 核心循环：Observe -> Decide -> Act

```
┌────────────────────────────────────────────────────────────────┐
│                        Observe                                  │
│  Worker Output → observation-factory → Observation              │
│  Human Input   → observation-factory → Observation              │
│  Runtime Error → observation-factory → Observation              │
└───────────────────────┬────────────────────────────────────────┘
                        ↓
┌────────────────────────────────────────────────────────────────┐
│                        Decide                                   │
│  Observation[] → GodDecisionService.makeDecision()             │
│                 → GodDecisionEnvelope {                         │
│                     diagnosis, actions, messages                │
│                   }                                             │
│  失败时 → Watchdog retry + backoff → fallback envelope         │
└───────────────────────┬────────────────────────────────────────┘
                        ↓
┌────────────────────────────────────────────────────────────────┐
│                         Act                                     │
│  envelope.actions  → HandExecutor → Observation[]              │
│  envelope.messages → MessageDispatcher → pending / UI / log    │
└────────────────────────────────────────────────────────────────┘
```

### 文件清单

**类型定义（4 个文件）**
- `src/types/god-schemas.ts` — TaskType / DispatchType / GodTaskAnalysis Zod schema
- `src/types/god-actions.ts` — 5 种 GodAction 的 Zod schema
- `src/types/god-envelope.ts` — GodDecisionEnvelope 类型（简化版，无 authority）
- `src/types/observation.ts` — Observation 类型系统（6 种观察类型）

**Adapter 层（5 个文件）**
- `src/god/god-adapter-config.ts` — adapter 配置与解析
- `src/god/god-adapter-factory.ts` — adapter 工厂
- `src/god/adapters/claude-code-god-adapter.ts` — Claude Code 实现
- `src/god/adapters/codex-god-adapter.ts` — Codex 实现
- `src/god/adapters/gemini-god-adapter.ts` — Gemini CLI 实现

**调用链（2 个文件）**
- `src/god/god-call.ts` — God adapter 统一调用入口
- `src/god/god-prompt-generator.ts` — Coder/Reviewer prompt 动态生成（基于 dispatchType）

**统一决策管线（3 个文件）**
- `src/god/god-decision-service.ts` — 统一决策服务（含 system prompt、prompt 构建）
- `src/god/hand-executor.ts` — Hand 执行器，执行 5 种 GodAction
- `src/god/message-dispatcher.ts` — 消息分发器，路由 EnvelopeMessage[]

**观察系统（1 个文件）**
- `src/god/observation-factory.ts` — 观察创建工厂（替代已删除的 observation-classifier）

**会话管理（2 个文件）**
- `src/god/tri-party-session.ts` — 三方会话管理
- `src/god/god-session-persistence.ts` — God 会话持久化（兼容性接口，始终返回 null）

**可靠性（1 个文件）**
- `src/god/watchdog.ts` — retry + backoff + pause 机制

**安全（1 个文件）**
- `src/god/rule-engine.ts` — 不可委托场景规则引擎（独立存在，不在 action 执行路径上）

**审计（1 个文件）**
- `src/god/god-audit.ts` — 审计日志（append-only JSONL + 决策归档）

---

## 2. 类型基础设施

### 2.1 `src/types/observation.ts` — Observation 类型系统

简化后仅保留 6 种运行时实际产生的观察类型，移除了 classifier 时代的细粒度分类（quota_exhausted、auth_failed、adapter_unavailable 等）。

```typescript
type ObservationType =
  | 'work_output'             // Coder 工作输出
  | 'review_output'           // Reviewer 审查输出
  | 'human_message'           // 人类文本输入
  | 'human_interrupt'         // 人类 Ctrl+C 中断
  | 'runtime_error'           // 运行时错误（替代旧的 tool_failure）
  | 'phase_progress_signal'   // Hand 执行结果信号

type ObservationSource = 'coder' | 'reviewer' | 'god' | 'human' | 'runtime';
type ObservationSeverity = 'info' | 'warning' | 'error' | 'fatal';

interface Observation {
  source: ObservationSource;
  type: ObservationType;
  summary: string;
  rawRef?: string;
  severity: ObservationSeverity;  // 默认 'info'
  timestamp: string;
  adapter?: string;
}
```

关键函数：`isWorkObservation(obs)` — 仅 `work_output` 和 `review_output` 返回 `true`。

**设计理念**：不再在运行时做 regex 预分类（quota/auth/empty/meta 等），God 直接阅读 worker 原始输出并自行判断情况。

### 2.2 `src/types/god-actions.ts` — 5 种 GodAction

使用 Zod discriminated union 定义 5 种结构化 action：

| Action | 参数 | 用途 |
|--------|------|------|
| `send_to_coder` | `dispatchType, message` | 向 Coder 发送工作指令，dispatchType 控制工作模式 |
| `send_to_reviewer` | `message` | 向 Reviewer 发送审查指令 |
| `accept_task` | `summary` | 任务完成 |
| `wait` | `reason, estimatedSeconds?` | 进入等待状态 |
| `request_user_input` | `question` | 请求人类输入 |

**`dispatchType`** 是此次简化的核心设计：

| dispatchType | 语义 | 文件变更 |
|-------------|------|---------|
| `explore` | 只读调查，不修改文件 | 禁止 |
| `discuss` | 评估方案，提供建议 | 禁止 |
| `code` | 实现、重构、写测试 | 允许 |
| `debug` | 诊断并最小化修复 | 窄范围允许 |

### 2.3 `src/types/god-envelope.ts` — GodDecisionEnvelope

简化后的 God 决策输出格式，**移除了 authority 和 autonomousResolutions**：

```typescript
interface GodDecisionEnvelope {
  diagnosis: {
    summary: string;               // 简要情势评估
    currentGoal: string;           // 当前目标
    notableObservations: string[]; // 驱动此决策的关键观察
  };
  actions: GodAction[];            // 5 种 Hand actions
  messages: EnvelopeMessage[];     // NL 消息通道
}

interface EnvelopeMessage {
  target: 'coder' | 'reviewer' | 'user' | 'system_log';
  content: string;
}
```

无 `superRefine` 跨字段约束 —— 因为 authority 字段已移除，不再需要 "override 必须有 system_log" 等校验。

### 2.4 `src/types/god-schemas.ts` — TaskType / DispatchType

```typescript
type TaskType = 'explore' | 'code' | 'debug' | 'discuss';  // 4 种，移除了 compound 和 review
type DispatchType = 'explore' | 'code' | 'debug' | 'discuss';  // 与 TaskType 相同

interface GodTaskAnalysis {
  taskType: TaskType;
  reasoning: string;
  confidence: number;  // 0.0 ~ 1.0
}
```

不再有 `phases` 字段和 compound 类型约束。

---

## 3. God Adapter 层

### 3.1 `src/god/god-adapter-config.ts` — Adapter 配置与解析

支持的 God adapter：`['claude-code', 'codex', 'gemini']`。

导出函数：
- `isSupportedGodAdapterName(name)` — 类型守卫
- `getInstalledGodAdapters(detected)` — 从已检测 CLI 列表过滤已安装的 God adapter
- `resolveGodAdapterForStart(reviewer, detected, explicitGod?)` — 启动时解析 God adapter
- `sanitizeGodAdapterForResume(reviewer, detected, persistedGod?)` — resume 时恢复 God adapter

**解析优先级**：
1. 用户显式 `--god` 参数 -> 校验是否支持且已安装
2. reviewer 同名 adapter
3. 自动选择已安装 fallback，优先 `claude-code`

### 3.2 `src/god/god-adapter-factory.ts` — Adapter 工厂

```typescript
function createGodAdapter(name: string): GodAdapter
```

简单工厂，根据名称创建 `ClaudeCodeGodAdapter`、`CodexGodAdapter` 或 `GeminiGodAdapter` 实例。

### 3.3 三种 Adapter 实现

**Claude Code** (`claude-code-god-adapter.ts`)
- `toolUsePolicy = 'forbid'` — 禁止工具调用
- 使用 `ProcessManager` + `StreamJsonParser`
- 构建参数：`-p prompt --output-format stream-json --verbose --dangerously-skip-permissions --system-prompt ... --tools '' --add-dir cwd`
- 会话恢复：支持 `--resume sessionId`
- 环境变量：仅保留 `ANTHROPIC_`、`CLAUDE_` 前缀，删除 `CLAUDECODE` 避免递归

**Codex** (`codex-god-adapter.ts`)
- `toolUsePolicy = 'allow-readonly'` — 允许只读工具
- `minimumTimeoutMs = 600_000`
- 使用 `ProcessManager` + `JsonlParser`
- 通过 `buildCodexGodPrompt()` 前置 `SYSTEM EXECUTION MODE` 声明
- `--full-auto --ephemeral` 模式（无会话恢复）
- 环境变量：仅保留 `OPENAI_` 前缀

**Gemini CLI** (`gemini-god-adapter.ts`)
- `toolUsePolicy = 'forbid'`
- 使用 `ProcessManager` + `StreamJsonParser`
- 通过 `buildGeminiGodPrompt()` 前置包装（resume 轮直接发送用户 prompt）
- 会话恢复：支持 `--resume sessionId`
- 环境变量：仅保留 `GOOGLE_`、`GEMINI_` 前缀

**三种 adapter 对比**：

| 特性 | Claude Code | Codex | Gemini |
|------|-------------|-------|--------|
| Tool Policy | forbid | allow-readonly | forbid |
| Min Timeout | 无 | 600s | 无 |
| 会话恢复 | 支持 (--resume) | 不支持 (--ephemeral) | 支持 (--resume) |
| 输出格式 | stream-json | JSONL | stream-json |
| Prompt 包装 | 原生 system-prompt 参数 | 前置 SYSTEM EXECUTION MODE | 首轮前置包装，resume 轮直接发送 |
| 环境变量前缀 | ANTHROPIC_, CLAUDE_ | OPENAI_ | GOOGLE_, GEMINI_ |

---

## 4. 调用链

### 4.1 `src/god/god-call.ts` — 统一调用入口

```typescript
interface GodCallOptions {
  adapter: GodAdapter;
  prompt: string;
  systemPrompt: string;
  projectDir?: string;
  timeoutMs: number;
  model?: string;
  logging?: GodCallLoggingOptions;
}

async function collectGodAdapterOutput(options): Promise<string>
```

核心逻辑：
- 使用 `Math.max(timeoutMs, adapter.minimumTimeoutMs)` 确保不低于 adapter 最低超时
- 可选 `logging` 参数写入 prompt-log
- 流式消费 adapter 输出，收集 `text`/`code`/`error` 类型 chunk
- 对 `tool_use`/`tool_result` chunk：`forbid` policy 时抛错，`allow-readonly` policy 时跳过
- `finally` 块确保进程清理

### 4.2 `src/god/god-prompt-generator.ts` — Coder/Reviewer Prompt 动态生成

基于 **dispatchType** 而非旧的 taskType/phaseType 组合。移除了 phases 信息、blocking issues 提取（`extractBlockingIssues`）和 propose-first 两阶段模式。

**`generateCoderPrompt(ctx: PromptContext, audit?: AuditOptions): string`**

按优先级组装 prompt：
1. **Worker 角色声明**：Coder 为纯执行者，无 accept authority；语言规则（使用与任务描述相同的语言回复）
2. **Task goal**
3. **God instruction**（最高优先级，如有）
4. **Reviewer Feedback**（如有 `lastReviewerOutput`，直传 Reviewer 原始分析）
5. **策略指令**：按 `dispatchType` 选择对应模板

策略指令模板（4 种）：

| dispatchType | 指令要点 |
|-------------|---------|
| `explore` | 分析代码库，不修改文件，推荐方案但不执行 |
| `code` | 实现变更，写测试，自主决策，不提问 |
| `debug` | 诊断根因，最小化修复，验证无副作用 |
| `discuss` | 评估方案优劣，权衡利弊，提供建议 |

可选 `audit` 参数触发 `PROMPT_GENERATION` 类型审计日志写入。

**`generateReviewerPrompt(ctx): string`**

1. **Worker 角色声明**：Reviewer 为观察提供者，verdict 仅供参考；语言规则（使用与任务描述相同的语言回复）
2. **Task goal**
3. **God instruction**（如有）
4. **Coder Output**
5. **Review Instructions**：识别 blocking issues 和 non-blocking suggestions
6. **Verdict Rules**：零 blocking issue 必须 approve，不因风格偏好阻塞

---

## 5. 统一决策管线

### 5.1 `src/god/god-decision-service.ts` — 统一决策服务

**`GodDecisionService` 类**——核心决策引擎：

```typescript
class GodDecisionService {
  constructor(adapter: GodAdapter, watchdog: WatchdogService, model?: string);
  async makeDecision(
    observations: Observation[],
    context: GodDecisionContext,
    isResuming?: boolean,
  ): Promise<GodDecisionEnvelope>;
}
```

**`GodDecisionContext`**（简化版）：

```typescript
interface GodDecisionContext {
  taskGoal: string;
  availableAdapters: string[];
  activeRole: 'coder' | 'reviewer' | null;
  sessionDir: string;
}
```

相比旧版移除了 `currentPhaseId`、`currentPhaseType`、`phases`、`previousDecisions`。

**决策流程**：

1. **调用 God** — 构建 prompt，通过 `collectGodAdapterOutput()` 发起请求（timeout 600s），用 `GodDecisionEnvelopeSchema` 验证输出
2. **God 成功** -> `watchdog.handleSuccess()` 重置计数，返回 envelope
3. **God 失败** -> 检查 `watchdog.shouldRetry()`
   - 可重试 -> exponential backoff 后清除 adapter 会话，重试一次
   - 重试成功 -> 返回 envelope
   - 重试失败或不可重试 -> 返回 fallback envelope（含 wait action）

**System Prompt**：

`SYSTEM_PROMPT` 常量定义了简洁的 God 角色指令：

- 角色：Duo runtime 的 God 编排器
- 职责：在 coder 和 reviewer 之间路由工作直到任务完成
- 5 种 action 及其语义
- 语言规则：始终使用与用户任务描述相同的语言回复
- 指导原则：多方案先送 reviewer、承认 reviewer 反馈、反思后才 accept、循环时换策略、不轻易求助用户
- 输出格式：单个 JSON code block

**Prompt 构建**：

**`buildUserPrompt(observations, context)`** — 完整 prompt（首次调用）：
- Task Goal
- Active Role
- Available Adapters
- Observations section（按 severity 排序）
- Hand Catalog（5 种 action 的可读说明）

**`buildResumePrompt(observations)`** — 精简 prompt（resume 迭代）：
- 仅包含 Observations + 格式提醒

**文本处理工具函数**：
- `stripAnsiEscapes()` — 清除终端控制码
- `stripToolMarkers()` — 去除 `[Read]`、`[Bash]` 等 tool 标记噪声
- `buildObservationsSection()` — 按 severity 排序，work observation 去除 tool markers

**Fallback Envelope**：

God 失败时生成包含 `wait` action 的 fallback envelope，防止空 actions 死循环。

### 5.2 `src/god/hand-executor.ts` — Hand 执行器

```typescript
async function executeActions(
  actions: GodAction[],
  context: HandExecutionContext
): Promise<Observation[]>
```

**简化版**：逐条顺序执行，**不调用 rule engine**，直接执行。失败时生成 `runtime_error` observation。

**`HandExecutionContext`**：

```typescript
interface HandExecutionContext {
  pendingCoderMessage: string | null;
  pendingCoderDispatchType: string | null;  // NEW: 记录 dispatchType
  pendingReviewerMessage: string | null;
  auditLogger: GodAuditLogger | null;
  taskCompleted: boolean;
  waitState: { active: boolean; reason: string | null; estimatedSeconds: number | null };
  clarificationState: { active: boolean; question: string | null };
  sessionDir: string;
  cwd: string;
}
```

相比旧版移除了 `currentPhaseId`、`adapters` map、`activeRole`、`interruptResumeStrategy`、`adapterConfig`、`envelopeMessages`。新增了 `pendingCoderDispatchType`。

**各 action 执行器**：

| Action | 副作用 | 审计 |
|--------|--------|------|
| `send_to_coder` | 设置 `pendingCoderMessage` + `pendingCoderDispatchType` | - |
| `send_to_reviewer` | 设置 `pendingReviewerMessage` | - |
| `accept_task` | 设置 `taskCompleted = true` | 写入 `accept_task` 审计 |
| `wait` | 设置 `waitState` | - |
| `request_user_input` | 设置 `clarificationState` | - |

### 5.3 `src/god/message-dispatcher.ts` — 消息分发器

**关键约束**：消息分发 **不得** 触发任何状态变化。

```typescript
function dispatchMessages(messages: EnvelopeMessage[], context: DispatchContext): DispatchResult

interface DispatchResult {
  pendingCoderMessage: string | null;
  pendingReviewerMessage: string | null;
}
```

**分发规则**：

| target | 处理方式 |
|--------|---------|
| `coder` | 返回在 `result.pendingCoderMessage` 中（多条合并换行） |
| `reviewer` | 返回在 `result.pendingReviewerMessage` 中 |
| `user` | 通过 `formatGodMessage()` 格式化后 `displayToUser()` |
| `system_log` | 写入 `god-audit.jsonl`（`message_dispatch` 类型） |

`dispatchMessages()` 是纯函数，返回新值由调用方应用。

---

## 6. 观察系统

### `src/god/observation-factory.ts` — 观察工厂

替代已删除的 `observation-classifier.ts`。不再做 regex 预分类，God 直接解读原始内容。

```typescript
function createWorkObservation(llmText: string, source: ObservationSource): Observation
function createHumanObservation(text: string, type?: 'human_message' | 'human_interrupt'): Observation
function createRuntimeErrorObservation(errorMessage: string): Observation
function deduplicateObservations(observations: Observation[]): Observation[]
```

**设计理念**：

旧 classifier 使用 regex 检测 quota/auth/empty/meta 等错误类型并预分类。简化后的设计认为 God LLM 本身就能理解这些情况，无需预分类层。observation-factory 只负责创建正确格式的 Observation 对象。

- `createWorkObservation` — reviewer source 自动标记为 `review_output`，其他为 `work_output`
- `createHumanObservation` — 默认 `human_message`，可选 `human_interrupt`
- `createRuntimeErrorObservation` — 统一为 `runtime_error`（替代旧的 quota_exhausted/auth_failed/adapter_unavailable/tool_failure 等）
- `deduplicateObservations` — 使用 `timestamp+source+type` 去重

---

## 7. 可靠性保障

### `src/god/watchdog.ts` — WatchdogService

核心原则：**LLM 下线 = 系统暂停，而非降级模式**。

```typescript
class WatchdogService {
  static readonly MAX_RETRIES = 3;

  handleSuccess(): void;        // 重置失败计数和 paused 状态
  shouldRetry(): boolean;       // 记录失败，返回是否应重试
  getBackoffMs(): number;       // Exponential backoff: 2s, 4s, 8s (上限 10s)
  isPaused(): boolean;
  isGodAvailable(): boolean;    // 等同于 !isPaused()
  reset(): void;                // 用户选择重试后调用
  getConsecutiveFailures(): number;
}
```

**行为**：
- 每次 God 调用失败时调用 `shouldRetry()`，递增 `consecutiveFailures`
- `<= MAX_RETRIES (3)` 时返回 true
- 超过 3 次连续失败 -> `paused = true`
- God 调用成功 -> `handleSuccess()` 重置所有状态

**与 GodDecisionService 的协作**：
1. God 调用失败
2. `watchdog.shouldRetry()` 判断是否重试
3. 是 -> `watchdog.getBackoffMs()` 获取等待时间，`adapter.clearSession()` 清除污染会话，重试
4. 否 -> 返回 fallback envelope（含 wait action）

---

## 8. Rule Engine

### `src/god/rule-engine.ts` — 不可委托场景规则引擎

同步规则引擎，< 5ms，无 LLM 调用。**独立存在，不在 Hand executor 的 action 执行路径上**。

```typescript
interface ActionContext {
  type: 'file_write' | 'command_exec' | 'config_modify';
  path?: string;
  command?: string;
  cwd: string;
  godApproved?: boolean;
}

function evaluateRules(action: ActionContext): RuleEngineResult
```

**5 条规则**：

| ID | 级别 | 描述 |
|----|------|------|
| R-001 | block | 文件写入必须在 `~/Documents` 目录内 |
| R-002 | block | 禁止访问系统关键目录（/etc, /usr, /bin, /System, /Library） |
| R-003 | block | 检测可疑网络外传（`curl -d @file` 模式） |
| R-004 | warn | God 批准 vs rule engine block 矛盾 |
| R-005 | warn | Coder 修改 `.duo/` 配置 |

路径解析使用 `realpathSync` 解析符号链接，防止 symlink 绕过。

---

## 9. 审计日志

### `src/god/god-audit.ts` — 审计日志

Append-only JSONL 格式。

```typescript
interface GodAuditEntry {
  seq: number;
  timestamp: string;
  decisionType: string;
  inputSummary: string;     // <= 2000 chars
  outputSummary: string;    // <= 2000 chars
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  decision: unknown;
  model?: string;
  outputRef?: string;       // god-decisions/ 中的完整输出引用
}
```

**两种 API**：

**`appendAuditLog(sessionDir, entry)`** — 兼容函数，直接追加条目

**`GodAuditLogger` 类** — 带 seq 追踪和 outputRef 支持：
- `append(entry, fullOutput?)` — 自动递增 seq（3 位 0 填充），可选存储完整输出到 `god-decisions/`
- `getEntries(filter?)` — 读取所有条目，可按 `decisionType` 过滤
- `getSequence()` — 获取当前 seq
- 构造时从已有日志文件恢复 seq

**专项审计函数**：

- **`logEnvelopeDecision(logger, params)`** — 记录完整 God 决策上下文（observations、diagnosis、actions、messages、execution results），完整归档存储在 `god-decisions/`
- **`logReviewerOverrideAudit(logger, params)`** — 记录 reviewer 原始结论 + God 最终裁定
- **`logIncidentAudit(logger, params)`** — 记录 incident 响应

**`cleanupOldDecisions(dir, maxSizeMB)`** — `god-decisions/` 目录超限时清理最旧文件（上限 50MB）。

---

## 10. 会话管理

### 10.1 `src/god/tri-party-session.ts` — 三方会话管理

```typescript
interface TriPartySessionState {
  coderSessionId: string | null;
  reviewerSessionId: string | null;
  godSessionId: string | null;
}
```

- **`extractTriPartyState(state)`** — 从 `SessionState` 提取三方会话 ID，`undefined` 转为 `null`
- **`restoreTriPartySession(triParty, config, adapterFactory)`** — 各 party 独立恢复，一方失败不影响其他，每个 party 获得独立 adapter 实例确保隔离

### 10.2 `src/god/god-session-persistence.ts` — 兼容性接口

```typescript
async function restoreGodSession(state, adapterFactory): Promise<null>
```

始终返回 `null`。实际会话恢复逻辑在各 GodAdapter 实现中（`lastSessionId` / `restoreSessionId` / `clearSession`）。

---

## 11. 集成点

### 统一管线数据流

```
Worker Output → observation-factory → Observation
                                          |
Observation[] → GodDecisionService.makeDecision() → GodDecisionEnvelope
                                                        |
                            +---------------------------+------------------------+
                            |                                                    |
                envelope.actions → HandExecutor → Observation[]    envelope.messages → MessageDispatcher
                                      |                                         |
                            (直接执行，无 rule engine)                (纯函数，无状态变更)
                                      |                                         |
                          phase_progress_signal /                  pendingCoder/ReviewerMessage
                          runtime_error                            displayToUser / auditLog
```

### God 决策上下文传递

```
god-prompt-generator.ts  → Coder/Reviewer prompts（dispatchType 策略模板 + Worker 角色声明）
                                |
god-decision-service.ts  → GodDecisionEnvelope（diagnosis + actions + messages）
                                |
hand-executor.ts         → Observation[]（执行结果）
                                |
god-audit.ts             → god-audit.jsonl + god-decisions/（审计归档）
```

### 故障恢复链

```
God adapter 调用
    |
    +-- 成功 → watchdog.handleSuccess() → 重置计数
    |
    +-- 失败 → watchdog.shouldRetry()
                   |
                   +-- true  → backoff 等待 → clearSession → 重试
                   |               |
                   |               +-- 成功 → handleSuccess() → 返回 envelope
                   |               +-- 失败 → fallback envelope (wait action)
                   |
                   +-- false → fallback envelope (wait action)
                   |
                   +-- 连续 > MAX_RETRIES (3) → paused = true
```
