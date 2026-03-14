# 工作流引擎 (Workflow Engine)

> 源码：`src/engine/workflow-machine.ts`、`src/engine/interrupt-handler.ts`
>
> 规格引用：FR-003 (Runtime Core Loop)、FR-004、FR-007、FR-011
>
> 变更卡片：Card D.1 (Observe-Decide-Act 重构)、Card E.1 (Interrupt Observation 归一化)、Card E.2 (Clarification 状态)

---

## 1 状态机（workflow-machine.ts）

### 1.1 模块职责

WorkflowMachine 是 Duo 的核心调度器，基于 **xstate v5** 实现。它驱动 **Observe → Decide → Act** 循环，保证在任意时刻**只有一个 LLM 进程在运行**（串行执行原则）。状态机支持序列化/反序列化，用于 session 恢复。

#### 拓扑概览

```
IDLE → TASK_INIT → CODING → OBSERVING → GOD_DECIDING → EXECUTING → ...
REVIEWING → OBSERVING → GOD_DECIDING → EXECUTING → ...
```

#### Card D.1 变更记录

- **移除的状态**：`ROUTING_POST_CODE`、`ROUTING_POST_REVIEW`、`EVALUATING`
- **新增的状态**：`OBSERVING`（收集 observations）、`EXECUTING`（Hand executor 执行 GodActions）、`CLARIFYING`（Card E.2：God 调解的多轮澄清）

### 1.2 WorkflowContext 结构

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `round` | `number` | `0` | 当前迭代轮次 |
| `maxRounds` | `number` | `10` | 最大允许轮次（可由 `TASK_INIT_COMPLETE` 覆盖） |
| `consecutiveRouteToCoder` | `number` | `0` | 连续路由回 coder 的次数，用于 circuit breaker 检测 |
| `taskPrompt` | `string \| null` | `null` | 当前任务 prompt（Phase 切换时自动注入 `[Phase: xxx]` 前缀） |
| `activeProcess` | `'coder' \| 'reviewer' \| null` | `null` | 当前活跃的 LLM 进程角色 |
| `lastError` | `string \| null` | `null` | 最后一次错误信息 |
| `lastCoderOutput` | `string \| null` | `null` | coder 最近一次输出 |
| `lastReviewerOutput` | `string \| null` | `null` | reviewer 最近一次输出 |
| `sessionId` | `string \| null` | `null` | 当前 session ID（用于持久化与恢复） |
| `pendingPhaseId` | `string \| null` | `null` | 待切换的 Phase ID |
| `pendingPhaseSummary` | `string \| null` | `null` | 待切换 Phase 的摘要说明 |
| `currentObservations` | `Observation[]` | `[]` | Card D.1：当前待处理的 observation 列表 |
| `lastDecision` | `GodDecisionEnvelope \| null` | `null` | Card D.1：God 最近一次决策信封 |
| `incidentCount` | `number` | `0` | Card D.1：累计 incident 次数 |
| `frozenActiveProcess` | `'coder' \| 'reviewer' \| null` | `null` | Card E.2：进入 CLARIFYING 前冻结的活跃进程角色（用于恢复时路由） |
| `clarificationRound` | `number` | `0` | Card E.2：澄清轮次计数 |
| `clarificationObservations` | `Observation[]` | `[]` | Card E.2：累积的澄清 observation（用于上下文保留 AC-6） |

所有字段均可通过 `input` 参数在创建 machine 时注入初始值，未提供的字段取默认值。

### 1.3 状态（共 12 个）

| 状态 | 类型 | 说明 |
|------|------|------|
| `IDLE` | 初始 | 等待 `START_TASK` 或 `RESUME_SESSION` |
| `TASK_INIT` | 过渡 | God LLM intent 解析阶段，在 IDLE 和 CODING 之间插入 |
| `CODING` | 活跃 | coder LLM 正在执行；`activeProcess = 'coder'` |
| `REVIEWING` | 活跃 | reviewer LLM 正在执行；`activeProcess = 'reviewer'` |
| `OBSERVING` | 收集 | Card D.1：收集 coder/reviewer 输出或 incident 后的 observation，分类后传递给 GOD_DECIDING |
| `GOD_DECIDING` | 决策 | Card D.1：调用统一 God 决策服务，等待 GodDecisionEnvelope |
| `EXECUTING` | 执行 | Card D.1：Hand executor 运行 GodActions，产出 result observations |
| `CLARIFYING` | 澄清 | Card E.2：God 调解的多轮人机澄清循环。由 `request_user_input` action 进入，人类回答后经 observation pipeline 回到 GOD_DECIDING，God 可继续追问或恢复工作 |
| `MANUAL_FALLBACK` | 降级 | God LLM 无法自动决策时的手动降级模式，等待 `USER_CONFIRM` |
| `INTERRUPTED` | 中断 | 保留用于向后兼容（session 恢复 via `RESTORED_TO_INTERRUPTED`）。Card E.1 之后新的中断走 `INCIDENT_DETECTED → OBSERVING` 路径 |
| `RESUMING` | 恢复 | 从持久化 session 恢复到目标状态 |
| `DONE` | **final** | 工作流正常结束 |
| `ERROR` | 错误 | 可通过 `RECOVERY` 恢复到 `GOD_DECIDING` |

