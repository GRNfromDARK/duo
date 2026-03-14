# God LLM 编排器模块

## 1. 模块概述

### God LLM 的角色

God LLM 是 Duo 系统中的 Sovereign 编排层。在原有的 Coder/Reviewer 双方协作模式之上，God 作为唯一决策者（Sovereign God），通过统一的 **Observation → Decision → Hand** 管线驱动整个运行时：

- **任务分析**：解析用户意图，分类任务类型（explore/code/discuss/review/debug/compound），制定终止条件和动态轮次
- **统一决策**：通过 `GodDecisionService.makeDecision(observations, context)` 单入口生成 `GodDecisionEnvelope`，取代原先分散在 5 个调用点的决策逻辑
- **Hand 执行**：通过结构化 `GodAction[]` 执行状态变更，rule engine 逐条校验，所有状态变化必须 action-backed（NFR-001 / FR-016）
- **消息分发**：自然语言消息通道将 envelope 中的 messages 路由到 coder/reviewer/user/system_log，且不触发任何状态变化
- **观察管线**：Coder/Reviewer/Runtime/Human 的所有输出通过 observation-classifier 归一化为 `Observation`，non-work 输出（quota/auth/empty 等）被拦截不得推进工作流
- **质量保障**：检测 God 自身输出的幻觉、漂移和死循环
- **可靠性**：四级降级策略确保 God 不可用时自动回退

### 架构演进：从五散点到统一管线

| 维度 | 旧五散点模式 | Sovereign God 统一管线 |
|------|-------------|----------------------|
| 决策入口 | routePostCoder / routePostReviewer / evaluateConvergence / makeAutoDecision / classifyTask | `GodDecisionService.makeDecision()` 单入口 |
| 输入格式 | 各调用点拼接不同 prompt | 统一 `Observation[]` 输入 |
| 输出格式 | 5 种不同 JSON schema | 统一 `GodDecisionEnvelope`（diagnosis + authority + actions + messages） |
| 状态变更 | 隐含在 XState 事件映射中 | 显式 `GodAction[]` 经 Hand Executor 执行 |
| 消息通道 | 无独立通道 | 独立 `EnvelopeMessage[]` 分发，保证不触发状态变化 |
| NL/Action 一致性 | 无检查 | `checkNLInvariantViolations()` 检测不一致 |

### 文件清单（28 + 5 = 33 个文件）

**Adapter 层（4 个文件）**
- `src/types/god-adapter.ts` — GodAdapter 接口定义
- `src/god/god-adapter-config.ts` — adapter 配置与解析
- `src/god/god-adapter-factory.ts` — adapter 工厂
- `src/god/adapters/claude-code-god-adapter.ts` — Claude Code 实现
- `src/god/adapters/codex-god-adapter.ts` — Codex 实现

**调用链（3 个文件）**
- `src/god/god-call.ts` — God adapter 统一调用入口
- `src/god/god-system-prompt.ts` — God system prompt 构建
- `src/god/god-prompt-generator.ts` — Coder/Reviewer/God 三方 prompt 动态生成（heavily modified）

**上下文管理（1 个文件）**
- `src/god/god-context-manager.ts` — 增量 prompt 管理 + Observation-based prompt 构建

**统一决策管线（4 个文件, 含 3 个新文件）**
- `src/god/god-decision-service.ts` — 统一决策服务 GodDecisionService（heavily modified）
- `src/god/hand-executor.ts` — **NEW** Hand 执行器，执行 GodAction[] 并返回 Observation[]
- `src/god/message-dispatcher.ts` — **NEW** 消息分发器，路由 EnvelopeMessage[]
- `src/god/observation-integration.ts` — **NEW** 观察集成层，连接 classifier 到各输出源

**观察系统（1 个新文件）**
- `src/god/observation-classifier.ts` — **NEW** 输出分类 + Non-Work Guard + Incident Tracker

**遗留决策（3 个文件，deprecated）**
- `src/god/auto-decision.ts` — GOD_DECIDING 自主决策
- `src/god/god-router.ts` — PostCoder/PostReviewer 路由决策（deprecated，routing 已迁移到 GodDecisionService）
- `src/god/god-convergence.ts` — 收敛判定

**任务管理（3 个文件）**
- `src/god/task-init.ts` — 任务初始化与分类
- `src/god/phase-transition.ts` — compound 任务阶段转换
- `src/god/tri-party-session.ts` — 三方会话管理

**质量保障（3 个文件）**
- `src/god/consistency-checker.ts` — God 输出一致性检查
- `src/god/drift-detector.ts` — God 渐进漂移检测
- `src/god/loop-detector.ts` — 死循环检测

**可靠性（3 个文件）**
- `src/god/degradation-manager.ts` — 四级降级管理
- `src/god/alert-manager.ts` — 异常告警
- `src/god/interrupt-clarifier.ts` — 人类中断意图分类

**持久化与审计（2 个文件）**
- `src/god/god-audit.ts` — 审计日志（append-only JSONL + Envelope Decision Audit）
- `src/god/god-session-persistence.ts` — God 会话持久化

**类型定义（5 个文件，含 3 个新文件）**
- `src/types/god-schemas.ts` — 遗留 God 输出 Zod schema（5 个 schema）
- `src/types/god-actions.ts` — **NEW** Hand / GodAction catalog（11 种 action 的 Zod schema）
- `src/types/god-envelope.ts` — **NEW** GodDecisionEnvelope + Authority 类型
- `src/types/observation.ts` — **NEW** Observation 类型系统（13 种观察类型）

---

## 2. 类型基础设施（新增）

### 2.1 `src/types/observation.ts` — Observation 类型系统

Sovereign God Runtime 的核心数据类型。所有来自 coder/reviewer/god/human/runtime 的输出都被归一化为 Observation。

