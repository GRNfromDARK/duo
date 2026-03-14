# UI 状态管理模块

> 路径：`src/ui/*.ts`（不含 `components/`）

## 设计理念

Duo 的 UI 状态层遵循 **纯函数提取** 原则：

1. **所有状态计算都是纯函数** — 接受当前状态 + 事件参数，返回新状态，无副作用
2. **组件只做胶水** — React 组件通过 `useState` 持有状态，调用纯函数计算下一个状态
3. **可独立单测** — 每个模块均可脱离 Ink/React 运行测试，无需 DOM 或 TUI 环境

这一设计与 `InputArea.processInput`、`DirectoryPicker.processPickerInput` 等组件级纯函数保持一致，形成统一的 "state -> pure fn -> new state" 模式。

整个 UI 状态层共 **19 个模块**，分为两组：
- **Core UI 状态**（10 个）— 通用 UI 逻辑：滚动、显示模式、快捷键、Overlay、Markdown 解析、流式聚合、消息行计算
- **God LLM UI 状态**（9 个新增）— God 决策层的 UI 状态：escape window、决策 banner、fallback、消息样式、overlay 控制面板、阶段切换、重分类、恢复摘要、任务分析

---

## 模块总览

### Core UI 状态（10 个）

| # | 文件 | 职责 | FR 来源 |
|---|------|------|---------|
| 1 | `scroll-state.ts` | Smart Scroll Lock | FR-016 |
| 2 | `round-summary.ts` | 轮次摘要分隔符 | FR-020 |
| 3 | `display-mode.ts` | Minimal/Verbose 切换 | FR-021 |
| 4 | `directory-picker-state.ts` | 目录选择器逻辑 | FR-019 |
| 5 | `keybindings.ts` | 快捷键映射 | FR-022 |
| 6 | `overlay-state.ts` | Overlay 生命周期 | FR-022 |
| 7 | `markdown-parser.ts` | Markdown 解析 | FR-023 |
| 8 | `git-diff-stats.ts` | Git diff 统计 | FR-026 |
| 9 | `session-runner-state.ts` | 流式聚合与路由决策 | 多 FR |
| 10 | `message-lines.ts` | 消息行数计算与渲染 | — |

### God LLM UI 状态（9 个新增）

| # | 文件 | 职责 | FR 来源 |
|---|------|------|---------|
| 11 | `escape-window.ts` | Legacy escape window 状态 | FR-008 |
| 12 | `god-decision-banner.ts` | God 自动决策 banner 状态 | FR-008 |
| 13 | `god-fallback.ts` | God 调用 retry + degradation 包装 | FR-G01, FR-G04 |
| 14 | `god-message-style.ts` | God 消息视觉样式 | FR-014 |
| 15 | `god-overlay.ts` | God 控制面板 overlay 状态 | FR-015 |
| 16 | `phase-transition-banner.ts` | 阶段切换 banner 状态 | FR-010 |
| 17 | `reclassify-overlay.ts` | 运行时任务重分类 overlay 状态 | FR-002a |
| 18 | `resume-summary.ts` | 恢复摘要构建 | FR-016 |
| 19 | `task-analysis-card.ts` | 任务分析卡片状态 | FR-001a |

---

## Core UI 状态

### 1. scroll-state.ts — Smart Scroll Lock

**来源**: FR-016

智能滚动锁定状态管理。当用户向上滚动阅读历史消息时，自动锁定视口；当新消息到达时显示提示条而非强制滚到底部。

#### 核心类型

```ts
interface ScrollState {
  scrollOffset: number;     // 当前滚动偏移量
  autoFollow: boolean;      // 是否自动跟随新消息
  lockedAtCount: number;    // 锁定时的消息数（-1 表示正在跟随）
}

interface ScrollView {
  effectiveOffset: number;  // 实际渲染偏移
  visibleSlots: number;     // 可见行槽位数
  showIndicator: boolean;   // 是否显示 "新输出" 提示条
  newMessageCount: number;  // 锁定后新增的消息数
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `computeScrollView(state, totalMessages, messageAreaHeight)` | `ScrollState` + 消息总数 + 视口高度 | `ScrollView` | 当 `!autoFollow` 且 `totalMessages > lockedAtCount` 时显示提示条；提示条占 1 行，`visibleSlots` 相应减 1；计算 `newMessageCount = totalMessages - lockedAtCount` |
| `scrollUp(state, lines, totalMessages, messageAreaHeight)` | 当前状态 + 滚动行数 + 布局参数 | `ScrollState` | 关闭 `autoFollow`，首次锁定时记录 `lockedAtCount`；偏移量向 0 方向移动 |
| `scrollDown(state, lines, totalMessages, messageAreaHeight)` | 同上 | `ScrollState` | 到达底部（`next >= maxOffset`）时自动重新启用 `autoFollow`，清除 `lockedAtCount` |
| `jumpToEnd(totalMessages, messageAreaHeight)` | 消息总数 + 视口高度 | `ScrollState` | 立即跳到底部，重新启用 `autoFollow`，`lockedAtCount` 重置为 -1 |

**初始状态**: `INITIAL_SCROLL_STATE` — `autoFollow: true, scrollOffset: 0, lockedAtCount: -1`

---

### 2. round-summary.ts — 轮次摘要分隔线

**来源**: FR-020 (AC-068, AC-069)

在轮次之间插入格式化的分隔线，形如：

```
═══ Round 1→2 · Summary: <摘要文本> ═══
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `formatRoundSummary(fromRound, toRound, summary)` | 起始轮次、目标轮次、摘要文本 | `string` | 总行长度上限 `100` 字符；超长摘要自动截断并添加 `...` |
| `createRoundSummaryMessage(fromRound, toRound, summary)` | 同上 | `Message` | 生成带 `metadata.isRoundSummary: true` 的系统消息，id 格式 `round-summary-{from}-{to}-{uuid8}` |

