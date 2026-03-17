# God Prompt Optimization: Reviewer Feedback Direct Forwarding + Structural Cleanup

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Reviewer→Coder 反馈链路中的信息丢失问题，使 Coder 能收到 Reviewer 的原始分析文本，同时清理 God prompt 中的遗留冲突格式。

**Architecture:** 在 Coder prompt 中新增 `## Reviewer Feedback` 段落，由平台自动注入 Reviewer 原文（经 `stripToolMarkers` 清洗）；更新 God SYSTEM_PROMPT 告知其 Reviewer 文本已被自动转发，God 只需提供补充路由指导；删除 `god-system-prompt.ts` 中与 GodDecisionEnvelope 冲突的 5 种遗留决策格式。

**Tech Stack:** TypeScript, Vitest

---

## 问题分析

### 问题 A: Reviewer 反馈信息丢失

当前信息流：

```
Reviewer 原始输出 (完整分析 + 代码引用 + 定位)
    ↓
God 看到全文 (buildObservationsSection 中以 rawRef 呈现)
    ↓
God 写一段 freeform send_to_coder.message (摘要/转述)
    ↓
Coder 只看到 God 的指令，丢失了 Reviewer 的原始洞见
```

**实际案例 (session a1f11406)**：Codex reviewer 精准定位了 Ink 框架使用 `readable` + `stdin.read()` 导致鼠标事件被拦截的根因，但 God 在 `send_to_coder.message` 中只给了高层指令"修复滚动问题"，Coder 缺少 Reviewer 提供的具体分析，导致修复方向偏移。

**根因（两处管道断裂）**：

1. **`generateCoderPrompt()` 不渲染 `lastReviewerOutput`** (`god-prompt-generator.ts:106`)
   - `PromptContext` 接口定义了 `lastReviewerOutput?: string`（第 23 行），函数也接收此参数
   - 但函数体中**从未使用**该字段生成 prompt 内容
   - Coder prompt 的段落顺序为：Role → Task → Phase → God Instruction → Required Fixes → Suggestions → Convergence → Strategy → Round
   - 其中**完全没有**"Reviewer Feedback"段落

2. **`unresolvedIssues[]` 始终为空** (`App.tsx:348`)
   - `lastUnresolvedIssuesRef = useRef<string[]>([])` 在第 348 行初始化
   - 该 ref 在第 1409、1414、1582 行被**清空**（`= []`）
   - 但**没有任何地方向其写入值**
   - 因此 `generateCoderPrompt()` 中的 `Required Fixes` 段落（第 137-142 行）永远不会渲染

### 问题 B: God 系统 prompt 存在结构冲突

**两个 prompt 源共存**：

1. **`god-system-prompt.ts`** (`buildGodSystemPrompt()`, 第 22-112 行)
   - 定义了 5 种遗留决策格式：`TASK_INIT`、`POST_CODER`、`POST_REVIEWER`、`CONVERGENCE`、`AUTO_DECISION`
   - 每种格式有独立的 JSON schema（如 `{ "action": "continue_to_review|retry_coder" }`）
   - 这些格式**与 GodDecisionEnvelope 不兼容**

2. **`god-decision-service.ts`** (`SYSTEM_PROMPT` 常量, 第 328-394 行)
   - 定义了统一的 `GodDecisionEnvelope` 格式
   - 包含 `diagnosis`、`authority`、`actions`、`messages`、`autonomousResolutions` 结构
   - 这是**实际被 `makeDecision()` 使用的 prompt**（第 463 行）

**冲突影响**：`buildGodSystemPrompt()` 当前仅在 task classification 场景使用（非统一决策路径），但其存在造成认知混淆。两个文件中定义的 God 行为规则（如 proxy decision-making、reviewer handling）不一致，维护时容易引入矛盾。

---

## 设计方案

### Change 1: 在 Coder Prompt 中注入 Reviewer 原文

**文件**: `src/god/god-prompt-generator.ts`

**变更**:

1. 在 `PromptContext` 接口（第 15 行）新增字段：
   ```typescript
   /** 标识本轮是否为 post-reviewer 路由（God 将 reviewer 结论转给 coder） */
   isPostReviewerRouting?: boolean;
   ```