```typescript
type ObservationType =
  | 'work_output'                 // Coder 工作输出
  | 'review_output'               // Reviewer 审查输出
  | 'quota_exhausted'             // API 配额耗尽
  | 'auth_failed'                 // 认证失败
  | 'adapter_unavailable'         // Adapter 进程不可用
  | 'empty_output'                // 空输出
  | 'meta_output'                 // 非工作元输出（AI 拒绝等）
  | 'tool_failure'                // 工具/进程故障
  | 'human_interrupt'             // 人类 Ctrl+C 中断
  | 'human_message'               // 人类文本中断
  | 'clarification_answer'        // 人类回答澄清问题
  | 'phase_progress_signal'       // 阶段进展信号（Hand 执行结果）
  | 'runtime_invariant_violation' // 运行时不变量违规

type ObservationSource = 'coder' | 'reviewer' | 'god' | 'human' | 'runtime';
type ObservationSeverity = 'info' | 'warning' | 'error' | 'fatal';

interface Observation {
  source: ObservationSource;
  type: ObservationType;
  summary: string;
  rawRef?: string;               // 完整原始输出引用
  severity: ObservationSeverity;
  timestamp: string;
  round: number;
  phaseId?: string | null;
  adapter?: string;
}
```

关键函数：`isWorkObservation(obs)` — 仅 `work_output` 和 `review_output` 返回 `true`，其他类型均为 non-work。

### 2.2 `src/types/god-actions.ts` — Hand / GodAction Catalog

使用 Zod discriminated union 定义 11 种结构化 action：

| Action | 参数 | 用途 |
|--------|------|------|
| `send_to_coder` | `message: string` | 向 Coder 发送工作指令 |
| `send_to_reviewer` | `message: string` | 向 Reviewer 发送审查指令 |
| `stop_role` | `role, reason` | 停止运行中的角色 |
| `retry_role` | `role, hint?` | 重试角色（可附带提示） |
| `switch_adapter` | `role, adapter, reason` | 切换某角色的 adapter |
| `set_phase` | `phaseId, summary?` | 设置当前 phase（显式阶段转换） |
| `accept_task` | `rationale, summary` | 接受/完成任务，rationale 必须为 `reviewer_aligned` / `god_override` / `forced_stop` |
| `wait` | `reason, estimatedSeconds?` | 进入等待状态 |
| `request_user_input` | `question` | 请求人类输入 |
| `resume_after_interrupt` | `resumeStrategy` | 中断后恢复，策略为 `continue` / `redirect` / `stop` |
| `emit_summary` | `content` | 发出管理摘要 |

### 2.3 `src/types/god-envelope.ts` — GodDecisionEnvelope

统一的 God 决策输出格式，取代 5 个遗留 schema：

```typescript
interface GodDecisionEnvelope {
  diagnosis: {
    summary: string;               // 简要情势评估
    currentGoal: string;           // 当前目标
    currentPhaseId: string;        // 当前 phase ID
    notableObservations: string[]; // 驱动此决策的关键观察
  };
  authority: {
    userConfirmation: 'human' | 'god_override' | 'not_required';
    reviewerOverride: boolean;
    acceptAuthority: 'reviewer_aligned' | 'god_override' | 'forced_stop';
  };
  actions: GodAction[];            // 结构化 Hand actions
  messages: EnvelopeMessage[];     // NL 消息通道
}

interface EnvelopeMessage {
  target: 'coder' | 'reviewer' | 'user' | 'system_log';
  content: string;
}
```

**Authority 语义约束**（Zod superRefine 强制执行）：
- `reviewerOverride = true` → messages 必须包含 `system_log` 条目说明 override 原因
- `acceptAuthority = 'god_override'` → messages 必须包含 `system_log` 条目说明原因
- `userConfirmation = 'god_override'` → messages 必须包含 `system_log` 条目说明原因（BUG-18 fix）
- `acceptAuthority = 'forced_stop'` → messages 必须包含 `user` 目标的摘要消息

### 2.4 `src/types/god-schemas.ts` — 遗留 Zod Schema

5 个遗留 schema 仍保留用于向后兼容和旧调用路径：

| Schema | 用途 | 状态 |
|--------|------|------|
| `GodTaskAnalysisSchema` | TASK_INIT 输出 | 活跃 |
| `GodPostCoderDecisionSchema` | POST_CODER 路由 | deprecated |
| `GodPostReviewerDecisionSchema` | POST_REVIEWER 路由 | deprecated |
| `GodConvergenceJudgmentSchema` | 收敛判定 | deprecated |
| `GodAutoDecisionSchema` | 自主决策 | deprecated |

### 2.5 `src/types/god-adapter.ts` — GodAdapter 接口

```typescript
type GodAdapterName = 'claude-code' | 'codex';
type GodToolUsePolicy = 'forbid' | 'allow-readonly';

interface GodAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly version: string;
  readonly toolUsePolicy?: GodToolUsePolicy;
  readonly minimumTimeoutMs?: number;

  isInstalled(): Promise<boolean>;
  getVersion(): Promise<string>;
  execute(prompt, opts): AsyncIterable<OutputChunk>;
  kill(): Promise<void>;
  isRunning(): boolean;
}
```

关键设计：
- `toolUsePolicy` 控制 God 是否允许使用工具。`'forbid'`（Claude Code）完全禁止；`'allow-readonly'`（Codex）允许只读
- `minimumTimeoutMs` 允许 adapter 声明最低超时要求（Codex 为 90s）
- `execute()` 返回 `AsyncIterable<OutputChunk>`，支持流式处理

---

## 3. Adapter 层

### 3.1 `src/god/god-adapter-config.ts` — Adapter 配置与解析

