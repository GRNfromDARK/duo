# Duo 系统架构

## 八层架构

Duo 采用八层架构，自顶向下职责分明，层间单向依赖：

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 1: CLI 入口层                                                │
│  cli.ts, cli-commands.ts, index.ts                                  │
│  职责: 命令解析、参数校验、渲染启动                                      │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2: UI 组件层                                                 │
│  App.tsx, MainLayout.tsx, SetupWizard.tsx, StatusBar.tsx,            │
│  StreamRenderer.tsx, GodDecisionBanner.tsx, ... (24 components)     │
│  职责: 终端交互界面、流式输出渲染、Overlay 面板                          │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 3: UI 状态层                                                 │
│  session-runner-state.ts, god-decision-banner.ts,                   │
│  escape-window.ts, overlay-state.ts, ... (24 state files)           │
│  职责: 纯函数状态管理，为 UI 组件提供数据                                │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 4: Sovereign God Runtime                                     │
│  god-decision-service.ts, hand-executor.ts, rule-engine.ts,         │
│  observation-classifier.ts, task-init.ts, degradation-manager.ts,   │
│  consistency-checker.ts, loop-detector.ts, ... (28 files)           │
│  职责: Observe -> Decide -> Act 自主决策循环                           │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 5: 工作流引擎层                                               │
│  workflow-machine.ts (XState v5), interrupt-handler.ts              │
│  职责: 状态机驱动、中断处理、会话恢复状态路由                              │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 6: 决策引擎层 (旧版 fallback)                                 │
│  choice-detector.ts, convergence-service.ts                         │
│  职责: God 降级到 L4 后的规则兜底决策                                   │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 7: 会话管理层                                                 │
│  session-starter.ts, session-manager.ts, context-manager.ts,        │
│  prompt-log.ts                                                      │
│  职责: 启动参数解析、会话持久化 (原子写入)、Prompt 上下文                   │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 8: 适配层                                                     │
│  adapters/ (registry + detect + factory + 12 adapters)              │
│  parsers/ (stream-json / jsonl / text / god-json-extractor)         │
│  types/ (adapter / session / god-adapter / god-actions /             │
│          god-envelope / observation)                                 │
│  职责: AI 工具统一接口、输出解析、核心类型定义                             │
└─────────────────────────────────────────────────────────────────────┘
```

## 各层职责

### Layer 1: CLI 入口层

| 文件 | 职责 |
|------|------|
| `cli.ts` | 程序入口。解析 `process.argv`，分发到 `start` / `resume` / `log` / `--version`。`start` 命令检测已安装 CLI、创建 `SessionConfig`、渲染 Ink `App` 组件 |
| `cli-commands.ts` | 命令处理器。`handleStart` 检测工具 + 校验参数；`handleResume` 加载会话快照并校验完整性；`handleLog` 读取 God 审计日志、按类型过滤、输出延迟统计 |
| `index.ts` | 版本号导出 (`VERSION = '1.0.0'`) |

### Layer 2: UI 组件层

基于 Ink + React 的 24 个终端 UI 组件：

| 组件 | 职责 |
|------|------|
| `App.tsx` | 根组件。管理 XState 状态机生命周期、God 编排集成、会话启动/恢复 |
| `MainLayout.tsx` | 主布局：消息列表 + 输入区 + 状态栏 |
| `SetupWizard.tsx` | 交互式设置向导：引导用户选择 Coder / Reviewer / God / Task |
| `StatusBar.tsx` | 底部状态栏：显示轮次、状态机状态、God 信息 |
| `StreamRenderer.tsx` | 流式渲染器：实时显示 LLM 输出 |
| `GodDecisionBanner.tsx` | God 决策横幅：显示路由/收敛/accept 决策 |
| `PhaseTransitionBanner.tsx` | 阶段转换横幅：compound 任务阶段切换时展示 |
| `TaskAnalysisCard.tsx` | 任务分析卡片：展示 TASK_INIT 分析结果 |
| `CompletionScreen.tsx` | 任务完成画面 |
| 其他 14 个组件 | InputArea, MessageView, CodeBlock, SystemMessage, ScrollIndicator, DirectoryPicker, ConvergenceCard, DisagreementCard, HelpOverlay, ContextOverlay, TimelineOverlay, SearchOverlay, ReclassifyOverlay, TaskBanner, ThinkingIndicator |

### Layer 3: UI 状态层

24 个纯函数状态管理模块，为 UI 组件提供数据：

| 文件 | 职责 |
|------|------|
| `session-runner-state.ts` | 核心会话运行状态，驱动整个 UI 生命周期 |
| `escape-window.ts` | Escape Window -- God 自主决策前给用户的干预机会 |
| `god-decision-banner.ts` | God 决策横幅数据 |
| `god-fallback.ts` | God 降级到 fallback 模式的状态管理 |
| `completion-flow.ts` | 完成流程状态 |
| `global-ctrl-c.ts` | 全局 Ctrl+C 处理 |
| `safe-shutdown.ts` | 安全关机状态 |
| 其他 17 个文件 | scroll-state, round-summary, display-mode, directory-picker-state, keybindings, overlay-state, markdown-parser, git-diff-stats, message-lines, god-message-style, god-overlay, god-routing-feedback, phase-transition-banner, reclassify-overlay, resume-summary, task-analysis-card |

### Layer 4: Sovereign God Runtime

**核心创新层** -- 28 个文件，实现 God LLM 作为自主决策者的完整运行时。详见下方 "God LLM 架构" 章节。

### Layer 5: 工作流引擎层

| 文件 | 职责 |
|------|------|
| `workflow-machine.ts` | XState v5 状态机。12 个状态、20+ 事件。详见下方 "状态机详解" |
| `interrupt-handler.ts` | 中断处理。单次 Ctrl+C 杀进程 -> 生成 `human_interrupt` Observation -> 走 Observation pipeline 到 God。文本中断附带用户指令。双击 Ctrl+C (<500ms) 保存会话后退出 |

### Layer 6: 决策引擎层 (旧版 fallback)

God 降级到 L4 后的兜底组件：

| 文件 | 职责 |
|------|------|
| `choice-detector.ts` | 检测 LLM 输出中的提问/选项 |
| `convergence-service.ts` | 基于规则的收敛判断 (不依赖 God LLM) |

### Layer 7: 会话管理层

| 文件 | 职责 |
|------|------|
| `session-starter.ts` | 解析 CLI 参数 (`parseStartArgs`)，创建 `SessionConfig`，校验 Coder/Reviewer 是否已安装 |
| `session-manager.ts` | 会话持久化。原子写入 (write-tmp-rename) 到 `.duo/sessions/<id>/snapshot.json`，支持 load / list / validate |
| `context-manager.ts` | Prompt 上下文构建 (God 降级时使用，正常模式由 `god-prompt-generator.ts` 替代) |
| `prompt-log.ts` | Prompt 日志记录 |

### Layer 8: 适配层

三个子系统：

**Adapter 子系统** -- 统一 12 种 AI 工具的执行接口：

| 文件 | 职责 |
|------|------|
| `registry.ts` | 静态注册表。每种工具定义 command / detectCommand / execCommand / outputFormat / yoloFlag / parserType |
| `detect.ts` | 自动检测已安装工具 (运行 detectCommand) |
| `factory.ts` | 按名称创建 `CLIAdapter` 实例 |
| `process-manager.ts` | 子进程管理 (spawn / kill / timeout / buffered output 收集) |
| `output-stream-manager.ts` | 输出流生命周期管理与多消费者广播 |
| `env-builder.ts` | 环境变量白名单构建 |
| 12 个 adapter 目录 | 每个包含具体 `adapter.ts` 实现 |

**Parser 子系统** -- 三种输出格式解析 + God JSON 提取：

| 文件 | 职责 |
|------|------|
| `stream-json-parser.ts` | 流式 JSON 解析 (Claude Code / Gemini / Amp / Qwen) |
| `jsonl-parser.ts` | JSONL 行解析 (Codex / Copilot / Cursor / Cline / Continue) |
| `text-stream-parser.ts` | 纯文本流解析 (Aider / Amazon Q / Goose) |
| `god-json-extractor.ts` | God 输出 JSON 提取 + Zod 校验。`extractWithRetry` 解析失败时带错误提示重试一次 |

**Type 子系统** -- 核心类型定义 (所有层共享)：

| 文件 | 职责 |
|------|------|
| `adapter.ts` | `CLIAdapter` 接口、`OutputChunk` (6 种 type)、`ExecOptions`、`CLIRegistryEntry` |
| `session.ts` | `SessionConfig` (projectDir + coder + reviewer + god + task) |
| `god-adapter.ts` | `GodAdapter` 接口 (与 CLIAdapter 分离，支持 toolUsePolicy / minimumTimeoutMs) |
| `god-actions.ts` | 11 种 Hand Action 的 Zod discriminated union |
| `god-envelope.ts` | `GodDecisionEnvelope` (diagnosis + authority + actions + messages)，含 authority 语义约束 |
| `observation.ts` | 13 种 Observation 类型 (source / type / summary / severity / timestamp / round) |

## 数据流

### 完整会话数据流 (Observe -> Decide -> Act)

```
用户输入任务
    |
    v