#### 常量

- `MAX_LINE_LENGTH = 100`
- `PREFIX_TEMPLATE = '═══ Round '`
- `SUFFIX = ' ═══'`
- `SUMMARY_SEPARATOR = ' · Summary: '`

---

### 3. display-mode.ts — Minimal/Verbose 模式切换

**来源**: FR-021 (AC-070, AC-071)

两种显示模式的定义和消息过滤逻辑。

#### 核心类型

```ts
type DisplayMode = 'minimal' | 'verbose';
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `toggleDisplayMode(current)` | `DisplayMode` | `DisplayMode` | `'minimal'` <-> `'verbose'` 切换 |
| `filterMessages(messages, mode)` | `Message[]` + `DisplayMode` | `Message[]` | verbose 模式返回全部；minimal 模式过滤掉 `metadata.isRoutingEvent` 为 true 的消息 |

#### 两种模式对比

| 特性 | Minimal (默认) | Verbose (Ctrl+V) |
|------|---------------|------------------|
| 路由事件 | 隐藏 | 显示 |
| 时间戳 | HH:MM | HH:MM:SS |
| Token 计数 | 隐藏 | 显示 |
| CLI 命令详情 | 隐藏 | 显示 |
| Activity block | 折叠为单行摘要 | 展开详情 |

---

### 4. directory-picker-state.ts — 目录选择器逻辑

**来源**: FR-019 (AC-065, AC-066, AC-067)

为 Setup 阶段的目录选择器提供纯逻辑，与 `scroll-state.ts` 和 `InputArea.processInput` 保持相同的提取模式。

#### 核心类型

```ts
interface PickerState {
  inputValue: string;
  selectedIndex: number;
  items: string[];         // MRU + discovered 合并列表
  mru: string[];
  discovered: string[];
  completions: string[];
  warning: string | null;
}

type PickerAction =
  | { type: 'update_input'; value: string }
  | { type: 'tab_complete' }
  | { type: 'submit'; value: string }
  | { type: 'select'; index: number }
  | { type: 'cancel' }
  | { type: 'noop' };
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `completePath(partial)` | 部分路径字符串 | `string[]` | 展开 `~`，列出匹配的子目录（绝对路径） |
| `isGitRepo(dir)` | 目录路径 | `boolean` | 检查 `.git` 是否存在 |
| `discoverGitRepos(scanDirs)` | 扫描目录列表 | `string[]` | 对 `scanDirs` 中每个目录做单层扫描，返回含 `.git` 的子目录 |
| `loadMRU(filePath)` | JSON 文件路径 | `string[]` | 读取 MRU 列表，文件不存在或无效时返回空数组 |
| `saveMRU(filePath, dirs)` | 文件路径 + 目录列表 | `void` | 自动创建父目录后写入 JSON |
| `addToMRU(current, newDir, maxItems?)` | 当前列表 + 新目录 | `string[]` | 纯函数，移至列表头部，上限 `MRU_MAX_ITEMS = 10` |
| `processPickerInput(state, input, key)` | 选择器状态 + 键盘输入 | `PickerAction` | Tab -> 补全；Escape -> 取消；Enter -> 提交/选择；上下箭头 -> 导航；Backspace -> 删字符；其他字符 -> 追加 |

#### 常量

- `DEFAULT_SCAN_DIRS`: `~/Projects`, `~/Developer`, `~/code`
- `MRU_MAX_ITEMS = 10`

---

### 5. keybindings.ts — 快捷键映射

**来源**: FR-022 (AC-072, AC-073, AC-074)

将键盘输入映射为语义化的 `KeyAction`，根据上下文（Overlay 是否打开、输入框是否为空）决定不同行为。

#### 核心类型

```ts
type OverlayType = 'help' | 'context' | 'timeline' | 'search' | 'god';

type KeyAction =
  | { type: 'scroll_up'; amount: number }
  | { type: 'scroll_down'; amount: number }
  | { type: 'jump_to_end' }
  | { type: 'toggle_display_mode' }
  | { type: 'open_overlay'; overlay: OverlayType }
  | { type: 'close_overlay' }
  | { type: 'clear_screen' }
  | { type: 'new_session' }
  | { type: 'interrupt' }
  | { type: 'reclassify' }
  | { type: 'toggle_code_block' }
  | { type: 'tab_complete' }
  | { type: 'noop' };

interface KeyContext {
  overlayOpen: OverlayType | null;
  inputEmpty: boolean;
  pageSize: number;
}
```

#### `processKeybinding(input, key, ctx)` — 优先级顺序

