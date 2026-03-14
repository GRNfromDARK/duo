# Sovereign God Runtime — 主权式 God 编排运行时需求文档

> **版本**: v1.0
> **日期**: 2026-03-13
> **状态**: Draft
> **Pipeline**: auto-requirement → auto-todo → auto-dev
> **Supersedes**: `docs/requirements/2026-03-11-god-llm-orchestrator-requirement.md` 中关于 God 权限边界、人工确认门禁、局部路由控制的旧定义

---

## 1. Executive Summary

### 问题

当前 Duo 已经引入 God 作为编排者，但运行时仍然保留了大量局部控制逻辑：

- `Coder`/`Reviewer` 的原始输出会直接推动状态跳转
- God 可以通过自然语言 prompt 间接“改变 phase / 代替用户确认 / 接受任务”，但系统状态未必同步
- token limit、鉴权失败、额度提示等外部故障会被误当作正常产出，导致错误回环
- `Reviewer` 与 God 的裁决边界模糊，最终 accept 缺少统一 authority 语义
- 人类仍然被视为流程 gate，而不是 God 可调用的信息源

典型失败案例：某次会话中 `claude-code` 先后作为 `God` 与 `Coder` 命中 `You're out of extra usage · resets 7pm (Asia/Shanghai)`，系统却继续把该文本当成有效产出推进流程，最终从预算 `12` 轮失控到 `48` 轮。

### 解决方案

将 Duo 重构为 **Sovereign God Runtime**：

- `God` 是唯一的主决策者、管理者、监督者、控制者
- `Coder` 和 `Reviewer` 是工作执行者，不拥有最终裁决权
- 系统核心循环改为 `Observe -> God Decide -> Execute Hands -> Observe`
- God 同时拥有三类能力：
  - **脑**：理解局面、拍板、代替用户确认、覆盖 reviewer
  - **口**：向 coder / reviewer / user 发自然语言消息
  - **手**：发出结构化动作，改变运行时状态
- 人类默认是观察者，只在 `Ctrl+C` 打断后进入 God 主持的多轮澄清对话

### 成功指标

| KPI | 目标值 | 度量方式 |
|-----|-------|---------|
| 外部故障误推进率 | 0 | token limit / auth failed / empty output 不再直接形成 `CODE_COMPLETE` 或 `REVIEW_COMPLETE` |
| God 决策显式化率 | 100% | 所有 phase change / accept / override / stop / switch 都有结构化决策记录 |
| 自动运行连续性 | ≥ 95% | 无人工输入的正常会话可持续运行直到 accept / stop / wait |
| 人类打断恢复率 | ≥ 90% | `Ctrl+C` 打断后的任务可在 God 澄清后恢复到主链 |
| 关键 override 可审计率 | 100% | God 代替用户确认、覆盖 reviewer、切换 adapter 均有审计记录 |

---

## 2. Strategic Goals & Traceability

```
SG-1: 让 God 成为唯一主决策中心
  ├── CD-1: Authority Model（权限模型）
  ├── CD-2: Decision Envelope（统一决策封装）
  └── CD-7: Audit & Traceability（审计与追溯）

SG-2: 将系统重构为 Observe -> Decide -> Act 的运行时
  ├── CD-3: Observation Pipeline（观察管线）
  ├── CD-4: Hand Execution（动作执行）
  └── CD-5: Worker Orchestration（执行者编排）

SG-3: 让人类从流程 gate 退化为 God 可调用的信息源
  └── CD-6: Interrupt-Driven Human Interaction（中断驱动的人机协作）

SG-4: 让外部故障成为 God 的管理对象，而不是工作流污染源
  ├── CD-3: Observation Pipeline（观察管线）
  ├── CD-4: Hand Execution（动作执行）
  └── CD-7: Audit & Traceability（审计与追溯）
```

---

## 3. Role Model

### 3.1 God

God 是 Duo 的唯一主决策者，负责：

- 理解任务目标和运行上下文
- 判断当前状态与问题来源
- 决定 phase 变化
- 决定接受、暂停、停止、切换 adapter、重试
- 代替用户确认
- 覆盖 reviewer 结论
- 向 coder / reviewer / user 输出自然语言消息
- 发出结构化动作，驱动运行时改变