┌──────────────┐     SessionConfig     ┌────────────────┐
│  CLI 入口     │ ────────────────────> │  App.tsx (Ink)  │
└──────────────┘                       └───────┬────────┘
                                               |
                                               v
                                    ┌─────────────────────┐
                                    │  TASK_INIT           │ God 分析任务意图
                                    │  task-init.ts        │ -> 任务类型/阶段/轮次
                                    └──────────┬──────────┘
                                               |
                                               v
                                    ┌─────────────────────┐
                               ┌──> │  CODING              │ Coder 编码
                               |    │  CLIAdapter.execute() │
                               |    └──────────┬──────────┘
                               |               | coderOutput
                               |               v
                               |    ┌─────────────────────┐
                               |    │  OBSERVING           │ 收集 + 分类 Observation
                               |    │  observation-        │ (work_output / incident /
                               |    │  classifier.ts       │  quota_exhausted / ...)
                               |    └──────────┬──────────┘
                               |               | Observation[]
                               |               v
                               |    ┌─────────────────────┐
                               |    │  GOD_DECIDING        │ God 统一决策
                               |    │  god-decision-       │ observations + context
                               |    │  service.ts          │ -> GodDecisionEnvelope
                               |    └──────────┬──────────┘
                               |               | GodDecisionEnvelope
                               |               |   { diagnosis, authority,
                               |               |     actions[], messages[] }
                               |               v
                               |    ┌─────────────────────┐
                               |    │  EXECUTING           │ Hand 执行器
                               |    │  hand-executor.ts    │ GodAction[] -> 执行
                               |    │  rule-engine.ts      │ (含规则引擎校验)
                               |    └──────────┬──────────┘
                               |               | result Observation[]
                               |               v
                               |         ┌───────────┐
                               |         │  路由分支   │ resolvePostExecutionTarget()
                               |         └─────┬─────┘
                               |               |
                 ┌─────────────┼───────────────┼──────────────┬──────────────┐
                 |             |               |              |              |
                 v             v               v              v              v
          ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌──────────┐  ┌────────────┐
          │  CODING   │  │ REVIEWING │  │    DONE    │  │CLARIFYING│  │GOD_DECIDING│
          │(round++)  │  │           │  │  (final)   │  │(多轮问答) │  │ (re-enter) │
          └──────────┘  └───────────┘  └────────────┘  └──────────┘  └────────────┘
                               |
                               | reviewerOutput
                               v
                        (回到 OBSERVING -> GOD_DECIDING -> EXECUTING -> ...)
