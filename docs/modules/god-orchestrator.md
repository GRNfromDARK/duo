# God LLM 编排器模块

## 1. 模块概述

### God LLM 的角色

God LLM 是 Duo 系统中的第三方智能编排层。在原有的 Coder/Reviewer 双方协作模式之上，God 作为高层决策者，负责：

- **任务分析**：解析用户意图，分类任务类型（explore/code/discuss/review/debug/compound），制定终止条件和动态轮次
- **路由决策**：在 Coder 和 Reviewer 输出后，决定下一步走向（继续、重试、收敛、阶段转换）
- **收敛判定**：评估任务是否完成，基于 Reviewer 的权威判定和 blocking issue 计数
- **自主决策**：在 `GOD_DECIDING` 状态下自主决定 accept 或 continue，不依赖人类介入
- **质量保障**：检测 God 自身输出的幻觉、漂移和死循环

### 从二方到三方的转变

| 维度 | 原双方模式 | God 三方模式 |
|------|-----------|-------------|
| 决策者 | ContextManager + ConvergenceService | God LLM（智能决策） |
| 路由 | 固定规则 | God 动态路由 + rule-engine 硬约束 |
| 收敛 | ChoiceDetector 本地判定 | God 收敛判定 + 一致性检查 |
| prompt 构建 | ContextManager 静态拼接 | GodPromptGenerator 按任务类型动态生成 |
| 降级 | 无 | 四级降级，自动回退到旧组件 |

### 文件清单（25 个文件）

**Adapter 层（4 个文件）**
- `src/types/god-adapter.ts` — GodAdapter 接口定义
- `src/god/god-adapter-config.ts` — adapter 配置与解析
- `src/god/god-adapter-factory.ts` — adapter 工厂
- `src/god/adapters/claude-code-god-adapter.ts` — Claude Code 实现
- `src/god/adapters/codex-god-adapter.ts` — Codex 实现

**调用链（3 个文件）**
- `src/god/god-call.ts` — God adapter 统一调用入口
- `src/god/god-system-prompt.ts` — God system prompt 构建
- `src/god/god-prompt-generator.ts` — Coder/Reviewer/God 三方 prompt 动态生成

**上下文管理（1 个文件）**
- `src/god/god-context-manager.ts` — 增量 prompt 管理与上下文窗口重建

**智能决策（4 个文件）**
- `src/god/auto-decision.ts` — GOD_DECIDING 自主决策
- `src/god/rule-engine.ts` — 不可委托场景规则引擎
- `src/god/god-router.ts` — PostCoder/PostReviewer 路由决策
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
- `src/god/god-audit.ts` — 审计日志（append-only JSONL）
- `src/god/god-session-persistence.ts` — God 会话持久化

**Schema 定义（1 个文件）**
- `src/types/god-schemas.ts` — God 输出 Zod schema

---

## 2. 核心架构

### 2.1 God Adapter 层

#### `src/types/god-adapter.ts` — GodAdapter 接口

God adapter 的核心抽象接口。

```typescript
type GodAdapterName = 'claude-code' | 'codex';
type GodToolUsePolicy = 'forbid' | 'allow-readonly';

interface GodExecOptions {
  cwd: string;
  systemPrompt: string;
  timeoutMs: number;
}

interface GodAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly version: string;
  readonly toolUsePolicy?: GodToolUsePolicy;
  readonly minimumTimeoutMs?: number;

  isInstalled(): Promise<boolean>;
  getVersion(): Promise<string>;
  execute(prompt: string, opts: GodExecOptions): AsyncIterable<OutputChunk>;
  kill(): Promise<void>;
  isRunning(): boolean;
}
```

关键设计：
- `toolUsePolicy` 控制 God 是否允许使用工具。`'forbid'`（Claude Code）完全禁止工具调用；`'allow-readonly'`（Codex）允许只读工具
- `minimumTimeoutMs` 允许 adapter 声明最低超时要求（Codex 为 90s）
- `execute()` 返回 `AsyncIterable<OutputChunk>`，支持流式处理