导出函数：
- `isSupportedGodAdapterName(name)` — 类型守卫，校验 adapter 名称
- `getInstalledGodAdapters(detected)` — 从已检测 CLI 列表中过滤已安装的 God adapter
- `resolveGodAdapterForStart(reviewer, detected, explicitGod?)` — 启动时解析 God adapter：优先显式指定 > reviewer 同名 > 已安装 fallback（优先 `claude-code`）
- `sanitizeGodAdapterForResume(reviewer, detected, persistedGod?)` — resume 时恢复 God adapter，不可用时自动降级

返回类型 `GodAdapterResolution` 区分 `ResolutionSuccess` 和 `ResolutionFailure`，携带 `warnings` 数组。

### 3.2 `src/god/god-adapter-factory.ts` — Adapter 工厂

```typescript
function createGodAdapter(name: string): GodAdapter
```

简单工厂，根据名称创建 `ClaudeCodeGodAdapter` 或 `CodexGodAdapter` 实例。

### 3.3 `src/god/adapters/claude-code-god-adapter.ts` — Claude Code 实现

- `toolUsePolicy = 'forbid'` — 完全禁止工具调用
- 使用 `ProcessManager` 管理子进程，`StreamJsonParser` 解析 stream-json 格式输出
- 构建参数：`-p prompt --output-format stream-json --verbose --system-prompt ... --tools '' --add-dir cwd`
- 通过 `buildAdapterEnv` 过滤环境变量，仅保留 `ANTHROPIC_` 和 `CLAUDE_` 前缀
- 删除 `CLAUDECODE` 环境变量以避免递归检测

### 3.4 `src/god/adapters/codex-god-adapter.ts` — Codex 实现

- `toolUsePolicy = 'allow-readonly'` — 允许只读工具
- `minimumTimeoutMs = 90_000` — 声明最低 90s 超时
- 使用 `JsonlParser` 解析 JSONL 格式输出
- 通过 `buildCodexGodPrompt()` 包装 prompt，明确声明这是 orchestrator 子调用，禁止直接解决任务
- 运行在 `--sandbox read-only --ephemeral` 模式
- 启动前检测 git repo 状态，非 git repo 时添加 `--skip-git-repo-check`

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
  logging?: GodCallLoggingOptions;
}