God **不是**真正下场干活的角色，不负责提交代码实现、手工审查文件或亲自替代 coder/reviewer 产出工作结果。

### 3.2 Coder

Coder 是执行者，负责：

- 根据 God 的消息执行编码、探索、修复、实现等工作
- 返回工作产出，而不是做最终管理判断

Coder 无权：

- 自行 accept 任务
- 自行决定 phase 切换
- 自行请求流程停在等待人类确认

### 3.3 Reviewer

Reviewer 是审查执行者，负责：

- 对 coder 产出进行质量审查
- 提供阻塞问题、建议、质量判断

Reviewer 无权：

- 最终决定 accept
- 最终决定是否覆盖 God
- 将自己提升为与 God 平级的裁决层

### 3.4 Human

Human 默认是观察者。

人类正常交互入口只有：

1. `Ctrl+C` 打断
2. 输入文字后打断

打断后 Human 作为 God 可调用的信息源存在，而不是固定流程 gate。

---

## 4. Authority Model

### FR-001: Sovereign God Authority

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-1, CD-1 |
| depends_on | — |

**描述**: God 拥有全局最高权限。系统必须把 God 视为唯一主决策源。

God 必须能够：

- 代替用户确认
- 覆盖 reviewer 结论
- 决定 phase 变化
- 决定 `accept / stop / switch adapter / wait / retry`

**验收标准**:

- AC-001: God 可显式输出 `user_confirmation = god_override`
- AC-002: God 可显式输出 `reviewer_override = true`
- AC-003: God 可显式发出 `set_phase` 动作
- AC-004: God 可显式发出 `accept_task`、`stop_role`、`switch_adapter`、`wait` 动作

### FR-002: Authority Override Must Be Explicit

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-1, CD-1, CD-7 |
| depends_on | FR-001 |

**描述**: God 虽然拥有最高权限，但所有 override 必须显式记录在结构化决策中，不能仅存在于自然语言 prompt。

**验收标准**:

- AC-005: God 代替用户确认时，审计日志中必须记录 override 原因
- AC-006: God 覆盖 reviewer 时，审计日志中必须记录 reviewer 原结论与 override 原因
- AC-007: 任何 accept 决策必须带 authority 来源

---

## 5. Core Runtime Architecture

### FR-003: Runtime Core Loop

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-2 |
| depends_on | FR-001, FR-002 |

**描述**: Duo 运行时必须重构为统一主循环：

`Observe -> God Decide -> Execute Hands -> Observe`

局部状态不再自行拍板业务决策；局部模块只负责产生 observation 或执行 God action。

**验收标准**:

- AC-008: `ROUTING_POST_CODE`、`ROUTING_POST_REVIEW`、`GOD_DECIDING` 等阶段本质上都通过 God 统一决策
- AC-009: Runtime 不再依赖自然语言 prompt 猜测 phase/confirmation/accept
- AC-010: 每次 action 执行结果都会回流为新 observation

### FR-004: God Decision Envelope

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-1, SG-2, CD-2 |
| depends_on | FR-003 |

**描述**: God 的一次标准输出必须是一个统一的决策封装，而不是单个 `accept/continue` 或纯自然语言。

建议的逻辑结构：

```typescript
interface GodDecisionEnvelope {
  diagnosis: {
    summary: string;
    currentGoal: string;
    currentPhaseId: string | null;
    notableObservations: string[];
  };
  authority: {
    userConfirmation: 'human' | 'god_override' | 'not_required';
    reviewerOverride: boolean;
    acceptAuthority: 'reviewer_aligned' | 'god_override' | 'forced_stop';
  };
  actions: GodAction[];
  messages: Array<{
    target: 'coder' | 'reviewer' | 'user' | 'system_log';
    content: string;
  }>;
}
```

**验收标准**:

- AC-011: God 决策同时支持结构化 action 与自然语言 message
- AC-012: God 决策可表达 authority override
- AC-013: Runtime 仅执行 `actions` 改变状态，不从 `messages` 推断状态变化

---

## 6. Observation Pipeline

