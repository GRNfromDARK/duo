# 工作流引擎 (Workflow Engine)

> 源码：`src/engine/workflow-machine.ts`、`src/engine/interrupt-handler.ts`
>
> 规格引用：FR-004 (AC-012 ~ AC-015)、FR-007 (AC-024 ~ AC-028)

---

## 1 状态机（workflow-machine.ts）

### 1.1 模块职责

WorkflowMachine 是 Duo 的核心调度器，基于 **xstate v5** 实现。它驱动 coding → review → evaluate 循环，保证在任意时刻**只有一个 LLM 进程在运行**（串行执行原则）。状态机支持序列化/反序列化，用于 session 恢复。

### 1.2 WorkflowContext 结构

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `round` | `number` | `0` | 当前迭代轮次 |
| `maxRounds` | `number` | `10` | 最大允许轮次（可由 `TASK_INIT_COMPLETE` 覆盖） |
| `consecutiveRouteToCoder` | `number` | `0` | 连续路由回 coder 的次数，用于死循环检测 |
| `taskPrompt` | `string \| null` | `null` | 当前任务 prompt（Phase 切换时自动注入 `[Phase: xxx]` 前缀） |
| `activeProcess` | `'coder' \| 'reviewer' \| null` | `null` | 当前活跃的 LLM 进程角色 |
| `lastError` | `string \| null` | `null` | 最后一次错误信息 |
| `lastCoderOutput` | `string \| null` | `null` | coder 最近一次输出 |
| `lastReviewerOutput` | `string \| null` | `null` | reviewer 最近一次输出 |
| `sessionId` | `string \| null` | `null` | 当前 session ID（用于持久化与恢复） |
| `pendingPhaseId` | `string \| null` | `null` | 待切换的 Phase ID |
| `pendingPhaseSummary` | `string \| null` | `null` | 待切换 Phase 的摘要说明 |

所有字段均可通过 `input` 参数在创建 machine 时注入初始值，未提供的字段取默认值。

### 1.3 状态（共 12 个）

| 状态 | 类型 | 说明 |
|------|------|------|
| `IDLE` | 初始 | 等待 `START_TASK` 或 `RESUME_SESSION` |
| `TASK_INIT` | 过渡 | God LLM intent 解析阶段（Card A.2），在 IDLE 和 CODING 之间插入 |
| `CODING` | 活跃 | coder LLM 正在执行；`activeProcess = 'coder'` |
| `ROUTING_POST_CODE` | 路由 | coder 完成后的路由决策点 |
| `REVIEWING` | 活跃 | reviewer LLM 正在执行；`activeProcess = 'reviewer'` |
| `ROUTING_POST_REVIEW` | 路由 | reviewer 完成后的路由决策点 |
| `EVALUATING` | 评估 | 判断 coder + reviewer 结果是否收敛 |
| `GOD_DECIDING` | 决策 | God LLM 做最终裁决，等待用户确认（continue / accept） |
| `MANUAL_FALLBACK` | 降级 | God LLM 无法自动决策时的手动降级模式 |
| `INTERRUPTED` | 中断 | LLM 进程被用户中断，等待 `USER_INPUT` 恢复 |
| `RESUMING` | 恢复 | 从持久化 session 恢复到目标状态 |
| `DONE` | **final** | 工作流正常结束 |
| `ERROR` | 错误 | 可通过 `RECOVERY` 恢复到 `GOD_DECIDING` |

### 1.4 事件（共 27 个）