| 优先级 | 条件 | 快捷键 | 动作 |
|--------|------|--------|------|
| 1 | `key.ctrl` — 始终激活 | Ctrl+C | `interrupt` |
| 1 | | Ctrl+N | `new_session` |
| 1 | | Ctrl+I | toggle `context` overlay |
| 1 | | Ctrl+V | `toggle_display_mode` |
| 1 | | Ctrl+T | toggle `timeline` overlay |
| 1 | | Ctrl+G | toggle `god` overlay |
| 1 | | Ctrl+R | `reclassify` |
| 1 | | Ctrl+L | `clear_screen` |
| 2 | `key.escape` | Esc | `close_overlay`（有 overlay 时）/ `noop` |
| 3 | 输入字符 | `?` | 输入为空时打开 `help` overlay；已在 help 时关闭 |
| 3 | | `/` | 输入为空时打开 `search` overlay |
| 4 | 无 overlay 且输入为空 | `j`/`↓` | `scroll_down` 1 行 |
| 4 | | `k`/`↑` | `scroll_up` 1 行 |
| 4 | | `G` | `jump_to_end` |
| 4 | 无 overlay（不论输入） | PageDown | `scroll_down` pageSize 行 |
| 4 | | PageUp | `scroll_up` pageSize 行 |
| 5 | Enter 且输入为空且无 overlay | Enter | `toggle_code_block` |
| 5 | | Tab | `tab_complete` |

#### 快捷键参考列表 (`KEYBINDING_LIST`)

供 HelpOverlay 使用的完整列表，包含 15 项 `KeybindingEntry`（`shortcut` + `description`）：

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+C` | 中断 LLM（单次）/ 退出（双击） |
| `Ctrl+N` | 新会话 |
| `Ctrl+I` | Context 摘要 Overlay |
| `Ctrl+V` | 切换 Minimal/Verbose |
| `Ctrl+T` | 事件时间线 Overlay |
| `Ctrl+G` | God 控制面板 Overlay |
| `Ctrl+R` | 重分类任务类型 |
| `Ctrl+L` | 清屏（保留历史） |
| `j/k` 或 `↑/↓` | 滚动消息 |
| `G` | 跳至最新消息 |
| `Enter` | 展开/折叠代码块 |
| `Tab` | 路径自动补全 |
| `?` | 帮助 / 快捷键列表 |
| `/` | 搜索消息历史 |
| `Esc` | 关闭 Overlay |

---

### 6. overlay-state.ts — Overlay 生命周期

**来源**: FR-022 (AC-072, AC-073, AC-074)

管理五种 Overlay 的打开/关闭状态和搜索查询。

#### 核心类型

```ts
type OverlayType = 'help' | 'context' | 'timeline' | 'search' | 'god';

interface OverlayState {
  activeOverlay: OverlayType | null;
  searchQuery: string;
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `openOverlay(state, overlay)` | 当前状态 + 要打开的 overlay | `OverlayState` | 打开 search 时清空 `searchQuery` |
| `closeOverlay(state)` | 当前状态 | `OverlayState` | 关闭 overlay 并清空 `searchQuery`；若已无 overlay 则返回原状态 |
| `updateSearchQuery(state, query)` | 当前状态 + 新查询 | `OverlayState` | 仅更新 `searchQuery` |
| `computeSearchResults(messages, query)` | 消息列表 + 查询字符串 | `Message[]` | 大小写不敏感的子串匹配；空查询返回空数组 |

**初始状态**: `INITIAL_OVERLAY_STATE` — `activeOverlay: null, searchQuery: ''`

#### 关键约束

- 任一时刻只能有一个 Overlay 处于打开状态
- 搜索查询在 Overlay 关闭时自动清空

---

### 7. markdown-parser.ts — Markdown 解析

**来源**: FR-023 (AC-076, AC-077)

将 Markdown 文本解析为类型化的 segment 数组，供 `StreamRenderer` 和 `message-lines.ts` 渲染。支持流式场景下未闭合的代码块。

#### 输出类型 `MarkdownSegment`

| type | 字段 | 说明 |
|------|------|------|
| `text` | `content` | 普通文本段落 |
| `code_block` | `content`, `language?` | 围栏代码块（`` ``` ``）；未闭合时也会输出 |
| `activity_block` | `kind`, `title`, `content` | `:::activity`/`:::result`/`:::error` 活动块 |
| `inline_code` | `content` | 行内代码 `` `code` `` |
| `bold` | `content` | `**bold**` |
| `italic` | `content` | `*italic*` |
| `list_item` | `content`, `marker` | 有序 (`1.`) / 无序 (`*`, `-`) 列表项 |
| `table` | `headers`, `rows` | Markdown 表格（需 >=2 行且第二行为分隔符） |

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `parseMarkdown(text)` | Markdown 字符串 | `MarkdownSegment[]` | 逐行状态机：先检测 activity block，再检测围栏代码块，再检测表格、列表项，最后收集连续纯文本并做 inline 解析 |

#### 解析规则

- **Activity block**: 匹配 `/^:::(activity|result|error)\s*(.*)$/`，`:::` 单独一行闭合
- **围栏代码块**: 匹配 `/^```(\w*)$/`，未闭合的块视为仍在流式输出
- **表格**: 要求第二行匹配 `/^\|[\s-:|]+\|$/`（分隔行），否则作为普通文本处理
- **列表**: 无序 `/^([*-]) (.+)$/`，有序 `/^(\d+)\. (.+)$/`
- **内联格式**: 正则 `/(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+?)`)/g` 解析 bold、italic、inline_code

---

### 8. git-diff-stats.ts — Git 变更统计

**来源**: FR-026 (AC-082)

解析 `git diff --stat` 输出的摘要行。

#### 核心类型

```ts
interface GitDiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `parseGitDiffStat(output)` | `git diff --stat` 的输出字符串 | `GitDiffStats` | 正则提取 `N files changed`、`N insertions(+)`、`N deletions(-)`；无匹配时返回全零 |