### FR-005: Observation Normalization

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-2, SG-4, CD-3 |
| depends_on | FR-003 |

**描述**: 任何来自 coder / reviewer / god / human / runtime 的输入，必须先翻译为 `Observation`，再交给 God 解释。

建议基础结构：

```typescript
interface Observation {
  source: 'coder' | 'reviewer' | 'god' | 'human' | 'runtime';
  type: string;
  summary: string;
  rawRef?: string;
  severity: 'info' | 'warning' | 'error' | 'fatal';
  timestamp: string;
  round: number;
  phaseId?: string | null;
  adapter?: string;
}
```

**核心 observation 类型**:

- `work_output`
- `review_output`
- `quota_exhausted`
- `auth_failed`
- `adapter_unavailable`
- `empty_output`
- `meta_output`
- `tool_failure`
- `human_interrupt`
- `human_message`
- `clarification_answer`
- `phase_progress_signal`
- `runtime_invariant_violation`

**验收标准**:

- AC-014: `You're out of extra usage` 这类文本被归一为 `quota_exhausted`
- AC-015: `empty output` 不再被当作 `work_output`
- AC-016: observation 可携带 `rawRef` 指向完整输出或 prompt 日志

### FR-006: Non-Work Outputs Must Not Advance Work States

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-4, CD-3 |
| depends_on | FR-005 |

**描述**: 配额错误、鉴权错误、meta 文本、空输出等不能直接进入 `CODE_COMPLETE`、`REVIEW_COMPLETE` 或后续路由。

这不是业务层硬编码控制，而是 observation 感知层的基本防污染机制。

**验收标准**:

- AC-017: `quota_exhausted` 不再直接进入 reviewer 审查
- AC-018: `auth_failed` 不再触发正常 post-code/post-review 路由
- AC-019: Runtime 会把此类 observation 送给 God 决策，而不是默认继续流程

---

## 7. Hand / Action Catalog

### FR-007: Structured Hand Catalog

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-2, CD-4 |
| depends_on | FR-004 |

**描述**: God 必须通过有限、稳定、显式的 Hand 集合改变系统状态。

v1 必需动作：

- `send_to_coder`
- `send_to_reviewer`
- `stop_role`
- `retry_role`
- `switch_adapter`
- `set_phase`
- `accept_task`
- `wait`
- `request_user_input`
- `resume_after_interrupt`
- `emit_summary`

**验收标准**:

- AC-020: 所有关键状态变化均可映射到 Hand
- AC-021: Runtime 执行 Hand 后返回结果 observation
- AC-022: 不能依赖自然语言 message 隐式完成 `set_phase` / `accept_task`

### FR-008: Natural-Language Message Channel

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-1, CD-2, CD-4 |
| depends_on | FR-004 |

**描述**: God 除了发 Hand，还必须能向不同目标输出自然语言消息。

目标包括：

- `coder`
- `reviewer`
- `user`
- `system_log`

**验收标准**:

- AC-023: God 可在一次决策中同时输出 `actions + messages`
- AC-024: God 可给 coder/reviewer 下发自然语言工作指令
- AC-025: God 可给 user 输出解释、追问或总结

---

## 8. Worker Orchestration

### FR-009: Coder / Reviewer As Workers

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-2, CD-5 |
| depends_on | FR-001, FR-008 |

**描述**: Coder 与 Reviewer 必须被建模为 God 管理下的工作执行者。

运行原则：

- Coder 只执行工作，不拥有 accept 权
- Reviewer 只提供审查，不拥有最终裁决权
- God 负责给下一个执行者发送自然语言消息并决定是否切换角色

**验收标准**:

- AC-026: coder 输出只形成 observation，不直接决定 accept
- AC-027: reviewer 输出只形成 observation，不直接拥有终局否决权
- AC-028: God 可决定跳过、重试、停止或切换某个 worker

### FR-010: Reviewer Can Be Overridden But Not Ignored

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-1, CD-5, CD-7 |
| depends_on | FR-002, FR-009 |

**描述**: Reviewer 的结论必须被 God 看见，但 God 可以显式覆盖。

**验收标准**:

- AC-029: God 决策中可引用 reviewer 结论
- AC-030: God 覆盖 reviewer 时必须写明 override 原因
- AC-031: 审计中能追溯 reviewer 原结论与 God 最终裁决

---

## 9. Interrupt-Driven Human Interaction

### FR-011: Human Interrupt Is The Only Standard Entry

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-3, CD-6 |
| depends_on | FR-003 |

**描述**: 系统默认不主动等待人类输入。人类的标准介入方式只有中断。

允许方式：

1. `Ctrl+C`
2. 输入文字后打断

**验收标准**:

- AC-032: 正常任务流默认不停留在等待人类确认状态
- AC-033: `Ctrl+C` 总能进入中断语义
- AC-034: 输入文字后打断时，文字会进入 God 澄清上下文

### FR-012: God-Mediated Multi-Turn Clarification

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-3, CD-6 |
| depends_on | FR-011 |

**描述**: 人类打断后，God 进入临时主持模式，可与人类进行多轮澄清。

流程：

`Suspend current work -> God clarifies with human -> God emits decision -> Resume`

**验收标准**:

- AC-035: God 可基于 human message 追问多轮问题
- AC-036: 澄清期间主工作链被冻结
- AC-037: 澄清完成后 God 可恢复原任务链

### FR-013: Resume Semantics After Interrupt

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-3, CD-6 |
| depends_on | FR-012 |

**描述**: 中断恢复必须保留被打断工作链的上下文，而不是启动一个无关新任务。

恢复后 God 可以决定：

- 继续原方向
- 改道
- 切换 adapter
- 直接停止或 accept

**验收标准**:

- AC-038: 恢复后能知道原任务、原 phase、原 active role
- AC-039: God 可基于澄清结果重写后续 message/action
- AC-040: 恢复不会丢失被打断前的 observation 历史

---

## 10. External Incident Autonomy

### FR-014: Incidents Are Management Events

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-4, CD-3, CD-4 |
| depends_on | FR-005, FR-007 |

**描述**: token limit、adapter 不可用、鉴权失败、空输出等必须被视为 `Execution Incident`，由 God 管理。

God 在 incident 上至少完成三件事：

1. 诊断
2. 决策
3. 编排

**验收标准**:

- AC-041: token limit 被 God 作为 incident 处理，而不是 reviewer 审查对象
- AC-042: incident 后 God 可输出 `switch / wait / stop`
- AC-043: incident 处理结果写入审计日志

### FR-015: God Chooses Switch / Wait / Stop

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-4, CD-4 |
| depends_on | FR-014 |

**描述**: 当出现外部故障时，God 可自主选择：

- `switch`
- `wait`
- `stop`

系统不强制固定优先级。

**验收标准**:

- AC-044: God 可为 coder/reviewer/god 任一角色切换 adapter
- AC-045: God 可决定进入 wait，并向 user 输出等待原因
- AC-046: God 可决定 stop 并输出管理总结

---

## 11. State Consistency & Minimal Invariants

### FR-016: State Changes Must Be Action-Backed

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-2, SG-4, CD-7 |
| depends_on | FR-007 |

**描述**: 所有真实状态变化必须由 Hand/action 明确承载。

例如：
- God 自然语言里说“进入 phase-3”不算 phase 变化
- 只有 `set_phase(phase-3)` 才真正改变 runtime

**验收标准**:

- AC-047: phase 变化必须有显式 `set_phase`
- AC-048: accept 必须有显式 `accept_task`
- AC-049: action 执行失败必须回写 observation

### FR-017: Accept Must Carry Rationale

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-1, SG-4, CD-7 |
| depends_on | FR-002, FR-016 |

**描述**: God 的 accept 决策必须带上明确接受依据。

接受依据可包括：

- `reviewer_aligned`
- `god_override`
- `forced_stop_with_partial_result`

**验收标准**:

- AC-050: 所有 accept 决策都可追溯 authority
- AC-051: God override accept 时必须说明为何不采纳 reviewer
- AC-052: `forced_stop_with_partial_result` 时必须有总结消息

---

## 12. Audit & Traceability

### FR-018: Decision Audit Must Explain God