| 事件 | 携带数据 | 说明 |
|------|----------|------|
| `START_TASK` | `prompt: string` | 启动新任务 |
| `RESUME_SESSION` | `sessionId: string` | 请求恢复会话 |
| `TASK_INIT_COMPLETE` | `maxRounds?: number` | God LLM intent 解析完成，可选覆盖 maxRounds |
| `TASK_INIT_SKIP` | -- | 跳过 intent 解析，直接进入 CODING |
| `CODE_COMPLETE` | `output: string` | coder 完成 |
| `REVIEW_COMPLETE` | `output: string` | reviewer 完成 |
| `CONVERGED` | -- | 评估判定已收敛 |
| `NOT_CONVERGED` | -- | 评估判定未收敛 |
| `USER_INTERRUPT` | -- | 用户中断（Ctrl+C / 文本中断） |
| `USER_INPUT` | `input: string; resumeAs: 'coder' \| 'reviewer' \| 'decision'` | 中断后用户提供新指令 |
| `USER_CONFIRM` | `action: 'continue' \| 'accept'` | 用户在 GOD_DECIDING / MANUAL_FALLBACK 做出选择 |
| `PROCESS_ERROR` | `error: string` | LLM 进程错误 |
| `TIMEOUT` | -- | LLM 进程超时 |
| `ROUTE_TO_REVIEW` | -- | 路由：进入 review 阶段 |
| `ROUTE_TO_CODER` | -- | 路由：回到 coder 阶段 |
| `ROUTE_TO_EVALUATE` | -- | 路由：进入评估阶段 |
| `CHOICE_DETECTED` | `choices: string[]` | 编码后检测到需要用户选择 |
| `NEEDS_USER_INPUT` | -- | 需要用户补充输入 |
| `LOOP_DETECTED` | -- | 检测到 coder/reviewer 循环 |
| `RECLASSIFY` | -- | 需要重新分类任务 |
| `PHASE_TRANSITION` | `nextPhaseId: string; summary: string` | 多阶段任务的 phase 切换 |
| `CLEAR_PENDING_PHASE` | -- | 清除待切换的 phase 信息 |
| `MANUAL_FALLBACK_REQUIRED` | -- | God LLM 无法自动决策，降级至手动 |
| `RECOVERY` | -- | 从 ERROR 恢复 |
| `RESTORED_TO_CODING` | -- | session 恢复至 CODING |
| `RESTORED_TO_REVIEWING` | -- | session 恢复至 REVIEWING |
| `RESTORED_TO_WAITING` | -- | session 恢复至 GOD_DECIDING |
| `RESTORED_TO_INTERRUPTED` | -- | session 恢复至 INTERRUPTED |

### 1.5 状态转换图

```
                    START_TASK              RESUME_SESSION
                        │                       │
                        ▼                       ▼
┌──────┐          ┌───────────┐          ┌───────────┐
│ IDLE │──────────│ TASK_INIT │          │ RESUMING  │
└──────┘          └─────┬─────┘          └─────┬─────┘
                        │                      │
              TASK_INIT_COMPLETE          RESTORED_TO_*
              TASK_INIT_SKIP                   │
                        │         ┌────────────┼─────────────┐
                        ▼         ▼            ▼             ▼
                  ┌─────────┐  CODING    GOD_DECIDING   INTERRUPTED
          ┌──────►│ CODING  │◄──────┐         ▲             │
          │       └────┬────┘       │         │        USER_INPUT
          │            │            │         │             │
          │      CODE_COMPLETE      │         │    ┌────────┼────────┐
          │            │            │         │    ▼        ▼        ▼
          │            ▼            │         │  CODING  REVIEWING  GOD_
          │   ┌──────────────────┐  │         │                   DECIDING
          │   │ROUTING_POST_CODE │  │         │
          │   └────────┬─────────┘  │         │
          │            │            │         │
          │  ┌─────────┼─────────┐  │         │
          │  ▼         ▼         ▼  │         │
          │ REVIEWING CODING  GOD_DECIDING    │
          │  │        (再)        ▲            │
          │  │                    │            │
          │  │ REVIEW_COMPLETE    │            │
          │  │                    │            │
          │  ▼                    │            │
          │ ┌───────────────────┐ │            │
          │ │ROUTING_POST_REVIEW│─┘            │
          │ └─────────┬─────────┘              │
          │           │                        │
          │   ┌───────┼────────────┐           │
          │   ▼       ▼            ▼           │
          │ CODING EVALUATING  GOD_DECIDING    │
          │ (再)      │            ▲            │
          │           │            │            │
          │   ┌───────┴───────┐    │            │
          │   ▼               ▼    │            │
          │ CODING(NOT_     GOD_DECIDING       │
          │  CONVERGED +                       │
          │  canContinue)                      │
          │   │                                │
          └───┘                                │
                                               │
   GOD_DECIDING ──MANUAL_FALLBACK_REQUIRED──▶ MANUAL_FALLBACK
       │                                          │
       │◄─────────────────────────────────────────┘
       │          (共享 USER_CONFIRM 逻辑)
       │
       ├── USER_CONFIRM(continue) ──▶ CODING (round++)
       ├── USER_CONFIRM(continue + pendingPhase) ──▶ CODING (round++, taskPrompt 更新)
       └── USER_CONFIRM(accept) ──▶ DONE

   CODING / REVIEWING ──USER_INTERRUPT──▶ INTERRUPTED
   CODING / REVIEWING ──PROCESS_ERROR / TIMEOUT──▶ ERROR
   ERROR ──RECOVERY──▶ GOD_DECIDING
```