#### `src/god/god-adapter-config.ts` — Adapter 配置与解析

导出函数：
- `isSupportedGodAdapterName(name)` — 类型守卫，校验 adapter 名称
- `getInstalledGodAdapters(detected)` — 从已检测 CLI 列表中过滤已安装的 God adapter
- `resolveGodAdapterForStart(reviewer, detected, explicitGod?)` — 启动时解析 God adapter：优先显式指定 > reviewer 同名 > 已安装 fallback（优先 `claude-code`）
- `sanitizeGodAdapterForResume(reviewer, detected, persistedGod?)` — resume 时恢复 God adapter，如已持久化的 adapter 不可用则自动降级

返回类型 `GodAdapterResolution` 区分 `ResolutionSuccess` 和 `ResolutionFailure`，携带 `warnings` 数组。

#### `src/god/god-adapter-factory.ts` — Adapter 工厂

```typescript
function createGodAdapter(name: string): GodAdapter
```

简单工厂，根据名称创建 `ClaudeCodeGodAdapter` 或 `CodexGodAdapter` 实例。

#### `src/god/adapters/claude-code-god-adapter.ts` — Claude Code 实现

- `toolUsePolicy = 'forbid'` — 完全禁止工具调用
- 使用 `ProcessManager` 管理子进程，`StreamJsonParser` 解析 stream-json 格式输出
- 构建参数：`-p prompt --output-format stream-json --verbose --system-prompt ... --tools '' --add-dir cwd`
- 通过 `buildAdapterEnv` 过滤环境变量，仅保留 `ANTHROPIC_` 和 `CLAUDE_` 前缀
- 删除 `CLAUDECODE` 环境变量以避免递归检测

#### `src/god/adapters/codex-god-adapter.ts` — Codex 实现

- `toolUsePolicy = 'allow-readonly'` — 允许只读工具
- `minimumTimeoutMs = 90_000` — 声明最低 90s 超时
- 使用 `JsonlParser` 解析 JSONL 格式输出
- 通过 `buildCodexGodPrompt()` 包装 prompt，明确声明这是 orchestrator 子调用，禁止直接解决任务
- 运行在 `--sandbox read-only --ephemeral` 模式
- 启动前检测 git repo 状态，非 git repo 时添加 `--skip-git-repo-check`

### 2.2 God 调用链

#### `src/god/god-call.ts` — 统一调用入口

```typescript
interface GodCallOptions {
  adapter: GodAdapter;
  prompt: string;
  systemPrompt: string;
  projectDir?: string;
  timeoutMs: number;
}

async function collectGodAdapterOutput(options: GodCallOptions): Promise<string>
```

核心逻辑：
- 使用 `Math.max(timeoutMs, adapter.minimumTimeoutMs)` 确保不低于 adapter 最低超时
- 流式消费 adapter 输出，收集 `text`/`code`/`error` 类型 chunk
- 对 `tool_use`/`tool_result` chunk，根据 `toolUsePolicy` 判断：`forbid` 时抛错，`allow-readonly` 时跳过
- `finally` 块确保进程清理

#### `src/god/god-system-prompt.ts` — System Prompt 构建

```typescript
interface GodPromptContext {
  task: string;
  coderName: string;
  reviewerName: string;
}

function buildGodSystemPrompt(context: GodPromptContext): string
```

生成的 system prompt 包含：
- **CRITICAL OVERRIDE 开头**：明确覆盖宿主 CLI 的内置指令（CLAUDE.md、skills 等）
- **角色定义**：纯 JSON 决策者，不写代码、不读文件、不使用工具
- **5 个决策点的 JSON schema**：TASK_INIT、POST_CODER、POST_REVIEWER、CONVERGENCE、AUTO_DECISION
- **规则约束**：只输出 JSON code block，保守优先，禁止请求人类介入

