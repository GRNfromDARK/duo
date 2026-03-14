# Duo 系统架构

## 分层架构

Duo 采用八层架构，自顶向下职责分明，层间单向依赖：

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: CLI 入口层                                            │
│  cli.ts, cli-commands.ts, index.ts                              │
├─────────────────────────────────────────────────────────────────┤
│  Layer 2: UI 组件层                                             │
│  App.tsx, MainLayout.tsx, SetupWizard.tsx, StatusBar.tsx, ...   │
├─────────────────────────────────────────────────────────────────┤
│  Layer 3: UI 状态层                                             │
│  session-runner-state.ts, god-decision-banner.ts,               │
│  escape-window.ts, god-fallback.ts, ...                         │
├─────────────────────────────────────────────────────────────────┤
│  Layer 4: God 编排层 [NEW]                                      │
│  task-init, god-router, god-convergence, auto-decision,         │
│  rule-engine, consistency-checker, loop/drift-detector, ...     │
├─────────────────────────────────────────────────────────────────┤
│  Layer 5: 工作流引擎层                                           │
│  workflow-machine.ts (XState v5), interrupt-handler.ts          │
├─────────────────────────────────────────────────────────────────┤
│  Layer 6: 决策引擎层（旧版 fallback）                              │
│  choice-detector.ts, convergence-service.ts                     │
├─────────────────────────────────────────────────────────────────┤
│  Layer 7: 会话管理层                                             │
│  session-starter.ts, session-manager.ts, context-manager.ts     │
├─────────────────────────────────────────────────────────────────┤
│  Layer 8: 适配层                                                 │
│  adapters/ (12 CLI 适配器), parsers/, types/                     │
│  god/adapters/ (God 专用适配器)                                   │
└─────────────────────────────────────────────────────────────────┘
```

## 各层职责

### Layer 1: CLI 入口层

| 文件 | 职责 |
|------|------|
| `cli.ts` | 程序入口。解析命令行参数，分发到 `start`/`resume`/`log` 处理器。`start` 命令检测已安装 CLI、创建 `SessionConfig`、渲染 Ink `App` 组件 |
| `cli-commands.ts` | 命令处理器。`handleStart` 检测工具+校验参数，`handleResume` 加载会话快照，`handleLog` 读取 God 审计日志并格式化输出 |
| `index.ts` | 版本号导出 |

### Layer 2: UI 组件层

基于 Ink + React 的终端 UI 组件：

| 组件 | 职责 |
|------|------|
| `App.tsx` | 根组件。管理 XState 状态机生命周期、会话启动/恢复、God 编排集成。约 70K，是最大的单文件 |
| `MainLayout.tsx` | 主布局。消息列表 + 输入区 + 状态栏的排列 |
| `SetupWizard.tsx` | 交互式设置向导。引导用户选择 Coder/Reviewer/God/Task |
| `StatusBar.tsx` | 底部状态栏。显示轮次、状态机状态、God 信息 |
| `InputArea.tsx` | 用户输入区。支持输入文本、中断操作 |
| `StreamRenderer.tsx` | 流式渲染器。实时显示 LLM 输出 |
| `GodDecisionBanner.tsx` | God 决策横幅。显示 God 的路由/收敛决策 |
| `PhaseTransitionBanner.tsx` | 阶段转换横幅。compound 任务阶段切换时显示 |
| `TaskAnalysisCard.tsx` | 任务分析卡片。展示 God 的 TASK_INIT 分析结果 |
| `ReclassifyOverlay.tsx` | 重分类 Overlay。允许用户修改 God 的任务分类 |
| 其他 | `MessageView`, `CodeBlock`, `SystemMessage`, `ScrollIndicator`, `DirectoryPicker`, `ConvergenceCard`, `DisagreementCard`, `HelpOverlay`, `ContextOverlay`, `TimelineOverlay`, `SearchOverlay` |

### Layer 3: UI 状态层

纯函数状态管理，为 UI 组件提供数据：

| 文件 | 职责 |
|------|------|
| `session-runner-state.ts` | 核心会话运行状态，驱动整个 UI 生命周期 |
| `escape-window.ts` | Escape 窗口状态 — God 自主决策前给用户的干预机会 |
| `god-decision-banner.ts` | God 决策横幅数据 |
| `god-fallback.ts` | God 降级到 fallback 模式的状态管理 |
| `god-message-style.ts` | God 消息的视觉样式 |
| `god-overlay.ts` | God 详情 Overlay 面板 |
| `phase-transition-banner.ts` | 阶段转换横幅数据 |
| `reclassify-overlay.ts` | 任务重分类 Overlay 数据 |
| `task-analysis-card.ts` | 任务分析卡片数据 |
| `resume-summary.ts` | 会话恢复摘要 |
| 其他 | `scroll-state`, `round-summary`, `display-mode`, `directory-picker-state`, `keybindings`, `overlay-state`, `markdown-parser`, `git-diff-stats`, `message-lines` |

### Layer 4: God 编排层

**God LLM 智能编排模块**（23 个文件），是 Duo 的核心创新。God 作为独立的第三方 LLM，自主完成以下职责：

#### 4.1 God 适配器子系统

| 文件 | 职责 |
|------|------|
| `god-adapter-config.ts` | God 适配器配置。定义支持的 God 工具列表、resume 时的 God 清理逻辑 |
| `god-adapter-factory.ts` | God 适配器工厂。`createGodAdapter(name)` 按名称创建 GodAdapter 实例 |
| `god-call.ts` | God 调用封装。`collectGodAdapterOutput()` 统一调用 God LLM 并收集输出，处理 tool_use 策略 |
| `adapters/claude-code-god-adapter.ts` | Claude Code 作为 God 的具体实现 |
| `adapters/codex-god-adapter.ts` | Codex 作为 God 的具体实现 |

#### 4.2 提示词与上下文

| 文件 | 职责 |
|------|------|
| `god-system-prompt.ts` | God 系统提示词构建。以 `CRITICAL OVERRIDE` 覆盖宿主 CLI 的默认行为，强制 JSON-only 输出 |
| `god-prompt-generator.ts` | 动态提示词生成。根据任务类型、轮次、阶段、历史记录生成 Coder/Reviewer 的提示词，以及 God 自身的决策提示词 |
| `god-context-manager.ts` | God 上下文管理。增量式提示（每轮只发送增量信息），token 估算（约 4 chars/token），超限时自动重建会话 |

#### 4.3 核心决策流

| 文件 | 职责 |
|------|------|
| `task-init.ts` | **任务初始化**。调用 God 解析用户任务意图，输出 `GodTaskAnalysis`（任务类型、阶段划分、建议轮次、终止标准）。按任务类型动态调整 maxRounds |
| `god-router.ts` | **路由决策**。Coder 输出后决定 `continue_to_review` 或 `retry_coder`；Reviewer 输出后决定 `route_to_coder`、`converged`、`phase_transition` 或 `loop_detected`。将 God 决策映射为 XState 事件 |
| `god-convergence.ts` | **收敛判断**。Reviewer 是收敛的唯一权威。输出 `GodConvergenceJudgment`（classification、shouldTerminate、blockingIssueCount、criteriaProgress）。max_rounds 和 loop_detected 可强制终止 |
| `auto-decision.ts` | **自主决策**。GOD_DECIDING 状态下 God 自主决定 `accept`（任务完成）或 `continue_with_instruction`（注入指令继续）。决策前经过 rule-engine 校验 |

#### 4.4 安全与质量保障

| 文件 | 职责 |
|------|------|
| `rule-engine.ts` | **规则引擎**。不可委托场景的同步规则（< 5ms，无 LLM）。block 级别规则具有绝对优先级，God 不可覆盖。保护系统目录（/etc, /usr 等）、检测危险命令 |
| `consistency-checker.ts` | **一致性校验**。检测 God JSON 输出中的逻辑矛盾：structural（缺失必填字段）、semantic（计数字段与分类字段矛盾）、low_confidence（低置信度关键决策）。自动修正语义矛盾 |
| `loop-detector.ts` | **循环检测**。3 轮连续 stagnant 进度、语义重复的 unresolvedIssues、blockingIssueCount 不下降。检测到后建议干预（rephrase_prompt/skip_issue/force_converge） |
| `drift-detector.ts` | **漂移检测**。监控 God 决策质量：`god_too_permissive`（连续 3+ 次 approve 而本地判断 changes_requested）、`confidence_declining`（4+ 轮连续置信度下降）。severe 级别触发临时 fallback |
| `degradation-manager.ts` | **降级管理**。四级降级策略：L1 正常、L2 可重试错误、L3 不可重试错误、L4 连续 3 次失败则禁用 God。降级后切换到旧版 decision/ 组件（ContextManager + ConvergenceService + ChoiceDetector） |
| `alert-manager.ts` | **告警管理**。三种告警：GOD_LATENCY（>30s）Warning、STAGNANT_PROGRESS（3 轮停滞）Warning、GOD_ERROR（API 失败）Critical。Warning 不阻塞，Critical 暂停等待确认 |

#### 4.5 多阶段与会话

| 文件 | 职责 |
|------|------|
| `phase-transition.ts` | **阶段转换**。compound 任务的多阶段管理。评估是否应转换阶段，保留跨阶段的 RoundRecord |
| `interrupt-clarifier.ts` | **中断分类**。God 分析用户中断意图：`restart`（重新开始）、`redirect`（改变方向）、`continue`（继续） |
| `god-audit.ts` | **审计日志**。append-only JSONL 格式。记录每次 God 决策的 seq、时间、轮次、决策类型、输入/输出摘要、延迟、完整输出引用 |
| `god-session-persistence.ts` | **会话持久化**。God 运行时无状态设计，恢复时不恢复 God 会话（向后兼容保留接口） |
| `tri-party-session.ts` | **三方会话协调**。独立恢复 Coder/Reviewer/God 的会话。各方互不影响，同一 CLI 工具时创建独立实例保证隔离 |

### Layer 5: 工作流引擎层

| 文件 | 职责 |
|------|------|
| `workflow-machine.ts` | XState v5 状态机。详见下方"状态机详解" |
| `interrupt-handler.ts` | 中断处理。单次 Ctrl+C 杀进程进 INTERRUPTED、文本中断附带指令、双击 Ctrl+C（<500ms）保存退出 |

### Layer 6: 决策引擎层（旧版 fallback）

God 降级到 L4 后的兜底组件：

| 文件 | 职责 |
|------|------|
| `choice-detector.ts` | 检测 LLM 输出中的提问/选项 |
| `convergence-service.ts` | 基于规则的收敛判断（不依赖 God LLM） |

### Layer 7: 会话管理层

| 文件 | 职责 |
|------|------|
| `session-starter.ts` | 解析 CLI 参数，创建 `SessionConfig`，校验 Coder/Reviewer 是否已安装 |
| `session-manager.ts` | 会话持久化。保存快照到 `.duo/sessions/<id>/snapshot.json`，加载/恢复/验证 |
| `context-manager.ts` | 旧版上下文管理。为 Coder/Reviewer 构建提示词（God 模式下由 `god-prompt-generator.ts` 替代） |

### Layer 8: 适配层

#### Coder/Reviewer 适配器

| 文件 | 职责 |
|------|------|
| `registry.ts` | 12 种 CLI 工具的静态注册表。每个工具定义 `command`, `detectCommand`, `execCommand`, `outputFormat`, `yoloFlag`, `parserType` |
| `detect.ts` | 自动检测已安装的 CLI 工具（运行 detectCommand） |
| `factory.ts` | 按名称创建 `CLIAdapter` 实例 |
| `process-manager.ts` | 子进程管理。通过 `spawn` 启动 CLI 进程，管理 stdin/stdout/stderr |
| `output-stream-manager.ts` | 输出流管理。收集 `AsyncIterable<OutputChunk>` 输出 |
| `env-builder.ts` | 构建 CLI 进程的环境变量 |
| 12 个适配器目录 | 每个包含具体适配器实现和可能的配置文件 |

#### 解析器

| 文件 | 职责 |
|------|------|
| `stream-json-parser.ts` | 流式 JSON 解析（Claude Code 格式） |
| `jsonl-parser.ts` | JSONL 行解析（Codex 格式） |
| `text-stream-parser.ts` | 纯文本流解析 |
| `god-json-extractor.ts` | God 输出 JSON 提取。支持 `extractWithRetry`：解析失败时带错误提示重试一次 |

#### 类型系统

| 文件 | 职责 |
|------|------|
| `adapter.ts` | `CLIAdapter` 接口、`OutputChunk`（text/code/tool_use/tool_result/error/status）、`ExecOptions`、`CLIRegistryEntry` |
| `session.ts` | `SessionConfig`（projectDir + coder + reviewer + god + task） |
| `ui.ts` | `RoleName`（12 种 AI 工具 + system + user）、`RoleStyle`（displayName + color + border） |
| `god-adapter.ts` | `GodAdapter` 接口。与 `CLIAdapter` 分离，支持 `toolUsePolicy`（forbid/allow-readonly）、`minimumTimeoutMs` |
| `god-schemas.ts` | 5 种 God 输出的 Zod Schema 定义（见下方"God 决策数据结构"） |

## 数据流

### 完整会话数据流

```
用户输入任务
    │
    ▼