### 1.6 Guard 条件（共 9 个）

| Guard | 逻辑 | 使用位置 |
|-------|------|----------|
| `canContinueRounds` | `round < maxRounds` | EVALUATING/ROUTING 中 `NOT_CONVERGED` / `ROUTE_TO_CODER` 时判断是否继续迭代 |
| `maxRoundsReached` | `round >= maxRounds` | 声明但通过 xstate 数组 fallback 机制隐式生效 |
| `retryLimitReachedOnRouteToCoder` | `consecutiveRouteToCoder + 1 >= 3` | `ROUTING_POST_CODE` / `ROUTING_POST_REVIEW` 中连续路由回 coder 达 3 次时强制进入 GOD_DECIDING |
| `resumeAsCoder` | `event.resumeAs === 'coder'` | INTERRUPTED → CODING |
| `resumeAsReviewer` | `event.resumeAs === 'reviewer'` | INTERRUPTED → REVIEWING |
| `resumeAsDecision` | `event.resumeAs === 'decision'` | INTERRUPTED → GOD_DECIDING |
| `confirmContinue` | `event.action === 'continue'` | GOD_DECIDING / MANUAL_FALLBACK → CODING |
| `confirmContinueWithPhase` | `action === 'continue' && pendingPhaseId != null` | GOD_DECIDING / MANUAL_FALLBACK → CODING（同时更新 taskPrompt 的 Phase 前缀） |
| `confirmAccept` | `event.action === 'accept'` | GOD_DECIDING / MANUAL_FALLBACK → DONE |

> **注意**：`maxRoundsReached` 在代码中声明但实际通过 xstate 数组 fallback 机制生效——当 `canContinueRounds` 不满足时自动走 fallback 分支到 `GOD_DECIDING`。`USER_CONFIRM` 和 `USER_INPUT` 同理，均有 fallback 兜底（默认进入 `DONE` 或 `GOD_DECIDING`）。

### 1.7 Actions

所有 action 均使用 xstate 的 `assign()` 进行 context 更新：