```

### God LLM 决策流

```
observations[] + GodDecisionContext
    |
    v
┌───────────────────────────────────────────┐
│  god-decision-service.ts                  │
│                                           │
│  1. buildUserPrompt()                     │
│     - Task Goal                           │
│     - Phase & Round                       │
│     - Phase Plan (compound 任务)           │
│     - Available Adapters                  │
│     - Observations (按 severity 排序)      │
│     - Last Decision Summary               │
│     - Hand Action Catalog (11 种动作)      │
│                                           │
│  2. collectGodAdapterOutput()             │
│     - GodAdapter.execute() (90s timeout)  │
│     - System Prompt (Sovereign God)       │
│                                           │
│  3. extractWithRetry()                    │
│     - JSON 提取                           │
│     - Zod GodDecisionEnvelopeSchema 校验   │
│     - 失败则带错误提示重试 1 次             │
│                                           │
│  4. 结果处理                              │
│     - 成功 -> DegradationManager.reset()  │
│     - 失败 -> DegradationManager.fail()   │
│              -> buildFallbackEnvelope()    │
└───────────────────┬───────────────────────┘
                    |
                    v
            GodDecisionEnvelope
            {
              diagnosis: { summary, currentGoal, currentPhaseId, notableObservations[] },
              authority: { userConfirmation, reviewerOverride, acceptAuthority },
              actions: GodAction[],
              messages: EnvelopeMessage[]
            }
```

### Hand Action 执行流

```
GodAction[]
    |
    v (per action, sequentially)
┌───────────────────────────┐
│  rule-engine.ts           │
│  evaluateRules(action)    │
│  R-001..R-005 检查        │
└──────────┬────────────────┘
           |
    ┌──────┴──────┐
    |             |
  blocked       pass
    |             |
    v             v