---

### 9. session-runner-state.ts — 流式聚合与路由决策

**来源**: 多个 FR，是 SessionRunner 组件的核心状态逻辑提取。

这是最复杂的状态模块，包含三大职责：

1. **流式聚合** — 将 adapter 输出的 `OutputChunk` 流逐步聚合为最终文本
2. **路由决策** — 在 Coder/Reviewer 完成后决定下一步转向
3. **会话恢复** — 从持久化的 `LoadedSession` 重建运行时状态

#### 流式聚合

```ts
interface StreamAggregation {
  fullText: string;          // 完整历史文本（含 tool use 记录）
  displayText: string;       // UI 显示文本（含工具摘要头）
  displayBodyText: string;   // 纯正文部分（不含工具摘要头）
  errorMessages: string[];   // 累积的错误消息
  activeToolName: string | null;
  toolUpdateCount: number;
  toolWarningCount: number;
  latestToolSummary: string | null;
}

type StreamOutcome =
  | { kind: 'success'; fullText: string; displayText: string }
  | { kind: 'error'; fullText: string; displayText: string; errorMessage: string }
  | { kind: 'no_output'; fullText: string; displayText: string };
```

| 函数 | 说明 |
|------|------|
| `createStreamAggregation()` | 创建初始聚合状态 |
| `applyOutputChunk(state, chunk)` | 处理一个 chunk：text/code 追加到 fullText 和 displayBodyText；tool_use 格式化为摘要行（对 Bash、Read、Explore 有特殊处理）；tool_result 记录行数或错误；error 追加到 errorMessages |
| `finalizeStreamAggregation(state)` | 根据 errorMessages 和文本内容决定 outcome 类型 |

**工具格式化特殊逻辑**:
- `Bash` -> 提取 `description` 字段，显示为 `Bash: <description>`
- `Read` -> 提取 `file_path`/`path` 并显示文件名，显示为 `Read: Read <filename>`
- `Explore` -> 提取 `description` 字段
- 其他工具 -> JSON 序列化 input

**displayText 构建**: 在正文前添加工具统计摘要行，格式 `⏺ N tool updates · M warnings · latest <summary>`

#### 路由决策

```ts
interface ChoiceRoute {
  source: 'coder' | 'reviewer';
  target: 'coder' | 'reviewer';
  prompt: string;
}

interface RouteDecision {
  event: 'ROUTE_TO_REVIEW' | 'ROUTE_TO_EVALUATE' | 'ROUTE_TO_CODER';
  choiceRoute?: ChoiceRoute;
  clearChoiceRoute?: boolean;
}
```

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `decidePostCodeRoute(output, taskContext, detector, activeChoiceRoute)` | Coder 输出 + 任务上下文 + ChoiceDetector + 当前活跃路由 | `RouteDecision` | 若有来自 reviewer->coder 的 choiceRoute 则清除并转 review；否则检测 choice，若检测到则创建 coder->reviewer 路由；默认转 review |
| `decidePostReviewRoute(output, taskContext, detector, activeChoiceRoute)` | Reviewer 输出 + 同上 | `RouteDecision` | 对称逻辑：若有来自 coder->reviewer 的路由则清除并转 coder；检测到 choice 则创建 reviewer->coder 路由；默认转 evaluate |

#### 用户决策

```ts
type UserDecision =
  | { type: 'confirm'; action: 'accept' | 'continue'; pendingInstruction?: string }
  | { type: 'resume'; input: string; resumeAs: 'coder' | 'reviewer' };
```

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `resolveUserDecision(stateValue, text, lastInterruptedRole)` | 状态机状态值 + 用户输入 + 上次中断角色 | `UserDecision \| null` | `WAITING_USER`/`MANUAL_FALLBACK` 状态：`a`/`accept` -> accept，`c`/`continue` -> continue，其他文本 -> continue + pendingInstruction；`INTERRUPTED` 状态：有文本 -> resume |

#### 会话恢复