| 触发事件 | 更新字段 |
|----------|----------|
| `START_TASK` | `taskPrompt` = event.prompt |
| `TASK_INIT_COMPLETE` | `activeProcess` = `'coder'`, `consecutiveRouteToCoder` = 0, `maxRounds` 可被 event 覆盖 |
| `TASK_INIT_SKIP` | `activeProcess` = `'coder'`, `consecutiveRouteToCoder` = 0 |
| `CODE_COMPLETE` | `lastCoderOutput` = event.output, `activeProcess` = `null` |
| `REVIEW_COMPLETE` | `lastReviewerOutput` = event.output, `activeProcess` = `null` |
| `NOT_CONVERGED`（canContinue） | `round` = round + 1, `activeProcess` = `'coder'`, `consecutiveRouteToCoder` = 0 |
| `USER_INTERRUPT` | `activeProcess` = `null` |
| `PROCESS_ERROR` | `lastError` = event.error, `activeProcess` = `null` |
| `TIMEOUT` | `lastError` = `'Process timed out'`, `activeProcess` = `null` |
| `RESUME_SESSION` | `sessionId` = event.sessionId |
| `ROUTE_TO_REVIEW` | `activeProcess` = `'reviewer'` |
| `ROUTE_TO_CODER`（正常） | `round` = round + 1, `activeProcess` = `'coder'`, `consecutiveRouteToCoder` ++ |
| `ROUTE_TO_CODER`（retryLimit） | `consecutiveRouteToCoder` = 0（→ GOD_DECIDING） |
| `NEEDS_USER_INPUT` / `CHOICE_DETECTED` / `CONVERGED` / `LOOP_DETECTED` / `RECLASSIFY` | `consecutiveRouteToCoder` = 0 |
| `PHASE_TRANSITION` | `pendingPhaseId` = event.nextPhaseId, `pendingPhaseSummary` = event.summary, `consecutiveRouteToCoder` = 0 |
| `CLEAR_PENDING_PHASE` | `pendingPhaseId` = null, `pendingPhaseSummary` = null |
| `USER_CONFIRM`（continue + phase） | `round` ++, `activeProcess` = `'coder'`, `taskPrompt` 注入 `[Phase: xxx]` 前缀, `pendingPhaseId`/`pendingPhaseSummary` = null |
| `USER_CONFIRM`（continue） | `round` ++, `activeProcess` = `'coder'`, `consecutiveRouteToCoder` = 0 |
| `USER_CONFIRM`（accept） | `consecutiveRouteToCoder` = 0 |
| `RESTORED_TO_CODING` | `activeProcess` = `'coder'` |
| `RESTORED_TO_REVIEWING` | `activeProcess` = `'reviewer'` |
| `USER_INPUT`（resumeAsCoder） | `activeProcess` = `'coder'` |
| `USER_INPUT`（resumeAsReviewer） | `activeProcess` = `'reviewer'` |
| `RECOVERY` | `consecutiveRouteToCoder` = 0 |

### 1.8 与 God LLM 的集成

工作流引擎在以下环节与 God LLM 交互：

1. **TASK_INIT 阶段**：God LLM 负责 intent 解析（Card A.2 规格）。解析完成后通过 `TASK_INIT_COMPLETE` 事件通知状态机，可选覆盖 `maxRounds`。如果不需要解析，通过 `TASK_INIT_SKIP` 直接进入 CODING。
2. **GOD_DECIDING 状态**：多个路由节点在需要高层决策时汇聚到此状态。触发来源包括：
   - `ROUTING_POST_CODE`：`NEEDS_USER_INPUT`、`CHOICE_DETECTED`、`ROUTE_TO_CODER`（retryLimit 或 maxRounds 耗尽）
   - `ROUTING_POST_REVIEW`：`CONVERGED`、`NEEDS_USER_INPUT`、`LOOP_DETECTED`、`RECLASSIFY`、`PHASE_TRANSITION`、`ROUTE_TO_CODER`（retryLimit 或 maxRounds 耗尽）
   - `EVALUATING`：`CONVERGED`、`NOT_CONVERGED`（maxRounds 耗尽）
3. **MANUAL_FALLBACK**：当 God LLM 无法自动裁决时（`MANUAL_FALLBACK_REQUIRED`），从 `GOD_DECIDING` 降级到 `MANUAL_FALLBACK`，行为逻辑完全一致，等待 `USER_CONFIRM`。

### 1.9 死循环保护机制

状态机内建两层防护：

1. **轮次上限**（`maxRounds`，默认 10）：`round` 达到 `maxRounds` 时，`canContinueRounds` guard 返回 `false`，`NOT_CONVERGED` 和 `ROUTE_TO_CODER` 均走 fallback 分支导向 `GOD_DECIDING`
2. **连续 coder 重试检测**（`consecutiveRouteToCoder`）：连续 3 次 `ROUTE_TO_CODER` 触发 `retryLimitReachedOnRouteToCoder`，强制跳出循环进入 `GOD_DECIDING`。在收敛、用户操作或进入 GOD_DECIDING 时该计数器重置为 0

### 1.10 串行执行原则

状态机设计确保同一时刻只有一个 LLM 进程运行：

- `activeProcess` 字段标记当前活跃角色（`'coder'` / `'reviewer'` / `null`）
- 进入 `CODING` 或 `REVIEWING` 时设置对应角色
- 离开活跃状态时（完成、中断、错误、超时）一律重置为 `null`
- 路由状态（`ROUTING_POST_CODE`、`ROUTING_POST_REVIEW`）、评估状态（`EVALUATING`）和决策状态（`GOD_DECIDING`、`MANUAL_FALLBACK`）不设置 `activeProcess`，保证在决策期间没有 LLM 进程运行

