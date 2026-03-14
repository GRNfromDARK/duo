# 会话管理模块

> 源文件: `src/session/session-starter.ts` | `src/session/session-manager.ts` | `src/session/context-manager.ts`
>
> 需求追溯: FR-001 (AC-001 ~ AC-004), FR-002 (AC-005 ~ AC-008), FR-003 (AC-009 ~ AC-011)

---

## 1. 模块概览

会话管理模块负责 Duo 会话的完整生命周期：**创建与校验** (`session-starter`) → **持久化与恢复** (`session-manager`) → **Prompt 构建** (`context-manager`)。三者协作确保会话状态在进程崩溃后仍可恢复，并为 Coder / Reviewer LLM 提供结构化的 prompt。

---

## 2. Session Starter

### 2.1 CLI 参数解析

`parseStartArgs(argv)` 从命令行 argv 中提取 `StartArgs`：

| 参数 | 说明 |
|------|------|
| `--dir` | 项目目录（默认 `process.cwd()`） |
| `--coder` | Coder CLI 名称（必填） |
| `--reviewer` | Reviewer CLI 名称（必填） |
| `--god` | God adapter 名称（可选） |
| `--task` | 任务描述（必填） |

### 2.2 项目目录校验

`validateProjectDir(dir)` 执行两级检查：

1. **可访问性** — 通过 `fs.access(R_OK)` 验证目录存在且可读。
2. **Git 仓库** — 调用 `git rev-parse --is-inside-work-tree`。非 Git 目录不会报错，但会产生 warning（部分 CLI 如 Codex 要求 Git 仓库）。

### 2.3 CLI 选择校验

`validateCLIChoices(coder, reviewer, detected, god?)` 保证：

- Coder 和 Reviewer **不能是同一个** CLI 工具。
- 每个角色对应的 CLI 必须已注册 (`DetectedCLI[]`) 且已安装。
- 若指定 `--god`，验证其为受支持的 God adapter（当前支持 `claude-code`、`codex`）。

### 2.4 SessionConfig 创建

`createSessionConfig(args, detected)` 是入口函数，串联上述校验后返回 `StartResult`：

- 校验通过 → `config` 包含完整的 `SessionConfig`（projectDir / coder / reviewer / god / task）。
- 校验失败 → `config` 为 `null`，`validation.errors` 包含所有错误信息。
- 始终返回 `detectedCLIs`（已安装的 CLI 名称列表），供 UI 展示。

God adapter 解析由 `resolveGodAdapterForStart` 处理，失败时追加 error。

---

## 3. Session Manager

### 3.1 `.duo/` 目录结构

```
.duo/
├── sessions/
│   └── <uuid>/
│       ├── snapshot.json      ← 权威源：metadata + state 合并快照
│       ├── history.jsonl      ← 对话历史（append-only，每行一条 JSON）
│       ├── session.json       ← Legacy：仅 metadata
│       ├── state.json         ← Legacy：仅 state
│       └── history.json       ← Legacy：JSON 数组格式
└── prompts/                   ← 自定义 Prompt 模板（可选）
    ├── coder.md
    └── reviewer.md
```

**新会话同时写入新格式和 Legacy 文件**，以保证过渡期的向后兼容。读取时优先使用 `snapshot.json` / `history.jsonl`，不存在时自动 fallback 到 Legacy 文件。

### 3.2 核心数据模型

**SessionMetadata** — 不可变元信息：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | UUID |
| `projectDir` | `string` | 项目目录路径 |
| `coder` | `string` | Coder CLI 名称 |
| `reviewer` | `string` | Reviewer CLI 名称 |
| `god` | `string?` | God adapter 名称 |
| `task` | `string` | 任务描述 |
| `createdAt` | `number` | 创建时间戳 |
| `updatedAt` | `number` | 最后更新时间戳 |

**SessionState** — 可变运行状态：

| 字段 | 类型 | 说明 |
|------|------|------|
| `round` | `number` | 当前轮次 |
| `status` | `string` | 会话状态 |
| `currentRole` | `string` | 当前执行角色 |
| `coderSessionId` | `string?` | Coder adapter 的 CLI session ID |
| `reviewerSessionId` | `string?` | Reviewer adapter 的 CLI session ID |
| `godSessionId` | `string?` | Legacy God session ID（运行时恢复已禁用） |
| `godTaskAnalysis` | `GodTaskAnalysis?` | God 任务分析（首轮写入，FR-011） |
| `godConvergenceLog` | `ConvergenceLogEntry[]?` | God 收敛日志（每轮追加，摘要限 200 字符） |
| `degradationState` | `DegradationState?` | God 降级状态（用于 resume） |
| `currentPhaseId` | `string \| null?` | 复合任务当前阶段 ID |