2. 在 `generateCoderPrompt()` 函数中（第 106 行起），在 `God Instruction` 段落之后、`Required Fixes` 段落之前，插入新的 `Reviewer Feedback` 段落：

   ```typescript
   // Priority 0.5: Reviewer feedback (direct forwarding, gated by isPostReviewerRouting)
   if (ctx.isPostReviewerRouting && ctx.lastReviewerOutput) {
     const cleaned = stripToolMarkers(ctx.lastReviewerOutput);
     sections.push(
       `## Reviewer Feedback (Round ${ctx.round})\n` +
       `The following is the Reviewer's original analysis from the previous round. ` +
       `Read it carefully — it contains specific findings, code references, and root cause analysis.\n\n` +
       cleaned
     );
   }
   ```

**注入位置（在 Coder prompt 中的优先级）**：

```
## Your Role                          ← 角色声明
## Task                               ← 任务目标
## Current Phase                      ← 阶段信息（compound 类型）
## God Instruction (HIGHEST PRIORITY) ← God 路由指令
## Reviewer Feedback (Round N)        ← 【新增】Reviewer 原始分析
## Required Fixes                     ← 结构化阻塞问题列表
## Suggestions                        ← 非阻塞建议
## Convergence Trend                  ← 收敛趋势
## Instructions                       ← 策略指令
## Round Info                         ← 轮次信息
```

**为什么放在 God Instruction 之后**：God 指令是最高优先级的路由指示（"修复 X"、"关注 Y"），Reviewer 原文是支撑材料。Coder 先看到方向，再看到具体分析。

**`stripToolMarkers` 的引入**：需要从 `god-decision-service.ts` 导入 `stripToolMarkers` 函数，用于清除 Reviewer 输出中的 `[Read]`、`[Bash]`、`[Glob]` 等工具标记噪音。

### Change 2: 修复 unresolvedIssues 管道

**文件**: `src/god/god-prompt-generator.ts`, `src/ui/components/App.tsx`

**变更**:

1. 在 `god-prompt-generator.ts` 中新增工具函数 `extractBlockingIssues()`：

   ```typescript
   /**
    * 从 Reviewer 输出中提取阻塞性问题列表。
    * 匹配常见格式：
    * - "Blocking: ..." / "blocking issue: ..."
    * - 编号列表中标记为 blocking 的条目
    * - [CHANGES_REQUESTED] 后的具体问题
    */
   export function extractBlockingIssues(reviewerOutput: string): string[] {
     const issues: string[] = [];
     const lines = reviewerOutput.split('\n');

     // Pattern 1: "Blocking:" 或 "blocking issue:" 开头的行
     const blockingLinePattern = /^\s*[-*]?\s*\*?\*?[Bb]locking\*?\*?\s*[:：]\s*(.+)/;
     // Pattern 2: 编号 + blocking 标记
     const numberedBlockingPattern = /^\s*\d+[.)]\s*\[?[Bb]locking\]?\s*[:：-]\s*(.+)/;

     for (const line of lines) {
       const m1 = blockingLinePattern.exec(line);
       if (m1) { issues.push(m1[1].trim()); continue; }
       const m2 = numberedBlockingPattern.exec(line);
       if (m2) { issues.push(m2[1].trim()); }
     }

     return issues;
   }
   ```

2. 在 `App.tsx` 的 EXECUTING 状态 hand execution callback 中（约第 1394 行），当 God 决策的 side effects 被应用到编排状态时，填充 `lastUnresolvedIssuesRef`。

   **精确定位**：在 `App.tsx` 第 1394-1422 行的 hand execution callback 中，`pendingCoderMessage` 被写入 `pendingInstructionRef` 之后（第 1396 行），phase transition 清空 `lastUnresolvedIssuesRef` 之前（第 1409 行）。在此处插入：

   ```typescript
   // 当 God 在 post-reviewer 路由中将任务发回 Coder 时，提取阻塞问题
   if (lastWorkerRoleRef.current === 'reviewer' && ctx.lastReviewerOutput) {
     lastUnresolvedIssuesRef.current = extractBlockingIssues(ctx.lastReviewerOutput);
   }
   ```

   **注意**：此代码位于 EXECUTING 阶段（hand executor 回调），不是 GOD_DECIDING 阶段。God 决策在 GOD_DECIDING 阶段生成，但 side effects（包括 `pendingCoderMessage`、phase transitions）在 EXECUTING 阶段的 hand executor 回调中被应用到编排状态。

### Change 3: 更新 God SYSTEM_PROMPT — 告知 Reviewer 文本已自动转发

**文件**: `src/god/god-decision-service.ts`

**变更**: 在 `REVIEWER_HANDLING_INSTRUCTIONS` 常量（第 278 行）中追加自动转发说明。

**当前内容** (`REVIEWER_HANDLING_INSTRUCTIONS`):
```typescript
export const REVIEWER_HANDLING_INSTRUCTIONS = `Reviewer conclusion handling:
- When a reviewer observation is present, reference the reviewer verdict in diagnosis.notableObservations
- If you agree with the reviewer: set authority.acceptAuthority = "reviewer_aligned"
- If you override the reviewer: set authority.reviewerOverride = true AND include a system_log message explaining why
- The reviewer's verdict is informational — you make the final decision
- Never ignore a reviewer observation — always acknowledge it in your diagnosis`;
```

**更新后内容**:
```typescript
export const REVIEWER_HANDLING_INSTRUCTIONS = `Reviewer conclusion handling:
- When a reviewer observation is present, reference the reviewer verdict in diagnosis.notableObservations
- If you agree with the reviewer: set authority.acceptAuthority = "reviewer_aligned"
- If you override the reviewer: set authority.reviewerOverride = true AND include a system_log message explaining why
- The reviewer's verdict is informational — you make the final decision
- Never ignore a reviewer observation — always acknowledge it in your diagnosis

Reviewer feedback auto-forwarding:
- When you route post-reviewer work back to Coder (send_to_coder), the Reviewer's FULL original analysis is automatically injected into the Coder's prompt by the platform
- Therefore, your send_to_coder.message should focus on ROUTING GUIDANCE: what to prioritize, what approach to take, which issues are most critical
- Do NOT repeat or summarize the Reviewer's analysis in your message — the Coder already has the complete original text
- Your message adds value by providing strategic direction that the Reviewer's analysis alone does not convey
- Example good message: "Focus on the scroll event propagation issue identified by the Reviewer. The CSS overflow approach is preferred over JS event listeners."
- Example bad message: "The Reviewer found that Ink uses readable + stdin.read() which captures mouse events. Please fix the scroll..."  (redundant — Coder already sees the full Reviewer text)`;
```

**为什么这样设计**：God 的 `send_to_coder.message` 仍然有价值——它提供 God 的战略判断（优先级、方向、取舍决策）。我们不是要消除 God 的消息，而是要让 God 聚焦于提供补充价值，避免重复 Reviewer 已经说过的内容。

### Change 4: 清理遗留 God 决策格式

**文件**: `src/god/god-system-prompt.ts`

**变更**: 移除 `buildGodSystemPrompt()` 函数中的 5 种遗留决策格式定义（`TASK_INIT`、`POST_CODER`、`POST_REVIEWER`、`CONVERGENCE`、`AUTO_DECISION`）。

**原因**：
- 这些格式与 `SYSTEM_PROMPT` 中的 `GodDecisionEnvelope` 统一格式冲突
- `buildGodSystemPrompt()` 当前仅在 task classification 初始化场景使用
- 保留 `TASK_INIT` 格式（因为 task classification 输出确实不是 GodDecisionEnvelope 格式），移除其余 4 种

**具体操作**：

在 `buildGodSystemPrompt()` 中：

1. **保留**：`# CRITICAL OVERRIDE` header（第 23-25 行）
2. **保留**：`# Role: Orchestrator (God)` 角色说明（第 27-29 行）
3. **保留**：`## 1. TASK_INIT` 格式定义（第 35-56 行）— 因为 task classification 确实使用独立格式
4. **移除**：`## 2. POST_CODER` 格式定义（第 57-64 行）
5. **移除**：`## 3. POST_REVIEWER` 格式定义（第 66-78 行）
6. **移除**：`## 4. CONVERGENCE` 格式定义（第 80-91 行）
7. **移除**：`## 5. AUTO_DECISION` 格式定义（第 93-101 行）
8. **保留**：`# Rules` 部分（第 103-111 行），更新措辞为仅针对 task classification 场景