┌──────────────┐     SessionConfig
│  CLI 入口     │ ──────────────────►  App.tsx (Ink 渲染)
└──────────────┘                        │
                                        ▼
                                 ┌──────────────┐
                                 │  TASK_INIT    │ God 意图解析
                                 └──────┬───────┘
                                        │ GodTaskAnalysis
                                        ▼
                              ┌─────────────────┐
                         ┌───►│    CODING        │ Coder 编码
                         │    └────────┬────────┘
                         │             │ coderOutput
                         │             ▼
                         │    ┌─────────────────────┐
                         │    │  ROUTING_POST_CODE   │ God 分析 Coder 输出
                         │    └────────┬────────────┘
                         │             │ GodPostCoderDecision
                         │             ▼
                         │    ┌─────────────────┐
                         │    │   REVIEWING      │ Reviewer 审查
                         │    └────────┬────────┘
                         │             │ reviewerOutput
                         │             ▼
                         │    ┌──────────────────────┐
                         │    │  ROUTING_POST_REVIEW  │ God 分析 Reviewer 输出
                         │    └────────┬─────────────┘
                         │             │ GodPostReviewerDecision
                         │             ▼
                         │        ┌────────────┐
                         │        │  路由分支    │
                         │        └─────┬──────┘
                         │              │
                    ┌────┴───┐    ┌─────┴──────┐    ┌───────────────┐
                    │route_to│    │  converged  │    │phase_transition│
                    │_coder  │    │             │    │               │
                    └────────┘    └─────┬──────┘    └───────┬───────┘
                         ▲              │                    │
                         │              ▼                    ▼
                         │        ┌────────────┐     ┌──────────────┐
                         │        │ EVALUATING  │     │ GOD_DECIDING │
                         │        └─────┬──────┘     └──────┬───────┘
                         │              │                    │
                         │         CONVERGED/            accept/
                         │         NOT_CONVERGED     continue_with_instruction
                         │              │                    │
                         │              ▼                    ▼
                         │        ┌────────────┐       ┌─────────┐
                         └────────│ GOD_DECIDING│       │  DONE   │
                                  └────────────┘       └─────────┘