### 1.4 事件（共 22 个）

| 事件 | 携带数据 | 说明 |
|------|----------|------|
| `START_TASK` | `prompt: string` | 启动新任务 |
| `RESUME_SESSION` | `sessionId: string` | 请求恢复会话 |
| `TASK_INIT_COMPLETE` | `maxRounds?: number` | God LLM intent 解析完成，可选覆盖 maxRounds |
| `TASK_INIT_SKIP` | -- | 跳过 intent 解析，直接进入 CODING |
| `CODE_COMPLETE` | `output: string` | coder 完成。清除 `currentObservations`（Bug 5 fix） |
| `REVIEW_COMPLETE` | `output: string` | reviewer 完成。清除 `currentObservations`（Bug 5 fix） |
| `USER_INTERRUPT` | -- | 用户中断信号（类型保留，但 Card E.1 之后中断走 observation pipeline） |
| `USER_INPUT` | `input: string; resumeAs: 'coder' \| 'reviewer' \| 'decision'` | 中断后用户提供新指令（类型保留，但 Card E.1 之后走 observation pipeline） |
| `USER_CONFIRM` | `action: 'continue' \| 'accept'` | 用户在 MANUAL_FALLBACK 做出选择 |
| `PROCESS_ERROR` | `error: string` | LLM 进程错误 |
| `TIMEOUT` | -- | LLM 进程超时 |
| `CLEAR_PENDING_PHASE` | -- | 清除待切换的 phase 信息 |
| `MANUAL_FALLBACK_REQUIRED` | -- | God LLM 无法自动决策，降级至手动 |
| `RECOVERY` | -- | 从 ERROR 恢复 |
| `RESTORED_TO_CODING` | -- | session 恢复至 CODING |
| `RESTORED_TO_REVIEWING` | -- | session 恢复至 REVIEWING |
| `RESTORED_TO_WAITING` | -- | session 恢复至 GOD_DECIDING |
| `RESTORED_TO_INTERRUPTED` | -- | session 恢复至 INTERRUPTED |
| `RESTORED_TO_CLARIFYING` | -- | Card E.2：session 恢复至 CLARIFYING |
| `OBSERVATIONS_READY` | `observations: Observation[]` | Card D.1：observations 收集完毕，进入 GOD_DECIDING |
| `DECISION_READY` | `envelope: GodDecisionEnvelope` | Card D.1：God 决策信封就绪，进入 EXECUTING |
| `EXECUTION_COMPLETE` | `results: Observation[]` | Card D.1：Hand executor 执行完毕，携带结果 observations |
| `INCIDENT_DETECTED` | `observation: Observation` | Card D.1：运行时检测到 incident（中断、异常等），进入 OBSERVING |

### 1.5 状态转换图