#### `src/god/god-prompt-generator.ts` — 动态 Prompt 生成

导出三个 prompt 生成函数：

**`generateCoderPrompt(ctx, audit?)`**
- 按优先级组装 prompt 内容：God instruction（P0）> unresolvedIssues（P1）> suggestions（P2）> convergenceLog 趋势（P3）> round info（P4）
- 根据 `taskType` 选择策略指令模板（explore/code/review/debug/discuss）
- compound 类型时使用 `phaseType` 作为实际策略，并支持 `resolveEffectiveType()` 动态调整（当 instruction 包含实现类关键词时，explore/discuss 自动切换为 code）
- 强制 `MAX_PROMPT_LENGTH = 100_000` 字符上限
- 可选写入审计日志

**`generateReviewerPrompt(ctx)`**
- 包含任务目标、phase 信息、God instruction、Coder 输出
- 根据 `effectiveType` 区分 explore（只读审查）和通用审查指令
- 要求 Reviewer 显式声明 Blocking count 并以 `[APPROVED]`/`[CHANGES_REQUESTED]` 结尾

**`generateGodDecisionPrompt(ctx)`**
- 用于 POST_CODER/POST_REVIEWER/CONVERGENCE 决策点
- 包含任务信息、compound phase 列表、Coder/Reviewer 输出、unresolved issues、convergence log

### 2.3 God 上下文管理

#### `src/god/god-context-manager.ts` — 增量 Prompt 管理

```typescript
class GodContextManager {
  buildIncrementalPrompt(params): string;
  buildTrendSummary(convergenceLog): string;
  shouldRebuildSession(tokenEstimate, limit): boolean;
  buildSessionRebuildPrompt(convergenceLog): string;
}
```

核心设计原则：God CLI 通过 `--resume` 维护对话历史，Duo 每轮只发送增量信息。

关键常量：
- `CHARS_PER_TOKEN = 4` — token 估算
- `MAX_PROMPT_TOKENS = 10_000` — 单次 prompt 上限
- `MAX_OUTPUT_SECTION_CHARS = 15_000` — Coder/Reviewer 输出段落截断阈值
- `REBUILD_THRESHOLD = 0.9` — 达到上下文窗口 90% 时触发重建

`buildTrendSummary()` 生成简洁趋势摘要：blocking issue 数列（如 `5→3→1`）、趋势分类（improving/declining/stagnant/oscillating）、criteria 达成率。

`buildSessionRebuildPrompt()` 在上下文窗口耗尽后重建会话，携带 convergence 历史摘要确保决策连续性。

---

## 3. 智能决策系统

### 3.1 `src/god/auto-decision.ts` — 自主决策

在 `GOD_DECIDING` 状态下，God 自主决定下一步操作。

核心类型：

```typescript
interface AutoDecisionContext {
  round: number;
  maxRounds: number;
  taskGoal: string;
  sessionDir: string;
  seq: number;
  waitingReason: string;
  projectDir?: string;
  lastCoderOutput?: string;
  lastReviewerOutput?: string;
  currentPhaseId?: string;
  currentPhaseType?: AutoDecisionPhaseType;
  phases?: AutoDecisionPhase[];
  convergenceLog?: AutoDecisionLogEntry[];
  unresolvedIssues?: string[];
}

interface AutoDecisionResult {
  decision: GodAutoDecision;
  ruleCheck: RuleEngineResult;
  blocked: boolean;
  reasoning: string;
}
```

导出函数：

**`makeAutoDecision(godAdapter, context, ruleEngine)`** — 主函数
- 构建包含任务目标、轮次、等待原因、Coder/Reviewer 输出、unresolved issues、convergence 历史的 prompt
- 调用 God adapter，通过 `extractWithRetry` 提取 `GodAutoDecisionSchema` 格式的 JSON
- 解析失败时自动降级为 `makeLocalAutoDecision()`
- 对 `continue_with_instruction` 的 instruction 进行 rule engine 检查
- 结果写入审计日志