```

### God LLM 决策流

God 在工作流中的 4 个决策点：

```
决策点 1: TASK_INIT
  输入: 用户任务描述
  输出: GodTaskAnalysis { taskType, phases?, suggestedMaxRounds, terminationCriteria }
  作用: 分类任务、规划阶段、设定轮次

决策点 2: ROUTING_POST_CODE
  输入: Coder 输出
  输出: GodPostCoderDecision { action: continue_to_review | retry_coder }
  作用: 判断 Coder 输出是否可用

决策点 3: ROUTING_POST_REVIEW
  输入: Reviewer 输出 + convergenceLog + unresolvedIssues
  输出: GodPostReviewerDecision {
    action: route_to_coder | converged | phase_transition | loop_detected,
    unresolvedIssues, confidenceScore, progressTrend
  }
  作用: 核心路由决策 — 继续迭代/收敛/阶段转换/循环检测

决策点 4: GOD_DECIDING (自主决策)
  输入: 当前状态上下文 + waitingReason
  输出: GodAutoDecision { action: accept | continue_with_instruction }
  作用: 在 GOD_DECIDING 状态下自主决定是否完成任务
  约束: 必须通过 rule-engine 校验
```

### God 决策数据结构

5 种 Zod Schema 定义在 `types/god-schemas.ts`：

| Schema | 决策点 | 关键字段 |
|--------|--------|----------|
| `GodTaskAnalysisSchema` | TASK_INIT | `taskType` (6种), `phases?`, `suggestedMaxRounds`, `terminationCriteria` |
| `GodPostCoderDecisionSchema` | ROUTING_POST_CODE | `action` (continue_to_review/retry_coder), `retryHint?` |
| `GodPostReviewerDecisionSchema` | ROUTING_POST_REVIEW | `action` (4种), `unresolvedIssues`, `confidenceScore`, `progressTrend` |
| `GodConvergenceJudgmentSchema` | EVALUATING | `classification`, `shouldTerminate`, `blockingIssueCount`, `criteriaProgress` |
| `GodAutoDecisionSchema` | GOD_DECIDING | `action` (accept/continue_with_instruction), `instruction?` |

## 状态机详解

### 11 个状态

基于 XState v5 的 `workflowMachine`，定义在 `engine/workflow-machine.ts`：

```
┌──────┐   START_TASK   ┌───────────┐  TASK_INIT_COMPLETE  ┌────────┐
│ IDLE │ ──────────────► │ TASK_INIT │ ───────────────────► │ CODING │
└──────┘                 └───────────┘                      └────┬───┘
   │                                                             │
   │ RESUME_SESSION  ┌──────────┐                     CODE_COMPLETE
   └────────────────►│ RESUMING │                                │
                     └──────────┘                                ▼
                                                    ┌──────────────────┐
      ┌────────────────────────────────────────────►│ ROUTING_POST_CODE │
      │                                             └────────┬─────────┘
      │                                               ROUTE_TO_REVIEW
      │                                                      │
      │  ROUTE_TO_CODER                                      ▼
      │  (round++)                                    ┌───────────┐
      ├◄──────────────────────────────────────────────│ REVIEWING │
      │                                               └─────┬─────┘
      │                                            REVIEW_COMPLETE
      │                                                      │
      │                                                      ▼
      │                                        ┌───────────────────────┐
      ├◄───────────────────────────────────────│ ROUTING_POST_REVIEW   │
      │                                        └───────────┬───────────┘
      │                                     CONVERGED/PHASE_TRANSITION/
      │                                     LOOP_DETECTED/RECLASSIFY
      │         ┌────────────┐                             │
      │         │ EVALUATING │◄── ROUTE_TO_EVALUATE        │
      │         └──────┬─────┘                             │
      │                │ CONVERGED/NOT_CONVERGED            │
      │                ▼                                    ▼
      │         ┌──────────────┐    MANUAL_FALLBACK  ┌─────────────────┐
      └────────►│ GOD_DECIDING │ ──────────────────► │ MANUAL_FALLBACK │
                └──────┬───────┘                     └────────┬────────┘
                       │ USER_CONFIRM                         │ USER_CONFIRM
                       ├──► accept ──► DONE                   ├──► DONE
                       └──► continue ──► CODING               └──► CODING

  ┌─────────────┐                    ┌───────┐
  │ INTERRUPTED │◄── USER_INTERRUPT  │ ERROR │◄── PROCESS_ERROR/TIMEOUT
  └─────────────┘                    └───────┘
       USER_INPUT ──► CODING/REVIEWING/GOD_DECIDING    RECOVERY ──► GOD_DECIDING