async function collectGodAdapterOutput(options): Promise<string>
```

核心逻辑：
- 使用 `Math.max(timeoutMs, adapter.minimumTimeoutMs)` 确保不低于 adapter 最低超时
- 可选 `logging` 参数将 prompt 写入 prompt-log（FR-018 审计追溯）
- 流式消费 adapter 输出，收集 `text`/`code`/`error` 类型 chunk
- 对 `tool_use`/`tool_result` chunk，`forbid` 时抛错，`allow-readonly` 时跳过
- `finally` 块确保进程清理

### 4.2 `src/god/god-system-prompt.ts` — System Prompt 构建

```typescript
function buildGodSystemPrompt(context: GodPromptContext): string
```

生成的 system prompt 包含：
- **CRITICAL OVERRIDE 开头**：明确覆盖宿主 CLI 的内置指令（CLAUDE.md、skills 等）
- **角色定义**：纯 JSON 决策者，不写代码、不读文件、不使用工具
- **5 个决策点的 JSON schema**：TASK_INIT、POST_CODER、POST_REVIEWER、CONVERGENCE、AUTO_DECISION
- **规则约束**：只输出 JSON code block，保守优先，禁止请求人类介入
- override/forced_stop 时必须附带 system_log/user 消息

### 4.3 `src/god/god-prompt-generator.ts` — 动态 Prompt 生成（heavily modified）

导出三个 prompt 生成函数：

**`generateCoderPrompt(ctx, audit?)`**
- 开头插入 **Worker 角色声明**（Card D.2）：明确 Coder 为纯执行者，不具有 accept authority，不决定 phase 切换
- 按优先级组装内容：God instruction（P0）> unresolvedIssues（P1）> suggestions（P2）> convergenceLog 趋势（P3）> round info（P4）
- 根据 `taskType` 选择策略指令模板（explore/code/review/debug/discuss）
- compound 类型时使用 `resolveEffectiveType()` 动态调整（当 instruction 包含实现类关键词时，explore/discuss 自动切换为 code）
- 强制 `MAX_PROMPT_LENGTH = 100_000` 字符上限

**`generateReviewerPrompt(ctx)`**
- 开头插入 **Worker 角色声明**（Card D.2）：明确 Reviewer 为观察提供者，verdict 仅为参考信息，God 做最终决策
- 根据 `effectiveType` 区分 explore（只读审查）、review（提案评估，Bug 11 fix — 提案合理即可 approve）和通用审查指令
- 包含 **Anti-nitpick guardrail**：零 blocking issue 必须 approve

**`generateGodDecisionPrompt(ctx)`**
- 用于 POST_CODER/POST_REVIEWER/CONVERGENCE 决策点（遗留路径）

---

## 5. 上下文管理

### `src/god/god-context-manager.ts` — 增量 Prompt 管理

```typescript
class GodContextManager {
  buildIncrementalPrompt(params): string;
  buildTrendSummary(convergenceLog): string;
  shouldRebuildSession(tokenEstimate, limit): boolean;
  buildSessionRebuildPrompt(convergenceLog): string;
  buildObservationPrompt(params): string;          // Card C.3
  buildObservationRebuildPrompt(params): string;   // Card C.3
}
```

核心设计原则：God CLI 通过 `--resume` 维护对话历史，Duo 每轮只发送增量信息。

关键常量：
- `CHARS_PER_TOKEN = 4` — token 估算
- `MAX_PROMPT_TOKENS = 10_000` — 单次 prompt 上限
- `MAX_OUTPUT_SECTION_CHARS = 15_000` — Coder/Reviewer 输出段落截断阈值
- `REBUILD_THRESHOLD = 0.9` — 达到上下文窗口 90% 时触发重建

**Observation-based prompt 构建**（Card C.3 新增）：

`buildObservationPrompt()` 基于 Observation 历史和之前的 GodDecisionEnvelope 构建 God user prompt，包含：
- 按 severity 排序的观察列表（高严重度优先，40% token 预算）
- 之前的决策摘要（diagnosis.summary + action types）
- Hand action catalog（11 种 action 的可读列表）
- `GodDecisionEnvelope` JSON 输出格式要求
- Authority 约束提醒

`buildObservationRebuildPrompt()` 在上下文窗口耗尽后重建会话，保留 critical（error/fatal）observations，附带 recent observations 和决策历史摘要。

`buildTrendSummary()` 生成简洁趋势摘要：blocking issue 数列（如 `5→3→1`）、趋势分类（improving/declining/stagnant/oscillating）、criteria 达成率。

---

## 6. 统一决策管线（核心新架构）

### 6.1 `src/god/god-decision-service.ts` — 统一决策服务（heavily modified）

**单入口取代五散点**：

```typescript
class GodDecisionService {
  constructor(adapter: GodAdapter, degradation: DegradationManager);
  async makeDecision(observations: Observation[], context: GodDecisionContext): Promise<GodDecisionEnvelope>;
}
```

**`GodDecisionContext`**：

```typescript
interface GodDecisionContext {
  taskGoal: string;
  currentPhaseId: string;
  currentPhaseType?: 'explore' | 'code' | 'discuss' | 'review' | 'debug';
  phases?: { id: string; name: string; type: string; description: string }[];
  round: number;
  maxRounds: number;
  previousDecisions: GodDecisionEnvelope[];
  availableAdapters: string[];
  activeRole: 'coder' | 'reviewer' | null;
  sessionDir: string;
}
```

**决策流程**：

1. **构建 prompt** — `buildUserPrompt()` 组装 task goal、phase/round 信息、phase plan、available adapters、observations section、previous decision summary、Hand catalog
2. **调用 God adapter** — 通过 `collectGodAdapterOutput()` 发起请求，timeout 为 90s（Bug 8 fix：30s 对 claude-code 太短）
3. **解析 JSON** — `extractWithRetry()` 使用 `GodDecisionEnvelopeSchema` 验证，失败时重试一次
4. **错误处理** — adapter 调用失败或解析失败时触发 `DegradationManager`，返回 fallback envelope（BUG-22 fix：fallback 包含 wait action 防止空 actions 导致死循环）
5. **成功恢复** — 解析成功时调用 `degradation.handleGodSuccess()` 重置计数

**Prompt 构建细节**：

- **Observations section**（`buildObservationsSection()`）：
  - 按 severity 排序（fatal > error > warning > info）
  - Work observations（work_output/review_output）预算 20000 字符，runtime signals 预算 300 字符
  - `stripToolMarkers()` 去除 tool/shell 标记噪声（`[Read]`、`[Bash]`、`[shell result]` 等）
  - Card D.2：review_output 观察额外高亮 reviewer verdict `[APPROVED]`/`[CHANGES_REQUESTED]`

- **System prompt** 包含：
  - Sovereign God 角色定义
  - Phase-following instructions（Bug 11 fix）：compound 任务必须按 phase plan 顺序执行，review-type phase 必须先 send_to_reviewer
  - Reviewer handling instructions（Card D.2）：reviewer verdict 必须在 diagnosis 中引用，override 时必须说明原因
  - `GodDecisionEnvelope` JSON 格式和 authority 约束

- **Reviewer verdict 提取**：`extractReviewerVerdict(obs)` 从 review_output observation 中提取 `[APPROVED]` 或 `[CHANGES_REQUESTED]` 标记

### 6.2 `src/god/hand-executor.ts` — Hand 执行器（NEW）

```typescript
async function executeActions(
  actions: GodAction[],
  context: HandExecutionContext
): Promise<Observation[]>
```

**执行流程**（逐条顺序执行）：

1. **Rule engine 检查** — 每个 action 通过 `evaluateRules()` 校验
   - 被 block → 生成 `runtime_invariant_violation` observation，跳过执行
2. **执行 action** — 通过 `executeSingleAction()` dispatch
   - 成功 → 生成 `phase_progress_signal` observation
   - 失败 → 生成 `runtime_invariant_violation` observation

**`HandExecutionContext`** 封装了所有可变运行时状态：

```typescript
interface HandExecutionContext {
  currentPhaseId: string;
  pendingCoderMessage: string | null;
  pendingReviewerMessage: string | null;
  adapters: Map<string, HandAdapter>;
  auditLogger: GodAuditLogger | null;
  activeRole: 'coder' | 'reviewer' | null;
  taskCompleted: boolean;
  waitState: { active: boolean; reason: string | null; estimatedSeconds: number | null };
  clarificationState: { active: boolean; question: string | null };
  interruptResumeStrategy: 'continue' | 'redirect' | 'stop' | null;
  adapterConfig: Map<string, string>;
  round: number;
  sessionDir: string;
  cwd: string;
  envelopeMessages?: EnvelopeMessage[];  // D.3: 用于 accept_task 验证
}
```

**各 action 执行器**：

| Action | 副作用 | 审计 |
|--------|--------|------|
| `send_to_coder` | 设置 `pendingCoderMessage`，`activeRole = 'coder'` | - |
| `send_to_reviewer` | 设置 `pendingReviewerMessage`，`activeRole = 'reviewer'` | - |
| `set_phase` | 更新 `currentPhaseId` | 写入 `phase_transition` 审计 |
| `accept_task` | 设置 `taskCompleted = true`；D.3 验证：`god_override` 需 system_log，`forced_stop` 需 user message | 写入 `accept_task` 审计 |
| `stop_role` | 调用 `adapter.kill()` | - |
| `retry_role` | kill 当前 adapter，设置 pending message，`activeRole` | - |
| `switch_adapter` | 更新 `adapterConfig` | - |
| `wait` | 设置 `waitState` | - |
| `request_user_input` | 设置 `clarificationState` | - |
| `resume_after_interrupt` | 设置 `interruptResumeStrategy`，清除 `clarificationState` | - |
| `emit_summary` | - | 写入 `emit_summary` 审计 |

**SPEC-DECISION**：大多数 action 映射到 `config_modify` ActionContext（不涉及文件系统或命令执行），避免 rule engine 误报。`switch_adapter` 显式映射为 `config_modify`。

### 6.3 `src/god/message-dispatcher.ts` — 消息分发器（NEW）

**关键约束**：消息分发 **不得** 触发任何状态变化（NFR-001 / FR-016）。

```typescript
function dispatchMessages(
  messages: EnvelopeMessage[],
  context: DispatchContext
): DispatchResult