**`makeLocalAutoDecision(context, ruleEngine)`** — 本地降级决策
- 如果 Reviewer 输出包含 `[APPROVED]` 且无 unresolved issues → `accept`
- 否则 → `continue_with_instruction`，instruction 基于 unresolved issues 或当前 phase 生成

### 3.2 `src/god/rule-engine.ts` — 不可委托场景规则引擎

同步规则引擎，执行时间 < 5ms，无 LLM 调用。Block 级别规则具有绝对优先权，God 无法覆盖。

核心类型：

```typescript
type RuleLevel = 'block' | 'warn';

interface ActionContext {
  type: 'file_write' | 'command_exec' | 'config_modify';
  path?: string;
  command?: string;
  cwd: string;
  godApproved?: boolean;
}
```

**5 条规则**：

| ID | 级别 | 描述 |
|----|------|------|
| R-001 | block | 文件写入必须在 `~/Documents` 目录内 |
| R-002 | block | 禁止访问系统关键目录（`/etc`, `/usr`, `/bin`, `/System`, `/Library`） |
| R-003 | block | 检测可疑网络外传（`curl -d @file`） |
| R-004 | warn | God 批准的操作与规则引擎 block 相矛盾时发出警告 |
| R-005 | warn | Coder 修改 `.duo/` 配置目录 |

路径解析使用 `realpathSync` 解析符号链接，防止通过 symlink 绕过目录限制。

导出函数 `evaluateRules(action)` 返回 `RuleEngineResult`，其中 `blocked` 为 `true` 表示存在 block 级别匹配。

### 3.3 `src/god/god-router.ts` — 路由决策

God 分析 Coder/Reviewer 输出后决定下一步路由，映射为 XState 工作流事件。

**`routePostCoder(godAdapter, coderOutput, context)`**
- 决策点：`POST_CODER`
- 可能的 action：`continue_to_review`（默认）| `retry_coder`（Coder 崩溃或输出为空时）
- 提取失败时 fallback 到 `continue_to_review`

**`routePostReviewer(godAdapter, reviewerOutput, context)`**
- 决策点：`POST_REVIEWER`
- 可能的 action：`route_to_coder` | `converged` | `phase_transition` | `loop_detected`
- 运行 `checkConsistency()` 一致性检查，对低置信度终止操作自动纠正为 `route_to_coder`
- 对 `route_to_coder` 强制要求 `unresolvedIssues` 非空
- 提取失败时 fallback 到 `route_to_coder`

**`godActionToEvent(decision)`** — God action 到 XState event 的映射：

| God Action | XState Event |
|------------|-------------|
| `continue_to_review` | `ROUTE_TO_REVIEW` |
| `retry_coder` | `ROUTE_TO_CODER` |
| `route_to_coder` | `ROUTE_TO_CODER` |
| `converged` | `CONVERGED` |
| `phase_transition` | `PHASE_TRANSITION`（携带 `nextPhaseId` 和 `summary`） |
| `loop_detected` | `LOOP_DETECTED` |

### 3.4 `src/god/god-convergence.ts` — 收敛判定

Reviewer 权威原则：Reviewer 是收敛的唯一权威来源。

核心类型：

```typescript
interface ConvergenceLogEntry {
  round: number;
  timestamp: string;
  classification: string;         // approved | changes_requested | needs_discussion
  shouldTerminate: boolean;
  blockingIssueCount: number;
  criteriaProgress: { criterion: string; satisfied: boolean }[];
  summary: string;                // <= 200 chars
}

interface ConvergenceResult {
  judgment: GodConvergenceJudgment;
  shouldTerminate: boolean;
  terminationReason?: string;
}
```

**`evaluateConvergence(godAdapter, reviewerOutput, context)`** — 主函数