```

### 25+ 事件类型

| 事件 | 触发条件 | 目标状态 |
|------|---------|---------|
| `START_TASK` | 用户启动任务 | TASK_INIT |
| `TASK_INIT_COMPLETE` | God 完成意图解析 | CODING |
| `TASK_INIT_SKIP` | God 不可用，跳过 | CODING |
| `CODE_COMPLETE` | Coder 输出完成 | ROUTING_POST_CODE |
| `ROUTE_TO_REVIEW` | God 决定送审 | REVIEWING |
| `ROUTE_TO_CODER` | God 决定回退重写 | CODING（round++）或 GOD_DECIDING（重试超限） |
| `REVIEW_COMPLETE` | Reviewer 输出完成 | ROUTING_POST_REVIEW |
| `CONVERGED` | God/Evaluator 判断收敛 | GOD_DECIDING |
| `NOT_CONVERGED` | Evaluator 判断未收敛 | CODING（round++）或 GOD_DECIDING（超限） |
| `PHASE_TRANSITION` | God 判断阶段转换 | GOD_DECIDING |
| `LOOP_DETECTED` | God 检测到循环 | GOD_DECIDING |
| `RECLASSIFY` | 需要重新分类 | GOD_DECIDING |
| `NEEDS_USER_INPUT` | 需要用户输入 | GOD_DECIDING |
| `CHOICE_DETECTED` | 检测到选项 | GOD_DECIDING |
| `USER_INTERRUPT` | Ctrl+C | INTERRUPTED |
| `USER_INPUT` | 用户输入恢复 | CODING/REVIEWING/GOD_DECIDING |
| `USER_CONFIRM` | 用户确认 | DONE(accept)/CODING(continue) |
| `MANUAL_FALLBACK_REQUIRED` | God 降级 | MANUAL_FALLBACK |
| `PROCESS_ERROR` | 进程错误 | ERROR |
| `TIMEOUT` | 超时 | ERROR |
| `RECOVERY` | 错误恢复 | GOD_DECIDING |
| `RESUME_SESSION` | 恢复会话 | RESUMING |
| `RESTORED_TO_*` | 恢复到指定状态 | CODING/REVIEWING/GOD_DECIDING/INTERRUPTED |
| `CLEAR_PENDING_PHASE` | 清除待转换阶段 | (保持当前状态) |

### 关键状态机守卫

| 守卫 | 逻辑 |
|------|------|
| `canContinueRounds` | `round < maxRounds`，还能继续迭代 |
| `maxRoundsReached` | `round >= maxRounds`，已到达最大轮次 |
| `retryLimitReachedOnRouteToCoder` | 连续 ROUTE_TO_CODER 达到 3 次，强制进入 GOD_DECIDING |
| `confirmContinueWithPhase` | 确认继续且有待转换阶段，更新 taskPrompt 中的阶段标记 |

## God LLM 架构概述

### 设计原则

1. **God 是纯决策者**：God 只输出结构化 JSON，不编码、不读文件、不使用工具
2. **Reviewer 是收敛权威**：终止需要 Reviewer 审查通过，God 不能单独决定终止
3. **Rule Engine 不可覆盖**：block 级别规则（系统目录保护等）具有绝对优先级
4. **三层安全网**：God → fallback（旧版 decision/） → ERROR → MANUAL_FALLBACK → `duo resume`
5. **无状态设计**：God 运行时不保持状态，每次调用独立，resume 时不恢复 God 会话
6. **增量提示**：God CLI 通过 `--resume` 维护对话历史，Duo 每轮只发送增量信息

### God 与状态机的集成

```
                    ┌─────────────────────────┐
                    │     God Orchestrator     │
                    │                         │
                    │  task-init.ts           │──── TASK_INIT_COMPLETE
                    │  god-router.ts          │──── ROUTE_TO_REVIEW / ROUTE_TO_CODER
                    │  god-convergence.ts     │──── CONVERGED / NOT_CONVERGED
                    │  auto-decision.ts       │──── USER_CONFIRM (accept/continue)
                    │                         │
                    │  ┌───────────────────┐  │
                    │  │  Quality Guards   │  │
                    │  │  rule-engine      │  │
                    │  │  consistency      │  │
                    │  │  loop-detector    │  │
                    │  │  drift-detector   │  │
                    │  └───────────────────┘  │
                    │                         │
                    │  ┌───────────────────┐  │
                    │  │  Resilience       │  │
                    │  │  degradation-mgr  │──── MANUAL_FALLBACK_REQUIRED
                    │  │  alert-manager    │  │
                    │  └───────────────────┘  │
                    └───────────┬─────────────┘
                                │
                                ▼ WorkflowEvent
                    ┌─────────────────────────┐
                    │   XState Workflow Machine │
                    └─────────────────────────┘
