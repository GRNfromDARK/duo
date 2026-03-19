# UI 状态管理模块

> 路径：`src/ui/*.ts`（不含 `components/`）

## 设计理念

Duo 的 UI 状态层遵循 **纯函数提取** 原则：

1. **所有状态计算都是纯函数** — 接受当前状态 + 事件参数，返回新状态，无副作用
2. **组件只做胶水** — React 组件通过 `useState` 持有状态，调用纯函数计算下一个状态
3. **可独立单测** — 每个模块均可脱离 React 运行测试，无需 DOM 或 TUI 环境

这一设计与 `InputArea.processInput`、`DirectoryPicker.processPickerInput` 等组件级纯函数保持一致，形成统一的 "state -> pure fn -> new state" 模式。

整个 UI 状态层共 **27 个模块**，分为五组：
- **Core UI 状态**（7 个）— 通用 UI 逻辑：显示模式、目录选择器、快捷键、Overlay、Markdown 解析、Git diff 统计、流式聚合、消息行计算
- **God LLM UI 状态**（6 个）— God 决策层的 UI 状态：retry 包装、消息样式、阶段切换、重分类、任务分析
- **Runtime/Lifecycle 状态**（3 个）— 运行时生命周期管理：任务完成流、全局 Ctrl+C 处理、安全退出
- **Layout Primitives**（6 个）— OpenTUI layout 原语：从组件中提取的纯布局/样式计算逻辑，包括代码块折叠、输入区域、消息块、状态栏、流式渲染、任务 banner
- **Shared Layout Primitives**（5 个）— 统一 OpenTUI 布局原语：屏幕 shell 尺寸计算、Setup 向导文案、Setup 向导布局模型、TUI layout model（面板色调/选择行/分隔线）、TUI layout 组件（Row/Column/Panel/Divider 等）

> **OpenTUI 迁移说明**：`alternate-screen.ts`、`mouse-input.ts`、`scroll-state.ts` 三个模块已删除，`ScrollIndicator.tsx` 组件也一并删除。其功能由 OpenTUI 运行时原生提供：`createCliRenderer` 内置 alternate screen 管理（`useAlternateScreen` 选项），OpenTUI 原生处理鼠标输入，`ScrollBox` 组件提供原生滚动（`stickyScroll` / `scrollBy` / `scrollTo`）。详见下方 **TUI 层** 一节。

---

## TUI 层

> 路径：`src/tui/`

在 OpenTUI 迁移中新增的 TUI 适配层，共 4 个文件，负责将 OpenTUI 原语桥接为项目内部 API：

| 文件 | 职责 |
|------|------|
| `primitives.tsx` | Ink 兼容适配层 — 将 OpenTUI 的 `@opentui/core` 和 `@opentui/react` 封装为 Ink 风格 API（`Box`、`Text`、`ScrollBox`、`useInput`、`useApp`、`useStdout`），使现有组件代码零改动迁移 |
| `app.tsx` | 最小化 TUI 示例组件 — smoke test 和 resume preview 使用的简单 `<box>` + `<scrollbox>` 布局 |
| `cli.tsx` | CLI 入口 — 基于 `createCliRenderer` + `createRoot` 启动 OpenTUI 渲染循环，处理 `start` / `resume` / `--smoke-test` 命令路由 |
| `runtime/bun-launcher.ts` | Bun 运行时定位 — 按优先级解析 Bun binary（`DUO_BUN_BINARY` 环境变量 > 项目 bundled `.local/bun/bin/bun` > 系统 `which bun`），构建 `OpenTuiLaunchSpec` |

### primitives.tsx — Ink 兼容适配层

核心桥接：将 OpenTUI 的 `ParsedKey` 事件转换为 Ink 风格的 `Key` 接口（含 `upArrow`/`downArrow`/`ctrl`/`shift`/`meta` 等布尔字段），使 `keybindings.ts` 等模块无需修改。

| 导出 | 说明 |
|------|------|
| `Key` interface | Ink 兼容的键盘事件类型，扩展了 `pageDown`/`pageUp`/`home`/`end`/`capsLock`/`numLock` 等字段 |
| `useInput(handler)` | 将 `useKeyboard` 回调转换为 `(input: string, key: Key)` 签名 |
| `usePaste(handler)` | 订阅终端 paste 事件（bracketed paste mode）。通过 `decodePasteBytes` 解码粘贴字节，`stripAnsiSequences` 清除 ANSI 转义序列后回调 handler。使用 `useRef` + `useCallback` 保持 handler 引用稳定，通过 `keyHandler.on('paste', ...)` 订阅事件 |
| `useApp()` | 返回 `{ exit }` 方法，内部调用 `renderer.destroy()` |
| `useStdout()` | 返回 `{ stdout: process.stdout }` |
| `Box` | 映射到 OpenTUI `<box>` 元素 |
| `ScrollBox` | 映射到 OpenTUI `<scrollbox>` 元素，支持 `ref` 转发 |
| `Text` | 映射到 OpenTUI `<text>`/`<span>` 元素（根据嵌套层级自动选择），将 `color`/`bold`/`dimColor`/`inverse` 等 Ink props 转换为 OpenTUI 的 `fg`/`bg`/`attributes` |

> **Paste 支持**：`usePaste` hook 为所有 TUI 输入组件（InputArea、CompletionScreen、SearchOverlay 等）提供 bracketed paste 支持。终端的 bracketed paste mode 会将粘贴内容包裹在特殊转义序列中，OpenTUI 的 `keyHandler` 将其解析为 `PasteEvent`，`usePaste` 解码字节并清除 ANSI 序列后将纯文本传递给消费组件。这使得用户可以在任何输入场景中通过 Cmd+V / Ctrl+V 粘贴多行文本。

### cli.tsx — CLI 入口

通过 `renderNode()` 统一渲染流程：

```
createCliRenderer({ exitOnCtrlC: false, useAlternateScreen: true })
  → createRoot(renderer)
  → root.render(node)
  → await renderer 'destroy' event
```

命令路由：`start` 解析 CLI 参数并创建 `SessionConfig`；`resume` 加载已有 session 并恢复；`--smoke-test` 渲染 `TuiApp` 并在 30ms 后自动退出。

### runtime/bun-launcher.ts — Bun 运行时定位

| 函数 | 说明 |
|------|------|
| `resolveBunBinary(options)` | 按优先级查找 Bun：`DUO_BUN_BINARY` 环境变量 → bundled 路径 `.local/bun/bin/bun` → 系统 `which bun` |
| `buildOpenTuiLaunchSpec(input)` | 构建启动规格：`{ command: bunBinary, args: ['run', 'src/tui/cli.tsx', ...argv] }` |
| `getBundledBunBinaryPath(cwd)` | 返回项目内 bundled Bun 路径 |

---

## 模块总览

### Core UI 状态（7 个）

| # | 文件 | 职责 | FR 来源 |
|---|------|------|---------|
| 1 | `display-mode.ts` | Minimal/Verbose 切换 | FR-021 |
| 2 | `directory-picker-state.ts` | 目录选择器逻辑 | FR-019 |
| 3 | `keybindings.ts` | 快捷键映射 | FR-022 |
| 4 | `overlay-state.ts` | Overlay 生命周期 | FR-022 |
| 5 | `markdown-parser.ts` | Markdown 解析 | FR-023 |
| 6 | `git-diff-stats.ts` | Git diff 统计 | FR-026 |
| 7 | `session-runner-state.ts` | 流式聚合与路由决策 | 多 FR |

### God LLM UI 状态（6 个）