```
                    START_TASK              RESUME_SESSION
                        |                       |
                        v                       v
+------+          +-----------+          +-----------+
| IDLE |--------->| TASK_INIT |          | RESUMING  |
+------+          +-----+-----+          +-----+-----+
                        |                      |
              TASK_INIT_COMPLETE          RESTORED_TO_*
              TASK_INIT_SKIP                   |
                        |         +------------+-------+--------+--------+
                        v         v            v       v        v        v
                  +---------+  CODING    REVIEWING  GOD_     INTER-   CLARI-
          +------>| CODING  |<-----+                DECIDING  RUPTED   FYING
          |       +----+----+      |
          |            |           |
          |      CODE_COMPLETE     |
          |      INCIDENT_DETECTED |
          |            |           |
          |            v           |
          |      +-----------+     |
          |      | OBSERVING |     |
          |      +-----+-----+     |
          |            |           |
          |    OBSERVATIONS_READY  |
          |            |           |
          |            v           |
          |    +---------------+   |
          |    | GOD_DECIDING  |   |     MANUAL_FALLBACK_REQUIRED
          |    +-------+-------+   |            |
          |            |           |            v
          |      DECISION_READY    |     +----------------+
          |            |           |     | MANUAL_FALLBACK |
          |            v           |     +-------+--------+
          |      +-----------+     |             |
          |      | EXECUTING |-----+      USER_CONFIRM
          |      +-----+-----+     |        |         |
          |            |           |   continue     accept
          |   EXECUTION_COMPLETE   |        |         |
          |            |           |        v         v
          |   +--------+--------+--+     CODING     DONE
          |   |        |        |  |
          |   v        v        v  |
          | CODING  REVIEWING DONE |
          | (route)  (route)       |
          |   |                    |
          +---+                    |
                                   |
          +--- EXECUTION_COMPLETE (target = CLARIFYING) ---+
          |                                                |
          v                                                |
   +------------+    OBSERVATIONS_READY    +---------------+
   | CLARIFYING |------------------------>| GOD_DECIDING  |
   +------------+                          +---------------+
          ^                                       |
          |     (God asks again via                |
          +---  request_user_input) ---------------+

   CODING / REVIEWING --INCIDENT_DETECTED--> OBSERVING --> GOD_DECIDING
   CODING / REVIEWING --PROCESS_ERROR / TIMEOUT--> ERROR
   ERROR --RECOVERY--> GOD_DECIDING

   INTERRUPTED --OBSERVATIONS_READY--> GOD_DECIDING  (backward compat)
```

### 1.6 Post-Execution 路由逻辑

`EXECUTING` 状态的 `EXECUTION_COMPLETE` 事件使用 `resolvePostExecutionTarget()` 函数根据 `lastDecision` 信封中的 actions 确定下一个目标状态：

| Action type | 目标状态 | 附加逻辑 |
|-------------|----------|----------|
| `accept_task` | `DONE` | -- |
| `request_user_input` | `CLARIFYING` | Card E.2：替代原来的 INTERRUPTED |
| `send_to_coder` | `CODING` | `round++`，`consecutiveRouteToCoder++` |
| `send_to_reviewer` | `REVIEWING` | `consecutiveRouteToCoder` 重置为 0 |
| `retry_role` | `CODING` 或 `REVIEWING` | 取决于 `action.role` |
| `resume_after_interrupt` | 取决于 `resumeStrategy` | `stop` → DONE；`redirect` → GOD_DECIDING；`continue` → 根据 `frozenActiveProcess` 回到 CODING 或 REVIEWING |
| 其他（`wait`、`emit_summary`、`stop_role`、`switch_adapter`、`set_phase`） | `GOD_DECIDING` | 重新进入决策循环 |
| 空 actions 或无信封 | `GOD_DECIDING` | -- |

**BUG-22 修复**：当 execution 产生空 results 时，保留现有 `currentObservations` 而非覆盖为空数组，避免 fallback 导致的 observation 丢失死循环。

### 1.7 Guard 条件（共 9 个）

| Guard | 逻辑 | 使用位置 |
|-------|------|----------|
| `resumeAsCoder` | `event.resumeAs === 'coder'` | 类型保留（Card E.1 之前用于 INTERRUPTED） |
| `resumeAsReviewer` | `event.resumeAs === 'reviewer'` | 同上 |
| `resumeAsDecision` | `event.resumeAs === 'decision'` | 同上 |
| `confirmContinue` | `event.action === 'continue'` | MANUAL_FALLBACK → CODING |
| `confirmContinueWithPhase` | `action === 'continue' && pendingPhaseId != null` | MANUAL_FALLBACK → CODING（同时更新 taskPrompt 的 Phase 前缀） |
| `confirmAccept` | `event.action === 'accept'` | MANUAL_FALLBACK → DONE |
| `circuitBreakerTripped` | `resolvePostExecutionTarget() === 'CODING' && consecutiveRouteToCoder + 1 >= 3` | EXECUTING → MANUAL_FALLBACK（Bug 1 fix：防止无限 coder 循环） |
| `executionTargetCoding` | `resolvePostExecutionTarget() === 'CODING'` | EXECUTING → CODING |
| `executionTargetReviewing` | `resolvePostExecutionTarget() === 'REVIEWING'` | EXECUTING → REVIEWING |
| `executionTargetDone` | `resolvePostExecutionTarget() === 'DONE'` | EXECUTING → DONE |
| `executionTargetClarifying` | `resolvePostExecutionTarget() === 'CLARIFYING'` | Card E.2：EXECUTING → CLARIFYING |