**HistoryEntry** — 单条对话记录：`round`, `role`, `content`, `timestamp`。

### 3.3 Atomic Writes（原子写入）

`atomicWriteSync(filePath, data)` 实现写入安全：

1. 先写入 `<filePath>.tmp` 临时文件。
2. 调用 `fs.renameSync` 将 `.tmp` 原子替换目标文件。
3. Windows 兼容：`rename` 失败时先 `unlink` 再重试。

所有 `saveState` 和 `addHistoryEntry`（Legacy 部分）调用都通过此函数，确保即使进程在写入过程中崩溃，文件也不会处于半写状态。

### 3.4 Monotonic Timestamp

`monotonicNow()` 保证同一 Manager 实例内时间戳严格递增。当同一毫秒内多次调用时，自动 +1，避免排序冲突。实现：`this._lastTs = Math.max(now, this._lastTs + 1)`。

### 3.5 会话创建

`createSession(config)` 流程：

1. 生成 UUID 作为 session ID。
2. 创建 `.duo/sessions/<id>/` 目录。
3. 写入 `snapshot.json`（atomic）+ 空 `history.jsonl`。
4. 同时写入 Legacy 文件（`session.json` / `state.json` / `history.json`）。
5. 初始状态：`round=0, status='created', currentRole='coder'`。

### 3.6 状态更新

`saveState(sessionId, partialState)` 采用 merge 语义：

1. 加载当前 snapshot。
2. 将 `partialState` 浅合并到 `state`。
3. 更新 `metadata.updatedAt`。
4. Atomic write `snapshot.json` + Legacy 文件。

### 3.7 历史追加

`addHistoryEntry(sessionId, entry)` 使用 append-only 策略：

- **JSONL 格式**：直接 `fs.appendFileSync`，无需读-改-写，天然避免竞态。
- **Legacy 迁移**：如果 `history.jsonl` 不存在但 `history.json` 存在，首次追加时自动迁移。
- 同时更新 Legacy `history.json`（通过 atomic write）保持向后兼容。

### 3.8 会话加载与恢复

`loadSession(sessionId)` 返回完整的 `LoadedSession`（metadata + state + history）。

**Snapshot 加载优先级**：`snapshot.json` → Legacy `session.json` + `state.json`。通过 `isValidSnapshot` type guard 做结构校验。

**History 加载优先级**：`history.jsonl` → Legacy `history.json`。

**恢复校验**：`validateSessionRestore(sessionId)` 检查项目目录是否仍然存在。

### 3.9 会话列表

`listSessions()` 扫描 sessions 目录，跳过损坏的子目录，按 `updatedAt` 降序排列返回 `SessionSummary[]`。

### 3.10 错误类型

| 错误类 | 触发条件 |
|--------|---------|
| `SessionNotFoundError` | session 目录不存在 |
| `SessionCorruptedError` | snapshot 或 history 数据损坏（包装原始异常为 `cause`） |

---

## 4. Context Manager

### 4.1 Prompt Template 系统

Context Manager 在初始化时加载两套 prompt template：

- **Coder template** — 从 `.duo/prompts/coder.md` 加载，不存在时使用内置默认模板。
- **Reviewer template** — 从 `.duo/prompts/reviewer.md` 加载，同上。

`.duo/prompts/` 目录路径通过 `ContextManagerOptions.promptsDir` 配置，默认值由 `getDefaultTemplatesDir()` 返回。

### 4.2 resolveTemplate 机制

`resolveTemplate(template, vars)` 采用**单次正则替换**策略：

```typescript
template.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match)
```

核心设计：一次遍历完成所有占位符替换，替换值中包含的 `{{...}}` **不会被二次解析**，避免注入风险。未匹配的占位符保持原样。

支持的占位符：

| Coder Template | Reviewer Template |
|----------------|-------------------|
| `{{task}}` | `{{task}}` |
| `{{history}}` | `{{history}}` |
| `{{reviewerFeedback}}` | `{{coderOutput}}` |
| `{{interruptInstruction}}` | `{{interruptInstruction}}` |
| — | `{{roundNumber}}` |
| — | `{{previousFeedbackChecklist}}` |

### 4.3 Coder Prompt 构建

`buildCoderPrompt(task, rounds, opts?)` 生成 Coder 的系统 prompt：