| 属性 | 值 |
|------|-----|
| Priority | Must |
| traces_to | SG-1, SG-4, CD-7 |
| depends_on | FR-004, FR-014, FR-017 |

**描述**: 审计系统不仅要记录 coder/reviewer 输出，还必须能解释 God 为什么这么决定。

每次关键 God 决策至少记录：

- 相关 observations
- God diagnosis
- authority override
- chosen actions
- natural-language messages
- action execution results

**验收标准**:

- AC-053: God 代替用户确认可追溯
- AC-054: God 覆盖 reviewer 可追溯
- AC-055: God 切换 adapter / wait / stop 可追溯
- AC-056: God accept/stop 的最终理由可追溯

---

## 13. Non-Functional Requirements

| NFR ID | 类别 | 需求 | 目标值 |
|--------|------|------|--------|
| NFR-001 | 一致性 | 所有关键状态变化必须有显式 action | 100% |
| NFR-002 | 可追溯 | God override 审计完整率 | 100% |
| NFR-003 | 鲁棒性 | 外部故障误推进率 | 0 |
| NFR-004 | 自主性 | 非中断场景无需人工输入完成率 | ≥ 95% |
| NFR-005 | 恢复性 | 中断后恢复成功率 | ≥ 90% |
| NFR-006 | 可解释性 | God 决策日志可读性 | 每次关键决策均含 diagnosis + authority + action + message |

### 技术架构决策

| AR ID | 决策 | 理由 | 影响 |
|-------|------|------|------|
| AR-001 | God 是唯一主决策源 | 避免多头裁决与局部逻辑打架 | Runtime 收敛为 Observe -> Decide -> Act |
| AR-002 | God 同时拥有结构化动作通道与自然语言通道 | 满足 God 的脑、口、手统一模型 | 需要统一 Decision Envelope |
| AR-003 | Runtime 仅保留最小不变量 | 保持 AI-driven，不回到规则驱动系统 | 本地逻辑只做 observation translation 和 action execution |
| AR-004 | Human 只作为中断驱动信息源存在 | 保持默认全自动，避免人工 gate | 等待人类输入从默认路径中移除 |
| AR-005 | 外部故障统一建模为 incident | 避免 provider 文本污染工作流 | 需要 observation normalization 层 |

---

## 14. Scope & Boundaries

### In Scope

- God 主权模型与 authority 语义
- Observation 统一归一化
- Decision Envelope + Hand Catalog
- 中断驱动的人机澄清模型
- 外部故障自主管理
- 审计与追溯重构

### Out of Scope / Non-Goals

- 让 God 直接替代 coder 写代码
- 让 reviewer 升级为与 God 平级的裁决层
- 保留大量局部业务规则作为主决策机制
- 通过自然语言隐式修改 phase / accept / confirmation

---

## 15. Risks & Mitigations

| RSK ID | 风险 | 影响 | 概率 | 缓解措施 |
|--------|------|------|------|---------|
| RSK-001 | God 权限过大导致误裁决 | 高 | 中 | FR-018 全量审计 + authority 显式化 |
| RSK-002 | 自然语言通道与结构化动作通道不一致 | 高 | 中 | FR-016 要求状态变化必须 action-backed |
| RSK-003 | 外部故障分类不稳定 | 中 | 中 | FR-005 统一 observation 归一化 |
| RSK-004 | 中断澄清打断主链后无法恢复 | 高 | 低 | FR-013 恢复语义显式化 |
| RSK-005 | God 过度 override reviewer 降低质量 | 中 | 中 | FR-010 要求 reviewer 可见但可显式 override |

---

## 16. Acceptance Summary

该需求完成后，系统必须满足以下端到端能力：

1. token limit / auth failed / empty output 不再被当作正常工作产出推进流程
2. God 可以显式代替用户确认，并留下审计记录
3. God 可以显式覆盖 reviewer，并留下审计记录
4. God 的 phase 变化会真实落到 runtime state，而不是只存在于 prompt
5. 人类可通过 `Ctrl+C` 进入 God 主持的多轮澄清
6. 澄清完成后任务可恢复到原主链继续
7. 外部故障时 God 可自主选择 `switch / wait / stop`
8. 审计日志能解释 God 的关键管理决策