interface DispatchResult {
  pendingCoderMessage: string | null;
  pendingReviewerMessage: string | null;
}
```

**分发规则**：

| target | 处理方式 |
|--------|---------|
| `coder` | 返回在 `result.pendingCoderMessage` 中（多条消息合并换行） |
| `reviewer` | 返回在 `result.pendingReviewerMessage` 中 |
| `user` | 通过 `formatGodMessage()` 格式化后调用 `context.displayToUser()` |
| `system_log` | 写入 `god-audit.jsonl`（`message_dispatch` 类型） |

`dispatchMessages()` 是纯函数，不直接修改 context 的 pending messages — 而是返回新值由调用方决定如何应用。

**NL/Action 不变量检查**：

```typescript
function checkNLInvariantViolations(
  messages: EnvelopeMessage[],
  actions: GodAction[],
  context: { round: number; phaseId: string }
): Observation[]
```

检测自然语言消息中的状态变更关键词是否有对应的结构化 action：

| 检测模式 | 需要的 action | 违规类型 |
|---------|--------------|---------|
| "进入/切换到/transition to/enter phase" | `set_phase` | `runtime_invariant_violation` |
| "accepted/接受任务/结果" | `accept_task` | `runtime_invariant_violation` |
| "切换/switch/change adapter" | `switch_adapter` | `runtime_invariant_violation` |

SPEC-DECISION：使用 regex + keyword pattern 而非 LLM 检测，确保 < 1ms 延迟、确定性、零 API 成本。

### 6.4 `src/god/observation-classifier.ts` — 观察分类器（NEW）

纯同步 regex + keyword pattern matching，< 5ms 延迟，无 LLM 调用。

```typescript
function classifyOutput(
  raw: string,
  source: ObservationSource,
  meta: { round: number; phaseId?: string; adapter?: string }
): Observation