violation    executeSingleAction()
observation       |
    |        ┌────┴────────────────────────────────────────────┐
    |        | send_to_coder:  ctx.pendingCoderMessage = msg   |
    |        | send_to_reviewer: ctx.pendingReviewerMessage    |
    |        | accept_task:    ctx.taskCompleted = true        |
    |        | set_phase:      ctx.currentPhaseId = phaseId    |
    |        | stop_role:      adapter.kill()                  |
    |        | retry_role:     kill + queue message            |
    |        | switch_adapter: ctx.adapterConfig.set()         |
    |        | wait:           ctx.waitState.active = true     |
    |        | request_user_input: ctx.clarificationState      |
    |        | resume_after_interrupt: resumeStrategy           |
    |        | emit_summary:   audit log                       |
    |        └────┬────────────────────────────────────────────┘
    |             |
    v             v
  Observation[] (result observations -> 回到状态机)
```

## 状态机详解

### 12 个状态

基于 XState v5 的 `workflowMachine`，定义在 `engine/workflow-machine.ts`：

```
                         START_TASK
┌──────┐ ─────────────────────────────────> ┌───────────┐
│ IDLE │                                    │ TASK_INIT │
└──┬───┘                                    └─────┬─────┘
   |                                              |
   | RESUME_SESSION                  TASK_INIT_COMPLETE / TASK_INIT_SKIP
   v                                              |
┌──────────┐                                      v
│ RESUMING │                               ┌──────────┐
└──────────┘                          ┌──> │  CODING  │ <──────────────────────┐
  RESTORED_TO_*                       |    └────┬─────┘                        |
  -> 对应状态                          |         |                              |
                                      |    CODE_COMPLETE                       |
                                      |         | (clear observations)         |
                                      |         v                              |
                                      |    ┌───────────┐                       |
                               ┌──────┼──> │ OBSERVING │ <──────────┐          |
                               |      |    └─────┬─────┘            |          |
                               |      |          |                  |          |
                               |      |   OBSERVATIONS_READY        |          |
                               |      |          |                  |          |
                               |      |          v                  |          |
                               |      |    ┌──────────────┐        |          |
                               |      |    │ GOD_DECIDING │ <──┐   |          |
                               |      |    └──────┬───────┘    |   |          |
                               |      |           |            |   |          |
                               |      |    DECISION_READY      |   |          |
                               |      |           |            |   |          |
                               |      |           v            |   |          |
                               |      |    ┌───────────┐       |   |          |
                               |      |    │ EXECUTING │ ──────┘   |          |
                               |      |    └─────┬─────┘  (default:|          |
                               |      |          |      re-enter)  |          |
                               |      |   EXECUTION_COMPLETE       |          |
                               |      |          |                 |          |
                               |      |    ┌─────┴──────────┐     |          |
                               |      |    | 路由分支         |     |          |
                               |      |    | (guards)        |     |          |
                               |      |    └─┬──┬──┬──┬──┬──┘     |          |
                               |      |      |  |  |  |  |        |          |
      ┌──────────────────── CODING ───┘      |  |  |  |  |        |          |
      |                                      |  |  |  |  |        |          |
      | REVIEW_COMPLETE        REVIEWING ────┘  |  |  |  |        |          |
      | (clear observations)                    |  |  |  |        |          |
      |                                   DONE -┘  |  |  |        |          |
      v                                            |  |  |        |          |
┌───────────┐                           CLARIFYING-┘  |  |        |          |
│ REVIEWING │                                         |  |        |          |
└───────────┘                          GOD_DECIDING --┘  |        |          |
                                                         |        |          |
                              ┌───────────────── circuit |        |          |
                              |                  breaker |        |          |
                              v                  tripped |        |          |
                       ┌─────────────────┐               |        |          |
                       │ MANUAL_FALLBACK │ <─────────────┘        |          |
                       └────────┬────────┘                        |          |
                                |                                 |          |
                         USER_CONFIRM                             |          |
                           |        |                             |          |
                      accept    continue                          |          |
                           |        └─────────────────────────────|──────────┘
                           v                                      |
                       ┌────────┐                                 |
                       │  DONE  │ (final)                         |
                       └────────┘                                 |
                                                                  |
┌─────────────┐     OBSERVATIONS_READY -> GOD_DECIDING            |
│ INTERRUPTED │ (backward compat, session resume)                 |
└─────────────┘                                                   |
                                                                  |
┌────────────┐      OBSERVATIONS_READY ───────────────────────────┘
│ CLARIFYING │      (God 多轮澄清: human answers -> GOD_DECIDING
│            │       -> God 再问或 resume_after_interrupt)
└────────────┘