```ts
interface RestoredSessionRuntime {
  workflowInput: Partial<WorkflowContext>;
  restoreEvent: RestoreEventType;
  messages: Message[];
  rounds: RoundRecord[];
  reviewerOutputs: string[];
  tokenCount: number;
  coderSessionId?: string;
  reviewerSessionId?: string;
  godTaskAnalysis?: GodTaskAnalysis;
  godConvergenceLog?: ConvergenceLogEntry[];
  degradationState?: DegradationState;
  currentPhaseId?: string | null;
}
```

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `buildRestoredSessionRuntime(loaded, config)` | `LoadedSession` + `SessionConfig` | `RestoredSessionRuntime` | 按时间排序历史记录，转换为 Message 和 RoundRecord，估算 token（4 chars/token），提取 coderSessionId/reviewerSessionId 用于 adapter resume，恢复 God 相关状态（godTaskAnalysis、godConvergenceLog、degradationState、currentPhaseId），根据 `state.status` 映射恢复事件类型 |

**状态恢复映射**:

| 原始 status | RestoreEventType |
|-------------|------------------|
| `created`, `coding` | `RESTORED_TO_CODING` |
| `reviewing`, `routing_post_code` | `RESTORED_TO_REVIEWING` |
| `interrupted` | `RESTORED_TO_INTERRUPTED` |
| `god_deciding`, `manual_fallback`, 其他 | `RESTORED_TO_WAITING` |

---

### 10. message-lines.ts — 消息行数计算与渲染

连接数据层（`Message`）和视图层（MainLayout 行级渲染）的桥梁模块。将 `Message[]` 数组转换为扁平的 `RenderedMessageLine[]` 数组，供 MainLayout 进行滚动窗口切片和逐行渲染。

#### 核心类型

