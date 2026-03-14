# 决策引擎模块

> 源文件: `src/decision/choice-detector.ts` | `src/decision/convergence-service.ts`
>
> 需求追溯: FR-005 (AC-016 ~ AC-019), FR-006 (AC-020 ~ AC-023)

---

## 1. 模块概览

决策引擎负责两个核心判断：

- **Choice Detector** — 检测 LLM 输出中的选择题/提问模式，自动路由给对方 LLM 决策，确保工作流不因提问而中断。
- **Convergence Service** — 分析 Reviewer 输出，判定收敛状态（通过 / 需修改 / 循环），决定是否终止迭代。

---

## 2. Choice Detector

### 2.1 设计策略

采用**两层防线**：

1. **系统 prompt 层（预防）**：在 Coder/Reviewer prompt 中注入"不要提问，自主决策"的指令，从源头避免 LLM 提出选择题。
2. **Regex 检测层（兜底）**：当 LLM 仍然输出选择题格式内容时，`ChoiceDetector` 通过正则表达式拦截并自动代为决策。

### 2.2 检测条件

`detect(text)` 返回 `ChoiceDetectionResult`，**必须同时满足两个条件才触发**：

1. 存在**问题行** — 以 `?` / `？` 结尾，或包含选择引导词。
2. 存在**选项列表** — 至少 2 个匹配的选项。

检测前会先过滤 `` ``` `` 包围的代码块内容，避免将代码中的注释或字符串误判为选择题。

### 2.3 问题行识别

两类正则协同工作：

| 模式 | 正则 | 示例 |
|------|------|------|
| 问号结尾 | `/^.+[?？]\s*$/` | `你更倾向哪种方案？` |
| 选择引导词 | `/\b(options?\|choose\|prefer\|which\|pick\|select\|方案\|选择\|哪[个种])\b/i` | `以下是两个方案：` |

扫描所有非代码块行，记录**最后一个**匹配的问题行及其行号。

### 2.4 支持的选项模式

| 模式 | 正则 | 示例 |
|------|------|------|
| A/B/C 点号或括号 | `/^([A-C])[.)]\s*(.+)/` | `A. 使用 React` |
| A/B/C 冒号 | `/^([A-C])[:：]\s*(.+)/` | `A: 使用 Redux` |
| 数字编号 | `/^(\d)[.)]\s*(.+)/` | `1. 方案一` |
| 中文方案 | `/^方案([一二三...]+)[：:.]?\s*(.+)/` | `方案一：使用 Redux` |
| Option N | `/^Option\s+(\d+)[：:.]\s*(.+)/i` | `Option 1: Use hooks` |
| Bullet 列表 | `/^[-•*]\s+(.+)/` | `- 使用 Context API` |

**Bullet 列表的特殊处理**：仅在问题行之后出现、且长度 < 120 字符时才视为选项，避免将正常段落误判为选择题。

选项搜索范围：从问题行前 2 行到文本末尾。

### 2.5 Forward Prompt

`buildForwardPrompt(result, taskContext)` 生成转发给对方 LLM 的决策 prompt：

```
Task: <任务上下文>

A decision is needed:
<原始问题>

Choices:
1. <选项1>
2. <选项2>
...