### 1.11 序列化与 Session 恢复

状态机通过 `input` 参数支持全量 context 注入，配合 `RESUMING` 状态实现 session 恢复：

1. **保存**：`InterruptHandler.saveAndExit()` 在 double Ctrl+C 时调用 `sessionManager.saveState()`，保存 `round`、`status`、`currentRole`
2. **恢复**：从 `IDLE` 发送 `RESUME_SESSION` 事件进入 `RESUMING` 状态，`sessionId` 写入 context。外部恢复逻辑根据保存的状态分发对应事件：
   - `RESTORED_TO_CODING` → CODING（`activeProcess = 'coder'`）
   - `RESTORED_TO_REVIEWING` → REVIEWING（`activeProcess = 'reviewer'`）
   - `RESTORED_TO_WAITING` → GOD_DECIDING
   - `RESTORED_TO_INTERRUPTED` → INTERRUPTED
3. 如果恢复过程出错，`PROCESS_ERROR` → ERROR
4. **创建时注入**：通过 `input` 参数可在 machine 创建时恢复完整 context（所有 12 个字段均支持）

---

## 2 中断处理器（interrupt-handler.ts）

> 规格引用：FR-007 (AC-024 ~ AC-028)

### 2.1 模块职责

`InterruptHandler` 类管理三种用户中断场景：单次 Ctrl+C、双击 Ctrl+C 退出、文本中断。它通过依赖注入协调 `processManager`（杀进程）、`sessionManager`（保存状态）和 `actor`（发送状态机事件）之间的交互。

### 2.2 InterruptedInfo 接口

```ts
interface InterruptedInfo {
  bufferedOutput: string;       // 中断前 LLM 已产出的部分输出
  interrupted: true;            // 固定标记
  userInstruction?: string;     // 文本中断时用户输入的指令（可选）
}
```

### 2.3 依赖接口（InterruptHandlerDeps）

```ts
interface InterruptHandlerDeps {
  processManager: {
    kill(): Promise<void>;        // 终止当前 LLM 进程
    isRunning(): boolean;         // 进程是否在运行
    getBufferedOutput(): string;  // 获取已缓冲的输出
  };
  sessionManager: {
    saveState(sessionId: string, state: Record<string, unknown>): void;
  };
  actor: {
    send(event: Record<string, unknown>): void;
    getSnapshot(): {
      value: string;
      context: {
        sessionId: string | null;
        round: number;
        activeProcess: string | null;
      };
    };
  };
  onExit: () => void;               // 退出应用的回调
  onInterrupted: (info: InterruptedInfo) => void;  // 中断完成的回调
}
```

### 2.4 三种中断模式

| 模式 | 触发方式 | 行为 |
|------|----------|------|
| **Single Ctrl+C** | 按一次 Ctrl+C | 终止当前 LLM 进程 → 保留缓冲输出 → 发送 `USER_INTERRUPT` → 进入 INTERRUPTED |
| **Double Ctrl+C** | 500ms 内按两次 Ctrl+C | 保存 session → 退出应用 |
| **Text Interrupt** | LLM 运行时用户键入文本并回车 | 等同于 Ctrl+C + 立即附带用户指令 |

### 2.5 单次 Ctrl+C 流程

```
用户按下 Ctrl+C
       │
       ▼
  handleSigint()
       │
       ├── 记录时间戳 lastSigintTime，设置 hasPendingSigint = true
       │
       ▼
  interruptCurrentProcess()
       │
       ├── 检查当前状态是否为 ACTIVE_STATES（CODING / REVIEWING）
       │   └── 不是 → 直接返回，忽略此次 Ctrl+C
       │
       ├── getBufferedOutput()：获取 LLM 已产出的部分输出
       │
       ├── 如果 isRunning() 为 true → kill() 终止进程
       │   └── catch：进程可能已退出，静默处理
       │
       ├── actor.send({ type: 'USER_INTERRUPT' })
       │   └── 状态机从 CODING/REVIEWING 转入 INTERRUPTED
       │
       └── onInterrupted({ bufferedOutput, interrupted: true })
```