┌─────────┐
│  ERROR  │ <── PROCESS_ERROR / TIMEOUT (from CODING / REVIEWING /
└────┬────┘     OBSERVING / GOD_DECIDING / EXECUTING / RESUMING)
     |
     | RECOVERY
     v
  GOD_DECIDING (reset consecutiveRouteToCoder)
```

### 20+ 事件类型

| 事件 | 源 | 目标状态 | 说明 |
|------|-----|---------|------|
| `START_TASK` | IDLE | TASK_INIT | 用户启动任务，设置 taskPrompt |
| `TASK_INIT_COMPLETE` | TASK_INIT | CODING | God 完成意图解析，设置 activeProcess=coder |
| `TASK_INIT_SKIP` | TASK_INIT | CODING | God 不可用，跳过分析直接开始 |
| `CODE_COMPLETE` | CODING | OBSERVING | Coder 输出完成，清空旧 observations |
| `REVIEW_COMPLETE` | REVIEWING | OBSERVING | Reviewer 输出完成，清空旧 observations |
| `OBSERVATIONS_READY` | OBSERVING / INTERRUPTED / CLARIFYING | GOD_DECIDING | Observation 分类完成，送 God 决策 |
| `DECISION_READY` | GOD_DECIDING | EXECUTING | God 返回 GodDecisionEnvelope |
| `EXECUTION_COMPLETE` | EXECUTING | (多目标) | Hand 执行完毕，按 guard 路由到目标状态 |
| `INCIDENT_DETECTED` | CODING / REVIEWING | OBSERVING | 运行时事件 (中断/异常)，冻结 activeProcess |
| `USER_CONFIRM` | MANUAL_FALLBACK | DONE / CODING | 用户确认 accept 或 continue |
| `PROCESS_ERROR` | 多个状态 | ERROR | 进程错误 |
| `TIMEOUT` | CODING / REVIEWING | ERROR | 进程超时 |
| `RECOVERY` | ERROR | GOD_DECIDING | 错误恢复，重置 circuit breaker |
| `RESUME_SESSION` | IDLE | RESUMING | 恢复会话 |
| `RESTORED_TO_CODING` | RESUMING | CODING | 恢复到 CODING 状态 |
| `RESTORED_TO_REVIEWING` | RESUMING | REVIEWING | 恢复到 REVIEWING 状态 |
| `RESTORED_TO_WAITING` | RESUMING | GOD_DECIDING | 恢复到 GOD_DECIDING 状态 |
| `RESTORED_TO_INTERRUPTED` | RESUMING | INTERRUPTED | 恢复到 INTERRUPTED 状态 |
| `RESTORED_TO_CLARIFYING` | RESUMING | CLARIFYING | 恢复到 CLARIFYING 状态 |
| `CLEAR_PENDING_PHASE` | GOD_DECIDING / MANUAL_FALLBACK | (保持) | 清除待转换阶段 |
| `MANUAL_FALLBACK_REQUIRED` | GOD_DECIDING | MANUAL_FALLBACK | God 降级需人工介入 |

### EXECUTION_COMPLETE 路由守卫

`EXECUTION_COMPLETE` 是状态机最复杂的事件，通过 `resolvePostExecutionTarget()` 函数和 6 个 guard 决定目标状态：

| Guard | 条件 | 目标 | 说明 |
|-------|------|------|------|
| `circuitBreakerTripped` | 目标为 CODING 且 consecutiveRouteToCoder + 1 >= 3 | MANUAL_FALLBACK | 防止死循环 |
| `executionTargetCoding` | actions 含 `send_to_coder` 或 `retry_role(coder)` | CODING | round++, counter++ |
| `executionTargetReviewing` | actions 含 `send_to_reviewer` 或 `retry_role(reviewer)` | REVIEWING | 重置 counter |
| `executionTargetDone` | actions 含 `accept_task` | DONE | 任务完成 |
| `executionTargetClarifying` | actions 含 `request_user_input` | CLARIFYING | God 向人类提问 |
| (default) | 其他 (wait / emit_summary / set_phase) | GOD_DECIDING | re-enter 决策循环 |

### WorkflowContext 字段

```typescript
interface WorkflowContext {
  round: number;                          // 当前轮次
  maxRounds: number;                      // 最大轮次 (默认 10)
  consecutiveRouteToCoder: number;        // 连续 route-to-coder 次数 (circuit breaker)
  taskPrompt: string | null;              // 任务描述
  activeProcess: 'coder' | 'reviewer' | null;  // 当前活跃进程
  lastError: string | null;              // 最近错误
  lastCoderOutput: string | null;        // Coder 最近输出
  lastReviewerOutput: string | null;     // Reviewer 最近输出
  sessionId: string | null;              // 会话 ID
  pendingPhaseId: string | null;         // 待转换阶段 ID
  pendingPhaseSummary: string | null;    // 待转换阶段摘要
  currentObservations: Observation[];    // 当前 Observation 列表
  lastDecision: GodDecisionEnvelope | null;  // 最近 God 决策
  incidentCount: number;                 // 事件计数
  frozenActiveProcess: 'coder' | 'reviewer' | null;  // CLARIFYING 前冻结的活跃进程
  clarificationRound: number;            // 澄清轮次
  clarificationObservations: Observation[];  // 累积的澄清 Observation
}
```

## God LLM 架构

### 设计原则

1. **Sovereign Authority**：God 是运行时唯一决策者，所有状态变更必须通过结构化 GodAction 表达
2. **Reviewer 是收敛信号**：Reviewer 的 verdict 是重要参考，但 God 保留 override 权力 (需 system_log 审计)
3. **Rule Engine 不可覆盖**：block 级别规则 (R-001..R-005) 具有绝对优先级，God 的 action 被阻止时产生 violation observation
4. **统一决策信封**：GodDecisionEnvelope 替代旧版 5 种分散 schema，所有决策走同一管道
5. **无状态设计**：God 运行时不保持跨调用状态，每次 makeDecision() 调用独立
6. **增量提示**：God CLI 通过 `--resume` 维护对话历史，Duo 每轮只发送增量信息

### God 子系统组成

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Sovereign God Runtime                               │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Decision Pipeline (统一决策管道)                                  │   │
│  │                                                                    │   │
│  │  observation-classifier.ts    Observation 分类                     │   │
│  │        |                                                           │   │
│  │        v                                                           │   │
│  │  god-decision-service.ts      makeDecision(obs, ctx) -> Envelope  │   │
│  │        |                                                           │   │
│  │        v                                                           │   │
│  │  hand-executor.ts             executeActions(actions) -> obs[]     │   │
│  │        |                                                           │   │
│  │        v                                                           │   │
│  │  rule-engine.ts               R-001..R-005 安全校验               │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Adapter Layer (God 专用适配器)                                   │   │
│  │                                                                    │   │
│  │  god-adapter-factory.ts       创建 GodAdapter                     │   │
│  │  god-adapter-config.ts        配置 + resume 兼容性                │   │
│  │  god-call.ts                  collectGodAdapterOutput (统一调用)   │   │
│  │  god-system-prompt.ts         CRITICAL OVERRIDE 系统 prompt       │   │
│  │  god-prompt-generator.ts      动态 prompt 构建                    │   │
│  │  god-context-manager.ts       token 估算 + 增量提示管理            │   │
│  │  adapters/claude-code-god-adapter.ts                              │   │
│  │  adapters/codex-god-adapter.ts                                    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Quality & Safety Guards (质量与安全守卫)                          │   │
│  │                                                                    │   │
│  │  consistency-checker.ts       检测 God 输出逻辑矛盾/幻觉           │   │
│  │  loop-detector.ts             循环检测 (3 轮 stagnant / 语义重复)  │   │
│  │  drift-detector.ts            决策质量漂移监控                     │   │
│  │  degradation-manager.ts       L1-L4 四级降级策略                  │   │
│  │  alert-manager.ts             延迟/停滞/API 错误告警              │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Task & Session (任务与会话管理)                                   │   │
│  │                                                                    │   │
│  │  task-init.ts                 任务分析 (类型/阶段/轮次/终止标准)   │   │
│  │  phase-transition.ts          compound 任务多阶段转换              │   │
│  │  tri-party-session.ts         Coder/Reviewer/God 三方隔离          │   │
│  │  god-session-persistence.ts   God 会话持久化接口                   │   │
│  │  god-audit.ts                 审计日志 (append-only JSONL)         │   │
│  │  message-dispatcher.ts        消息分发器                           │   │
│  │  interrupt-clarifier.ts       中断意图分类                         │   │
│  │  observation-integration.ts   中断/文本中断 -> Observation 转换     │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Legacy (旧版，保留兼容)                                          │   │
│  │                                                                    │   │
│  │  god-router.ts                旧版路由 (POST_CODER/POST_REVIEWER) │   │
│  │  god-convergence.ts           旧版收敛判断                         │   │
│  │  auto-decision.ts             旧版自动决策                         │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### GodDecisionEnvelope 结构

所有 God 决策通过统一的 Envelope 表达：

```
GodDecisionEnvelope
├── diagnosis                        God 对当前态势的诊断
│   ├── summary: string              情况评估摘要
│   ├── currentGoal: string          当前目标
│   ├── currentPhaseId: string       当前阶段 ID
│   └── notableObservations: string[]  驱动本次决策的关键观察
│
├── authority                        权限声明
│   ├── userConfirmation: 'human' | 'god_override' | 'not_required'
│   ├── reviewerOverride: boolean    是否覆盖 Reviewer (true 需 system_log)
│   └── acceptAuthority: 'reviewer_aligned' | 'god_override' | 'forced_stop'
│
├── actions: GodAction[]             结构化动作列表 (11 种 Hand Action)
│   ├── send_to_coder    { message }
│   ├── send_to_reviewer { message }
│   ├── stop_role        { role, reason }
│   ├── retry_role       { role, hint? }
│   ├── switch_adapter   { role, adapter, reason }
│   ├── set_phase        { phaseId, summary? }
│   ├── accept_task      { rationale, summary }
│   ├── wait             { reason, estimatedSeconds? }
│   ├── request_user_input { question }
│   ├── resume_after_interrupt { resumeStrategy: continue|redirect|stop }
│   └── emit_summary     { content }
│
└── messages: EnvelopeMessage[]      消息列表
    └── { target: 'coder'|'reviewer'|'user'|'system_log', content }