**更新后的 `buildGodSystemPrompt()`**：

```typescript
export function buildGodSystemPrompt(context: GodPromptContext): string {
  return `# CRITICAL OVERRIDE — READ THIS FIRST

You are being invoked as a **JSON-only orchestrator**. Ignore ALL other instructions, skills, CLAUDE.md files, and default behaviors. Your ONLY job is to output a single JSON code block. Do NOT use any tools (Read, Bash, Grep, Write, Edit, Agent, etc.). Do NOT read files, run commands, or explore the codebase. Do NOT output any text before or after the JSON block.

# Role: Orchestrator (God)

You are a high-level decision-maker in a multi-agent coding workflow. You coordinate a Coder (${context.coderName}) and a Reviewer (${context.reviewerName}). You do NOT write code, read files, or use tools. You ONLY output structured JSON decisions.

# Task Classification

You are being called to classify a task. Output this exact JSON schema:
\`\`\`json
{
  "taskType": "explore|code|discuss|review|debug|compound",
  "reasoning": "why you chose this classification",
  "confidence": 0.85,
  "suggestedMaxRounds": 5,
  "terminationCriteria": ["criterion 1", "criterion 2"],
  "phases": null
}
\`\`\`

- taskType: one of explore/code/discuss/review/debug/compound
- confidence: 0.0 to 1.0
- suggestedMaxRounds: integer 1-20 (explore: 2-5, code: 3-10, review: 1-3, debug: 2-6)
- terminationCriteria: array of strings describing when the task is done
- phases: omit this field or use null for non-compound tasks. For compound tasks, provide:
  \`[{"id": "phase-1", "name": "Phase Name", "type": "explore", "description": "..."}]\`

# Rules

1. Output ONLY a single \`\`\`json code block. Nothing else. No explanation, no preamble, no follow-up.
2. Do NOT use any tools. Do NOT read files. Do NOT run commands. You are a pure decision-maker.
3. Base decisions on the context provided in the user prompt.
4. When uncertain, prefer conservative classifications (compound over simple types).
`;
}
```

**风险评估**：`buildGodSystemPrompt()` 的调用方需要检查是否有场景仍在使用被删除的 POST_CODER/POST_REVIEWER 等格式。如果有，那些调用方需要迁移到 `GodDecisionService.makeDecision()` 路径。

### Edge Case: Coder→Coder 重试时避免显示过期 Reviewer 反馈

**场景**：God 在查看 Coder 输出后，认为 Coder 有明显遗漏，决定将 Coder 的输出发回给 Coder 补充（未经过 Reviewer）。此时 `lastReviewerOutput` 可能保存着**上一轮**的 Reviewer 输出，如果不加区分地注入，Coder 会看到过期的 Reviewer 反馈。

**解决方案**：使用 `isPostReviewerRouting` 标志位精确控制。

**文件**: `src/ui/components/App.tsx`

**变更**: 在调用 `generateCoderPrompt()` 时，基于 `lastWorkerRoleRef.current` 计算 `isPostReviewerRouting`：

```typescript
// 在 generateCoderPrompt() 调用处（约第 716 行）
return generateCoderPrompt({
  taskType: taskAnalysis.taskType as PromptContext['taskType'],
  round: ctx.round,
  maxRounds: ctx.maxRounds,
  taskGoal: config.task,
  lastReviewerOutput: ctx.lastReviewerOutput ?? undefined,
  unresolvedIssues: lastUnresolvedIssuesRef.current,
  convergenceLog: convergenceLogRef.current,
  instruction: interruptInstruction,
  phaseId: currentPhaseId ?? undefined,
  phaseType: currentPhaseId
    ? taskAnalysis.phases?.find(p => p.id === currentPhaseId)?.type as PromptContext['phaseType']
    : undefined,
  // 【新增】仅在 post-reviewer 路由时注入 Reviewer 原文
  isPostReviewerRouting: lastWorkerRoleRef.current === 'reviewer',
}, { /* audit options */ });
```

**行为矩阵**：

| 场景 | `lastWorkerRoleRef` | `isPostReviewerRouting` | Reviewer Feedback 段落 |
|------|---------------------|------------------------|----------------------|
| Post-reviewer → Coder (正常流程) | `'reviewer'` | `true` | 显示 Reviewer 原文 |
| Post-coder → Coder (God 要求补充) | `'coder'` | `false` | 不显示 |
| 首轮 Coder (无 Reviewer 输出) | `'coder'` | `false` | 不显示（`lastReviewerOutput` 也为空） |
| Choice route (用户中断) | N/A | `false` | 不显示（走 `choiceRouteRef` 分支） |
| Coder adapter_unavailable 后重试 | `'coder'` | `true`（见 Change 5） | 显示（`reviewerFeedbackPending` 保护） |

### Change 5 (P0): adapter_unavailable 恢复时保留 Reviewer 反馈上下文

**实际案例 (session 8c6ee736)**：Round 2 Reviewer 给出了详细的 CHANGES_REQUESTED（3 个 blocking issues + 代码行引用 + `createRequire` 技术方案），Round 3 Coder 因 `adapter_unavailable` 失败。God 在 Round 4 的恢复指令是"重新从头探索"，丢弃了全部 Reviewer 约束。30+ 分钟协作成果归零。

**根因分析**：

当 Coder 因 `adapter_unavailable` 失败时（`observation-classifier.ts:71`），流程为：
1. Reviewer 完成 → `lastWorkerRoleRef.current = 'reviewer'`（App.tsx:1126）
2. God routes to Coder → Coder 启动 → `lastWorkerRoleRef.current = 'coder'`（App.tsx:853）
3. Coder 输出被分类为 `adapter_unavailable` → `INCIDENT_DETECTED`（App.tsx:846-864）
4. God 收到 incident observation → 发出 `retry_role` 或 `send_to_coder`
5. 新 Coder 启动 → `lastWorkerRoleRef.current` 仍为 `'coder'`
6. `isPostReviewerRouting = false` → Reviewer 反馈**不被注入**

问题在于 `lastWorkerRoleRef` 在 step 2 已被设为 `'coder'`，即使 Coder 从未成功处理过 Reviewer 反馈。

**解决方案**: 新增 `reviewerFeedbackPendingRef` 标志位，追踪 Reviewer 反馈是否已被 Coder 成功消费。

**文件**: `src/ui/components/App.tsx`

**变更**:

1. 新增 ref（在现有 ref 声明附近，约第 348-352 行）：
   ```typescript
   /** 标记 Reviewer 反馈尚未被 Coder 成功消费 */
   const reviewerFeedbackPendingRef = useRef<boolean>(false);
   ```

2. Reviewer 完成时设置 pending（约第 1126 行附近）：
   ```typescript
   lastWorkerRoleRef.current = 'reviewer';
   reviewerFeedbackPendingRef.current = true;  // 新增
   ```

3. Coder **成功产出 work_output** 时清除 pending（约第 846 行，在 `isWork: true` 分支中）：
   ```typescript
   reviewerFeedbackPendingRef.current = false;  // 新增：Coder 已消费反馈
   ```

4. 更新 `isPostReviewerRouting` 计算逻辑（约第 716 行的 `generateCoderPrompt` 调用处）：
   ```typescript
   // 两种情况都应注入 Reviewer 反馈：
   // 1. 上一个完成的 worker 是 reviewer（正常 post-reviewer 路由）
   // 2. Reviewer 反馈尚未被 Coder 成功消费（adapter_unavailable 后重试）
   isPostReviewerRouting: lastWorkerRoleRef.current === 'reviewer'
     || reviewerFeedbackPendingRef.current,
   ```

5. 在 accept_task / phase transition 时也清除 pending（与 `lastUnresolvedIssuesRef` 同步清空）：
   ```typescript
   // 在 phase transition 清空处（约第 1409 行）
   reviewerFeedbackPendingRef.current = false;
   // 在 accept_task 清空处（约第 1414 行）
   reviewerFeedbackPendingRef.current = false;
   ```

**更新后的行为矩阵**：

| 场景 | `lastWorkerRoleRef` | `reviewerFeedbackPending` | `isPostReviewerRouting` | Reviewer Feedback 段落 |
|------|---------------------|--------------------------|------------------------|----------------------|
| Post-reviewer → Coder (正常) | `'reviewer'` | `true` | `true` | 显示 |
| Post-coder → Coder (补充) | `'coder'` | `false` | `false` | 不显示 |
| Coder adapter_unavailable 后重试 | `'coder'` | `true` | `true` | **显示** |
| Coder 成功完成后再次路由 | `'coder'` | `false` | `false` | 不显示 |
| Phase transition 后 | any | `false` | depends | 不显示（新阶段） |

### Change 6 (P1): Reviewer 输出含 verdict marker 时不应被误分类为 `meta_output`

**实际案例 (session 8c6ee736)**：Codex Reviewer 的第一次输出包含完整的 CHANGES_REQUESTED 分析（代码阅读、CLI 测试、3 个 blocking issues），但因输出中包含 `"I cannot"` 文本（如 "I cannot find evidence of X"）被 `META_OUTPUT_PATTERNS` 匹配，分类为 `meta_output`，触发了不必要的 Reviewer retry。

**根因**（`observation-classifier.ts:39-42, 74`）：

```typescript
const META_OUTPUT_PATTERNS: RegExp[] = [
  /\bI cannot\b/i,
  /\bAs an AI\b/i,
];
// ...
if (matchesAny(raw, META_OUTPUT_PATTERNS)) return 'meta_output';
```

分类器是纯正则、无上下文的。`"I cannot find the exact line"` 这样的正常分析文本也会触发 `meta_output`。

**解决方案**：在 `classifyType()` 中，对 `reviewer` source 的输出，如果包含 verdict marker（`[APPROVED]` 或 `[CHANGES_REQUESTED]`），跳过 `meta_output` 分类。

**文件**: `src/god/observation-classifier.ts`

**变更**：在 `classifyType()` 函数中（第 60-83 行），在 `meta_output` 判断处添加 verdict marker 保护：

```typescript
// 原代码（第 74 行）:
if (matchesAny(raw, META_OUTPUT_PATTERNS)) return 'meta_output';