**关键点**：只在 `CODING` 或 `REVIEWING` 状态下生效，其他状态下的 Ctrl+C 被静默忽略。

### 2.6 双击 Ctrl+C 流程（<500ms）

```
第一次 Ctrl+C
       │
       ▼
  handleSigint()
       ├── lastSigintTime = now, hasPendingSigint = true
       └── interruptCurrentProcess()（正常中断流程）

第二次 Ctrl+C（间隔 <= 500ms）
       │
       ▼
  handleSigint()
       │
       ├── timeSinceLast = now - lastSigintTime <= 500ms
       ├── hasPendingSigint = true → 判定为双击
       ├── hasPendingSigint = false（重置）
       │
       ▼
  saveAndExit()
       │
       ├── 获取 actor snapshot
       │
       ├── 如果有 sessionId：
       │   └── sessionManager.saveState(sessionId, {
       │        round,
       │        status: 'interrupted',
       │        currentRole: activeProcess ?? 'coder'
       │      })
       │   └── catch：best-effort，保存失败也继续退出
       │
       └── onExit()（退出应用）
```

**阈值常量**：`DOUBLE_CTRLC_THRESHOLD_MS = 500`

### 2.7 文本中断流程

```
用户在 LLM 运行期间输入文本并回车
       │
       ▼
  handleTextInterrupt(text, resumeAs)
       │
       ├── isRunning() 为 false → 直接返回
       ├── 当前状态不在 ACTIVE_STATES → 直接返回
       │
       ├── getBufferedOutput()：获取已缓冲输出
       │
       ├── kill()：终止 LLM 进程
       │   └── catch：进程可能已退出，静默处理
       │
       ├── actor.send({ type: 'USER_INTERRUPT' })
       │   └── 状态机转入 INTERRUPTED
       │
       └── onInterrupted({
             bufferedOutput,
             interrupted: true,
             userInstruction: text    ← 用户输入附加到中断信息
           })
```

文本中断等价于 **Ctrl+C + 立即附带用户指令**。`userInstruction` 字段使得后续恢复时可以将用户意图传递给下一次 LLM 调用。

### 2.8 Buffer 保留机制

无论哪种中断方式，都会在 kill 进程**之前**调用 `getBufferedOutput()` 获取 LLM 已经产出的部分输出。这些输出通过 `InterruptedInfo.bufferedOutput` 传递给上层，确保：

- 用户可以看到中断前的部分结果
- 恢复时可以利用已有输出作为上下文，避免完全重做

### 2.9 内部状态

| 字段 | 类型 | 说明 |
|------|------|------|
| `lastSigintTime` | `number` | 上次 SIGINT 的时间戳（ms），初始为 0 |
| `hasPendingSigint` | `boolean` | 是否有未决的单次 Ctrl+C，初始为 false |
| `disposed` | `boolean` | 是否已销毁，调用 `dispose()` 后设为 true |

### 2.10 方法总览

| 方法 | 签名 | 说明 |
|------|------|------|
| `handleSigint` | `() => Promise<void>` | 处理 SIGINT 信号。首次中断进程；500ms 内再按则保存并退出 |
| `handleTextInterrupt` | `(text: string, resumeAs: 'coder' \| 'reviewer') => Promise<void>` | 处理文本中断，仅在 ACTIVE_STATES 且进程运行中时生效 |
| `handleUserInput` | `(input: string, resumeAs: 'coder' \| 'reviewer' \| 'decision') => void` | 向 actor 发送 `USER_INPUT` 事件以从 INTERRUPTED 恢复 |
| `dispose` | `() => void` | 标记 handler 为已销毁，后续调用全部跳过 |

### 2.11 恢复方法 handleUserInput

中断后，外部可调用 `handleUserInput(input, resumeAs)` 向 actor 发送 `USER_INPUT` 事件，驱动状态机从 `INTERRUPTED` 恢复到目标状态：

- `resumeAs = 'coder'` → CODING
- `resumeAs = 'reviewer'` → REVIEWING
- `resumeAs = 'decision'` → GOD_DECIDING
- 其他值 → fallback 到 GOD_DECIDING