| # | 文件 | 职责 | FR 来源 |
|---|------|------|---------|
| 8 | `god-fallback.ts` | God 调用 retry + backoff 包装 | FR-G01 |
| 9 | `god-message-style.ts` | God 消息视觉样式 | FR-014 |
| 10 | `phase-transition-banner.ts` | 阶段切换 banner 状态 | FR-010 |
| 11 | `reclassify-overlay.ts` | 运行时任务重分类 overlay 状态 | FR-002a |
| 12 | `task-analysis-card.ts` | 任务分析卡片状态 | FR-001a |
| 13 | `message-lines.ts` | 消息行计算与渲染 | — |

### Runtime/Lifecycle 状态（3 个）

| # | 文件 | 职责 | 说明 |
|---|------|------|------|
| 14 | `completion-flow.ts` | 任务完成后续流 | 构建追加任务的 prompt |
| 15 | `global-ctrl-c.ts` | 全局 Ctrl+C 双击检测 | 区分 interrupt 与 safe_exit |
| 16 | `safe-shutdown.ts` | 安全退出流程 | 协调 adapter 终止与进程退出 |

### Layout Primitives（6 个）

| # | 文件 | 职责 | 说明 |
|---|------|------|------|
| 20 | `code-block-layout.ts` | 代码块折叠布局 | 超过阈值行数时折叠预览，纯布局计算 |
| 21 | `input-area-layout.ts` | 输入区域布局 | Composer 区域的行拆分、光标定位、placeholder 逻辑 |
| 22 | `message-blocks.ts` | 消息块结构化 | 将 Message[] 转换为 header + body 的 MessageBlock 结构 |
| 23 | `status-bar-layout.ts` | 状态栏自适应布局 | 按优先级裁剪 segment，支持中间截断和响应式宽度 |
| 24 | `stream-renderer-layout.ts` | 流式渲染模型 | 将 MarkdownSegment 转换为渲染入口，支持 activity 折叠 |
| 25 | `task-banner-layout.ts` | 任务 banner 布局 | 任务摘要的截断与宽度计算 |

### Shared Layout Primitives（5 个）

| # | 文件 | 职责 | 说明 |
|---|------|------|------|
| 26 | `screen-shell-layout.ts` | 屏幕 shell 尺寸计算 | 统一的 surface 宽度 clamp（Setup/Overlay/Session 三种场景） |
| 27 | `setup-copy.ts` | Setup 向导文案定义 | 面向工作流的 hero slogan、subhead、feature bullets |
| 28 | `setup-wizard-layout.ts` | Setup 向导布局模型 | Stepper 分组模型 + Hero 区域响应式布局 |
| 29 | `tui-layout-model.ts` | TUI layout model | 面板色调、选择行、分隔线等纯数据模型 |
| 30 | `tui-layout.tsx` | TUI layout 组件库 | Row/Column/CenteredContent/Panel/Divider/SelectionRow 等复合布局组件 |

---

## Core UI 状态

### 1. display-mode.ts — Minimal/Verbose 模式切换

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

### 2. directory-picker-state.ts — 目录选择器逻辑

**来源**: FR-019 (AC-065, AC-066, AC-067)

为 Setup 阶段的目录选择器提供纯逻辑，与 `InputArea.processInput` 保持相同的提取模式。

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
| `completePath(partial)` | 部分路径字符串 | `string[]` | 展开 `~` 到 `$HOME`，列出匹配的子目录（绝对路径）；对目录和文件名使用 `fs.readdirSync` + `fs.statSync` 过滤 |
| `isGitRepo(dir)` | 目录路径 | `boolean` | 检查 `path.join(dir, '.git')` 是否存在 |
| `discoverGitRepos(scanDirs)` | 扫描目录列表 | `string[]` | 对 `scanDirs` 中每个目录做单层扫描，返回含 `.git` 的子目录；不存在或无权限的目录静默跳过 |
| `loadMRU(filePath)` | JSON 文件路径 | `string[]` | 读取 MRU 列表，文件不存在或 JSON 无效时返回空数组 |
| `saveMRU(filePath, dirs)` | 文件路径 + 目录列表 | `void` | 使用 `fs.mkdirSync(recursive: true)` 自动创建父目录后写入 JSON |
| `addToMRU(current, newDir, maxItems?)` | 当前列表 + 新目录 | `string[]` | 纯函数，先过滤已存在项，移至列表头部，上限 `MRU_MAX_ITEMS = 10` |
| `processPickerInput(state, input, key)` | 选择器状态 + 键盘输入 | `PickerAction` | Tab -> `tab_complete`；Escape -> `cancel`；Enter -> 若有输入值则 submit 输入值，否则 submit 列表当前选中项；上下箭头 -> `select` 导航（带边界检查）；Backspace -> 删末字符 `update_input`；普通字符 -> 追加 `update_input` |

#### 常量

- `DEFAULT_SCAN_DIRS`: `~/Projects`, `~/Developer`, `~/code`
- `MRU_MAX_ITEMS = 10`

---

### 3. keybindings.ts — 快捷键映射

**来源**: FR-022 (AC-072, AC-073, AC-074)

将键盘输入映射为语义化的 `KeyAction`，根据上下文（Overlay 是否打开、输入框是否为空）决定不同行为。

#### 核心类型

```ts
type OverlayType = 'help' | 'context' | 'timeline' | 'search';

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
| `Ctrl+R` | 重分类任务类型 |
| `Ctrl+L` | 清屏（保留历史） |
| `j/k` 或 `↑/↓` 或 wheel | 滚动消息 |
| `Shift+drag` | 选中/复制文本 |
| `G` | 跳至最新消息 |
| `Enter` | 展开/折叠代码块 |
| `Tab` | 路径自动补全 |
| `?` | 帮助 / 快捷键列表 |
| `/` | 搜索消息历史 |
| `Esc` | 关闭 Overlay / 返回 |

---

### 4. overlay-state.ts — Overlay 生命周期

**来源**: FR-022 (AC-072, AC-073, AC-074)

管理四种 Overlay 的打开/关闭状态和搜索查询。

#### 核心类型

```ts
type OverlayType = 'help' | 'context' | 'timeline' | 'search';