> **Guard 优先级**：`EXECUTION_COMPLETE` 事件的 guard 按数组顺序求值。`circuitBreakerTripped` 在最前面，确保在路由到 CODING 之前先检查是否触发 circuit breaker。

### 1.8 Actions

所有 action 均使用 xstate 的 `assign()` 进行 context 更新：

| 触发事件 | 更新字段 |
|----------|----------|
| `START_TASK` | `taskPrompt` = event.prompt |
| `RESUME_SESSION` | `sessionId` = event.sessionId |
| `TASK_INIT_COMPLETE` | `activeProcess` = `'coder'`，`consecutiveRouteToCoder` = 0，`maxRounds` 可被 event 覆盖 |
| `TASK_INIT_SKIP` | `activeProcess` = `'coder'`，`consecutiveRouteToCoder` = 0 |
| `CODE_COMPLETE` | `lastCoderOutput` = event.output，`activeProcess` = null，`currentObservations` = []（Bug 5 fix） |
| `REVIEW_COMPLETE` | `lastReviewerOutput` = event.output，`activeProcess` = null，`currentObservations` = []（Bug 5 fix） |
| `INCIDENT_DETECTED`（CODING/REVIEWING） | `frozenActiveProcess` = 当前 activeProcess（Card E.2），`activeProcess` = null，`incidentCount`++，`currentObservations` = [event.observation] |
| `PROCESS_ERROR` | `lastError` = event.error，`activeProcess` = null |
| `TIMEOUT` | `lastError` = 'Process timed out'，`activeProcess` = null |
| `OBSERVATIONS_READY`（OBSERVING） | `currentObservations` = event.observations |
| `OBSERVATIONS_READY`（CLARIFYING） | `currentObservations` = event.observations，`clarificationObservations` 累加 event.observations（AC-6 上下文保留） |
| `OBSERVATIONS_READY`（INTERRUPTED） | `currentObservations` = event.observations |
| `DECISION_READY` | `lastDecision` = event.envelope |
| `CLEAR_PENDING_PHASE` | `pendingPhaseId` = null，`pendingPhaseSummary` = null |
| `EXECUTION_COMPLETE` → CODING | `currentObservations` = event.results，`activeProcess` = 'coder'，`round`++，`consecutiveRouteToCoder`++，清除 clarification 状态 |
| `EXECUTION_COMPLETE` → REVIEWING | `currentObservations` = event.results，`activeProcess` = 'reviewer'，`consecutiveRouteToCoder` = 0，清除 clarification 状态 |
| `EXECUTION_COMPLETE` → DONE | `currentObservations` = event.results，清除 clarification 状态 |
| `EXECUTION_COMPLETE` → CLARIFYING | `currentObservations` = event.results，`activeProcess` = null，`clarificationRound`++ |
| `EXECUTION_COMPLETE` → circuitBreaker | `currentObservations` = event.results，`activeProcess` = null，`lastError` = circuit breaker 消息 |
| `EXECUTION_COMPLETE` → GOD_DECIDING (default) | `currentObservations` = event.results（非空时）或保留现有 observations（BUG-22 fix） |
| `USER_CONFIRM`（continue + phase） | `round`++，`activeProcess` = 'coder'，`consecutiveRouteToCoder` = 0，`taskPrompt` 注入 `[Phase: xxx]` 前缀，清除 pending phase |
| `USER_CONFIRM`（continue） | `round`++，`activeProcess` = 'coder'，`consecutiveRouteToCoder` = 0 |
| `USER_CONFIRM`（accept） | `consecutiveRouteToCoder` = 0 |
| `RESTORED_TO_CODING` | `activeProcess` = 'coder' |
| `RESTORED_TO_REVIEWING` | `activeProcess` = 'reviewer' |
| `RECOVERY` | `consecutiveRouteToCoder` = 0 |

### 1.9 Routing Conflict 检测

`detectRoutingConflicts()` 导出函数用于检测 GodDecisionEnvelope 中是否存在多个冲突的路由 action（BUG-12 fix）。