```

### God 降级策略

四级降级（`degradation-manager.ts`）：

| 级别 | 触发条件 | 处理策略 |
|------|---------|---------|
| L1 | 正常 | God 正常处理所有决策 |
| L2 | 进程崩溃/超时 | 重试 1 次，失败则使用默认 fallback 决策 |
| L3 | JSON 解析/Schema 校验失败 | 带错误提示重试 1 次（`extractWithRetry`），失败则 fallback |
| L4 | 连续 3 次失败 | 禁用 God，切换到旧版 decision/ 组件全程处理 |

降级后的 fallback 组件链：
```
God 失败 → ContextManager + ConvergenceService + ChoiceDetector
         → 如仍失败 → ERROR 状态 → GOD_DECIDING/MANUAL_FALLBACK
         → 如仍失败 → duo resume（用户手动恢复）
```

### God 输出解析流程

```
God LLM 原始输出
    │
    ▼
god-json-extractor.ts
    │ extractWithRetry(rawOutput, ZodSchema, retryFn)
    │
    ├─ 成功: 返回 { success: true, data: T }
    │
    └─ 失败: 调用 retryFn(errorHint)
         │
         ├─ 重试成功: 返回 { success: true, data: T }
         │
         └─ 重试失败: 返回 null
              │
              ▼
         使用默认 fallback 值
         (DEFAULT_POST_CODER / defaultPostReviewer / DEFAULT_JUDGMENT)