interface OverlayState {
  activeOverlay: OverlayType | null;
  searchQuery: string;
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `openOverlay(state, overlay)` | 当前状态 + 要打开的 overlay | `OverlayState` | 打开 search 时清空 `searchQuery` |
| `closeOverlay(state)` | 当前状态 | `OverlayState` | 关闭 overlay 并清空 `searchQuery`；若已无 overlay 则返回原状态引用 |
| `updateSearchQuery(state, query)` | 当前状态 + 新查询 | `OverlayState` | 仅更新 `searchQuery`，保留其余字段 |
| `computeSearchResults(messages, query)` | 消息列表 + 查询字符串 | `Message[]` | 大小写不敏感的子串匹配（`content.toLowerCase().includes(lower)`）；空查询返回空数组 |

**初始状态**: `INITIAL_OVERLAY_STATE` — `activeOverlay: null, searchQuery: ''`

#### 关键约束

- 任一时刻只能有一个 Overlay 处于打开状态
- 搜索查询在 Overlay 关闭时自动清空
- MainLayout 在 search overlay 打开时将文本输入路由到 `updateSearchQuery`，Backspace 删除末字符

---

### 5. markdown-parser.ts — Markdown 解析

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
| `parseMarkdown(text)` | Markdown 字符串 | `MarkdownSegment[]` | 逐行状态机：先检测 activity block（`:::` 语法），再检测围栏代码块，再检测表格、列表项，最后收集连续纯文本并做 inline 解析；空字符串返回空数组 |

#### 解析规则

- **Activity block**: 匹配 `/^:::(activity|result|error)\s*(.*)$/`，`:::` 单独一行闭合；kind 决定语义（activity=操作、result=结果、error=错误）
- **围栏代码块**: 匹配 `/^```(\w*)\s*$/`，闭合匹配 `/^```\s*$/`；未闭合的块视为仍在流式输出，content 为已收集的行
- **表格**: 要求第二行匹配 `/^\|[\s-:|]+\|$/`（分隔行），否则作为普通文本处理；`parseCells` 按 `|` 分割并 trim 每个单元格
- **列表**: 无序 `/^([*-]) (.+)$/`，有序 `/^(\d+)\. (.+)$/`
- **内联格式**: 正则 `/(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+?)`)/g` 解析 bold、italic、inline_code；嵌套在连续文本行的 `parseInline` 中处理

---

### 6. git-diff-stats.ts — Git 变更统计

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
| `parseGitDiffStat(output)` | `git diff --stat` 的输出字符串 | `GitDiffStats` | 正则提取 `N files changed`（`/(\d+)\s+files?\s+changed/`）、`N insertions(+)`（`/(\d+)\s+insertions?\(\+\)/`）、`N deletions(-)`（`/(\d+)\s+deletions?\(-\)/`）；无 filesMatch 时返回全零对象 |

---

### 10. session-runner-state.ts — 流式聚合与用户决策

**来源**: 多个 FR，是 App 组件中 SessionRunner 的核心状态逻辑提取。

这是最复杂的状态模块，包含三大职责：

1. **流式聚合** — 将 adapter 输出的 `OutputChunk` 流逐步聚合为最终文本
2. **用户决策解析** — 将用户输入映射为工作流 action
3. **会话恢复** — 从持久化的 `LoadedSession` 重建运行时状态

#### 流式聚合

```ts
interface StreamAggregation {
  fullText: string;          // 完整历史文本（含 tool use 记录）
  llmText: string;           // 纯 LLM 文本输出（仅 text + code chunk，不含工具标记和状态元数据）
  displayText: string;       // UI 显示文本（含工具摘要头）
  displayBodyText: string;   // 纯正文部分（不含工具摘要头）
  errorMessages: string[];   // 累积的错误消息
  activeToolName: string | null;  // 当前活跃的工具名
  toolUpdateCount: number;   // 工具调用累计次数
  toolWarningCount: number;  // 工具警告累计次数
  latestToolSummary: string | null;  // 最新工具摘要文本
}

type StreamOutcome =
  | { kind: 'success'; fullText: string; llmText: string; displayText: string }
  | { kind: 'error'; fullText: string; llmText: string; displayText: string; errorMessage: string }
  | { kind: 'no_output'; fullText: string; llmText: string; displayText: string };
```

| 函数 | 说明 |
|------|------|
| `createStreamAggregation()` | 创建初始聚合状态，所有字段为空/零 |
| `applyOutputChunk(state, chunk)` | 处理一个 chunk：text/code 追加到 fullText、llmText 和 displayBodyText；tool_use 格式化为摘要行；tool_result 记录行数或错误；error 追加到 errorMessages（`metadata.fatal !== false` 时）；status chunk 仅追加到 fullText（信息性，防止 stderr-only 运行产生 `no_output`） |
| `finalizeStreamAggregation(state)` | 根据 errorMessages 和文本内容决定 outcome 类型：有 error -> `'error'`；全空 -> `'no_output'`；否则 `'success'` |

**工具格式化特殊逻辑** (`formatToolUse`):
- `Bash` -> 提取 `input.description` 字段，`historyLine: "[Bash] description"`，`displaySummary: "Bash: description"`
- `Read` -> 提取 `input.file_path` 或 `input.path` 并取文件名，`"Read: Read filename"`
- `Explore` -> 提取 `input.description` 字段
- 其他工具 -> `summarizeStructuredValue` 将 input 做 `JSON.stringify(value, null, 2)`

**displayText 构建** (`buildDisplayText`): 在 bodyText 前添加工具统计摘要行，格式 `⏺ N tool updates · M warnings · latest <summary>`

**内容拼接逻辑** (`appendContent`): 两段内容之间的拼接规则——若前文以 `:::` 结尾而后文不以 `\n` 开头，插入 `\n`；否则若前文不以 `\n` 结尾且后文不以 `\n` 开头，插入 `\n`；其余直接拼接。

#### 用户决策

```ts
type UserDecision =
  | { type: 'confirm'; action: 'accept' | 'continue'; pendingInstruction?: string }
  | { type: 'resume'; input: string; resumeAs: 'coder' | 'reviewer' };
```

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `resolveUserDecision(stateValue, text, lastInterruptedRole)` | 状态机状态值 + 用户输入文本 + 上次中断角色 | `UserDecision \| null` | `WAITING_USER`/`PAUSED` 状态：`a`/`accept` -> accept，`c`/`continue` -> continue，其他非空文本 -> continue + pendingInstruction；`INTERRUPTED` 状态：有文本 -> resume（resumeAs 取 lastInterruptedRole，fallback 到 `'coder'`）；其余返回 null |

#### 会话恢复

```ts
interface RestoredSessionRuntime {
  workflowInput: Partial<WorkflowContext>;
  restoreEvent: RestoreEventType;
  messages: Message[];
  reviewerOutputs: string[];
  tokenCount: number;
  coderSessionId?: string;
  reviewerSessionId?: string;
  godSessionId?: string;
  godTaskAnalysis?: GodTaskAnalysis;
  currentPhaseId?: string | null;
}

type RestoreEventType =
  | 'RESTORED_TO_CODING'
  | 'RESTORED_TO_REVIEWING'
  | 'RESTORED_TO_WAITING'
  | 'RESTORED_TO_INTERRUPTED'
  | 'RESTORED_TO_CLARIFYING';
```

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `buildRestoredSessionRuntime(loaded, config)` | `LoadedSession` + `SessionConfig` | `RestoredSessionRuntime` | 按时间排序历史记录，通过 `toMessage` 转换为 Message（id 格式 `restored-{role}-{timestamp}`），估算 token（`CHARS_PER_TOKEN = 4`），提取 CLI session ID 用于 adapter resume，恢复 God 相关状态，支持 BUG-16 fix（CLARIFYING 状态恢复 `frozenActiveProcess` 和 `clarificationRound`） |

**状态恢复映射** (`mapRestoreEvent`):

| 原始 status | RestoreEventType |
|-------------|------------------|
| `created`, `coding` | `RESTORED_TO_CODING` |
| `reviewing`, `routing_post_code` | `RESTORED_TO_REVIEWING` |
| `interrupted` | `RESTORED_TO_INTERRUPTED` |
| `clarifying` | `RESTORED_TO_CLARIFYING` |
| `god_deciding`, `manual_fallback`, `routing_post_review`, `evaluating`, `waiting_user`, `error`, `done`, 其他 | `RESTORED_TO_WAITING` |

---

## God LLM UI 状态

### 11. god-fallback.ts — God 调用 Retry + Backoff 包装

简洁的 God 调用重试包装器，提供 Watchdog 驱动的 retry + exponential backoff 机制。核心原则：最多重试 3 次（由 Watchdog 控制），然后暂停。无 fallback 模式，无 degradation。

#### 核心类型

```ts
interface RetryResult<T> {
  result: T;
  retryCount: number;
}