路由 action 类型集合：`accept_task`、`request_user_input`、`send_to_coder`、`send_to_reviewer`、`retry_role`、`resume_after_interrupt`。

如果同一个 envelope 的 actions 数组中包含两个或更多路由 action，函数返回冲突的 action type 列表；否则返回空数组。

### 1.10 死循环保护机制（Circuit Breaker）

状态机内建 circuit breaker 防护（Bug 1 fix）：

- **触发条件**：`consecutiveRouteToCoder + 1 >= 3` 且本次 EXECUTION_COMPLETE 的目标为 CODING
- **触发行为**：跳转到 `MANUAL_FALLBACK`，`lastError` 设为 circuit breaker 消息
- **计数器管理**：
  - 路由到 CODING 时 `consecutiveRouteToCoder` 递增（不是重置）
  - 路由到 REVIEWING 时重置为 0（打破 coder 循环）
  - `USER_CONFIRM`、`RECOVERY` 时重置为 0

### 1.11 CLARIFYING 状态（Card E.2）

CLARIFYING 是 God 调解的多轮人机澄清状态，替代 INTERRUPTED 作为 `request_user_input` action 的目标状态：

1. **进入**：EXECUTING 的 `EXECUTION_COMPLETE` 事件，guard `executionTargetClarifying` 命中时
2. **循环**：人类回答 → observation pipeline → `OBSERVATIONS_READY` → GOD_DECIDING → God 决定继续追问（`request_user_input`）或恢复工作（`resume_after_interrupt`）
3. **退出**：God 发出 `resume_after_interrupt` action，根据 `resumeStrategy`：
   - `continue`：根据 `frozenActiveProcess` 回到 CODING 或 REVIEWING
   - `redirect`：回到 GOD_DECIDING 重新评估
   - `stop`：进入 DONE
4. **上下文保留**：`clarificationObservations` 累积每轮 observation（AC-6），退出时清零

### 1.12 串行执行原则

状态机设计确保同一时刻只有一个 LLM 进程运行：

- `activeProcess` 字段标记当前活跃角色（`'coder'` / `'reviewer'` / `null`）
- 进入 `CODING` 或 `REVIEWING` 时设置对应角色
- 离开活跃状态时（完成、incident、错误、超时）一律重置为 `null`
- `OBSERVING`、`GOD_DECIDING`、`EXECUTING`、`CLARIFYING`、`MANUAL_FALLBACK` 等非活跃状态不设置 `activeProcess`，保证在决策期间没有 LLM 进程运行

### 1.13 序列化与 Session 恢复

状态机通过 `input` 参数支持全量 context 注入，配合 `RESUMING` 状态实现 session 恢复：

1. **保存**：`InterruptHandler.saveAndExit()` 在 double Ctrl+C 时调用 `sessionManager.saveState()`，保存 `round`、`status`、`currentRole`
2. **恢复**：从 `IDLE` 发送 `RESUME_SESSION` 事件进入 `RESUMING` 状态，`sessionId` 写入 context。外部恢复逻辑根据保存的状态分发对应事件：
   - `RESTORED_TO_CODING` → CODING（`activeProcess = 'coder'`）
   - `RESTORED_TO_REVIEWING` → REVIEWING（`activeProcess = 'reviewer'`）
   - `RESTORED_TO_WAITING` → GOD_DECIDING
   - `RESTORED_TO_INTERRUPTED` → INTERRUPTED
   - `RESTORED_TO_CLARIFYING` → CLARIFYING（Card E.2）
3. 如果恢复过程出错，`PROCESS_ERROR` → ERROR
4. **创建时注入**：通过 `input` 参数可在 machine 创建时恢复完整 context（所有 18 个字段均支持）

---

## 2 中断处理器（interrupt-handler.ts）

> 规格引用：FR-007、FR-011
>
> 变更卡片：Card E.1 (Interrupt → Observation 归一化)

### 2.1 模块职责

`InterruptHandler` 类管理三种用户中断场景：单次 Ctrl+C、双击 Ctrl+C 退出、文本中断。