- 注入任务描述、历史记录、Reviewer 反馈。
- 核心指令：**不要提问，自主决策，直接实现**。
- 要求 Coder 逐一处理 Reviewer 指出的问题并简要说明修复内容。
- 可通过 `skipHistory` 跳过历史注入，通过 `interruptInstruction` 注入中断指令。

### 4.4 Reviewer Prompt 构建

`buildReviewerPrompt(task, rounds, coderOutput, opts?)` 生成 Reviewer 的系统 prompt：

- 包含当前轮次编号 `roundNumber`（默认为 `rounds.length + 1`）。
- 注入上一轮 Reviewer 反馈的结构化 checklist（`previousFeedbackChecklist`）。
- 要求 Reviewer 产出固定格式：Progress Checklist → New Issues → Blocking Count → Verdict。
- Verdict 只能是 `[APPROVED]` 或 `[CHANGES_REQUESTED]`。
- 明确禁止因非阻塞性建议而拒绝通过。
- 审查范围限定：只针对任务要求审查，不审查无关已有代码；不重复提出已修复的问题。

### 4.5 Previous Feedback Checklist

当存在上一轮 Reviewer 输出时，`buildPreviousFeedbackChecklist` 从中提取结构化问题列表：

1. `extractGroupedIssues` 解析 Reviewer 输出，识别编号问题组（Location / Problem / Fix）和 bullet 问题项。
2. 跳过代码块、heading、verdict marker、`Blocking: N` 计数行。
3. 将多行问题组合并为 `[classification] location — problem` 格式。
4. 注入为 checklist，要求 Reviewer 在新一轮逐项标注 `[x] Fixed` 或 `[ ] Still open`。

### 4.6 历史区段构建

`buildHistorySection(rounds)` 实现 **sliding window** 策略：

- **最近 3 轮**（`RECENT_ROUNDS_COUNT=3`）：完整内容（Coder + Reviewer 原文）。
- **更早轮次**：使用 summary 压缩（已有 `summary` 字段或即时调用 `generateSummary` 生成）。

### 4.7 Summary 生成

`generateSummary(text)` 在文本超过 200 token（约 800 字符）时压缩：

1. 优先尝试 `extractKeyPoints` — 提取 verdict marker、blocking/non-blocking 分类行、编号问题项、修复状态 header。
2. 提取结果仍超长时，按完整字符（`Array.from()` 避免断裂多字节序列）截断并追加 `...`。

### 4.8 Token Budget 控制

`enforceTokenBudget(prompt)` 确保最终 prompt 不超过 context window 的 80%：

- 估算公式：`maxChars = contextWindowSize * 4 * 0.8`（1 token ≈ 4 字符）。
- 超出时按完整字符截断（`Array.from()` 保护多字节序列）。

---

## 5. Crash Consistency 策略

Duo 采用 **snapshot 为权威源** 的崩溃恢复策略：

| 机制 | 说明 |
|------|------|
| **Atomic write (write-tmp-rename)** | `snapshot.json` 崩溃时要么是旧版本完整数据，要么是新版本完整数据，不会出现半写状态 |
| **JSONL append-only** | `history.jsonl` 使用 `appendFileSync` 逐行追加，不存在 read-modify-write 竞态 |
| **最后一行容错** | JSONL 最后一行若 JSON 解析失败或结构不合法，视为崩溃残留，仅跳过并打印 warning |
| **中间行严格** | 文件中间行出现损坏则抛出 `SessionCorruptedError`，不容忍非尾部数据损坏 |
| **Legacy 双写** | 过渡期同时维护旧格式文件，但加载优先读取新格式。即使旧格式文件损坏，新格式完整即可恢复 |
| **Monotonic timestamp** | `monotonicNow()` 确保时间戳严格递增，避免时钟回拨导致的排序异常 |
| **Type guard 校验** | `isValidSnapshot` / `isValidHistoryEntry` 在加载时验证数据结构完整性 |

---

## 6. 关键设计决策

| 决策 | 理由 |
|------|------|
| Atomic write + rename | 防止进程崩溃导致文件半写损坏 |
| JSONL append-only history | 避免 read-modify-write 竞态，对长会话友好 |
| 单次 resolveTemplate | 防止模板注入，替换值中的 `{{}}` 不被二次解析 |
| Legacy 双写 | 过渡期向后兼容，读取优先新格式 |
| 多字节安全截断 | `Array.from(text)` 按 code point 截断，保护 CJK 字符 |
| 近 3 轮完整 + 旧轮摘要 | 平衡上下文信息量与 token 预算 |
| 80% budget ratio | 为 LLM 回复和系统开销预留 20% 空间 |