function guardNonWorkOutput(obs: Observation): {
  isWork: boolean;
  shouldRouteToGod: boolean;
}
```

**分类优先级**（高到低）：

1. 空输出 → `empty_output` (warning)
2. Quota/rate limit（`429`、`rate limit` 等） → `quota_exhausted` (error)
3. 认证失败（`unauthorized`、`403` 等） → `auth_failed` (error)
4. Adapter 不可用（`command not found`、`ENOENT`） → `adapter_unavailable` (error)
5. Meta output（`I cannot`、`As an AI`） → `meta_output` (warning)
6. Tool failure（仅 runtime source 匹配 `error`/`exception`/`traceback`） → `tool_failure` (error)
7. 默认：reviewer source → `review_output` (info)，其他 → `work_output` (info)

SPEC-DECISION：quota/auth 模式在通用 error 模式之前检查，确保 "Error 429: rate limit" 被正确分类为 `quota_exhausted` 而非 `tool_failure`。

**Non-Work Guard**：`guardNonWorkOutput()` 判断观察是否为真实工作输出。non-work observations（quota/auth/empty/meta/tool_failure 等）不得触发 `CODE_COMPLETE` / `REVIEW_COMPLETE` 事件，而应路由到 God 处理。

**`IncidentTracker` 类**（Card F.1）：

追踪连续 incident 发生次数，实现严重度自动升级：
- `empty_output` 连续 2+ 次 → severity 从 warning 升级为 error
- `tool_failure` 连续 3+ 次 → severity 从 error 升级为 fatal
- 工作输出重置所有 incident 计数

**`createDegradationObservation()`**：将 DegradationManager 状态变化（L4 / fallback）转为 Observation。

### 6.5 `src/god/observation-integration.ts` — 观察集成层（NEW）

GLUE 层，连接 observation-classifier 到各输出源。

```typescript
function processWorkerOutput(raw, role, meta): {
  observation: Observation;
  isWork: boolean;
  shouldRouteToGod: boolean;
}
```

使用模式：在发送 `CODE_COMPLETE` / `REVIEW_COMPLETE` 之前调用，仅当 `isWork === true` 时才发送完成事件。

**便捷工厂函数**：

| 函数 | 输出 Observation |
|------|-----------------|
| `processWorkerOutput(raw, role, meta)` | Coder/Reviewer 工作输出 → 分类 + guard |
| `createInterruptObservation(round, opts?)` | 人类 Ctrl+C → `human_interrupt` (warning) |
| `createTextInterruptObservation(text, round, opts?)` | 人类文本输入 → `human_message` (info) |
| `createProcessErrorObservation(msg, round, opts?)` | 进程错误 → `tool_failure` (error) |
| `createTimeoutObservation(round, opts?)` | 进程超时 → `tool_failure` (error) |

---

## 7. 遗留决策路径

以下模块在 Sovereign God 架构中已被 `GodDecisionService` + `GodDecisionEnvelope` 管线取代，但仍保留用于向后兼容。

### 7.1 `src/god/auto-decision.ts` — 自主决策

在 `GOD_DECIDING` 状态下，God 自主决定下一步操作。

导出函数：

**`makeAutoDecision(godAdapter, context, ruleEngine)`** — 主函数
- 构建包含任务目标、轮次、等待原因、Coder/Reviewer 输出、unresolved issues、convergence 历史的 prompt
- 调用 God adapter，通过 `extractWithRetry` 提取 `GodAutoDecisionSchema` 格式的 JSON
- 解析失败时自动降级为 `makeLocalAutoDecision()`
- 对 `continue_with_instruction` 的 instruction 进行 rule engine 检查
- 结果写入审计日志

**`makeLocalAutoDecision(context, ruleEngine)`** — 本地降级决策
- Reviewer 输出包含 `[APPROVED]` 且无 unresolved issues → `accept`
- 否则 → `continue_with_instruction`

### 7.2 `src/god/god-router.ts` — 路由决策（deprecated）

God 分析 Coder/Reviewer 输出后决定下一步路由，映射为 XState 工作流事件。

> 注：此模块已标记为 deprecated。routing 现在通过 GodDecisionService + OBSERVING 管线流转。模块保留用于现有测试兼容。

**`routePostCoder(godAdapter, coderOutput, context)`**
- 可能的 action：`continue_to_review`（默认）| `retry_coder`

**`routePostReviewer(godAdapter, reviewerOutput, context)`**
- 可能的 action：`route_to_coder` | `converged` | `phase_transition` | `loop_detected`
- 运行 `checkConsistency()` 一致性检查
- 对 `route_to_coder` 强制要求 `unresolvedIssues` 非空

**`godActionToEvent(decision)`** — God action 到 XState event 的映射：

| God Action | XState Event |
|------------|-------------|
| `continue_to_review` | `ROUTE_TO_REVIEW` |
| `retry_coder` / `route_to_coder` | `ROUTE_TO_CODER` |
| `converged` | `CONVERGED` |
| `phase_transition` | `PHASE_TRANSITION` |
| `loop_detected` | `LOOP_DETECTED` |

### 7.3 `src/god/god-convergence.ts` — 收敛判定

Reviewer 权威原则：Reviewer 是收敛的唯一权威来源。

**`evaluateConvergence(godAdapter, reviewerOutput, context)`** — 主函数

决策树（按优先级）：
1. 无 Reviewer 输出 → 不终止
2. `round >= maxRounds` → 强制终止（reason: `max_rounds`）
3. `loop_detected` + 连续 3 轮无改善 → 强制终止
4. `blockingIssueCount > 0` → 不终止
5. 所有 `criteriaProgress` 满足 → 终止
6. 其他 → 不终止

一致性检查流程：
- 调用 `checkConsistency()` 检测幻觉
- 幻觉检测到时写入 `HALLUCINATION_DETECTED` 审计条目
- 使用自动纠正后的 judgment
- 额外强制：`shouldTerminate: true` 但有 blocking issues 或未满足 criteria → 覆盖为 `false`

---

## 8. 任务管理

### 8.1 `src/god/task-init.ts` — 任务初始化

```typescript
async function initializeTask(
  godAdapter, taskPrompt, systemPrompt, projectDir?, sessionDir?
): Promise<TaskInitResult | null>
```

- 向 God 发送 `TASK_INIT` 决策点 prompt
- 使用 `extractWithRetry` 提取 `GodTaskAnalysisSchema` 格式 JSON
- schema 验证失败时自动重试一次（附带 error hint）
- 最终失败返回 `null`，由调用方决定 fallback

**`validateRoundsForType(taskType, rounds)`** — 按任务类型限定轮次范围：

| 任务类型 | min | max |
|---------|-----|-----|
| explore | 2 | 5 |
| code | 3 | 10 |
| review | 1 | 3 |
| debug | 2 | 6 |
| discuss | 2 | 5 |
| compound | 不限制 |

### 8.2 `src/god/phase-transition.ts` — 阶段转换

管理 compound 任务的多阶段转换。

**`evaluatePhaseTransition(currentPhase, phases, convergenceLog, godDecision)`**

转换条件：
1. God decision `action === 'phase_transition'`
2. 当前 phase 在 phases 数组中有后继
3. 优先使用 God 指定的 `nextPhaseId`，fallback 到顺序下一个 phase
4. 防止自转换（God 幻觉 `nextPhaseId === currentPhase.id`）

转换时生成 `previousPhaseSummary`，包含已完成 phase 的最终轮次、classification、blocking issues、criteria 达成率。

### 8.3 `src/god/tri-party-session.ts` — 三方会话管理

```typescript
interface TriPartySessionState {
  coderSessionId: string | null;
  reviewerSessionId: string | null;
  godSessionId: string | null;
}
```

**`extractTriPartyState(state)`** — 从 `SessionState` 提取三方会话 ID，`undefined` 转为 `null`。

**`restoreTriPartySession(triParty, config, adapterFactory)`** — resume 时恢复三方会话：
- Coder 和 Reviewer 独立恢复，互不影响
- 每个 party 获得独立的 adapter 实例（即使使用相同 CLI 工具）
- **God 始终不恢复**（`god = null`），必须以无状态 system prompt 重新运行

---

## 9. 质量保障

### 9.1 `src/god/consistency-checker.ts` — 一致性检查

纯规则检查（< 1ms，无 LLM 调用），检测 God JSON 输出中的逻辑矛盾（幻觉）。

**三种违规类型和处理策略**：

| 类型 | 描述 | 处理 |
|------|------|------|
| structural | 给定状态下缺少必需字段 | 触发重试 → fallback |
| semantic | 可计数字段与分类字段矛盾 | 自动纠正（以可计数字段为权威） |
| low_confidence | 低置信度关键决策 | 保守偏向（不终止） |

**检查规则**：
- ConvergenceJudgment：`approved` + `blockingIssueCount > 0` → 纠正为 `changes_requested`
- ConvergenceJudgment：`needs_discussion` + `shouldTerminate: true` → 纠正为 `shouldTerminate: false`
- ConvergenceJudgment：`shouldTerminate: true` + `reason: null` → 纠正为 `shouldTerminate: false`
- PostReviewerDecision：`confidenceScore < 0.5` + `action: converged` → 纠正为 `route_to_coder`

**`crossValidate(godClassification, localClassification)`** — God 与本地 ConvergenceService 交叉验证。不一致时本地结果为权威（`soft_approved` 等价于 `approved`）。

### 9.2 `src/god/drift-detector.ts` — 渐进漂移检测

检测 God 决策的渐进偏移，防止长期运行中 God 逐渐偏离正确轨道。

**两种漂移信号**：

| 信号 | 触发条件 | 严重度 |
|------|---------|--------|
| `god_too_permissive` | God 连续 3+ 次 approved/converged，但本地判定 changes_requested | severe |
| `confidence_declining` | God confidence 连续 4+ 轮下降 | 末次 < 0.5 → severe，否则 mild |

**处理策略**：
- mild → 仅记录审计日志（warning）
- severe → 临时 fallback 2 轮，之后自动恢复

`DriftDetector` 类方法：
- `recordDecision(godDecision, localClassification)` — 记录每次 God 决策
- `checkDrift()` — 检查漂移信号
- `isFallbackActive()` / `getFallbackRoundsRemaining()` — 查询 fallback 状态
- `tickFallbackRound()` — 每轮递减 fallback 计数

构造函数要求：当提供 `sessionDir` 时必须同时提供 `seqProvider`，防止与 `GodAuditLogger` 写入同一文件时 seq 冲突。

### 9.3 `src/god/loop-detector.ts` — 死循环检测

检测任务执行中的死循环（同一问题反复出现但无实质进展）。

**`detectLoop(convergenceLog, recentDecisions)`** — 主检测函数

需要至少 3 轮数据。检测信号的组合逻辑：
1. 如果 `blockingIssueCount` 在递减 → 非循环
2. 检查最近 3 轮 `progressTrend` 是否全为 `stagnant` 或 `declining`
3. 检查 `blockingIssueCount` 是否不递减
4. 检查 `unresolvedIssues` 的语义重复（排序后字符串比较）

**干预策略**：
- 所有轮次 declining → `force_converge`（防止进一步恶化）
- 语义重复 + 不递减 → `rephrase_prompt`（打破循环）
- 仅不递减 → `rephrase_prompt`（打破停滞）

---

## 10. 可靠性

### 10.1 `src/god/degradation-manager.ts` — 四级降级管理

God CLI 故障时的自动降级与恢复。

```typescript
type DegradationLevel = 'L1' | 'L2' | 'L3' | 'L4';
type GodErrorKind = 'process_exit' | 'timeout' | 'parse_failure' | 'schema_validation';
```

**四级降级策略**：

| 级别 | 触发条件 | 处理 |
|------|---------|------|
| L1 | 正常 | 无降级 |
| L2 | 可重试错误（process_exit, timeout） | 重试 1 次 → fallback |
| L3 | 不可重试错误（parse_failure, schema_validation） | 格式纠正重试 1 次 → fallback |
| L4 | 连续 3 次失败 | 本会话永久禁用 God，完全 fallback |

Fallback 服务：切换到旧组件（`ContextManager` + `ConvergenceService` + `ChoiceDetector`）。

三层安全保障：God → fallback → ERROR → `GOD_DECIDING`/`MANUAL_FALLBACK` → duo resume。

关键方法：
- `handleGodFailure(error, context?)` — 返回 `DegradationAction`（`retry` / `retry_with_correction` / `fallback`）
- `handleGodSuccess()` — 成功后重置计数（L4 永久不恢复）
- `serializeState()` — 序列化状态用于 duo resume
- 构造函数支持 `restoredState` 恢复之前的降级状态

### 10.2 `src/god/alert-manager.ts` — 异常告警

三种告警规则：

| 类型 | 级别 | 触发条件 | UI 表现 |
|------|------|---------|---------|
| `GOD_LATENCY` | Warning | God 调用 > 30s | StatusBar spinner |
| `STAGNANT_PROGRESS` | Warning | 连续 3 轮 blockingIssueCount 不递减 | Blocking card |
| `GOD_ERROR` | Critical | God API 故障 | System message |

行为区分：Warning → 不阻塞工作流；Critical → 暂停工作流，等待用户确认。

### 10.3 `src/god/interrupt-clarifier.ts` — 中断意图分类

人类观察者中断时，God 分类中断意图。

```typescript
interface InterruptClassification {
  intent: 'restart' | 'redirect' | 'continue';
  instruction: string;
  reasoning: string;
  needsClarification: boolean;
}
```

**`classifyInterruptIntent(godAdapter, context)`**

三种意图：
- `restart` — 从头开始，使用不同方法
- `redirect` — 改变方向但保留有用进展
- `continue` — 保持当前方向，小幅调整

超时设置为 15s（比其他 God 调用更短，因为中断需要快速响应）。God 不可用时 fallback：直接使用用户输入作为 `redirect` instruction。

---

## 11. 持久化与审计

### 11.1 `src/god/god-audit.ts` — 审计日志

Append-only JSONL 格式审计日志，记录所有 God 决策。

```typescript
interface GodAuditEntry {
  seq: number;
  timestamp: string;
  round: number;
  decisionType: string;
  inputSummary: string;     // <= 500 chars
  outputSummary: string;    // <= 500 chars
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  decision: unknown;
  model?: string;
  phaseId?: string;
  outputRef?: string;       // god-decisions/ 中的完整输出引用
}
```

**两种 API**：

**`appendAuditLog(sessionDir, entry)`** — 兼容函数，直接追加条目到 `god-audit.jsonl`

**`GodAuditLogger` 类** — 带 seq 追踪和 `outputRef` 支持
- `append(entry, fullOutput?)` — 自动递增 seq，可选存储完整 God 输出到 `god-decisions/` 目录
- `getEntries(filter?)` — 读取所有条目，可按 `decisionType` 过滤
- `getSequence()` — 获取当前 seq
- 构造时从已有日志文件恢复 seq

**`cleanupOldDecisions(dir, maxSizeMB)`** — `god-decisions/` 目录超 50MB 时清理最旧的文件。

**Envelope Decision 审计**（Card F.2 新增）：

**`logEnvelopeDecision(logger, params)`** — 记录完整 God 决策上下文：
- Input observations（summary + severity + type）
- God diagnosis
- Authority override 详情（NFR-002）
- Chosen actions
- NL messages
- Action execution results
- 完整归档存储在 `god-decisions/` 目录

**`logReviewerOverrideAudit(logger, params)`** — Card D.2：记录 reviewer 原始结论 + God 最终裁定，跟踪 override 与否。

**`logIncidentAudit(logger, params)`** — Card F.1：记录 incident observation + God diagnosis + 决策 + 执行结果。

**Override tracking**（NFR-002）：
- `userConfirmation = 'god_override'` → 记录 override reason
- `reviewerOverride = true` → 记录 reviewer 原始结论 + override reason

### 11.2 `src/god/god-session-persistence.ts` — God 会话持久化

```typescript
async function restoreGodSession(state, adapterFactory): Promise<null>
```

当前实现始终返回 `null`。God 通过无状态的 `GodAdapter` 接口运行，持久化的 God session ID 仅保留在快照中用于向后兼容。

---

## 12. Rule Engine

### `src/god/rule-engine.ts` — 不可委托场景规则引擎

同步规则引擎，执行时间 < 5ms，无 LLM 调用。Block 级别规则具有绝对优先权，God 无法覆盖（NFR-009）。

**5 条规则**：

| ID | 级别 | 描述 |
|----|------|------|
| R-001 | block | 文件写入必须在 `~/Documents` 目录内 |
| R-002 | block | 禁止访问系统关键目录（`/etc`, `/usr`, `/bin`, `/System`, `/Library`） |
| R-003 | block | 检测可疑网络外传（`curl -d @file`） |
| R-004 | warn | God 批准的操作与 rule engine block 相矛盾时发出警告 |
| R-005 | warn | Coder 修改 `.duo/` 配置目录 |

路径解析使用 `realpathSync` 解析符号链接（含 macOS `/etc -> /private/etc`），并向上遍历目录层级找到最深的已存在祖先进行解析，防止通过 symlink 绕过目录限制。

`evaluateRules(action)` 返回 `RuleEngineResult`，其中 `blocked` 为 `true` 表示存在 block 级别匹配。Hand Executor 在执行每个 GodAction 前调用此函数。

---

## 13. 集成点

### 统一管线数据流

```
Worker Output → observation-classifier → Observation
                                            ↓