```

### 13 种 Observation 类型

| 类型 | 来源 | 说明 |
|------|------|------|
| `work_output` | coder | Coder 的工作输出 |
| `review_output` | reviewer | Reviewer 的审查输出 |
| `quota_exhausted` | runtime | API 配额耗尽 |
| `auth_failed` | runtime | 认证失败 |
| `adapter_unavailable` | runtime | Adapter 不可用 |
| `empty_output` | runtime | LLM 输出为空 |
| `meta_output` | coder/reviewer | 元信息输出 (非实质工作) |
| `tool_failure` | runtime | 工具调用失败 |
| `human_interrupt` | human | 用户 Ctrl+C 中断 |
| `human_message` | human | 用户文本中断 (附带指令) |
| `clarification_answer` | human | 用户回答 God 的澄清问题 |
| `phase_progress_signal` | runtime | 阶段进度信号 (Hand 执行结果) |
| `runtime_invariant_violation` | runtime | 运行时不变量违反 (rule-engine 阻止 / 执行失败) |

### 降级策略

四级降级 (`degradation-manager.ts`)：

```
L1 (正常)
 |
 | God adapter 超时/崩溃
 v
L2 (可重试)
 |  - 重试 1 次
 |  - 失败则使用 fallback envelope (wait action)
 |
 | JSON 解析/Zod 校验失败
 v