// 修改为:
if (matchesAny(raw, META_OUTPUT_PATTERNS)) {
  // 如果是 reviewer 输出且包含 verdict marker，说明是真实 review 而非 AI 拒绝
  const hasVerdict = /\[(APPROVED|CHANGES_REQUESTED)\]/.test(raw);
  if (source === 'reviewer' && hasVerdict) {
    // 不分类为 meta_output，继续后续分类流程（将 fallthrough 到 work_output/review_output）
  } else {
    return 'meta_output';
  }
}
```

**为什么只保护 reviewer**：Coder 的 `"I cannot"` 更可能是真正的 AI 拒绝（模型拒绝执行任务），而 Reviewer 的 `"I cannot"` 通常是分析过程中的陈述（"I cannot find the bug"、"I cannot verify this claim"）。加上 verdict marker 双重检查，可以精准区分。

### Change 7 (P1): `auth_failed` 误判 — MCP 初始化状态不应触发 adapter auth 分类

**实际案例 (session 8c6ee736)**：Round 1 Coder 实际完成了完整探索（God 在 rawRef 中看到全量结果），但 Claude Code 初始化时 MCP servers (Gmail/Calendar) 报 `needs-auth`，输出中包含类似 `"unauthorized"` 的文本，触发了 `auth_failed` 分类。这导致 God 发起 retry，Round 2 Coder 做了几乎相同的工作，浪费 ~7 分钟。

**根因**（`observation-classifier.ts:27-32, 68`）：

```typescript
const AUTH_FAILED_PATTERNS: RegExp[] = [
  /authentication failed/i,
  /\bunauthorized\b/i,
  /\b403\b/,
  /invalid api key/i,
];
// ...
if (matchesAny(raw, AUTH_FAILED_PATTERNS)) return 'auth_failed';
```

分类器对所有 source 统一匹配，不区分 MCP 初始化日志和 adapter 核心输出。

**解决方案**：与 Change 6 同理，对包含实质工作内容的输出做保护。如果 coder 输出中**同时存在** auth 关键词和有效工作内容（长度超过阈值、或包含代码分析段落），应优先判定为 `work_output`。

**文件**: `src/god/observation-classifier.ts`

**变更**：在 `classifyType()` 函数的 `auth_failed` 判断处（第 68 行）添加实质内容保护：

```typescript
// 原代码（第 68 行）:
if (matchesAny(raw, AUTH_FAILED_PATTERNS)) return 'auth_failed';