Observation[] → GodDecisionService.makeDecision() → GodDecisionEnvelope
                                                        ↓
                              ┌─────────────────────────┴──────────────────────┐
                              ↓                                                ↓
                  envelope.actions → HandExecutor → Observation[]    envelope.messages → MessageDispatcher
                                        ↓                                           ↓
                              (rule engine 校验)                         (NL invariant 检查)
                                        ↓                                           ↓
                            phase_progress_signal /                    pendingCoder/ReviewerMessage
                            runtime_invariant_violation                displayToUser / auditLog
```

### 与 Workflow Engine 的集成

遗留路径通过 `godActionToEvent()` 映射 God action 到 XState 事件。新架构中 Hand Executor 直接修改运行时状态，由运行时主循环读取 `HandExecutionContext` 的变化驱动下一步。

### 与 UI 层的集成

- `AlertManager` 的 `Alert` 类型被 UI 组件消费
- `DegradationNotification` 通过 system message 通知降级状态
- `GodAutoDecision` 的 `reasoning` 字段有 2000 字符上限（`MAX_REASONING_LENGTH`），防止 UI 溢出
- `MessageDispatcher` 通过 `formatGodMessage()` 格式化 user 目标消息

### 与 Parser 层的集成

God 模块依赖 `src/parsers/god-json-extractor.ts` 的 `extractWithRetry()` 从 God 原始输出中提取和验证 JSON。支持 markdown code block 提取、Zod schema 验证、失败时回调重试（附带 error hint），最多重试一次。

### 与 Session 层的集成

- `DegradationManager` 支持 `serializeState()` / `restoredState` 用于 duo resume
- `GodAuditLogger` 的 seq 从已有日志文件恢复，确保 resume 后审计连续性
- `TriPartySession` 确保 resume 时三方会话独立恢复，God 始终无状态重新开始

### 与旧组件的 Fallback 关系

降级时 God 模块回退到以下旧组件：
- `ContextManager`（`src/session/context-manager.ts`）— 替代 `GodContextManager` + `GodPromptGenerator`
- `ConvergenceService`（`src/decision/convergence-service.ts`）— 替代 `god-convergence.ts`
- `ChoiceDetector`（`src/decision/choice-detector.ts`）— 替代 `god-router.ts` 的路由功能