interface PausedResult {
  paused: true;
  retryCount: number;
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `withRetry<T>(fn, watchdog)` | 异步操作函数 + `WatchdogService` | `Promise<RetryResult<T> \| PausedResult>` | 循环调用 `fn()`：成功 -> `watchdog.handleSuccess()` -> 返回 `{ result, retryCount }`；失败 -> 检查 `watchdog.shouldRetry()`，若否则返回 `{ paused: true, retryCount }`；若是则 `retryCount++`，等待 `watchdog.getBackoffMs()` 后重试 |
| `isPaused<T>(r)` | `RetryResult<T> \| PausedResult` | `boolean` (type guard) | 检查 `'paused' in r && r.paused === true` |

#### 设计要点

- 无 fallback / degradation 逻辑，重试耗尽后简单暂停
- 依赖注入式设计，通过 `WatchdogService` 接口控制重试策略和 backoff 时间
- exponential backoff 由 `watchdog.getBackoffMs()` 提供

---

### 12. god-message-style.ts — God 消息视觉样式

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
  | 'anomaly_detection'   // 异常检测
  | 'clarification';      // God 澄清提问
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `shouldShowGodMessage(type)` | `GodMessageType` | `boolean` | 五种类型均为可见（`VISIBLE_TYPES` Set 包含所有五种） |
| `formatGodMessage(content, type)` | 内容 + 消息类型 | `string[]` | 生成 `╔═╗` / `║ content ║` / `╚═╝` 格式的行数组；内容按行 pad 到 `BOX_WIDTH(50) - 2` 宽度；header 行显示 `TYPE_LABELS` 中的标签 |

#### 辅助函数

- `getVisualWidth(text)` — 计算文本视觉宽度，CJK 字符计为宽度 2（检测范围与 `message-lines.ts` 相同）
- `truncateToWidth(text, maxWidth)` — 按视觉宽度截断文本，逐字符累加宽度直到超出 maxWidth
- `padLine(text, innerWidth)` — 先截断到 innerWidth，再用空格 pad 到 innerWidth，最后添加 `║` 边框

#### 常量

- `BOX_WIDTH = 50`
- `GOD_STYLE` — 预定义的样式对象（`borderChar: '║'`, `borderColor: 'cyan'`, `textColor: 'magenta'`）
- `TYPE_LABELS` — 各消息类型的标签映射：`'God · Task Analysis'`、`'God · Phase Transition'`、`'God · Auto Decision'`、`'God · Anomaly Detection'`、`'God · Clarification'`

---

### 13. phase-transition-banner.ts — 阶段切换 Banner 状态

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
| `handlePhaseTransitionKeyPress(state, key)` | 当前状态 + `'space'`/`'escape'` | `PhaseTransitionBannerState` | 已 cancelled/confirmed 时返回原状态；space -> confirmed; escape -> cancelled |
| `tickPhaseTransitionCountdown(state)` | 当前状态 | `PhaseTransitionBannerState` | 已 cancelled/confirmed 或 countdown <= 0 时返回原状态；每 tick 减 `PHASE_TICK_INTERVAL_MS(100)`；减至 0 时 confirmed（自动确认） |

#### 常量

- `PHASE_ESCAPE_WINDOW_MS = 2000` — 2 秒等待窗口
- `PHASE_TICK_INTERVAL_MS = 100`

---

### 14. reclassify-overlay.ts — 运行时任务重分类 Overlay 状态

**来源**: FR-002a (AC-010, AC-011, AC-012)

Ctrl+R 触发的全屏 overlay，允许用户在 session 运行中更改任务类型。

#### 核心类型

```ts
interface ReclassifyOverlayState {
  visible: boolean;
  currentType: TaskType;
  selectedType: TaskType;
  availableTypes: TaskType[];  // ['explore', 'code', 'review', 'debug']，不含 compound 和 discuss
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `canTriggerReclassify(workflowState)` | 状态机当前状态字符串 | `boolean` | 仅允许在 `RECLASSIFY_ALLOWED_STATES` 中的状态下触发 |
| `createReclassifyState(currentType)` | 当前任务类型 | `ReclassifyOverlayState` | `visible: true`，`selectedType` 初始化为 currentType（若在可用列表中）或列表第一项 |
| `handleReclassifyKey(state, key)` | 当前状态 + 按键字符串 | `{ state, action? }` | 数字 1-N -> 直接选择并 `confirm`（`visible: false`）；`arrow_down`/`arrow_up` -> 循环移动选择；`enter` -> `confirm`；`escape` -> `cancel` 并恢复 `selectedType` 为 `currentType` |
| `writeReclassifyAudit(sessionDir, opts)` | session 目录 + `{ seq, fromType, toType }` | `void` | 将重分类事件写入 audit log，`decisionType: 'RECLASSIFY'`，`inputSummary` 和 `outputSummary` 记录类型变更 |

#### 允许触发的状态

```ts
const RECLASSIFY_ALLOWED_STATES = ['CODING', 'REVIEWING', 'GOD_DECIDING', 'PAUSED'];
```

---

### 15. task-analysis-card.ts — 任务分析卡片状态

**来源**: FR-001a (AC-004, AC-005, AC-006, AC-007)

God 任务分析结果的 intent echo 卡片状态管理。用户可在 8 秒倒计时内选择/确认任务类型，超时自动确认推荐类型。

#### 核心类型

```ts
type TaskType = 'explore' | 'code' | 'discuss' | 'review' | 'debug' | 'compound';

const TASK_TYPE_LIST: TaskType[] = [
  'explore', 'code', 'discuss', 'review', 'debug', 'compound',
];

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
| `createTaskAnalysisCardState(analysis)` | `GodTaskAnalysis` | `TaskAnalysisCardState` | `selectedType` 初始为 `analysis.taskType`（强制转换为 TaskType），`countdown: 8`（`INITIAL_COUNTDOWN`），`countdownPaused: false`，`confirmed: false` |
| `handleKeyPress(state, key)` | 当前状态 + 按键字符串 | `TaskAnalysisCardState` | 已 confirmed 时返回原状态；数字 1-6 -> 直接选择并 confirm；`arrow_down`/`arrow_up` -> 循环移动选择并 `countdownPaused: true`；`enter` -> confirm；`space` -> 重置 selectedType 为推荐类型并 confirm |
| `tickCountdown(state)` | 当前状态 | `TaskAnalysisCardState` | 已 confirmed 或 paused 或 countdown <= 0 时返回原状态；每秒减 1；减至 0 时自动 confirm |

#### 常量

- `TASK_TYPE_LIST`: 6 种任务类型的有序列表（数字键 1-6 映射到此顺序）
- `INITIAL_COUNTDOWN = 8` — 8 秒自动确认

#### 交互逻辑

- 数字键 `1-6`：直接选中对应 `TASK_TYPE_LIST` 元素并确认
- 上下箭头：在列表中循环移动选择（使用模运算 `%`），同时暂停倒计时
- Enter：确认当前选中
- Space：确认 God 推荐的类型（重置 selectedType 后 confirm）
- 倒计时到 0：自动确认当前选中类型

---

### 16. message-lines.ts — 消息行计算与渲染

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
| `buildRenderedMessageLines(messages, displayMode, columns)` | `Message[]` + `DisplayMode` + 终端列宽 | `RenderedMessageLine[]` | 核心入口：遍历消息列表，每条消息生成 header 行 + 可选 CLI command 行 + body 行 + spacer 行 |
| `wrapText(text, width)` | 文本 + 列宽 | `string[]` | 按终端列宽自动折行，支持 CJK 宽字符；优先在空格和 CJK 字符边界断行，无合适断点时硬断 |

#### 每条消息的行结构

每条 `Message` 被转换为以下行序列：

1. **Header 行** — `${border} [RoleName · RoleLabel] HH:MM`，Verbose 模式下追加 `[Nk tokens]`
2. **CLI Command 行**（可选）— 仅 Verbose 模式下存在 `metadata.cliCommand` 时显示，前缀 `$ `，`dimColor: true`
3. **Body 行** — 消息内容经以下管线处理：
   - `parseMarkdown(content)` -> `MarkdownSegment[]`
   - `segmentsToBlocks(segments, displayMode)` -> `{ lines, style }[]`
   - `wrapText(line, bodyWidth)` -> 折行后的字符串数组
4. **Spacer 行** — 空行（`spans: [{ text: '' }]`），作为消息间分隔

#### 内部函数 `segmentsToBlocks`

将 `MarkdownSegment[]` 转换为带样式的文本块：

| Segment 类型 | 转换规则 |
|-------------|---------|
| `text` / `bold` / `italic` | 合并到当前段落（paragraph），flush 时按 `\n` 分行，`style: {}` |
| `inline_code` | 追加到段落，保留反引号包裹（`` ` ``） |
| `list_item` | flush 段落后，`-`/`*` 替换为 `•`，有序列表保留数字标记，`style: {}` |
| `code_block` | flush 段落后，`style: { color: 'cyan' }`，language 存在时在首行添加 `[lang]` |
| `table` | flush 段落后，`style: { dimColor: true }`，headers 和 rows 以 ` \| ` 连接 |
| `activity_block` | flush 段落后，根据 kind 选择图标（`⏺`/`⎿`/`⚠`）和颜色（cyan/gray/red）；Minimal 模式折叠为 `icon title: firstLine`；Verbose 模式展开所有内容行（`slice(1)` 显示后续行） |

#### 辅助函数

| 函数 | 说明 |
|------|------|
| `getCharWidth(char)` | 检测 CJK 字符范围（U+1100-U+115F、U+2E80-U+A4CF（排除 U+303F）、U+AC00-U+D7A3、U+F900-U+FAFF、U+FE10-U+FE19、U+FE30-U+FE6F、U+FF00-U+FF60、U+FFE0-U+FFE6），返回宽度 2；其他字符返回 1 |
| `computeStringWidth(s)` | 计算字符串的终端显示宽度，逐字符累加 `getCharWidth`；被 `TaskBanner` 等组件复用 |
| `formatTime(timestamp, verbose)` | 非 verbose 返回 `HH:MM`，verbose 返回 `HH:MM:SS` |
| `formatTokenCount(count)` | `< 1000` 返回原数字字符串，`>= 1000` 返回 `N.Mk` 格式（如 `1.5k`） |

#### 关键设计决策

- `bodyWidth = max(16, columns - 2)` — 最小宽度 16 字符（`MIN_BODY_WIDTH`），预留边框空间
- 颜色和边框字符从 `getRoleStyle(role)` 获取，按角色（user / system / claude 等）区分
- 空消息体会生成一个空文本行（`{ text: '', style: {} }`），保证渲染一致性
- 该模块取代了之前 MainLayout 直接渲染 `MessageView` 组件的方式，将行计算前置到纯数据层，使滚动切片可以精确到行级别
- `wrapText` 的折行算法追踪 `lastBreakPos` 和 `lastBreakWidth`，在空格和 CJK 字符之后标记断行点；无断行点时直接硬断

---

## Runtime/Lifecycle 状态

### 17. completion-flow.ts — 任务完成后续流

任务完成后支持用户追加需求的 prompt 构建逻辑。

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `buildContinuedTaskPrompt(currentTask, followUpRequirement)` | 当前任务描述 + 追加需求 | `string` | 将原始任务与追加需求拼接，格式：`currentTask + 空行 + "Additional user requirement:" + followUpRequirement.trim()`，使用 `\n` 连接 |

#### 使用场景

当用户在 CompletionScreen 中选择 "Continue current task" 时，调用此函数生成合并后的任务 prompt，传递给新一轮 Duo session。

---

### 18. global-ctrl-c.ts — 全局 Ctrl+C 双击检测

全局级别的 Ctrl+C 行为管理。单次 Ctrl+C 中断当前 LLM 执行；500ms 内双击 Ctrl+C 触发安全退出。

#### 核心类型

```ts
type GlobalCtrlCAction = 'interrupt' | 'safe_exit';
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `resolveGlobalCtrlCAction(now, lastCtrlCAt, thresholdMs?)` | 当前时间戳 + 上次 Ctrl+C 时间戳 + 阈值（默认 500ms） | `{ action: GlobalCtrlCAction; nextLastCtrlCAt: number }` | 若 `lastCtrlCAt > 0` 且两次按键间隔 `<= thresholdMs` 则返回 `safe_exit` 并重置 `nextLastCtrlCAt` 为 0；否则返回 `interrupt` 并设置 `nextLastCtrlCAt` 为当前时间戳 |

#### 常量

- `DOUBLE_CTRL_C_THRESHOLD_MS = 500` — 双击判定窗口 500 毫秒

#### 使用场景

App 组件在根级 `useInput` 中使用此函数，配合 `lastCtrlCRef` 维护上次按键时间。`interrupt` action 分发给 SessionRunner 中断当前 adapter；`safe_exit` action 触发 `performSafeShutdown` 安全退出。

---

### 19. safe-shutdown.ts — 安全退出流程

协调 adapter 终止、输出中断和进程退出的安全关机流程。确保所有子进程在退出前被正确清理。

#### 核心类型

```ts
interface KillableAdapter {
  kill(): Promise<void>;
}

interface InterruptibleOutputManager {
  interrupt(): void;
}

interface SafeShutdownOptions {
  adapters: KillableAdapter[];           // 需要 kill 的 adapter 列表
  outputManager?: InterruptibleOutputManager;  // 可选的输出流管理器
  beforeExit?: () => void;               // 退出前回调（如持久化状态）
  onExit: () => void;                    // 最终退出回调（通常是 process.exit 或 renderer.destroy）
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `performSafeShutdown(options)` | `SafeShutdownOptions` | `Promise<void>` | 1. 中断输出流（`outputManager?.interrupt()`）；2. 并行 kill 所有 adapter（`Promise.allSettled`，容错不阻塞）；3. 执行 `beforeExit?.()` 回调（try/catch 包裹，best-effort）；4. 调用 `onExit()` 完成退出 |

#### 设计要点

- 使用 `Promise.allSettled` 而非 `Promise.all`，确保某个 adapter kill 失败不会阻止其他 adapter 的清理
- `beforeExit` 回调被 try/catch 包裹，退出流程不依赖持久化是否成功
- 依赖注入式设计（duck typing），adapter 只需实现 `kill(): Promise<void>` 接口
- 执行顺序严格：先中断输出 -> 再终止适配器 -> 再持久化 -> 最后退出

---

## Layout Primitives

> 从组件中提取的纯布局/样式计算逻辑。遵循 OpenTUI layout 原语模式：组件调用 `build*Layout()` 纯函数获得布局描述对象，再根据描述对象渲染 UI 元素。这一提取使布局逻辑可独立单测，不依赖 React 或 TUI 环境。

### 20. code-block-layout.ts -- 代码块折叠布局

将代码块内容计算为折叠/展开的布局描述。超过 `FOLD_THRESHOLD`（10 行）的代码块默认折叠，仅显示前 `PREVIEW_LINES`（5 行）。

#### 核心类型

```ts
interface BuildCodeBlockLayoutOptions {
  content: string;
  language?: string;
  expanded?: boolean;
}

interface CodeBlockLayout {
  languageLabel?: string;
  displayLines: string[];
  lineCount: number;
  shouldFold: boolean;
  isExpanded: boolean;
  surfaceMode: 'container';
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `buildCodeBlockLayout(options)` | `BuildCodeBlockLayoutOptions` | `CodeBlockLayout` | 按 `\n` 分割内容行；行数 > `FOLD_THRESHOLD(10)` 时 `shouldFold: true`，未展开时仅返回前 `PREVIEW_LINES(5)` 行；空内容返回空行数组 |

#### 常量

- `FOLD_THRESHOLD = 10` -- 触发折叠的行数阈值
- `PREVIEW_LINES = 5` -- 折叠状态下显示的预览行数

---

### 21. input-area-layout.ts -- 输入区域布局

Composer 输入区域的完整布局计算：行拆分、光标行列定位、prompt 图标与颜色、placeholder 状态。

#### 核心类型

```ts
interface BuildInputAreaLayoutOptions {
  value: string;
  cursorPos: number;
  isLLMRunning: boolean;
  maxLines: number;
}

interface InputAreaRenderLine {
  prefix: string;        // 首行 "▸ " 或续行 "  "
  beforeCursor: string;
  cursorChar: string;
  afterCursor: string;
  isCursorLine: boolean;
}

interface InputAreaLayout {
  region: 'composer';
  height: number;
  showPlaceholder: boolean;
  promptIcon: string;       // LLM 运行时 "◆"，空闲时 "▸"
  promptColor: 'cyan' | 'yellow';
  placeholderText: string;
  lines: InputAreaRenderLine[];
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `getDisplayLines(value, maxLines)` | 输入值 + 最大行数 | `string[]` | 按 `\n` 分割后截取前 `maxLines` 行 |
| `getCursorLineCol(value, cursorPos)` | 输入值 + 光标位置 | `{ line, col }` | 根据光标前文本的 `\n` 分割计算行列号（0-based） |
| `buildInputAreaLayout(options)` | `BuildInputAreaLayoutOptions` | `InputAreaLayout` | 空值时返回 placeholder 布局（`height: 1`，无 lines）；非空时逐行构建 `InputAreaRenderLine`，标记光标所在行和列，首行前缀为 prompt 图标 |

#### 状态区分

| 状态 | promptIcon | promptColor | placeholderText |
|------|-----------|-------------|-----------------|
| LLM 运行中 | `◆` | `yellow` | `'Type to interrupt, or wait for completion...'` |
| 空闲 | `▸` | `cyan` | `'Type a message...'` |

---

### 22. message-blocks.ts -- 消息块结构化

将 `Message[]` 转换为结构化的 `MessageBlock[]`，包含 header（角色标签、时间、token 计数）和 body（内容、rail 样式、tone）。是 `message-lines.ts` 行级渲染的上层抽象。

#### 核心类型

```ts
interface MessageBlockHeader {
  label: string;         // 角色显示名，可能含 roleLabel 后缀
  time: string;          // HH:MM 或 HH:MM:SS（verbose 模式）
  tokenText?: string;    // verbose 模式下的 token 计数文本
}

interface MessageBlockBody {
  content: string;
  cliCommand?: string;   // verbose 模式下的 CLI 命令
  railSymbol: string;    // system 消息 "·"，其他 "▏"
  railColor: string;
  tone: 'accent' | 'muted' | 'neutral';
}

interface MessageBlock {
  id: string;
  header: MessageBlockHeader;
  body: MessageBlockBody;
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `buildMessageBlocks(messages, displayMode)` | `Message[]` + `DisplayMode` | `MessageBlock[]` | 遍历消息，通过 `getRoleStyle` 获取角色样式；verbose 模式显示秒级时间和 token 计数；tone 按角色区分：system -> `'muted'`，user -> `'neutral'`，其他 -> `'accent'` |

#### 内部辅助

| 函数 | 说明 |
|------|------|
| `formatTime(timestamp, verbose)` | 非 verbose 返回 `HH:MM`，verbose 返回 `HH:MM:SS` |
| `formatTokenCount(count)` | `< 1000` 返回 `"N tokens"`，`>= 1000` 返回 `"N.Mk tokens"` |

#### 依赖

- `types/ui.ts` -- `Message` 类型和 `getRoleStyle` 函数
- `display-mode.ts` -- `DisplayMode` 类型

---

### 23. status-bar-layout.ts -- 状态栏自适应布局

状态栏的响应式布局引擎。将多个 segment（品牌、路径、状态、agent、任务、阶段、延迟、token）按优先级分配到左右两组，当终端宽度不足时按优先级逐步裁剪低优先级 segment，并对路径做中间截断。

#### 核心类型

```ts
interface StatusBarLayoutSegment {
  kind: 'brand' | 'path' | 'status' | 'agent' | 'task' | 'phase' | 'latency' | 'tokens';
  text: string;
  color?: string;
  dimColor?: boolean;
  priority: number;    // 数字越小优先级越高
}

interface BuildStatusBarLayoutOptions {
  projectPath: string;
  statusLabel: string;
  statusColor: string;
  activeAgent: string | null;
  tokenText: string;
  taskType?: string;
  currentPhase?: string;
  godLatencyText?: string;
  columns: number;       // 终端列宽
}

interface StatusBarLayout {
  left: StatusBarLayoutSegment[];
  right: StatusBarLayoutSegment[];
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `buildStatusBarLayout(options)` | `BuildStatusBarLayoutOptions` | `StatusBarLayout` | 构建左侧（brand + path + status + 可选 agent/task/phase）和右侧（可选 latency + tokens）segment；宽度超出时按 `removalOrder`（phase -> task -> latency -> agent）逐步移除；仍超出时对 path 做 `truncateMiddle`（最小保留 `MIN_PATH_WIDTH(10)` 字符）；最终仍超出则完全移除 path |
| `computeStatusBarWidth(layout)` | `StatusBarLayout` | `number` | 计算布局的总显示宽度 |

#### 内部辅助

| 函数 | 说明 |
|------|------|
| `buildWidth(segments)` | 计算 segment 数组的总宽度（segment 间以 `SEGMENT_GAP(2)` 分隔） |
| `totalWidth(left, right)` | 左右两组总宽度（组间以 `GROUP_GAP(2)` 分隔） |
| `truncateMiddle(text, maxWidth)` | 中间截断：保留左右各一半字符，中间插入 `…`；`maxWidth <= 1` 时仅返回 `…` |
| `findSegment(segments, kind)` | 按 kind 查找 segment |
| `withoutKind(segments, kind)` | 返回移除指定 kind 后的 segment 数组 |

#### 常量

- `GROUP_GAP = 2` -- 左右组之间的间距
- `SEGMENT_GAP = 2` -- segment 之间的间距
- `MIN_PATH_WIDTH = 10` -- 路径截断的最小保留宽度

#### 裁剪优先级（从先移除到最后保留）

| 移除顺序 | kind | 说明 |
|----------|------|------|
| 1 | `phase` | 阶段标识（`φ:phaseName`） |
| 2 | `task` | 任务类型标签（`[taskType]`） |
| 3 | `latency` | God 延迟文本 |
| 4 | `agent` | 当前活跃 agent |
| 最后 | `path` | 先中间截断，仍不够则完全移除 |
| 不可移除 | `brand`, `status`, `tokens` | 始终保留 |

#### 依赖

- `message-lines.ts` -- `computeStringWidth` 函数

---

### 24. stream-renderer-layout.ts -- 流式渲染模型

将 `MarkdownSegment[]` 转换为 `StreamRenderEntry[]` 渲染模型，供 `StreamRenderer` 组件消费。支持 activity block 在 minimal 模式下折叠为摘要、系统消息外观配置、tone 到颜色的映射。

#### 核心类型

```ts
type StreamTone = 'accent' | 'muted' | 'warning' | 'neutral';

type StreamRenderEntry =
  | { kind: 'paragraph'; text: string; spacingAfter: number }
  | { kind: 'inline_code'; content: string; spacingAfter: number }
  | { kind: 'bold'; text: string; spacingAfter: number }
  | { kind: 'italic'; text: string; spacingAfter: number }
  | { kind: 'list_item'; marker: string; text: string; spacingAfter: number }
  | { kind: 'table'; headers: string[]; rows: string[][]; spacingAfter: number }
  | { kind: 'code_block'; content: string; language?: string; spacingAfter: number }
  | { kind: 'activity_block'; title: string; content: string; tone: StreamTone; spacingAfter: number }
  | { kind: 'activity_summary'; summary: string; tone: StreamTone; spacingAfter: number };

interface SystemMessageAppearance {
  tone: StreamTone;
  color: string;
  prefix: string;
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `buildStreamRenderModel(segments, displayMode)` | `MarkdownSegment[]` + `DisplayMode` | `StreamRenderEntry[]` | 逐 segment 转换：text 按双换行拆分为段落；inline_code / bold / italic / list_item / table / code_block 直接映射；activity_block 在 minimal 模式下收集连续 activity 块并调用 `summarizeActivityRun` 折叠为单条摘要，在 verbose 模式下保留完整内容 |
| `getSystemMessageAppearance(type)` | `'routing' \| 'interrupt' \| 'waiting'` | `SystemMessageAppearance` | interrupt -> `{ tone: 'warning', color: 'yellow', prefix: '⚠' }`；routing -> `{ tone: 'muted', color: 'gray', prefix: '·' }`；waiting -> `{ tone: 'muted', color: 'gray', prefix: '›' }` |
| `toneToColor(tone)` | `StreamTone` | `string` | warning -> `'red'`，muted -> `'gray'`，accent -> `'cyan'`，neutral -> `'white'` |

#### 内部辅助

| 函数 | 说明 |
|------|------|
| `toneForActivity(kind)` | activity -> `'accent'`，result -> `'muted'`，error -> `'warning'` |
| `splitParagraphs(text)` | 按双换行分割并 trim，过滤空段落 |
| `summarizeActivityRun(run)` | 将连续的 activity block 数组折叠为 `activity_summary`：统计 action / result / error 数量，提取最新 activity 的标题和首行内容作为摘要；tone 按 error > activity > result 优先级决定 |

#### 依赖

- `display-mode.ts` -- `DisplayMode` 类型
- `markdown-parser.ts` -- `MarkdownSegment` 类型

---

### 25. task-banner-layout.ts -- 任务 banner 布局

任务 banner 的文本截断和宽度分配。将任务摘要文本截断到可用宽度，支持 CJK 宽字符的正确宽度计算。

#### 核心类型

```ts
interface TaskBannerLayout {
  columns: number;
  prefixText: string;      // "▸ Task"
  displayText: string;     // 截断后的任务摘要
  availableWidth: number;
}

interface BuildTaskBannerLayoutOptions {
  taskSummary: string;
  columns: number;
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `truncateTaskSummary(text, maxWidth)` | 任务摘要文本 + 最大宽度 | `string` | 先将连续空白规范化为单空格并 trim；若视觉宽度 <= maxWidth 则原样返回；否则逐字符累加宽度（通过 `getCharWidth` 支持 CJK），截断并追加 `…` |
| `buildTaskBannerLayout(options)` | `BuildTaskBannerLayoutOptions` | `TaskBannerLayout` | 计算 prefix（`"▸ Task"`）宽度，`availableWidth = max(1, columns - prefixWidth - 3)`，对 taskSummary 调用 `truncateTaskSummary` |

#### 依赖

- `message-lines.ts` -- `computeStringWidth` 和 `getCharWidth` 函数

---

## Shared Layout Primitives

> 统一 OpenTUI 布局原语层。将 Setup 向导、Session 主界面、Overlay 等屏幕的共享布局逻辑提取为独立模块，实现跨屏幕一致的视觉风格和响应式尺寸计算。`tui-layout-model.ts` 提供纯数据模型（零 React 依赖），`tui-layout.tsx` 提供对应的 React 组件库。

### 26. screen-shell-layout.ts — 屏幕 shell 尺寸计算

统一的 surface 宽度 clamp 函数，为三种屏幕场景提供响应式宽度计算。通过 `clampWidth(columns, maxWidth, gutter, minWidth)` 内部辅助函数实现：先减去 gutter 得到可用宽度，再 clamp 到 `[minWidth, maxWidth]` 范围。

#### 导出常量

| 常量 | 值 | 说明 |
|------|---|------|
| `SETUP_SURFACE_MAX_WIDTH` | 70 | Setup 向导面板最大宽度 |
| `OVERLAY_SURFACE_MAX_WIDTH` | 88 | Overlay（Help/Context/Timeline/Search）最大宽度 |
| `SESSION_CONTENT_MAX_WIDTH` | 104 | Session 主界面内容区最大宽度 |

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `computeSetupSurfaceWidth(columns)` | 终端列宽 | `number` | `clampWidth(columns, 70, 6, 44)` — Setup 面板宽度，最小 44 |
| `computeOverlaySurfaceWidth(columns)` | 终端列宽 | `number` | `clampWidth(columns, 88, 6, 42)` — Overlay 面板宽度，最小 42 |
| `computeSessionContentWidth(columns)` | 终端列宽 | `number` | `clampWidth(columns, 104, 6, 48)` — Session 内容宽度，最小 48 |
| `computeSetupDividerWidth(surfaceWidth)` | surface 宽度 | `number` | `max(20, surfaceWidth - 10)` — Setup 内部分隔线宽度 |

---

### 27. setup-copy.ts — Setup 向导文案定义

面向工作流的 Setup 向导文案常量。将 hero 区域文案从组件中提取为独立模块，便于统一维护和本地化。

#### 导出常量

| 常量 | 类型 | 值 |
|------|------|---|
| `SETUP_HERO_SLOGAN` | `string` | `'Coder explores. Reviewer pressure-tests. God converges.'` |
| `SETUP_HERO_SUBHEAD` | `string` | `'A three-role coding workflow that routes work, pressure-tests changes, and converges on a clear next step.'` |
| `SETUP_FEATURE_BULLETS` | `readonly string[]` | 3 条 feature 描述（Coder executes / Reviewer checks / God routes） |

---

### 28. setup-wizard-layout.ts — Setup 向导布局模型

Setup 向导的 stepper 分组模型和 hero 区域响应式布局计算。将 9 个 `SetupPhase` 分组为 6 个 stepper 步骤，并根据终端行数决定 hero 区域的展示粒度。

#### 核心类型

```ts
interface SetupStepperItem {
  key: string;
  label: string;
  state: 'complete' | 'active' | 'pending';
}

interface SetupHeroLayout {
  compact: boolean;        // rows <= 28 时启用紧凑模式
  showBullets: boolean;    // rows >= 30 时显示 feature bullets
  showSubhead: boolean;    // 始终为 true
  showVersionLine: boolean; // rows >= 32 时显示版本行
  topMargin: 0 | 1;       // compact 模式下为 0，否则为 1
}
```

#### 常量

- `SETUP_PANEL_WIDTH = 70` — Setup 面板固定宽度

#### Stepper 分组

| key | label | 对应 SetupPhase |
|-----|-------|----------------|
| `project` | Project | `select-dir` |
| `coder` | Coder | `select-coder`, `coder-model` |
| `reviewer` | Reviewer | `select-reviewer`, `reviewer-model` |
| `god` | God | `select-god`, `god-model` |
| `task` | Task | `enter-task` |
| `confirm` | Confirm | `confirm` |

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `buildSetupStepperModel(currentPhase)` | `SetupPhase` | `SetupStepperItem[]` | 查找当前 phase 所在分组的 index，index 之前的分组为 `'complete'`，当前分组为 `'active'`，之后为 `'pending'` |
| `buildSetupHeroLayout(rows)` | 终端行数 | `SetupHeroLayout` | 根据行数阈值决定 compact/showBullets/showVersionLine |

---

### 29. tui-layout-model.ts — TUI layout model

纯数据模型层，提供面板色调（`PanelTone`）、选择行（`SelectionRowModel`）、分隔线内容等 UI 原语的计算函数。零 React 依赖，可独立单测。

#### 核心类型

```ts
type PanelTone = 'hero' | 'section' | 'overlay' | 'warning';

interface PanelToneModel {
  borderColor: string;
  titleColor: string;
}

interface SelectionRowModel {
  chevron: string;       // 选中 '▸'，未选中 '·'
  chevronColor: string;  // 选中 'cyan'，未选中 'gray'
  textColor: string;     // 选中 'cyan'，未选中 'white'
  emphasis: boolean;     // 是否加粗
  label: string;
  suffix?: string;
}
```

#### 核心函数

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `buildPanelTone(tone)` | `PanelTone` | `PanelToneModel` | hero/overlay -> `cyan/cyan`；warning -> `yellow/yellow`；section/default -> `gray/white` |
| `buildDividerContent(width)` | 宽度 | `string` | 生成 `─` 重复 `width - 1` 次的字符串，前导一个空格 |
| `buildSelectionRowModel({ label, selected, suffix })` | 配置对象 | `SelectionRowModel` | selected=true 时 chevron `'▸'` + cyan + bold；false 时 `'·'` + gray |
| `buildRowProps()` | 无 | `{ flexDirection: 'row' }` | 返回 row 方向的 flex props |

#### 色调映射

| PanelTone | borderColor | titleColor |
|-----------|-------------|------------|
| `hero` | cyan | cyan |
| `overlay` | cyan | cyan |
| `warning` | yellow | yellow |
| `section` | gray | white |

---

### 30. tui-layout.tsx — TUI layout 组件库

基于 `tui-layout-model.ts` 纯数据模型的 React 组件库。提供统一的 OpenTUI 布局原语，被 Setup 向导、Session 界面、Overlay 等屏幕共享使用。从 `tui/primitives.tsx` 导入 `Box` 和 `Text`。

#### 导出组件

| 组件 | Props | 说明 |
|------|-------|------|
| `Row` | `BoxProps` | 水平布局容器（`flexDirection: 'row'`） |
| `Column` | `BoxProps` | 垂直布局容器（`flexDirection: 'column'`） |
| `CenteredContent` | `{ children, width, height?, justifyContent? }` | 居中内容包装器：外层 Column 100% 宽高，内层 Row 100% 宽 + `justifyContent: 'center'`，再内层 Column 指定 width |
| `Panel` | `BoxProps & { tone?: PanelTone }` | 带圆角边框的面板（`borderStyle: 'round'`），颜色由 `buildPanelTone(tone)` 决定，默认 `tone='section'`，`paddingX={1}` |
| `Divider` | `{ width, color? }` | 水平分隔线，默认灰色 dim |
| `SectionTitle` | `{ title, tone? }` | 段标题，颜色由 `buildPanelTone(tone)` 的 `titleColor` 决定，加粗 |
| `LabelValueRow` | `{ label, value, labelWidth?, valueColor? }` | 标签-值行，label 固定宽度（默认 14）dim + bold，value 区域 flexGrow |
| `SelectionRow` | `{ label, selected, suffix? }` | 选择行，通过 `buildSelectionRowModel` 计算样式，显示 chevron + label + 可选 suffix（dim） |
| `PromptRow` | `{ prompt?, promptColor?, value, placeholder?, cursor?, leadingSpace? }` | 输入提示行，空值时显示 placeholder（dim），有值时显示 value + cursor（inverse） |
| `FooterHint` | `{ text }` | 底部提示文本（dim 颜色） |

#### 重导出

同时重导出 `tui-layout-model.ts` 的 `buildDividerContent`、`buildPanelTone`、`buildRowProps`、`buildSelectionRowModel`，使消费方可从单一入口导入模型函数和组件。

---

## 模块间依赖关系

```
TUI 适配层:
  tui/primitives.tsx ──> @opentui/core (createTextAttributes, ParsedKey)
                     ──> @opentui/react (useAppContext, useKeyboard)