决策树（按优先级）：
1. 无 Reviewer 输出 → 不终止（Reviewer 权威要求）
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

**`validateConvergenceConsistency(judgment)`** — 内部验证：
- `classification: approved` + `blockingIssueCount > 0` → 矛盾
- `shouldTerminate: true` + `blockingIssueCount > 0` → 矛盾（exception reason 除外）
- `shouldTerminate: true` + 未满足 criteria → 矛盾（exception reason 除外）

---

## 4. 任务管理

### 4.1 `src/god/task-init.ts` — 任务初始化

导出函数：

**`initializeTask(godAdapter, taskPrompt, systemPrompt, projectDir?)`**

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

**`applyDynamicRounds(currentMax, suggested, taskType)`** — 运行时动态调整轮次。

### 4.2 `src/god/phase-transition.ts` — 阶段转换

管理 compound 任务的多阶段转换。

```typescript
interface Phase {
  id: string;
  name: string;
  type: 'explore' | 'code' | 'discuss' | 'review' | 'debug' | 'compound';
  description: string;
}

interface PhaseTransitionResult {
  shouldTransition: boolean;
  nextPhaseId?: string;
  previousPhaseSummary?: string;
}
```

**`evaluatePhaseTransition(currentPhase, phases, convergenceLog, godDecision)`**

转换条件：
1. God decision `action === 'phase_transition'`
2. 当前 phase 在 phases 数组中有后继
3. 优先使用 God 指定的 `nextPhaseId`，fallback 到顺序下一个 phase
4. 防止自转换（God 幻觉 `nextPhaseId === currentPhase.id`）

转换时生成 `previousPhaseSummary`，包含已完成 phase 的最终轮次、classification、blocking issues、criteria 达成率。

### 4.3 `src/god/tri-party-session.ts` — 三方会话管理

管理 Coder、Reviewer、God 三方的会话协调。

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
- **God 始终不恢复**（`god = null`），因为 God 必须以无状态 system prompt 重新运行

---

## 5. 质量保障

### 5.1 `src/god/consistency-checker.ts` — 一致性检查

纯规则检查（< 1ms，无 LLM 调用），检测 God JSON 输出中的逻辑矛盾（幻觉）。

```typescript
interface ConsistencyViolation {
  type: 'structural' | 'semantic' | 'low_confidence';
  description: string;
  autoFix?: unknown;
}

interface ConsistencyResult {
  valid: boolean;
  violations: ConsistencyViolation[];
  corrected?: unknown;
}
```

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

### 5.2 `src/god/drift-detector.ts` — 渐进漂移检测

检测 God 决策的渐进偏移，防止长期运行中 God 逐渐偏离正确轨道。

```typescript
type DriftType = 'god_too_permissive' | 'confidence_declining';
type DriftSeverity = 'mild' | 'severe';
```

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

检测到漂移后自动重置计数器，防止恢复后立即重新触发。

构造函数要求：当提供 `sessionDir` 时必须同时提供 `seqProvider`，防止与 `GodAuditLogger` 写入同一文件时 seq 冲突。

### 5.3 `src/god/loop-detector.ts` — 死循环检测

检测任务执行中的死循环（同一问题反复出现但无实质进展）。

```typescript
interface LoopIntervention {
  type: 'rephrase_prompt' | 'skip_issue' | 'force_converge';
  details: string;
}

interface LoopDetectionResult {
  detected: boolean;
  reason?: string;
  suggestedAction?: string;
  intervention?: LoopIntervention;
}
```

**`detectLoop(convergenceLog, recentDecisions)`** — 主检测函数

需要至少 3 轮数据（`STAGNATION_THRESHOLD`）。检测信号的组合逻辑：

1. 如果 `blockingIssueCount` 在递减 → 非循环，直接返回
2. 检查最近 3 轮 `progressTrend` 是否全为 `stagnant` 或 `declining`
3. 检查 `blockingIssueCount` 是否不递减
4. 检查 `unresolvedIssues` 的语义重复（排序后字符串比较）