**Card E.1 关键变更**：InterruptHandler 不再直接向 state machine actor 发送事件（如 `USER_INTERRUPT`、`USER_INPUT`）。所有中断和用户输入均通过 **observation pipeline**（`onObservation` 回调）路由。pipeline 负责将 observation 转化为 `INCIDENT_DETECTED` 或 `OBSERVATIONS_READY` 事件发送给 actor。

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
  /** Card E.1: 只读状态访问器 — InterruptHandler 不得直接发送事件给 actor */
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
  onExit: () => void;
  onInterrupted: (info: InterruptedInfo) => void;
  /** Card E.1: 必需 — observation pipeline 回调，用于将 observation 路由给 God */
  onObservation: (obs: Observation) => void;
}
```

### 2.4 三种中断模式

| 模式 | 触发方式 | 行为 |
|------|----------|------|
| **Single Ctrl+C** | 按一次 Ctrl+C | 终止 LLM 进程 → 保留缓冲输出 → 通过 `onObservation` 发出 `human_interrupt` observation → 由 pipeline 触发 `INCIDENT_DETECTED` |
| **Double Ctrl+C** | 500ms 内按两次 Ctrl+C | 保存 session → 退出应用（唯一绕过 God 的路径） |
| **Text Interrupt** | LLM 运行时用户键入文本并回车 | 终止进程 → 通过 `onObservation` 发出 `human_message` observation → 由 pipeline 触发 `INCIDENT_DETECTED` |

### 2.5 单次 Ctrl+C 流程

```
用户按下 Ctrl+C
       |
       v
  handleSigint()
       |
       +-- 记录时间戳 lastSigintTime，设置 hasPendingSigint = true
       |
       v
  interruptCurrentProcess()
       |
       +-- 检查当前状态是否为 ACTIVE_STATES（CODING / REVIEWING）
       |   +-- 不是 → 直接返回，忽略此次 Ctrl+C
       |
       +-- getBufferedOutput()：获取 LLM 已产出的部分输出
       |
       +-- 如果 isRunning() 为 true → kill() 终止进程
       |   +-- catch：进程可能已退出，静默处理
       |
       +-- onObservation(createInterruptObservation(round))
       |   +-- Card E.1: 通过 observation pipeline 路由，而非直接 actor.send()
       |
       +-- onInterrupted({ bufferedOutput, interrupted: true })
```

**关键点**：只在 `CODING` 或 `REVIEWING` 状态下生效，其他状态下的 Ctrl+C 被静默忽略。

### 2.6 双击 Ctrl+C 流程（<500ms）

```
第一次 Ctrl+C
       |
       v
  handleSigint()
       +-- lastSigintTime = now, hasPendingSigint = true
       +-- interruptCurrentProcess()（正常中断流程）

第二次 Ctrl+C（间隔 <= 500ms）
       |
       v
  handleSigint()
       |
       +-- timeSinceLast = now - lastSigintTime <= 500ms
       +-- hasPendingSigint = true → 判定为双击
       +-- hasPendingSigint = false（重置）
       |
       v
  saveAndExit()
       |
       +-- 获取 actor snapshot
       |
       +-- 如果有 sessionId：
       |   +-- sessionManager.saveState(sessionId, {
       |        round,
       |        status: 'interrupted',
       |        currentRole: activeProcess ?? 'coder'
       |      })
       |   +-- catch：best-effort，保存失败也继续退出
       |
       +-- onExit()（退出应用）
```

**阈值常量**：`DOUBLE_CTRLC_THRESHOLD_MS = 500`

### 2.7 文本中断流程

```
用户在 LLM 运行期间输入文本并回车
       |
       v
  handleTextInterrupt(text, resumeAs)
       |
       +-- isRunning() 为 false → 直接返回
       +-- 当前状态不在 ACTIVE_STATES → 直接返回
       |
       +-- getBufferedOutput()：获取已缓冲输出
       |
       +-- kill()：终止 LLM 进程
       |   +-- catch：进程可能已退出，静默处理
       |
       +-- onObservation(createTextInterruptObservation(text, round))
       |   +-- Card E.1: 通过 observation pipeline 路由
       |
       +-- onInterrupted({
             bufferedOutput,
             interrupted: true,
             userInstruction: text
           })