  tui/cli.tsx ──> @opentui/core (createCliRenderer)
              ──> @opentui/react (createRoot)
              ──> ui/components/App.tsx
              ──> tui/app.tsx (TuiApp)
              ──> session/session-starter.ts
              ──> adapters/detect.ts

  tui/runtime/bun-launcher.ts ──> node:child_process, node:fs, node:path

Core UI 依赖:
  message-lines.ts ──> markdown-parser.ts (parseMarkdown)
                   ──> display-mode.ts (DisplayMode 类型)
                   ──> types/ui.ts (Message, getRoleStyle, RoleName)

  keybindings.ts ──> tui/primitives.ts (Key 类型)

  overlay-state.ts ──> types/ui.ts (Message)

  directory-picker-state.ts ──> node:fs, node:path
                             ──> tui/primitives.ts (Key 类型)

  session-runner-state.ts ──> types/adapter.ts (OutputChunk)
                           ──> session/session-manager.ts (LoadedSession, SessionState)
                           ──> engine/workflow-machine.ts (WorkflowContext)
                           ──> types/god-schemas.ts (GodTaskAnalysis)
                           ──> types/session.ts (SessionConfig)
                           ──> types/ui.ts (Message, RoleName)

God LLM UI 依赖:
  god-fallback.ts ──> god/watchdog.ts (WatchdogService)