**干预策略**：
- 所有轮次 declining → `force_converge`（防止进一步恶化）
- 语义重复 + 不递减 → `rephrase_prompt`（打破循环）
- 仅不递减 → `rephrase_prompt`（打破停滞）

---

## 6. 可靠性

### 6.1 `src/god/degradation-manager.ts` — 四级降级管理

God CLI 故障时的自动降级与恢复。

```typescript
type DegradationLevel = 'L1' | 'L2' | 'L3' | 'L4';
type GodErrorKind = 'process_exit' | 'timeout' | 'parse_failure' | 'schema_validation';

interface DegradationState {
  level: DegradationLevel;
  consecutiveFailures: number;
  godDisabled: boolean;
  fallbackActive: boolean;
  lastError?: string;
}
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
- `handleGodFailure(error, context?)` — 处理 God 失败，返回 `DegradationAction`（`retry` / `retry_with_correction` / `fallback`）
- `handleGodSuccess()` — 成功后重置计数（L4 永久不恢复）
- `serializeState()` — 序列化状态用于 duo resume
- 构造函数支持 `restoredState` 恢复之前的降级状态

### 6.2 `src/god/alert-manager.ts` — 异常告警

三种告警规则：

| 类型 | 级别 | 触发条件 | UI 表现 |
|------|------|---------|---------|
| `GOD_LATENCY` | Warning | God 调用 > 30s | StatusBar spinner |
| `STAGNANT_PROGRESS` | Warning | 连续 3 轮 blockingIssueCount 不递减 | Blocking card |
| `GOD_ERROR` | Critical | God API 故障 | System message |

行为区分：
- Warning → 不阻塞工作流
- Critical → 暂停工作流，等待用户确认

`AlertManager` 类方法：
- `checkLatency(latencyMs)` → `Alert | null`
- `checkProgress(convergenceLog)` → `Alert | null`
- `checkGodError(error)` → `Alert`（始终返回 Critical）
- `shouldBlockWorkflow(alert)` → `boolean`

### 6.3 `src/god/interrupt-clarifier.ts` — 中断意图分类

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

超时设置为 15s（比其他 God 调用更短，因为中断需要快速响应）。

God 不可用时 fallback：直接使用用户输入作为 `redirect` instruction。

---

## 7. 持久化与审计

### 7.1 `src/god/god-audit.ts` — 审计日志

Append-only JSONL 格式审计日志，记录所有 God 决策。

```typescript
interface GodAuditEntry {
  seq: number;              // 序号
  timestamp: string;
  round: number;
  decisionType: string;     // CONVERGENCE, ROUTING_POST_CODE, ROUTING_POST_REVIEW,
                            // AUTO_DECISION, PROMPT_GENERATION, HALLUCINATION_DETECTED,
                            // DRIFT_DETECTED, DEGRADATION_L4, INTERRUPT_CLASSIFICATION
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

两种 API：

**`appendAuditLog(sessionDir, entry)`** — 兼容函数，直接追加条目到 `god-audit.jsonl`

**`GodAuditLogger` 类** — 带 seq 追踪和 `outputRef` 支持
- `append(entry, fullOutput?)` — 自动递增 seq，可选存储完整 God 输出到 `god-decisions/` 目录
- `getEntries(filter?)` — 读取所有条目，可按 `decisionType` 过滤
- `getSequence()` — 获取当前 seq
- 构造时从已有日志文件恢复 seq

**`cleanupOldDecisions(dir, maxSizeMB)`** — `god-decisions/` 目录超 50MB 时清理最旧的文件，按 seq 前缀排序删除。

### 7.2 `src/god/god-session-persistence.ts` — God 会话持久化

```typescript
async function restoreGodSession(state, adapterFactory): Promise<GodSessionRestoreResult | null>
```

当前实现始终返回 `null`。God 现在通过无状态的 `GodAdapter` 接口运行，持久化的 God session ID 仅保留在快照中用于向后兼容，运行时恢复已被有意禁用。

---

## 8. Schema 定义

### `src/types/god-schemas.ts` — Zod Schema

使用 Zod 定义 God 输出的 5 个 JSON schema，确保类型安全和运行时验证：

**`GodTaskAnalysisSchema`** — TASK_INIT 输出
- `taskType`: 6 种枚举（explore/code/discuss/review/debug/compound）
- `confidence`: 0.0-1.0
- `suggestedMaxRounds`: 1-20 整数
- `terminationCriteria`: 字符串数组
- `phases`: compound 类型时必须非空（Zod refine 约束）

**`GodPostCoderDecisionSchema`** — POST_CODER 路由
- `action`: `continue_to_review` | `retry_coder`
- `retryHint`: 可选

**`GodPostReviewerDecisionSchema`** — POST_REVIEWER 路由
- `action`: `route_to_coder` | `converged` | `phase_transition` | `loop_detected`
- `unresolvedIssues`: `route_to_coder` 时必须非空（Zod refine 约束）
- `confidenceScore`: 0.0-1.0
- `progressTrend`: improving/stagnant/declining
- `nextPhaseId`: 可选

**`GodConvergenceJudgmentSchema`** — CONVERGENCE 判定
- `classification`: approved/changes_requested/needs_discussion
- `shouldTerminate`: boolean
- `reason`: nullable string
- `blockingIssueCount`: >= 0 整数
- `criteriaProgress`: 数组
- `reviewerVerdict`: string

**`GodAutoDecisionSchema`** — AUTO_DECISION
- `action`: `accept` | `continue_with_instruction`
- `reasoning`: 最大 2000 字符（`MAX_REASONING_LENGTH`）
- `instruction`: 可选

---

## 9. 集成点

### 与 Workflow Engine 的集成

God router 的输出通过 `godActionToEvent()` 映射为 XState 工作流事件（`WorkflowEvent`），直接驱动状态机转换。主要事件包括 `ROUTE_TO_REVIEW`、`ROUTE_TO_CODER`、`CONVERGED`、`PHASE_TRANSITION`、`LOOP_DETECTED`。

### 与 UI 层的集成

- `AlertManager` 的 `Alert` 类型被 UI 组件消费，Warning 级别显示为 StatusBar spinner 或非阻塞卡片，Critical 级别显示为阻塞确认对话框
- `DegradationNotification` 通过 system message 通知用户降级状态
- `GodAutoDecision` 的 `reasoning` 字段有 2000 字符上限，防止 UI 溢出
- God 决策结果用于 `GodDecisionBanner` 和 `TaskAnalysisCard` 等 UI 组件

### 与 Parser 层的集成

God 模块依赖 `src/parsers/god-json-extractor.ts` 的 `extractWithRetry()` 函数从 God 原始输出中提取和验证 JSON。该函数支持：
- 从 markdown code block 中提取 JSON
- Zod schema 验证
- 失败时回调重试（附带 error hint），最多重试一次

### 与 Session 层的集成

- `DegradationManager` 支持 `serializeState()` / `restoredState` 用于 duo resume
- `GodAuditLogger` 的 seq 从已有日志文件恢复，确保 resume 后审计连续性
- `TriPartySession` 确保 resume 时三方会话独立恢复，God 始终无状态重新开始

### 与旧组件的 Fallback 关系

降级时 God 模块回退到以下旧组件：
- `ContextManager`（`src/session/context-manager.ts`）— 替代 `GodContextManager` + `GodPromptGenerator`
- `ConvergenceService`（`src/decision/convergence-service.ts`）— 替代 `god-convergence.ts`
- `ChoiceDetector`（`src/decision/choice-detector.ts`）— 替代 `god-router.ts` 的路由功能