```ts
interface LineSpan {
  text: string;
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
}

interface RenderedMessageLine {
  key: string;          // 唯一 key，格式 `${messageId}-header` / `${messageId}-body-N` / `${messageId}-spacer`
  spans: LineSpan[];    // 一行内的多个样式片段
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `buildRenderedMessageLines(messages, displayMode, columns)` | `Message[]` + `DisplayMode` + 终端列宽 | `RenderedMessageLine[]` | 核心入口：遍历消息列表，每条消息生成 header 行 + body 行 + spacer 行 |
| `wrapText(text, width)` | 文本 + 列宽 | `string[]` | 按终端列宽自动折行，支持 CJK 宽字符（双宽度计算） |

#### 每条消息的行结构

每条 `Message` 被转换为以下行序列：

1. **Header 行** — `${border} [RoleName · RoleLabel] HH:MM`，Verbose 模式下追加 `[Nk tokens]`
2. **CLI Command 行**（可选）— 仅 Verbose 模式下存在 `metadata.cliCommand` 时显示，前缀 `$ `，`dimColor: true`
3. **Body 行** — 消息内容经以下管线处理：
   - `parseMarkdown(content)` -> `MarkdownSegment[]`
   - `segmentsToBlocks(segments, displayMode)` -> `{ lines, style }[]`
   - `wrapText(line, bodyWidth)` -> 折行后的字符串数组
4. **Spacer 行** — 空行，作为消息间分隔

#### 内部函数 `segmentsToBlocks`

将 `MarkdownSegment[]` 转换为带样式的文本块：

| Segment 类型 | 转换规则 |
|-------------|---------|
| `text` / `bold` / `italic` | 合并到当前段落（paragraph），flush 时按 `\n` 分行 |
| `inline_code` | 追加到段落，保留反引号包裹 |
| `list_item` | flush 段落后，`-`/`*` 替换为 `•`，有序列表保留数字标记 |
| `code_block` | flush 段落后，`style: { color: 'cyan' }`，language 存在时在首行添加 `[lang]` |
| `table` | flush 段落后，`style: { dimColor: true }`，headers 和 rows 以 ` \| ` 连接 |
| `activity_block` | flush 段落后，根据 kind 选择图标（`⏺`/`⎿`/`⚠`）和颜色（cyan/gray/red）；Minimal 模式折叠为 `icon title: firstLine`；Verbose 模式展开所有内容行 |

#### 辅助函数

| 函数 | 说明 |
|------|------|
| `getCharWidth(char)` | 检测 CJK 字符范围（U+1100-U+115F、U+2E80-U+A4CF、U+AC00-U+D7A3 等），返回宽度 2；其他字符返回 1 |
| `formatTime(timestamp, verbose)` | 非 verbose 返回 `HH:MM`，verbose 返回 `HH:MM:SS` |
| `formatTokenCount(count)` | `< 1000` 返回原数字，`>= 1000` 返回 `Nk` 格式（如 `1.5k`） |

#### 关键设计决策

- `bodyWidth = max(16, columns - 2)` — 最小宽度 16 字符，预留边框空间
- 颜色和边框字符从 `ROLE_STYLES` 常量获取，按角色（user / system / claude 等）区分
- 空消息体会生成一个空文本行（`{ text: '', style: {} }`），保证渲染一致性
- 该模块取代了之前 MainLayout 直接渲染 `MessageView` 组件的方式，将行计算前置到纯数据层，使滚动切片可以精确到行级别

---

## God LLM UI 状态

### 11. escape-window.ts — Legacy Escape Window

**来源**: FR-008 (AC-025, AC-026, AC-027)

God auto-decision 的 legacy 纯状态封装。在 AI-driven 模式下，决策在创建时立即标记为 confirmed，escape window 不再展示，key/countdown handler 均为空操作。

#### 核心类型

```ts
interface EscapeWindowState {
  visible: boolean;      // AI-driven 模式下始终 false
  countdown: number;     // AI-driven 模式下始终 0
  decision: GodAutoDecision;
  decisionPreview: string;  // 格式: `[action] reasoning`
  confirmed: boolean;    // AI-driven 模式下创建即 true
  cancelled: boolean;
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `createEscapeWindowState(decision)` | `GodAutoDecision` | `EscapeWindowState` | 创建即 `confirmed: true, visible: false, countdown: 0` |
| `handleEscapeKey(state, key)` | 当前状态 + `'escape'`/`'space'` | `EscapeWindowState` | 已 confirmed/cancelled 时返回原状态；escape -> cancelled; space -> confirmed |
| `tickEscapeCountdown(state)` | 当前状态 | `EscapeWindowState` | 已 resolved 时返回原状态；countdown 减至 0 时 confirmed |

---

### 12. god-decision-banner.ts — God 自动决策 Banner 状态

**来源**: FR-008 (AC-025, AC-026, AC-027)

God auto-decision escape window 的纯状态逻辑。AI-driven 模式下决策立即执行（`ESCAPE_WINDOW_MS = 0`）。

#### 核心类型

```ts
interface GodDecisionBannerState {
  decision: GodAutoDecision;
  countdown: number;       // 毫秒，AI-driven 模式下为 0
  cancelled: boolean;
  executed: boolean;       // AI-driven 模式下创建即 true
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `createGodDecisionBannerState(decision)` | `GodAutoDecision` | `GodDecisionBannerState` | `countdown: 0, executed: true` — 立即执行 |
| `handleBannerKeyPress(state, key)` | 当前状态 + `'space'`/`'escape'` | `GodDecisionBannerState` | 已 resolved 时返回原状态；space -> executed; escape -> cancelled |
| `tickBannerCountdown(state)` | 当前状态 | `GodDecisionBannerState` | 每 tick 减 `TICK_INTERVAL_MS(100)`；减至 0 时 executed |
| `formatDecisionSummary(decision)` | `GodAutoDecision` | `string` | `accept` -> `"God: accepting output"`；`continue_with_instruction` -> `"God: continuing - \"instruction\""` |

#### 常量

- `ESCAPE_WINDOW_MS = 0` — AI-driven 模式无等待
- `TICK_INTERVAL_MS = 100`

---

### 13. god-fallback.ts — God 调用 Retry + Degradation 包装

**来源**: FR-G01 (AC-055, AC-056, AC-057), FR-G04 (AC-062, AC-063)

统一的 God 调用包装器，提供 retry + degradation 机制。所有 God 调用点使用此包装器以保证一致的降级行为。

#### 降级级别

- **L1**: 正常 God 调用
- **L2/L3**: 失败后 retry 一次（process_exit/timeout 或 parse/schema 错误）
- **L4**: 连续 3 次失败 -> God 禁用，完全 fallback 到 v1

#### 核心类型

```ts
interface GodFallbackResult<T> {
  result: T;
  usedGod: boolean;
  notification?: DegradationNotification;
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `withGodFallback<TGod, TFallback>(dm, godCall, fallbackCall, errorKind)` | DegradationManager + God 异步调用 + fallback 调用 + 错误类型 | `Promise<GodFallbackResult>` | God 不可用 -> fallback；God 成功 -> recordSuccess；失败 -> handleGodFailure 判断是否 retry；retry 失败 -> fallback |
| `withGodFallbackSync<TGod, TFallback>(dm, godCall, fallbackCall, errorKind?)` | 同上（同步版） | `GodFallbackResult` | 同步版本，无 retry 支持；用于 prompt 生成等同步场景 |

#### 调用流程

```
1. dm.isGodAvailable()? → No → fallback
2. godCall() → 成功 → dm.handleGodSuccess() → return
3. godCall() → 失败 → dm.handleGodFailure() → retry?
4. retry → 成功 → dm.handleGodSuccess() → return (with notification)
5. retry → 失败 → dm.handleGodFailure() → fallback (with notification)
```

---

### 14. god-message-style.ts — God 消息视觉样式

**来源**: FR-014 (AC-041)

God 消息使用 `╔═╗` 双边框 + Cyan/Magenta 颜色，与 Coder/Reviewer 的单边框视觉区分。仅在关键决策点显示，避免视觉噪音。

#### 核心类型

```ts
interface GodMessageStyle {
  borderChar: string;     // ║ 侧边框
  topBorder: string;      // ╔═...═╗
  bottomBorder: string;   // ╚═...═╝
  borderColor: string;    // cyan
  textColor: string;      // magenta
}

type GodMessageType =
  | 'task_analysis'       // 任务分析
  | 'phase_transition'    // 阶段切换
  | 'auto_decision'       // 代理决策
  | 'anomaly_detection';  // 异常检测
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `shouldShowGodMessage(type)` | `GodMessageType` | `boolean` | 四种类型均为可见（`VISIBLE_TYPES` Set） |
| `formatGodMessage(content, type)` | 内容 + 消息类型 | `string[]` | 生成 `╔═╗` / `║ content ║` / `╚═╝` 格式的行数组；内容按行 pad 到 `BOX_WIDTH(50) - 2` 宽度 |

#### 辅助函数

- `getVisualWidth(text)` — 计算文本视觉宽度，CJK 字符计为宽度 2
- `truncateToWidth(text, maxWidth)` — 按视觉宽度截断文本
- `padLine(text, innerWidth)` — 将文本 pad 到指定宽度并添加 `║` 边框

#### 常量

- `BOX_WIDTH = 50`
- `GOD_STYLE` — 预定义的样式对象
- `TYPE_LABELS` — 各消息类型的标签映射（如 `'God · Task Analysis'`）

---

### 15. god-overlay.ts — God 控制面板 Overlay 状态

**来源**: FR-015 (AC-042, AC-043)

Ctrl+G 打开的 God 控制面板，显示任务类型、阶段、置信度、决策历史，并提供手动干预快捷键。

#### 核心类型

```ts
type GodOverlayAction =
  | { type: 'reclassify' }
  | { type: 'skip_phase' }
  | { type: 'force_converge' }
  | { type: 'pause_auto_decision' };

interface GodOverlayState {
  visible: boolean;
  currentTaskType: string;
  currentPhase?: string;
  confidenceScore?: number;
  decisionHistory: GodAuditEntry[];
  convergenceLog: ConvergenceLogEntry[];
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `createGodOverlayState(analysis, auditEntries, convergenceLog)` | `GodTaskAnalysis` + audit 日志 + convergence 日志 | `GodOverlayState` | 从最新 `POST_REVIEWER` audit entry 提取 confidenceScore；compound 任务从最新 `PHASE_TRANSITION` entry 提取 currentPhase（fallback 到首个 phase） |
| `handleGodOverlayKey(state, key)` | 当前状态 + 按键 | `{ state, action? }` | escape -> 关闭；r/s/f/p -> 返回对应 action |
| `writeGodOverlayActionAudit(sessionDir, opts)` | session 目录 + 操作参数 | `void` | 将手动干预事件写入 audit log，decisionType 为 `'MANUAL_INTERVENTION'` |

#### 手动干预快捷键

| 按键 | Action | 说明 |
|------|--------|------|
| `R` | `reclassify` | 重分类任务类型 |
| `S` | `skip_phase` | 跳过当前阶段 |
| `F` | `force_converge` | 强制收敛 |
| `P` | `pause_auto_decision` | 暂停自动决策 |

---

### 16. phase-transition-banner.ts — 阶段切换 Banner 状态

**来源**: FR-010 (AC-033, AC-034)

compound 任务阶段切换时的 2 秒 escape window 状态管理。用户可确认或取消阶段切换。

#### 核心类型

```ts
interface PhaseTransitionBannerState {
  nextPhaseId: string;
  previousPhaseSummary: string;
  countdown: number;       // 毫秒，初始 2000
  cancelled: boolean;
  confirmed: boolean;
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `createPhaseTransitionBannerState(nextPhaseId, previousPhaseSummary)` | 下一阶段 ID + 上一阶段摘要 | `PhaseTransitionBannerState` | `countdown: 2000, cancelled: false, confirmed: false` |
| `handlePhaseTransitionKeyPress(state, key)` | 当前状态 + `'space'`/`'escape'` | `PhaseTransitionBannerState` | space -> confirmed; escape -> cancelled |
| `tickPhaseTransitionCountdown(state)` | 当前状态 | `PhaseTransitionBannerState` | 每 tick 减 `PHASE_TICK_INTERVAL_MS(100)`；减至 0 时 confirmed（自动确认） |

#### 常量

- `PHASE_ESCAPE_WINDOW_MS = 2000` — 2 秒等待窗口
- `PHASE_TICK_INTERVAL_MS = 100`

---

### 17. reclassify-overlay.ts — 运行时任务重分类 Overlay 状态

**来源**: FR-002a (AC-010, AC-011, AC-012)

Ctrl+R 触发的全屏 overlay，允许用户在 session 运行中更改任务类型。

#### 核心类型

```ts
interface ReclassifyOverlayState {
  visible: boolean;
  currentType: TaskType;
  currentRound: number;
  selectedType: TaskType;
  availableTypes: TaskType[];  // ['explore', 'code', 'review', 'debug']，不含 compound
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `canTriggerReclassify(workflowState)` | 状态机当前状态 | `boolean` | 仅允许在 `CODING`/`REVIEWING`/`GOD_DECIDING`/`MANUAL_FALLBACK` 状态下触发 |
| `createReclassifyState(currentType, currentRound)` | 当前任务类型 + 当前轮次 | `ReclassifyOverlayState` | `visible: true`，availableTypes 为四种非 compound 类型 |
| `handleReclassifyKey(state, key)` | 当前状态 + 按键 | `{ state, action? }` | 数字 1-4 -> 直接选择并 confirm；arrow -> 移动选择；enter -> confirm；escape -> cancel 并恢复原类型 |
| `writeReclassifyAudit(sessionDir, opts)` | session 目录 + 操作参数 | `void` | 将重分类事件写入 audit log，decisionType 为 `'RECLASSIFY'` |

#### 允许触发的状态

```ts
const RECLASSIFY_ALLOWED_STATES = ['CODING', 'REVIEWING', 'GOD_DECIDING', 'MANUAL_FALLBACK'];
```

---

### 18. resume-summary.ts — 恢复摘要构建

**来源**: FR-016 (AC-044, AC-045)

`duo resume` 后为用户构建 God 决策摘要，展示 session 中的关键决策事件。

#### 核心类型

```ts
type ResumeSummaryEvent = {
  type: 'task_init' | 'phase_transition' | 'auto_decision';
  timestamp: string;
  summary: string;
};

interface ResumeSummaryState {
  events: ResumeSummaryEvent[];
  visible: boolean;
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `buildResumeSummary(auditLog, convergenceLog)` | `GodAuditEntry[]` + `ConvergenceLogEntry[]` | `ResumeSummaryState` | O(n) 扫描 audit log，过滤 `TASK_INIT`/`PHASE_TRANSITION`/`AUTO_DECISION` 事件，按时间排序，为每个事件生成人类可读摘要 |

#### 事件摘要格式

| 事件类型 | 摘要格式 |
|----------|---------|
| `task_init` | `"Task initialized: <outputSummary>"` |
| `phase_transition` | `"Phase transition: <inputSummary>"` |
| `auto_decision` | `"Auto-decision: <action> — <outputSummary>"` |

---

### 19. task-analysis-card.ts — 任务分析卡片状态

**来源**: FR-001a (AC-004, AC-005, AC-006, AC-007)

God 任务分析结果的 intent echo 卡片状态管理。用户可在 8 秒倒计时内选择/确认任务类型，超时自动确认推荐类型。

#### 核心类型

```ts
type TaskType = 'explore' | 'code' | 'discuss' | 'review' | 'debug' | 'compound';

interface TaskAnalysisCardState {
  analysis: GodTaskAnalysis;
  selectedType: TaskType;
  countdown: number;          // 8 秒倒计时
  countdownPaused: boolean;   // 箭头键导航时暂停
  confirmed: boolean;
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `createTaskAnalysisCardState(analysis)` | `GodTaskAnalysis` | `TaskAnalysisCardState` | `selectedType` 初始为 God 推荐类型，`countdown: 8` |
| `handleKeyPress(state, key)` | 当前状态 + 按键 | `TaskAnalysisCardState` | 数字 1-6 -> 直接选择并 confirm；arrow -> 移动选择并暂停 countdown；enter -> confirm；space -> confirm 推荐类型 |
| `tickCountdown(state)` | 当前状态 | `TaskAnalysisCardState` | 已 confirmed 或 paused 时不 tick；每秒减 1；减至 0 时自动 confirm |

#### 常量

- `TASK_TYPE_LIST`: 6 种任务类型的有序列表
- `INITIAL_COUNTDOWN = 8` — 8 秒自动确认

#### 交互逻辑

- 数字键 `1-6`：直接选中并确认
- 上下箭头：移动选择，暂停倒计时
- Enter：确认当前选中
- Space：确认 God 推荐的类型
- 倒计时到 0：自动确认当前选中类型

---

## 模块间依赖关系

```
Core UI 依赖:
  message-lines.ts ──> markdown-parser.ts (parseMarkdown)
                   ──> display-mode.ts (DisplayMode 类型)
                   ──> types/ui.ts (Message, ROLE_STYLES)

  keybindings.ts ──> (定义 OverlayType，与 overlay-state.ts 共享类型，含 'god')

  session-runner-state.ts ──> types/adapter.ts (OutputChunk)
                           ──> decision/choice-detector.ts (ChoiceDetectionResult)
                           ──> session/session-manager.ts (LoadedSession, SessionState)
                           ──> session/context-manager.ts (RoundRecord)
                           ──> types/god-schemas.ts (GodTaskAnalysis)
                           ──> god/god-convergence.ts (ConvergenceLogEntry)
                           ──> god/degradation-manager.ts (DegradationState)

God LLM UI 依赖:
  escape-window.ts ──> types/god-schemas.ts (GodAutoDecision)

  god-decision-banner.ts ──> types/god-schemas.ts (GodAutoDecision)

  god-fallback.ts ──> god/degradation-manager.ts (DegradationManager, GodErrorKind)

  god-message-style.ts ──> (无外部依赖，纯样式定义)

  god-overlay.ts ──> types/god-schemas.ts (GodTaskAnalysis)
                 ──> god/god-audit.ts (GodAuditEntry, appendAuditLog)
                 ──> god/god-convergence.ts (ConvergenceLogEntry)

  phase-transition-banner.ts ──> (无外部依赖)

  reclassify-overlay.ts ──> task-analysis-card.ts (TaskType)
                         ──> god/god-audit.ts (GodAuditEntry, appendAuditLog)

  resume-summary.ts ──> god/god-audit.ts (GodAuditEntry)
                    ──> god/god-convergence.ts (ConvergenceLogEntry)

  task-analysis-card.ts ──> types/god-schemas.ts (GodTaskAnalysis)

MainLayout 组件消费:
  scroll-state.ts, display-mode.ts, keybindings.ts,
  overlay-state.ts, message-lines.ts

App/SessionRunner 组件消费:
  session-runner-state.ts, escape-window.ts, god-decision-banner.ts,
  god-fallback.ts, god-overlay.ts, phase-transition-banner.ts,
  reclassify-overlay.ts, resume-summary.ts, task-analysis-card.ts
```