  god-message-style.ts ──> (无外部依赖，纯样式定义)

  phase-transition-banner.ts ──> (无外部依赖)

  reclassify-overlay.ts ──> task-analysis-card.ts (TaskType)
                         ──> god/god-audit.ts (GodAuditEntry, appendAuditLog)

  task-analysis-card.ts ──> types/god-schemas.ts (GodTaskAnalysis)

Runtime/Lifecycle 依赖:
  completion-flow.ts ──> (无外部依赖，纯字符串拼接)

  global-ctrl-c.ts ──> (无外部依赖，纯时间戳计算)

  safe-shutdown.ts ──> (无外部依赖，duck typing 接口)

Layout Primitives 依赖:
  code-block-layout.ts ──> (无外部依赖，纯布局计算)

  input-area-layout.ts ──> (无外部依赖，纯布局计算)

  message-blocks.ts ──> types/ui.ts (Message, getRoleStyle)
                     ──> display-mode.ts (DisplayMode)

  status-bar-layout.ts ──> message-lines.ts (computeStringWidth)

  stream-renderer-layout.ts ──> display-mode.ts (DisplayMode)
                              ──> markdown-parser.ts (MarkdownSegment)

  task-banner-layout.ts ──> message-lines.ts (computeStringWidth, getCharWidth)

Shared Layout Primitives 依赖:
  screen-shell-layout.ts ──> (无外部依赖，纯数值计算)

  setup-copy.ts ──> (无外部依赖，纯常量)

  setup-wizard-layout.ts ──> ui/components/SetupWizard.ts (SetupPhase 类型)

  tui-layout-model.ts ──> (无外部依赖，纯数据模型)

  tui-layout.tsx ──> tui/primitives.tsx (Box, Text, BoxProps)
                  ──> tui-layout-model.ts (buildDividerContent, buildPanelTone, buildRowProps, buildSelectionRowModel)

MainLayout 组件消费:
  display-mode.ts, keybindings.ts,
  overlay-state.ts, message-lines.ts
  (滚动由 OpenTUI ScrollBox 原生管理)

App/SessionRunner 组件消费:
  session-runner-state.ts, god-fallback.ts,
  phase-transition-banner.ts, reclassify-overlay.ts,
  task-analysis-card.ts, completion-flow.ts,
  global-ctrl-c.ts, safe-shutdown.ts
```