Reply with ONLY: the choice number, then one sentence of reasoning.
只回复：选项编号 + 一句话理由。不要提问。
```

核心约束：
- 提供任务上下文，让对方 LLM 有足够信息做出判断。
- 统一编号格式列出所有选项。
- 要求对方 LLM **只返回编号 + 一句话理由**，不允许反问，确保决策链路不发散。
- 问题文本缺失时使用 `(no question text)` 作为兜底。

### 2.6 无状态设计

`ChoiceDetector` 不维护任何对话历史或内部状态，可在工作流任意节点复用。

---

## 3. Convergence Service

### 3.1 分类体系

`classify(output)` 将 Reviewer 输出分为三类（按优先级）：

| Classification | 触发条件 | 含义 |
|----------------|---------|------|
| `approved` | 输出中包含 `[APPROVED]` marker | 正式通过 |
| `soft_approved` | 无 blocking issue + 无 `[CHANGES_REQUESTED]` + 匹配 soft approval 短语 | 语义通过（Reviewer 表达了认可但忘记标记） |
| `changes_requested` | 其他所有情况 | 需要继续修改（默认分类） |

**关键设计**：只有显式的 `[APPROVED]` marker 才是正式通过。这是保守策略，避免 Reviewer 的客套话被误判为通过。

### 3.2 Soft Approval 模式

以下模式触发 `soft_approved`（需同时无 blocking issue 且无 `[CHANGES_REQUESTED]`）：

**英文**：
- `LGTM`、`looks good to me`
- `no (more) issues/problems/concerns/changes`
- `all issues resolved/fixed/addressed`
- `ship it`、`ready to merge/ship/deploy`
- `nothing (else) to fix/change/address`

**中文**：
- `代码已通过`
- `没有(更多)问题/意见/修改`
- `所有问题已修复/解决/处理`
- `可以合并/提交/部署`
- `非常好`

### 3.3 Blocking Issue 计数

`countBlockingIssues(output)` 采用两级策略：

1. **结构化输出**（优先）：匹配 `Blocking: N` 格式行（由 Reviewer prompt template 要求产出）。匹配到后直接返回 N，不再做 heuristic 计数。
2. **Heuristic fallback**：统计 `**Blocking**`、`**Bug**`、`**Error**`、`**Missing**`、`**Issue**`、`**Problem**` 等 marker 出现次数，减去 `**Non-blocking**` 的数量，下限为 0。

### 3.4 终止条件

`evaluate(reviewerOutput, ctx)` 返回 `ConvergenceResult`，按优先级检查以下终止条件：

| 优先级 | Reason | 条件 | shouldTerminate |
|--------|--------|------|-----------------|
| 1 | `approved` | `[APPROVED]` marker | true |
| 2 | `soft_approved` | Soft approval 模式匹配 | true |
| 3 | `max_rounds` | `currentRound >= maxRounds`（默认 20） | true |
| 4 | `loop_detected` | Loop detection 触发 | true |
| 5 | `diminishing_issues` | blocking count = 0 + trend = improving + 无 `[CHANGES_REQUESTED]` + 至少 2 轮 | true |
| — | `null` | 以上均不满足 | false（继续迭代） |

`maxRounds` 默认值为 20，可通过 `ConvergenceServiceOptions` 配置。

### 3.5 Loop Detection

`detectLoop(current, previousOutputs)` 通过关键词相似度检测重复反馈模式：

**规则一：近期匹配** — 当前输出与最近 4 轮中任意一轮相似度 >= 阈值 → 判定为循环。

**规则二：周期性模式** — 历史至少 3 轮时，当前输出与最近 8 轮中 2 轮以上相似 → 判定为循环。

**相似度算法**：基于关键词的 Jaccard similarity，阈值 `SIMILARITY_THRESHOLD = 0.45`。

#### 关键词提取

`extractKeywords(text)` 实现双语关键词提取：

**英文处理**：
- 小写化 → 按非字母数字拆分 → 过滤长度 < 3 的词。
- 过滤 stop words：the, this, that, with, from, have, been, was, were, are, for, and, but, not 等。

**中文处理**：
- 提取 CJK 字符（`\u4e00-\u9fff` 范围）。
- 生成 bigram（2 字符滑动窗口）用于语义匹配。
- 同时保留有意义的单字符。
- 过滤中文 stop words：的、了、在、是、我、有、和、就、不 等。

这种双语提取确保了中英文混合输出的循环检测能力。

### 3.6 Progress Trend

`detectProgressTrend(currentIssueCount, previousOutputs)` 对比当前和最近 3 轮的 blocking issue 数量：

| Trend | 条件 |
|-------|------|
| `improving` | 当前 issue 数 < 上轮，或从 >0 降到 0 |
| `stagnant` | 当前 issue 数 = 上轮且 >0 |
| `unknown` | 无历史数据或不满足上述条件 |

Trend 信息用于 `diminishing_issues` 终止条件的判断，同时可供 UI 展示迭代进展。

### 3.7 评估结果接口

```typescript
interface ConvergenceResult {
  classification: 'approved' | 'soft_approved' | 'changes_requested';
  shouldTerminate: boolean;
  reason: 'approved' | 'soft_approved' | 'max_rounds'
        | 'loop_detected' | 'diminishing_issues' | null;
  loopDetected: boolean;
  issueCount: number;
  progressTrend: 'improving' | 'stagnant' | 'unknown';
}
```

---

## 4. 协作流程

```
LLM 输出文本
    │
    ├─── ChoiceDetector.detect()
    │       │
    │       ├─ detected: false → 继续正常流程
    │       │
    │       └─ detected: true
    │               │
    │               ▼
    │           buildForwardPrompt()
    │               │
    │               ▼
    │           转发给对方 LLM 决策
    │               │
    │               ▼
    │           用决策结果替换原始选择题
    │               │
    │               ▼
    │           回到正常流程
    │
    └─── ConvergenceService.evaluate()（仅 Reviewer 输出）
            │
            ├── shouldTerminate: true
            │       │
            │       ├── reason: approved          → 工作流完成
            │       ├── reason: soft_approved     → 工作流完成
            │       ├── reason: max_rounds        → 工作流完成（附带警告）
            │       ├── reason: loop_detected     → 工作流完成（附带警告）
            │       └── reason: diminishing_issues → 工作流完成
            │
            └── shouldTerminate: false → 继续下一轮 Coder → Reviewer 循环
```

---

## 5. 关键设计决策

| 决策 | 理由 |
|------|------|
| 只认 `[APPROVED]` marker | 保守策略，避免 Reviewer 客套话误判为通过 |
| Soft approval 作为补充 | 兜底处理 Reviewer 忘记标记但明确表达认可的情况 |
| Jaccard similarity + 双语 bigram | 轻量级相似度计算，无需 embedding 模型，支持中英文混合场景 |
| 阈值 0.45 | 平衡灵敏度与误报率，低于此值的输出通常包含足够的新信息 |
| Bullet 列表长度限制 120 | 避免将正常代码描述段落误判为选择题选项 |
| 代码块过滤 | 防止代码注释中的问号/列表触发误检测 |
| 默认 maxRounds = 20 | 防止无限迭代，可通过配置覆盖 |
| Diminishing issues 至少 2 轮 | 避免首轮就因 issue = 0 误终止 |
| 双层 issue 计数 | 优先使用结构化 `Blocking: N` 输出，heuristic 仅作 fallback |
| ChoiceDetector 无状态 | 不维护历史，可在任意节点复用，降低耦合 |