L3 (不可重试)
 |  - extractWithRetry 带错误提示重试 1 次
 |  - 失败则使用 fallback envelope
 |
 | 连续 3 次失败
 v
L4 (God 禁用)
    - 切换到旧版 decision/ 组件 (ChoiceDetector + ConvergenceService)
    - 全程无 God 参与
    - MANUAL_FALLBACK_REQUIRED -> 人工介入
```

## 关键设计决策

### 1. GodAdapter 与 CLIAdapter 接口分离

`GodAdapter` (`types/god-adapter.ts`) 独立于 `CLIAdapter` (`types/adapter.ts`)：

- God 需要 `toolUsePolicy` (forbid / allow-readonly) 控制工具使用
- God 需要 `minimumTimeoutMs` 确保足够推理时间 (90s)
- God 使用 `GodExecOptions` (必须传 systemPrompt + timeoutMs)
- Coder/Reviewer 使用 `ExecOptions` (支持 permissionMode / disableTools)

### 2. God 系统 prompt 使用 CRITICAL OVERRIDE

God 通过宿主 CLI (如 Claude Code) 运行，宿主有自己的系统提示词。`god-system-prompt.ts` 使用 `CRITICAL OVERRIDE` 前缀强制覆盖宿主行为，确保 God 只输出结构化 JSON，不使用工具、不编码、不读文件。

### 3. 统一 Envelope 替代分散 Schema

旧版使用 5 种独立 schema (GodTaskAnalysis / GodPostCoderDecision / GodPostReviewerDecision / GodConvergenceJudgment / GodAutoDecision)。新版 `GodDecisionEnvelope` 统一所有决策场景：
- 一个入口 (`makeDecision`)，一种输出格式
- 通过 `actions[]` 的组合表达任意决策
- authority 语义约束通过 Zod `superRefine` 在 schema 层强制执行

### 4. Observe -> Decide -> Act 循环替代散点路由

旧版 ROUTING_POST_CODE / ROUTING_POST_REVIEW / EVALUATING 三个散点路由合并为统一的 OBSERVING -> GOD_DECIDING -> EXECUTING 循环：
- OBSERVING: 收集并分类所有来源的 Observation
- GOD_DECIDING: God 统一分析所有 Observation，输出 Envelope
- EXECUTING: Hand 执行器逐个执行 GodAction，产生结果 Observation

### 5. 中断走 Observation Pipeline

中断 (Ctrl+C / 文本中断) 不再直接发送 XState 事件 (`USER_INTERRUPT`)，而是：
1. 生成 `human_interrupt` 或 `human_message` Observation
2. 通过 `INCIDENT_DETECTED` 事件进入 OBSERVING
3. 正常走 OBSERVING -> GOD_DECIDING -> EXECUTING 管道
4. God 决定如何处理中断 (continue / redirect / stop)

### 6. CLARIFYING 多轮澄清

God 可通过 `request_user_input` action 进入 CLARIFYING 状态：
- 冻结 `frozenActiveProcess` (记住中断前在做什么)
- 用户回答 -> `clarification_answer` Observation -> GOD_DECIDING
- God 可继续提问 (再次 request_user_input) 或恢复工作 (resume_after_interrupt)
- 累积的 `clarificationObservations` 保留完整上下文

### 7. Circuit Breaker 防死循环

连续 3 次 route-to-coder (`consecutiveRouteToCoder >= 3`) 触发熔断：
- 直接跳转 MANUAL_FALLBACK
- 需要人工确认 (continue 重置计数器 / accept 完成任务)
- route-to-reviewer 时自动重置计数器

### 8. BUG-22 Fallback Envelope 含 wait action

God 决策失败时的 fallback envelope 包含一个 `wait` action (而非空 actions)，防止 "empty actions -> empty results -> lost observations" 的死亡螺旋。

## 模块依赖图

```
cli.ts ──> cli-commands.ts
  |              |
  |              |── session/session-starter.ts
  |              |── session/session-manager.ts
  |              |── adapters/detect.ts
  |              └── god/god-audit.ts
  |
  └──> ui/components/App.tsx
          |
          |── engine/workflow-machine.ts (XState v5)
          |── engine/interrupt-handler.ts
          |       └── god/observation-integration.ts
          |           god/observation-classifier.ts
          |
          |── god/god-decision-service.ts ────────────────> god/god-call.ts
          |       |                                              |
          |       |── parsers/god-json-extractor.ts              |── types/god-adapter.ts
          |       |── types/god-envelope.ts                      └── god/god-system-prompt.ts
          |       └── god/degradation-manager.ts
          |               └── decision/convergence-service.ts
          |                   decision/choice-detector.ts
          |
          |── god/hand-executor.ts
          |       └── god/rule-engine.ts
          |
          |── god/task-init.ts ──> god/god-call.ts
          |── god/god-prompt-generator.ts
          |── god/god-context-manager.ts
          |── god/god-adapter-factory.ts ──> god/adapters/claude-code-god-adapter.ts
          |                                  god/adapters/codex-god-adapter.ts
          |── god/consistency-checker.ts
          |── god/loop-detector.ts
          |── god/drift-detector.ts
          |── god/alert-manager.ts
          |── god/phase-transition.ts
          |── god/tri-party-session.ts
          |── god/god-audit.ts
          |── god/message-dispatcher.ts
          |
          |── adapters/factory.ts ──> adapters/process-manager.ts
          |                           adapters/output-stream-manager.ts
          |                           adapters/env-builder.ts
          |                           adapters/{cli}/adapter.ts (x12)
          |── adapters/registry.ts
          |── adapters/detect.ts
          |
          |── session/session-manager.ts
          |── session/context-manager.ts
          |
          └── types/ (adapter, session, ui, god-adapter, god-actions,
                      god-envelope, observation, god-schemas)
```

### 依赖方向原则

- **上层 -> 下层**：严格单向依赖，上层可以依赖下层，反之不行
- **types/ 是最底层**：不依赖任何其他模块，被所有层共享
- **god/ -> decision/**：`degradation-manager.ts` 降级时依赖旧版 decision/ 组件
- **god/ 不依赖 ui/**：God Runtime 与 UI 解耦，通过 App.tsx 集成
- **engine/ 不依赖 god/**：状态机只定义状态和事件，不包含业务逻辑
- **adapters/ 不依赖 god/**：Adapter 层只负责工具统一接口，不参与决策