```

## 关键设计决策

### 1. God 与 Coder/Reviewer 使用独立适配器接口

`GodAdapter`（`types/god-adapter.ts`）与 `CLIAdapter`（`types/adapter.ts`）分离：
- God 需要 `toolUsePolicy` 控制工具使用（forbid/allow-readonly）
- God 需要 `minimumTimeoutMs` 确保足够的推理时间
- God 使用不同的 `GodExecOptions`（必须传 `systemPrompt` 和 `timeoutMs`）

### 2. God 系统提示词使用 CRITICAL OVERRIDE

God 通过宿主 CLI（如 Claude Code）运行，宿主有自己的系统提示词。`god-system-prompt.ts` 使用 `CRITICAL OVERRIDE` 前缀强制覆盖宿主行为，确保 God 只输出 JSON。

### 3. 一致性校验在路由决策后执行

`consistency-checker.ts` 在 `god-router.ts` 中的 `routePostReviewer` 里调用。三种违规类型：
- **structural**：触发重试 → fallback
- **semantic**：自动修正（以计数字段为权威）
- **low_confidence**：偏向保守（不终止）

### 4. compound 任务的多阶段设计

`GodTaskAnalysis` 支持 `compound` 类型，将任务拆分为多个 `Phase`（每个 Phase 有独立的类型和描述）。`phase-transition.ts` 管理阶段间转换，`PHASE_TRANSITION` 事件携带 `nextPhaseId`。

### 5. Escape Window 用户干预机制

God 自主决策前，UI 显示 Escape Window（`ui/escape-window.ts`），给用户短暂的干预窗口。用户可以在此时中断或修改 God 的决策。

### 6. 审计日志的 append-only 设计

`god-audit.ts` 使用 JSONL 格式的 append-only 日志。每条记录包含序号、时间戳、轮次、决策类型等。支持通过 `duo log` 查看和过滤。完整的 God 原始输出存储在 `god-decisions/` 目录，审计日志通过 `outputRef` 引用。

## 模块依赖关系

```
cli.ts ──► cli-commands.ts
  │            │
  │            ├──► session/session-starter.ts
  │            ├──► session/session-manager.ts
  │            ├──► adapters/detect.ts
  │            └──► god/god-audit.ts (duo log)
  │
  └──► ui/components/App.tsx
          │
          ├──► engine/workflow-machine.ts (XState)
          ├──► engine/interrupt-handler.ts
          │
          ├──► god/task-init.ts ──► god/god-call.ts ──► types/god-adapter.ts
          ├──► god/god-router.ts ──► god/god-call.ts
          │                      ──► god/consistency-checker.ts
          │                      ──► god/god-prompt-generator.ts
          │                      ──► parsers/god-json-extractor.ts
          ├──► god/god-convergence.ts ──► god/god-call.ts
          ├──► god/auto-decision.ts ──► god/rule-engine.ts
          │                         ──► god/god-call.ts
          ├──► god/loop-detector.ts
          ├──► god/drift-detector.ts
          ├──► god/degradation-manager.ts ──► decision/convergence-service.ts
          │                               ──► decision/choice-detector.ts
          │                               ──► session/context-manager.ts
          ├──► god/alert-manager.ts
          ├──► god/phase-transition.ts
          ├──► god/interrupt-clarifier.ts
          ├──► god/god-context-manager.ts
          ├──► god/god-system-prompt.ts
          ├──► god/god-adapter-factory.ts ──► god/adapters/claude-code-god-adapter.ts
          │                               ──► god/adapters/codex-god-adapter.ts
          ├──► god/god-adapter-config.ts
          ├──► god/tri-party-session.ts
          ├──► god/god-session-persistence.ts
          │
          ├──► adapters/factory.ts ──► adapters/process-manager.ts
          │                        ──► adapters/output-stream-manager.ts
          │                        ──► adapters/env-builder.ts
          │                        ──► adapters/{cli}/adapter.ts (x12)
          ├──► adapters/registry.ts
          │
          ├──► parsers/stream-json-parser.ts
          ├──► parsers/jsonl-parser.ts
          ├──► parsers/text-stream-parser.ts
          │
          ├──► session/session-manager.ts
          ├──► session/context-manager.ts
          │
          └──► types/ (adapter.ts, session.ts, ui.ts, god-adapter.ts, god-schemas.ts)
```

### 依赖方向原则

- 上层可以依赖下层，反之不行
- `god/` 模块依赖 `types/god-schemas.ts` 和 `types/god-adapter.ts`，但不依赖 `ui/`
- `god/degradation-manager.ts` 依赖 `decision/`（旧版组件），作为降级 fallback
- `ui/` 组件通过 `session-runner-state.ts` 间接驱动 god/ 模块的调用
- `types/` 是最底层，不依赖任何其他模块