```

### 2.8 用户输入处理（handleUserInput）

Card E.1 之后，`handleUserInput` 不再向 actor 发送 `USER_INPUT` 事件，而是通过 observation pipeline 发出 `clarification_answer` 类型的 observation：

```ts
handleUserInput(input, resumeAs) {
  onObservation(createObservation('clarification_answer', 'human', input, {
    round: snapshot.context.round,
    severity: 'info',
    rawRef: input,
  }));
}
```

这个 observation 会通过 pipeline 路由给 God，由 God 决定后续动作。`resumeAs` 参数不再被使用（保留签名以兼容调用方）。

### 2.9 Buffer 保留机制

无论哪种中断方式，都会在 kill 进程**之前**调用 `getBufferedOutput()` 获取 LLM 已经产出的部分输出。这些输出通过 `InterruptedInfo.bufferedOutput` 传递给上层，确保：

- 用户可以看到中断前的部分结果
- 恢复时可以利用已有输出作为上下文，避免完全重做

### 2.10 内部状态

| 字段 | 类型 | 说明 |
|------|------|------|
| `lastSigintTime` | `number` | 上次 SIGINT 的时间戳（ms），初始为 0 |
| `hasPendingSigint` | `boolean` | 是否有未决的单次 Ctrl+C，初始为 false |
| `disposed` | `boolean` | 是否已销毁，调用 `dispose()` 后设为 true |

### 2.11 方法总览

| 方法 | 签名 | 说明 |
|------|------|------|
| `handleSigint` | `() => Promise<void>` | 处理 SIGINT 信号。首次中断进程；500ms 内再按则保存并退出 |
| `handleTextInterrupt` | `(text: string, resumeAs: 'coder' \| 'reviewer') => Promise<void>` | 处理文本中断，仅在 ACTIVE_STATES 且进程运行中时生效 |
| `handleUserInput` | `(input: string, resumeAs: 'coder' \| 'reviewer' \| 'decision') => void` | Card E.1：通过 observation pipeline 发出 `clarification_answer` observation |
| `dispose` | `() => void` | 标记 handler 为已销毁，后续调用全部跳过 |

---

## 3 Observation 与 GodAction 类型参考

### 3.1 Observation 类型（13 种）

`work_output`、`review_output`、`quota_exhausted`、`auth_failed`、`adapter_unavailable`、`empty_output`、`meta_output`、`tool_failure`、`human_interrupt`、`human_message`、`clarification_answer`、`phase_progress_signal`、`runtime_invariant_violation`

来源（source）：`coder`、`reviewer`、`god`、`human`、`runtime`

严重程度（severity）：`info`、`warning`、`error`、`fatal`

### 3.2 GodAction 类型（11 种）

| Action | 参数 | 路由效果 |
|--------|------|----------|
| `send_to_coder` | `message: string` | → CODING |
| `send_to_reviewer` | `message: string` | → REVIEWING |
| `accept_task` | `rationale: 'reviewer_aligned' \| 'god_override' \| 'forced_stop'`，`summary: string` | → DONE |
| `retry_role` | `role: 'coder' \| 'reviewer'`，`hint?: string` | → CODING 或 REVIEWING |
| `request_user_input` | `question: string` | → CLARIFYING |
| `resume_after_interrupt` | `resumeStrategy: 'continue' \| 'redirect' \| 'stop'` | → CODING/REVIEWING/GOD_DECIDING/DONE |
| `stop_role` | `role: 'coder' \| 'reviewer'`，`reason: string` | → GOD_DECIDING（非路由） |
| `switch_adapter` | `role`，`adapter: string`，`reason: string` | → GOD_DECIDING（非路由） |
| `set_phase` | `phaseId: string`，`summary?: string` | → GOD_DECIDING（非路由） |
| `wait` | `reason: string`，`estimatedSeconds?: number` | → GOD_DECIDING（非路由） |
| `emit_summary` | `content: string` | → GOD_DECIDING（非路由） |

### 3.3 GodDecisionEnvelope 结构

```ts
{
  diagnosis: {
    summary: string;
    currentGoal: string;
    currentPhaseId: string;
    notableObservations: string[];
  };
  authority: {
    userConfirmation: 'human' | 'god_override' | 'not_required';
    reviewerOverride: boolean;
    acceptAuthority: 'reviewer_aligned' | 'god_override' | 'forced_stop';
  };
  actions: GodAction[];       // 有序 action 列表
  messages: EnvelopeMessage[]; // 目标消息列表（target: coder/reviewer/user/system_log）
}
```

**Authority 约束**（schema-level validation）：
- `reviewerOverride = true` 时必须包含 `system_log` 消息
- `acceptAuthority = 'god_override'` 时必须包含 `system_log` 消息
- `userConfirmation = 'god_override'` 时必须包含 `system_log` 消息（BUG-18 fix）
- `acceptAuthority = 'forced_stop'` 时必须包含 `user` 消息