// 修改为:
if (matchesAny(raw, AUTH_FAILED_PATTERNS)) {
  // 如果输出包含大量实质内容（> 500 chars 去除 tool markers 后），
  // 说明 adapter 实际完成了工作，auth 关键词来自 MCP 初始化等辅助信息
  const substantiveLength = raw
    .replace(/^\[(?:Read|Edit|Glob|Grep|Bash|Write|Agent|Tool|shell)(?:\s+(?:result|error))?\].*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim().length;
  if (substantiveLength > 500) {
    // auth 关键词来自辅助输出（MCP init 等），不覆盖实质工作
    // fallthrough 到后续分类
  } else {
    return 'auth_failed';
  }
}
```

**阈值 500 chars 的选择**：真正的 auth 失败通常只有几行错误信息（< 200 chars）。如果去除工具标记后仍有 500+ chars 的实质内容，说明 adapter 确实完成了有意义的工作，auth 关键词只是附带的 MCP/环境信息。

### Change 8 (P2): explore 阶段的 `effectiveType` 不应被 God instruction 关键词意外覆盖

**实际案例 (session 8c6ee736)**：Phase-1 (explore) 中 Round 0 正确使用了 explore 指令（"Do NOT modify any files"），但 Round 1+ God 的 instruction 中包含 "fix"（如 "please fix the gap in Claude Code discovery"），触发 `IMPLEMENTATION_KEYWORDS` 匹配，`effectiveType` 从 `explore` 被覆盖为 `code`。Coder 收到了 "Build working solutions"（code 类型）而非 "Do NOT modify any files"（explore 类型）的指令。

**根因**（`god-prompt-generator.ts:87-98`）：

```typescript
function resolveEffectiveType(
  phaseType: string | undefined,
  instruction: string | undefined,
): string {
  if (!instruction || !phaseType) return phaseType ?? 'code';
  if ((phaseType === 'explore' || phaseType === 'discuss') && IMPLEMENTATION_KEYWORDS.test(instruction)) {
    return 'code';
  }
  return phaseType;
}
```

`IMPLEMENTATION_KEYWORDS` 是 `/实现|开发|编写|修改|implement|build|write|code|create|fix|develop|modify/i`。像 "fix the gap"、"code discovery" 这样的探索性指令也会匹配 `fix` 和 `code`。

**解决方案**：收窄关键词匹配——仅匹配**明确的实现意图短语**，而非单个动词。

**文件**: `src/god/god-prompt-generator.ts`

**变更**：将 `IMPLEMENTATION_KEYWORDS` 从单词级匹配改为短语级匹配（第 74 行）：

```typescript
// 原代码:
const IMPLEMENTATION_KEYWORDS = /实现|开发|编写|修改|implement|build|write|code|create|fix|develop|modify/i;

// 修改为:
const IMPLEMENTATION_KEYWORDS = /实现(?:这个|该|以下|功能|方案)|开发(?:功能|模块)|编写(?:代码|实现)|修改(?:代码|实现|文件)|implement\s+(?:the|this|a)|build\s+(?:the|this|a)|write\s+(?:the|this|code)|(?:create|fix|develop|modify)\s+(?:the|this|a)\s+(?:code|implementation|feature|function|module)/i;
```

**替代方案（更保守）**：完全移除自动覆盖，改为让 God 在 `send_to_coder` 时显式指定 `effectiveType`。但这需要修改 GodDecisionEnvelope schema，变更范围更大。上述短语级匹配是最小改动。

---

## 验收标准

### AC-1: Reviewer 原文注入

- [ ] 当 God 在 post-reviewer 路由后将任务发回 Coder 时，Coder prompt 包含 `## Reviewer Feedback (Round N)` 段落
- [ ] 该段落内容为 `stripToolMarkers()` 清洗后的 Reviewer 原始输出
- [ ] 段落位置在 `## God Instruction` 之后、`## Required Fixes` 之前

### AC-2: 过期反馈隔离

- [ ] 当 God 在查看 Coder 输出后直接将任务发回 Coder（coder→coder 重试），Coder prompt **不包含** Reviewer Feedback 段落
- [ ] `isPostReviewerRouting` 标志位正确反映 `lastWorkerRoleRef.current === 'reviewer'`

### AC-3: God 行为更新

- [ ] God 的 `REVIEWER_HANDLING_INSTRUCTIONS` 包含 auto-forwarding 说明
- [ ] God 的 `send_to_coder.message` 在 post-reviewer 场景下聚焦路由指导，不再重复 Reviewer 分析内容

### AC-4: unresolvedIssues 管道修复

- [ ] `extractBlockingIssues()` 函数能从 Reviewer 输出中提取阻塞问题
- [ ] `lastUnresolvedIssuesRef` 在 God post-reviewer routing 时被正确填充
- [ ] Coder prompt 中的 `## Required Fixes` 段落在有阻塞问题时正确渲染

### AC-5: 遗留格式清理

- [ ] `god-system-prompt.ts` 中移除 POST_CODER/POST_REVIEWER/CONVERGENCE/AUTO_DECISION 格式
- [ ] 保留 TASK_INIT 格式（task classification 专用）
- [ ] 更新 `audit-bug-regressions.test.ts` 第 496-529 行的 2 个遗留格式断言测试
- [ ] 验证 `bug-15-16-17-18-regression.test.ts` 第 437-446 行的 `god_override`/`system_log` 测试仍通过
- [ ] 现有测试全部通过

### AC-6: adapter_unavailable 上下文保留 (Change 5)

- [ ] `reviewerFeedbackPendingRef` 在 Reviewer 完成时设为 `true`
- [ ] `reviewerFeedbackPendingRef` 在 Coder 成功产出 `work_output` 时设为 `false`
- [ ] `reviewerFeedbackPendingRef` 在 phase transition 和 accept_task 时设为 `false`
- [ ] Coder adapter_unavailable 后重试时，`isPostReviewerRouting` 为 `true`，Reviewer 原文被注入
- [ ] Coder 成功完成后再次路由时，`isPostReviewerRouting` 为 `false`

### AC-7: meta_output verdict marker 保护 (Change 6)

- [ ] Reviewer 输出包含 `[APPROVED]` 或 `[CHANGES_REQUESTED]` 且包含 "I cannot" 时，**不被**分类为 `meta_output`
- [ ] Reviewer 输出仅包含 "I cannot" 且无 verdict marker 时，仍被分类为 `meta_output`
- [ ] Coder 输出包含 "I cannot" 时，仍被分类为 `meta_output`（不受保护）

### AC-8: auth_failed 实质内容保护 (Change 7)

- [ ] Coder 输出包含 auth 关键词但去除工具标记后有 500+ chars 实质内容时，**不被**分类为 `auth_failed`
- [ ] Coder 输出仅有 auth 错误信息（< 500 chars 实质内容）时，仍被分类为 `auth_failed`

### AC-9: explore 阶段 effectiveType 保护 (Change 8)

- [ ] explore 阶段中 God instruction 包含 "fix the gap" 时，`effectiveType` 保持 `explore`
- [ ] explore 阶段中 God instruction 包含 "implement the fix" 时，`effectiveType` 切换为 `code`

### AC-10: 测试覆盖

- [ ] `generateCoderPrompt()` 新增测试：post-reviewer routing 时包含 Reviewer Feedback 段落
- [ ] `generateCoderPrompt()` 新增测试：coder→coder retry 时不包含 Reviewer Feedback 段落
- [ ] `generateCoderPrompt()` 新增测试：adapter_unavailable 后重试时 `reviewerFeedbackPending` 触发注入
- [ ] `extractBlockingIssues()` 新增测试：各种 Reviewer 输出格式的阻塞问题提取
- [ ] `classifyType()` 新增测试：reviewer 含 verdict marker + "I cannot" 不误判为 meta_output
- [ ] `classifyType()` 新增测试：coder 含 auth keyword + 大量实质内容不误判为 auth_failed
- [ ] `resolveEffectiveType()` 新增测试：explore 阶段 "fix the gap" 不触发 code 覆盖
- [ ] `REVIEWER_HANDLING_INSTRUCTIONS` 更新后的内容验证
- [ ] 回归：所有现有测试通过（2200+ tests）

---

## 影响范围

### 受影响文件

| 文件 | 变更类型 | 影响 |
|------|---------|------|
| `src/god/god-prompt-generator.ts` | 修改 | 新增 `isPostReviewerRouting` 字段、Reviewer Feedback 段落、`extractBlockingIssues()` 函数；收窄 `IMPLEMENTATION_KEYWORDS` (Change 1,2,8) |
| `src/god/god-decision-service.ts` | 修改 | 更新 `REVIEWER_HANDLING_INSTRUCTIONS` 常量 (Change 3) |
| `src/god/god-system-prompt.ts` | 修改 | 移除 4 种遗留决策格式 (Change 4) |
| `src/god/observation-classifier.ts` | 修改 | `classifyType()` 新增 verdict marker 保护 + auth 实质内容保护 (Change 6,7) |
| `src/ui/components/App.tsx` | 修改 | 传入 `isPostReviewerRouting`，填充 `lastUnresolvedIssuesRef`，新增 `reviewerFeedbackPendingRef` (Change 1,2,5) |
| `src/__tests__/god/god-prompt-generator.test.ts` | 修改 | 新增 Reviewer Feedback 注入、adapter retry、explore effectiveType 测试 |
| `src/__tests__/god/observation-classifier.test.ts` | 修改 | 新增 verdict marker 保护、auth 实质内容保护测试 (Change 6,7) |
| `src/__tests__/god/audit-bug-regressions.test.ts` | 修改 | 更新第 496-529 行的 2 个测试（`test_regression_r2_bug1_post_coder_actions_match_schema`、`test_regression_r2_bug1_post_reviewer_actions_match_schema`），这些测试断言 `buildGodSystemPrompt` 输出包含 POST_CODER/POST_REVIEWER 的 action names，移除格式后需要删除或改写这些断言 |
| `src/__tests__/engine/bug-15-16-17-18-regression.test.ts` | 修改 | 更新第 437-446 行的测试（`god system prompt mentions god_override system_log constraint`），该测试断言 prompt 包含 `god_override` 和 `system_log`——由于更新后的 Rules 部分仍保留这些关键词，此测试**可能仍然通过**，但需验证 |

### 不受影响的路径

- **Task classification** (`buildGodSystemPrompt` + TASK_INIT)：保持不变
- **Reviewer prompt 生成** (`generateReviewerPrompt`)：保持不变
- **God 统一决策路径** (`GodDecisionService.makeDecision`)：SYSTEM_PROMPT 格式不变，仅更新指令文本
- **Watchdog 错误恢复**：保持不变
- **Observation classification** (`observation-classifier.ts`)：Change 6/7 修改了 `classifyType()` 逻辑，但仅添加了保护性 guard，不影响正常分类路径

### 向后兼容性

本变更完全向后兼容：
- `isPostReviewerRouting` 是可选字段，默认 `undefined`（等同 `false`），不传时行为与当前一致
- `reviewerFeedbackPendingRef` 默认 `false`，不影响首轮行为
- `extractBlockingIssues()` 返回空数组时，`Required Fixes` 段落不渲染，行为与当前一致
- God SYSTEM_PROMPT 更新是指令文本变更，不影响 GodDecisionEnvelope schema
- 遗留格式清理仅影响 `buildGodSystemPrompt()`，不影响统一决策路径
- Observation classifier 变更为**缩小误判范围**（添加保护性 guard），不会将之前正确分类的输出重新分类
- `IMPLEMENTATION_KEYWORDS` 收窄为短语级匹配，之前被正确覆盖的场景仍会被匹配

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Reviewer 输出过长导致 Coder prompt 超出 token 限制 | Coder 收到截断的 prompt | 当前 God prompt 已接受全量 Reviewer 输出（`buildObservationsSection`），Coder prompt 添加同等长度文本不会额外超限。如未来需要限制，可添加 truncation 逻辑 |
| `extractBlockingIssues()` 正则匹配率不高 | `Required Fixes` 段落仍为空 | 这是增量改进——即使提取失败，Coder 仍能从 Reviewer Feedback 原文段落中获取完整信息 |
| 遗留格式移除影响未知调用方 | task classification 以外的场景出错 | 实现前需搜索 `buildGodSystemPrompt` 所有调用点，确认仅用于 task classification |
| God 仍然在 message 中重复 Reviewer 内容 | Coder prompt 冗余 | prompt 指令已明确告知 God 不要重复，但 LLM 行为无法 100% 保证；这是 soft guidance，退化场景仅为冗余而非错误 |
| Coder incident 后 `lastWorkerRoleRef` 残留为 `'reviewer'` | 下一轮 Coder 启动时 `isPostReviewerRouting` 误判为 `true`，注入过期 Reviewer 反馈 | Change 5 的 `reviewerFeedbackPendingRef` 已解决此问题——pending 在 Coder 成功完成后清除，phase transition / accept_task 时也清除 |
| `reviewerFeedbackPendingRef` 在多轮 coder retry 中持续为 `true` | 同一份 Reviewer 反馈被反复注入 | 预期行为——只要 Coder 没有成功消费反馈，就应该持续注入。一旦 Coder 产出 work_output，pending 被清除 |
| verdict marker 保护可能放过真正的 AI 拒绝 | Reviewer 输出类似 "I cannot do this task [CHANGES_REQUESTED]" 被当作正常 review | 极低概率。真正的 AI 拒绝不会包含结构化的 `[APPROVED]`/`[CHANGES_REQUESTED]` verdict marker。即使误判，退化结果为 God 收到无意义 review 后做出修正性路由 |
| auth 实质内容阈值 (500 chars) 过高或过低 | 过高：真正 auth 失败但附带长错误栈不被捕获；过低：MCP 杂音仍触发 auth_failed | 500 chars 基于观察——真正 auth 失败 < 200 chars，有效工作输出 > 1000 chars。可在实际运行中调整阈值 |
| `IMPLEMENTATION_KEYWORDS` 收窄后，God 无法通过 instruction 触发 explore→code 升级 | 部分应该升级为 code 的场景未被触发 | 短语级匹配仍覆盖明确意图（"implement the fix"），仅排除意外匹配（"fix the gap"、"code discovery"）。如 God 需要明确升级，可使用 `set_phase` action 切换到 code 阶段 |
