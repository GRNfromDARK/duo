# UI 组件

> 路径: `src/ui/components/*.tsx`

## 技术框架

Duo 的终端 UI 基于以下技术栈：

- **OpenTUI** (`@opentui/core` + `@opentui/react`) — 替代 Ink 的终端 UI 框架，通过 `src/tui/primitives.tsx` 提供 Ink 兼容 API（`Box`、`Text`、`ScrollBox`、`useInput`、`useApp`、`useStdout`），使组件代码零改动迁移
- **@xstate/react** — 通过 `useMachine` hook 驱动工作流状态机 (`workflowMachine`)，实现 CODING -> ROUTING -> REVIEWING -> EVALUATING 等状态转换
- **纯函数状态层** — 所有复杂逻辑提取到 `src/ui/*.ts`（见 `ui-state.md`），组件仅负责渲染和事件绑定
- **TUI 适配层** — `src/tui/` 目录（见 `ui-state.md` TUI 层一节），负责 OpenTUI 原语桥接、CLI 入口和 Bun 运行时定位
- **统一 OpenTUI 布局原语** — `src/ui/tui-layout.tsx` + `src/ui/tui-layout-model.ts` 提供跨屏幕共享的 `Row`/`Column`/`Panel`/`Divider`/`SelectionRow` 等复合布局组件（见 `ui-state.md` Shared Layout Primitives 一节）

整个 UI 组件层共 **21 个组件**，分为三组：
- **Core 组件**（14 个）— 通用 UI 组件：布局、输入、消息渲染、Overlay、状态栏等
- **God LLM 组件**（4 个）— God 决策层专用组件：阶段切换、重分类、Setup 向导、任务分析
- **Lifecycle 组件**（3 个）— 任务完成屏幕、任务 banner、思考指示器

> **OpenTUI 迁移说明**：`ScrollIndicator.tsx` 组件已删除。其功能由 OpenTUI 的 `ScrollBox` 组件原生提供（`stickyScroll` 自动跟随、`scrollBy`/`scrollTo` 编程滚动）。MainLayout 现在直接使用 `ScrollBox` 管理消息区滚动，不再需要手动 scroll state 管理。

> **统一 OpenTUI 布局迁移**：Setup 向导和 Session 主界面已统一到 OpenTUI 主题下。共享布局原语（`screen-shell-layout.ts` 的响应式宽度计算、`tui-layout.tsx` 的 `Panel`/`Row`/`Column`/`CenteredContent` 等组件、`tui-layout-model.ts` 的 `PanelTone` 色调系统）确保所有屏幕使用一致的视觉风格。Setup 向导的 hero 文案提取到 `setup-copy.ts`，stepper 和 hero 区域布局逻辑提取到 `setup-wizard-layout.ts`。详见 `ui-state.md` Shared Layout Primitives 一节。

> **Paste 支持**：`tui/primitives.tsx` 新增 `usePaste` hook，为所有 TUI 输入组件启用 bracketed paste mode 支持。InputArea、CompletionScreen、SearchOverlay 等包含文本输入的组件均已集成 paste 功能，用户可通过 Cmd+V / Ctrl+V 粘贴文本到任何输入场景。

## 组件树结构

```
App (根组件)
├── [Setup 阶段]
│   └── SetupWizard
│       ├── BrandHeader (内部)         — ASCII art logo + 版本号
│       ├── ProgressStepper (内部)     — 6 步进度指示器
│       ├── DirectoryPicker            — 项目目录选择
│       ├── CLISelector (内部)         — Coder/Reviewer 选择
│       ├── GodSelector (导出)         — God adapter 选择
│       ├── ModelSelector (导出)       — 模型选择
│       ├── TaskInput (内部)           — 任务描述输入
│       └── ConfirmScreen (导出)       — 配置确认
│
└── [Session 阶段] SessionRunner (App 内部)
    ├── TaskAnalysisCard               — God 任务分析卡片
    ├── PhaseTransitionBanner          — 阶段切换 escape window
    ├── ReclassifyOverlay              — 运行时任务重分类
    ├── CompletionScreen               — 任务完成后续选择
    └── MainLayout
        ├── StatusBar                  — 顶部状态栏（含 God 信息）
        ├── TaskBanner                 — 持久任务目标展示
        ├── ScrollBox                  — OpenTUI 原生滚动容器（stickyScroll）
        │   ├── RenderedLineView[]     — 消息行列表（基于 message-lines.ts）
        │   │   └── LineSpan 渲染     — 逐 span 着色
        │   └── ThinkingIndicator      — LLM 思考中动画
        ├── InputArea                  — 用户输入区域
        └── [Overlay 层]（全屏替换布局）
            ├── HelpOverlay            — 快捷键帮助
            ├── ContextOverlay         — 会话上下文
            ├── TimelineOverlay        — 事件时间线
            └── SearchOverlay          — 消息搜索

其他组件（由 StreamRenderer / App 外部使用）：
  ├── MessageView              — 单条消息渲染（含 StreamRenderer）
  ├── StreamRenderer           — Markdown 流式渲染
  │   └── CodeBlock            — 可折叠代码块
  ├── SystemMessage            — 系统消息（routing/interrupt/waiting）
  └── DisagreementCard         — 分歧卡片
```

---

## Core 组件（14 个）

### 1. App.tsx — 根组件

**Props**:

```ts
interface AppProps {
  initialConfig?: SessionConfig;   // 命令行传入的初始配置
  detected: DetectedCLI[];         // 检测到的 CLI 工具列表
  resumeSession?: LoadedSession;   // 要恢复的会话（可选）
}
```

**职责**:
- 判断配置是否完整（`projectDir` + `coder` + `reviewer` + `god` + `task` 均存在），决定进入 Setup 还是 Session 阶段
- Setup 阶段：渲染 `SetupWizard`，完成后获得完整 `SessionConfig`
- Session 阶段：实例化内部 `SessionRunner`，传入最终 `SessionConfig`
- 全局 Ctrl+C 处理：使用 `resolveGlobalCtrlCAction` 区分单次中断与双击安全退出，双击触发 `performSafeShutdown`
- 复制选中文本：鼠标拖选结束时自动通过 OSC52 复制到剪贴板（auto-copy on selection），无需额外按键。同时 Ctrl+C / Cmd+C（macOS `key.super`）/ Option+C（`key.meta`）在有活跃文本选区时也通过 OSC52 复制而非触发中断。采用 identity-based selection cache：在 `renderer` 的 `'selection'` 事件触发时缓存选中文本和 Selection 对象引用，当流式渲染导致 `getSelectedText()` 返回空字符串时，通过对象 identity 校验回退到缓存文本，防止 stale cache 泄漏到新选区
- 支持 session 重启：通过 `sessionRunKey` 递增触发 SessionRunner 重新挂载，支持 CompletionScreen 的 "Continue" / "New task" 流

**SessionRunner — App 内部的 Session 阶段核心组件**:

```ts
interface SessionRunnerProps {
  config: SessionConfig;
  detected: DetectedCLI[];
  columns: number;
  rows: number;
  resumeSession?: LoadedSession;
}
```

SessionRunner 的职责包括：
- 通过 `useMachine(workflowMachine)` 创建 xstate actor
- 持有 adapter（coder、reviewer、god）、SessionManager、OutputStreamManager 等服务的 `useRef`
- 管理 `messages`（`Message[]`）、`tokenCount`、`timelineEvents` 等 UI 状态
- 管理 God 相关状态：`godTaskAnalysis`、`currentPhaseId`
- 监听 `CODING` 状态：启动 coder adapter 流式执行，通过 `createStreamAggregation` + `applyOutputChunk` 聚合输出
- 监听 `REVIEWING` 状态：与 CODING 对称
- 监听 `GOD_DECIDING` 状态：调用 God adapter 进行自动决策
- 处理 God 任务分析：session 启动时显示 `TaskAnalysisCard`
- 处理阶段切换：compound 任务显示 `PhaseTransitionBanner`
- 处理 Ctrl+R：显示 `ReclassifyOverlay`
- 处理任务完成：`DONE` 状态显示 `CompletionScreen`，支持 continue/new-task/exit 三种后续操作
- 处理用户输入和中断
- 会话持久化（含 God 状态恢复）
- 向 App 注册全局 Ctrl+C handler（`registerGlobalCtrlCHandlers`），提供 interrupt 和 safeExit 回调

**副作用管理模式**: 每个 xstate 状态对应一个 `useEffect`，依赖 `stateValue` 变化。CODING 和 REVIEWING 的 effect 包含 cleanup 函数（`cancelled = true; osm.interrupt()`），确保组件卸载或状态切换时中断进程。

**关键导入**: `workflowMachine`、`createAdapter`、`createGodAdapter`、`OutputStreamManager`、`SessionManager`、`GodAuditLogger`、`WatchdogService`、`initializeTask`、`classifyInterruptIntent`、`executeActions`（hand-executor）、`processWorkerOutput`（observation-integration）、`dispatchMessages`（message-dispatcher）等。

---

### 2. MainLayout.tsx — 主布局组件

**Props**:

```ts
interface MainLayoutProps {
  messages: Message[];
  statusText?: string;              // @deprecated，使用 statusBarProps
  columns: number;
  rows: number;
  isLLMRunning?: boolean;
  workflowState?: WorkflowStateHint;  // 上下文感知的状态指示器
  onInputSubmit?: (text: string) => void;
  onNewSession?: () => void;
  onInterrupt?: () => void;
  onClearScreen?: () => void;
  onReclassify?: () => void;
  statusBarProps?: {
    projectPath: string;
    status: WorkflowStatus;
    activeAgent: string | null;
    tokenCount: number;
    taskType?: string;
    currentPhase?: string;
    godAdapter?: string;
    reviewerAdapter?: string;
    coderModel?: string;
    reviewerModel?: string;
    godLatency?: number;
  };
  contextData?: {
    coderName: string;
    reviewerName: string;
    taskSummary: string;
    tokenEstimate: number;
  };
  timelineEvents?: TimelineEvent[];
  footer?: React.ReactNode;
  footerHeight?: number;
  suspendGlobalKeys?: boolean;
}
```

**`WorkflowStateHint` 类型**:

```ts
type WorkflowStateHint =
  | { phase: 'idle' }
  | { phase: 'llm_running' }          // CODING/REVIEWING
  | { phase: 'task_init' }            // God 正在分析任务
  | { phase: 'god_deciding' }         // God 正在做路由决策
  | { phase: 'god_convergence' }      // God 评估 post-reviewer 收敛（任务是否完成）
  | { phase: 'observing' }            // 分类输出
  | { phase: 'executing' }            // Hand executor 执行动作
  | { phase: 'classifying_intent' }   // 分类用户中断意图
  | { phase: 'done' };
```

**职责**: Session 阶段的核心布局组件，整合所有 UI 状态模块，管理消息区滚动、显示模式、Overlay 和输入。

**布局结构**（从上到下）:

| 区域 | 高度 | 内容 |
|------|------|------|
| Status Bar | 1 行 | `StatusBar` 组件或 fallback `<Text inverse bold>` |
| Task Banner | 0-1 行 | `TaskBanner` 组件（仅当有 `contextData.taskSummary` 时显示） |
| 分隔线 | 1 行 | `─` 填充 |
| 消息区 | 动态行 | OpenTUI `ScrollBox`（`stickyScroll`）内的 `RenderedLineView` 列表 + ThinkingIndicator |
| 分隔线 | 1 行 | `─` 重复 `columns` 次 |
| InputArea / Footer | 3 行或自定义 | 用户输入区域或自定义 footer（如 CompletionScreen inline 模式） |

**关键行为**:

- **消息渲染管线**: `messages` -> `filterMessages(displayMode)` -> `.slice(clearedCount)` -> `buildRenderedMessageLines(columns)` -> `RenderedLineView` 组件列表
- **滚动管理**: 使用 OpenTUI `ScrollBox` 组件原生管理滚动。`stickyScroll` prop 实现自动跟随（新消息到达时自动滚到底部）。通过 `scrollRef.current.scrollBy({ x: 0, y: delta })` 和 `scrollRef.current.scrollTo({ x: 0, y: target })` 实现编程滚动（j/k 快捷键、PageUp/PageDown、G 跳底）
- **显示模式**: 持有 `DisplayMode`（默认 `'minimal'`），通过 `toggleDisplayMode` 切换
- **Overlay 状态**: 持有 `OverlayState`（来自 `overlay-state.ts`），有 overlay 时全屏替换正常布局（渲染 HelpOverlay/ContextOverlay/TimelineOverlay/SearchOverlay）
- **清屏功能**: `Ctrl+L` 记录 `clearedCount`（当前已过滤消息数），后续只显示新消息，不删除历史
- **上下文感知指示器**: `resolveIndicatorConfig(workflowState, isLLMRunning, messages)` 根据 `WorkflowStateHint.phase` 返回不同的指示器配置（message/color/showElapsed），如 `task_init` -> "Analyzing task..."（yellow, showElapsed:true）；`god_convergence` -> "Evaluating convergence..."（yellow, showElapsed:true）；`llm_running` 仅在 `shouldShowThinking` 返回 true 时显示
- **键盘处理**: `useInput` -> `processKeybinding(input, key, ctx)` -> `handleAction(action)`，分发到各状态更新函数；`suspendGlobalKeys` 为 true 时忽略所有按键
- **Search overlay 输入**: 当 search overlay 打开时，额外将文本输入路由到 `updateSearchQuery`；Backspace 删末字符，普通字符追加，忽略 ctrl/escape/return/tab/`/`
- **Footer 插槽**: `footer` prop 允许替换默认 InputArea 为自定义内容；`footerHeight` 指定高度（默认 `INPUT_AREA_HEIGHT = 3`）
- **InputArea 集成**: InputArea 为非受控模式，通过 `onValueChange` 通知 MainLayout 输入是否为空（驱动 `inputEmpty` 状态，用于 j/k 滚动快捷键路由判断），`disabled` 在 overlay 打开时为 true；`onSpecialKey` 处理 `?` 和 `/` 打开对应 overlay

**内部组件 `RenderedLineView`**: 接收 `RenderedMessageLine`，渲染为 `<Box>` 内的多个 `<Text>` span，每个 span 应用 `color`/`bold`/`dimColor` 样式。

---

### 3. StatusBar.tsx — 状态栏

**Props**:

```ts
type WorkflowStatus = 'idle' | 'active' | 'error' | 'routing' | 'interrupted' | 'done';

interface StatusBarProps {
  projectPath: string;
  status: WorkflowStatus;
  activeAgent: string | null;
  tokenCount: number;
  columns: number;
  godAdapter?: string;
  reviewerAdapter?: string;
  coderModel?: string;
  reviewerModel?: string;
  taskType?: string;
  currentPhase?: string;
  godLatency?: number;        // God 决策延迟 (ms)
}
```

**职责**: 渲染顶部 1 行状态栏，固定高度。

**布局**: ` Duo  <项目路径>  <Agent> <icon> <status>  ⊛model  [taskType]  φ:phase  God:X  Nms  Ntok`

**关键行为**:
- 状态图标和颜色由 `STATUS_CONFIG` 映射：active=绿色 `◆`，idle=白色 `◇`，error=红色 `⚠`，routing=黄色 `◈`，interrupted=白色 `⏸`，done=绿色 `◇`
- token 计数 >= 1000 时显示为 `N.Mk` 格式（如 `1.5k`），后缀 `tok`
- 使用 `<Text inverse bold>` 实现反色高亮背景
- **优先级自适应宽度**: 每个 Segment 使用 `priority`（1-5）标记重要度，终端宽度不足时从最低优先级（数字最大）开始隐藏，priority 1 永不隐藏

**段优先级分配**:

| 段 | Priority | 位置 |
|----|----------|------|
| `Duo` | 1 | 左侧 |
| `projectPath` | 4 | 左侧 |
| agent + status | 2 | 左侧 |
| model `⊛model` | 4 | 左侧 |
| taskType `[type]` | 3 | 左侧 |
| phase `φ:phase` | 3 | 左侧 |
| God adapter | 4 | 右侧 |
| latency `Nms` | 5 | 右侧 |
| token count | 2 | 右侧 |

**God 信息显示**:
- `taskType` — cyan 颜色显示 `[taskType]`
- `currentPhase` — magenta 颜色显示 `φ:phase`
- `godAdapter` — 仅与 reviewer 不同时显示 `God:X`（magenta）
- `godLatency` — dim 颜色显示延迟毫秒数
- `activeModel` — 根据 activeAgent 是否包含 `:Coder` 或 `:Reviewer` 选择对应 model 显示

---

### 4. CodeBlock.tsx — 可折叠代码块

**Props**:

```ts
interface CodeBlockProps {
  content: string;
  language?: string;
  expanded?: boolean;         // 受控展开状态（undefined 时根据行数自动决定）
  onToggle?: () => void;      // 展开/折叠切换回调
}
```

**职责**: 渲染带语法提示的代码块，超长时自动折叠。

**关键行为**:
- **折叠阈值**: `FOLD_THRESHOLD = 10` 行
- **预览行数**: `PREVIEW_LINES = 5` 行
- 超过 10 行时默认折叠（`expanded ?? false`），显示前 5 行 + `[▶ Expand · N lines]` 提示（cyan）
- 展开状态下显示 `[▼ Collapse · N lines]`（cyan）
- 10 行及以下始终展开
- 代码行以 `backgroundColor="gray" color="white"` 渲染，每行前后各有一个空格
- 语言标签以 dim 颜色显示在代码块上方（` language`）
- 空 content 时 lines 为空数组

---

### 5. DirectoryPicker.tsx — 目录选择器

**Props**:

```ts
interface DirectoryPickerProps {
  onSelect: (dir: string) => void;
  onCancel: () => void;
  mruFile?: string;       // 默认 ~/.duo/recent.json
  scanDirs?: string[];    // 默认 ~/Projects, ~/Developer, ~/code
}
```

**职责**: Setup 阶段的项目目录选择器。

**关键行为**:
- **初始化**: 使用 `useMemo` 在挂载时加载 MRU（`loadMRU`）和发现 Git 仓库（`discoverGitRepos`）
- **路径输入** — 用户可直接输入路径，Tab 键触发自动补全
- **Tab 补全** — 单个匹配直接填入（末尾加 `/`），多个匹配显示 cyan 颜色的补全列表
- **MRU 列表** — 从 `mruFile` 加载最近使用的目录，选择后调用 `addToMRU` + `saveMRU` 更新
- **Git 仓库发现** — 扫描 `scanDirs` 下的一级子目录，发现含 `.git` 的目录
- **非 Git 警告** — 选择非 Git 仓库时设置黄色 warning `"Warning: Selected directory is not a git repository (Codex requires git)"`
- **导航** — 上下箭头在合并列表中切换（MRU 在前，discovered 在后），Enter 选择，Esc 取消
- **列表合并和去重**: `items = [...mru]`，然后添加不在 MRU 中的 discovered 项
- 外框 `borderStyle="single"`，标题 `Select Project Directory`（cyan 加粗）
- 路径中的 `$HOME` 显示为 `~`
- 选中项以 `> ` 前缀和绿色高亮
- 处理逻辑委托给 `processPickerInput` 纯函数

---

### 6. HelpOverlay.tsx — 快捷键帮助

**Props**:

```ts
interface HelpOverlayProps {
  columns: number;
  rows: number;
}
```

**职责**: 全屏显示完整的快捷键列表。

**关键行为**:
- 数据源为 `keybindings.ts` 的 `KEYBINDING_LIST`（15 项）
- 圆角边框 (`borderStyle="round"`)，cyan 边框色
- 快捷键列宽 18 字符，黄色加粗；描述为默认颜色
- 根据终端行数限制可见条目数 (`maxVisible = rows - 6`，预留标题 + 边框 + 底部提示)
- 居中标题 `Keybindings`（cyan 加粗）
- 底部居中提示 `Press Esc to close`（dim 颜色）

---

### 7. ContextOverlay.tsx — 会话上下文信息

**Props**:

```ts
interface ContextOverlayProps {
  columns: number;
  rows: number;
  coderName: string;
  reviewerName: string;
  taskSummary: string;
  tokenEstimate: number;
}
```

**职责**: 全屏显示当前会话的上下文摘要信息。

**关键行为**:
- 标签列宽 16 字符，显示 4 项信息：
  - Coder — 蓝色
  - Reviewer — 绿色
  - Task — 默认颜色
  - Tokens — 默认颜色
- 居中标题 `Context Summary`（cyan 加粗）
- 圆角边框，cyan 边框色，`paddingX={1}`
- 底部居中提示 `Press Esc to close`

---

### 8. TimelineOverlay.tsx — 事件时间线

**Props**:

```ts
interface TimelineEvent {
  timestamp: number;
  type: 'task_start' | 'coding' | 'reviewing' | 'converged' | 'interrupted' | 'error';
  description: string;
}

interface TimelineOverlayProps {
  columns: number;
  rows: number;
  events: TimelineEvent[];
}
```

**职责**: 按时间顺序展示工作流事件历史。

**关键行为**:
- 每个事件类型有对应颜色：task_start=白色，coding=蓝色，reviewing=绿色，converged=青色，interrupted=黄色，error=红色（`EVENT_COLORS` 映射）
- 时间列宽 12 字符，显示 `new Date(event.timestamp).toLocaleTimeString()` 格式（dim 颜色）
- 只显示最近 `maxVisible = rows - 6` 条事件（从尾部截取 `events.slice(-maxVisible)`）
- 无事件时显示 `No events yet`（dim 颜色）
- 居中标题 `Event Timeline`（cyan 加粗）
- 圆角边框，cyan 边框色

---

### 9. SearchOverlay.tsx — 消息搜索

**Props**:

```ts
interface SearchOverlayProps {
  columns: number;
  rows: number;
  query: string;
  results: Message[];
}
```

**职责**: 全屏搜索消息历史并展示匹配结果。

**关键行为**:
- 搜索栏前缀 `/ `（黄色加粗），空查询时显示占位符 `Type to search...`（dim），有查询时在末尾显示 `█` 光标（dim）
- 结果列表：左侧 10 字符宽显示角色名（使用 `ROLE_STYLES[msg.role]` 配色加粗），右侧显示消息预览
- 消息预览根据终端宽度截断（`columns - 20`），超长时末尾添加 `...`（截断到 `columns - 23`）
- 最大结果数 `maxResults = rows - 7`（标题 + 搜索栏 + 底部提示 + 边框）
- 空查询显示 `Enter a search term`；无匹配显示 `No results found`
- 搜索逻辑在 `overlay-state.ts` 的 `computeSearchResults` 中实现（大小写不敏感子串匹配）
- 圆角边框，cyan 边框色

---

### 10. InputArea.tsx — 用户输入区域

**Props**:

```ts
interface InputAreaProps {
  isLLMRunning: boolean;
  onSubmit: (text: string) => void;
  maxLines?: number;                      // 默认 5
  onValueChange?: (value: string) => void;  // 值变化通知（非受控）
  onSpecialKey?: (key: string) => void;   // 空输入时按 ? 或 / 的回调
  disabled?: boolean;                     // overlay 打开时禁用
}
```

**职责**: 用户文本输入区域，支持多行输入和光标控制。

**关键行为**:
- **非受控模式**：组件内部通过 `useState` 管理 `InputState`（`value` + `cursorPos`），通过 `onValueChange` 通知外部值变化（在 `useEffect` 中检测 `state.value` 变化后调用）
- **提交**: Enter 提交（仅 `value.trim()` 非空时），提交后重置为 `INITIAL_INPUT_STATE`（空值 + 光标位置 0）
- **多行**: Alt+Enter / Ctrl+Enter / Shift+Enter 在光标位置插入换行，最多 `maxLines` 行
- **光标移动**: 左右箭头移动光标；Home 跳到当前行首（`lastIndexOf('\n', cursorPos-1) + 1`）；End 跳到当前行尾；Ctrl+A 同 Home；Ctrl+E 同 End
- **行编辑**: Ctrl+K 删除光标到行尾的内容（若光标在行尾则删除换行符）；Backspace 删除光标前一个字符
- **特殊键**: 输入为空时按 `?` 或 `/` 返回 `{ type: 'special', key: input }` 触发 `onSpecialKey` 回调
- **忽略的键**: upArrow、downArrow、pageUp、pageDown、tab、escape、未处理的 ctrl 组合
- **占位符**: LLM 运行中显示 `"Type to interrupt, or wait for completion..."`；空闲时显示 `"Type a message..."`
- 输入提示符: LLM 运行中 `◆`（黄色），空闲时 `▸`（cyan）
- `disabled` 为 true 时 `useInput` 回调直接 return
- 多行显示时，第一行显示提示符，后续行缩进 2 空格；光标所在行在光标位置显示 `█`（dim）

**纯函数 `processInput(currentValue, cursorPos, input, key, maxLines)`**:
- 提取为独立纯函数以便测试
- 返回 `InputAction`: `submit` | `update` | `special` | `noop`

**辅助函数**:
- `getDisplayLines(value, maxLines)` — 按 `\n` 分割并截取前 `maxLines` 行用于渲染
- `getCursorLineCol(value, cursorPos)` — 计算光标所在的行号和列号（基于 `cursorPos` 前的文本按 `\n` 分割）

---

### 11. SystemMessage.tsx — 系统消息

**Props**:

```ts
interface SystemMessageProps {
  type: 'routing' | 'interrupt' | 'waiting';
  agentName?: string;
  displayMode?: DisplayMode;
  routingDetails?: RoutingDetails;  // { question: string, choices: string[] }
  outputChars?: number;
}
```

**职责**: 渲染三种系统级消息。

**关键行为**:

| type | Minimal 模式 | Verbose 模式 |
|------|-------------|-------------|
| `routing` | `· [Router] Choice detected → Forwarding to <Agent>` | 额外显示 question 和 choices 列表（`·   ` 缩进 + 编号） |
| `interrupt` | `⚠ INTERRUPTED - <Agent> process terminated (output: N chars)` | 同上 |
| `waiting` | `> Waiting for your instructions...` | 同上 |

- routing 消息全部为黄色（`·` 前缀 + `[Router]` 加粗 + 正文）
- interrupt 消息为黄色 `⚠` 标记 + `INTERRUPTED` 加粗
- waiting 消息为白色 `>` 前缀
- 内部由三个子组件 `RoutingMessage`、`InterruptMessage`、`WaitingMessage` 分别渲染

---

### 12. DisagreementCard.tsx — 分歧卡片

**Props**:

```ts
type DisagreementAction = 'continue' | 'decide' | 'accept_coder' | 'accept_reviewer';

interface DisagreementCardProps {
  currentRound: number;
  agreedPoints: number;
  totalPoints: number;
  onAction: (action: DisagreementAction) => void;
}
```

**职责**: 当 Coder 和 Reviewer 存在分歧时显示分歧信息和操作选项。

**关键行为**:
- 黄色圆角边框 (`borderColor="yellow"`)
- 标题 `⚡ DISAGREEMENT`（黄色加粗）+ ` · Round N`（黄色）
- 一致度统计：`Agreed: M/N    Disputed: K/N`（K = totalPoints - agreedPoints，灰色）
- 四个操作按钮分两行（`marginTop={1}`）：
  - 第一行：`[C] Continue`  `[D] Decide manually`
  - 第二行：`[A] Accept Coder's`  `[B] Accept Reviewer's`
- 键盘 `c`/`d`/`a`/`b`（不区分大小写）触发对应 action

---

### 13. MessageView.tsx — 消息渲染

**Props**:

```ts
interface MessageViewProps {
  message: Message;
  displayMode?: DisplayMode;  // 默认 'minimal'
}
```

**职责**: 渲染单条消息，包含角色头、时间戳和内容。

**注意**: 在当前架构中，MainLayout 使用 `message-lines.ts` 的 `buildRenderedMessageLines` 进行行级渲染，而非直接使用 MessageView 组件。MessageView 作为独立的可复用消息渲染组件存在。

**关键行为**:
- **角色头**: 使用 `ROLE_STYLES[message.role]` 获取颜色和边框字符，格式 `<border> [<displayName> · <roleLabel>] HH:MM`
- **Verbose 模式额外信息**: 时间戳精确到秒 (`HH:MM:SS`)，显示 `[Nk tokens]`（灰色），显示 `$ cliCommand`（dimColor 灰色）
- **内容委托**: 将 `message.content` 和 `message.isStreaming` 传递给 `StreamRenderer` 渲染
- `marginBottom={1}` 提供消息间距

---

### 14. StreamRenderer.tsx — Markdown 流式渲染

**Props**:

```ts
interface StreamRendererProps {
  content: string;
  isStreaming: boolean;
  displayMode?: DisplayMode;  // 默认 'minimal'
}
```

**职责**: 将 Markdown 内容解析为 segment 并渲染为终端 UI，支持流式输出。

**关键行为**:
- 通过 `useMemo` 调用 `parseMarkdown(content)` 并做 `compactSegments` 处理
- **Activity block 压缩** (Minimal 模式): `compactSegments` 将连续的 `activity_block` 压缩为单个 `activity_summary`，格式 `⏺ N actions · M results · K errors · latest <title>: <summary>`；Verbose 模式保持原样
- **代码块状态管理**: 使用 `expandedBlocks` (`Record<number, boolean>`) 追踪每个代码块的展开/折叠状态（`useState`），`toggleBlock` 通过 `useCallback` 切换指定 index 的展开状态
- **流式指示器**: `isStreaming` 为 true 时在内容末尾显示旋转 spinner（`⣾⣽⣻⢿⡿⣟⣯⣷`），字符基于 `content.length % 8` 选择（确保测试输出确定性），cyan 颜色
- **Segment 渲染映射**（通过内部 `SegmentView` 组件）:

| Segment 类型 | 渲染方式 |
|-------------|---------|
| `text` | 按 `\n` 分行，每行一个 `<Text>` |
| `code_block` | 委托给 `<CodeBlock>`，传入 `expanded` 和 `onToggle` |
| `activity_block` | `ActivityBlock` 子组件：根据 kind 显示图标（`⏺`/`⎿`/`⚠`）+ 颜色（cyan/gray/red）+ 标题摘要；verbose 模式下剩余内容行展开为 `CodeBlock(language="text")` |
| `activity_summary` | `ActivitySummary` 子组件：单行 `<Text color={color}>{icon} {summary}</Text>` |
| `inline_code` | 灰底白字 `backgroundColor="gray" color="white"` |
| `bold` | `<Text bold>` |
| `italic` | `<Text italic>` |
| `list_item` | `*`/`-` 显示为 `  •`（Unicode bullet），有序列表保留原始标记 |
| `table` | `TableView` 子组件：动态列宽（`max(headerWidth, maxDataWidth) + 2`），`-+-` 分隔线 |

**内部子组件**:
- `SegmentView` — segment 类型分发渲染
- `TableView` — 表格渲染，计算每列最大宽度，使用 `padEnd` 对齐
- `ActivitySummary` — 简洁的单行活动摘要
- `ActivityBlock` — 完整的活动块渲染，支持 minimal/verbose 模式

---

## God LLM 组件（4 个）

### 15. PhaseTransitionBanner.tsx — 阶段切换 Escape Window

**来源**: FR-010 (AC-033, AC-034)

**Props**:

```ts
interface PhaseTransitionBannerProps {
  nextPhaseId: string;
  previousPhaseSummary: string;
  onConfirm: () => void;
  onCancel: () => void;
}
```

**职责**: compound 任务阶段切换时显示 2 秒 escape window，允许用户确认或取消切换。

**关键行为**:
- 使用 `phase-transition-banner.ts` 的纯状态函数管理状态转换
- **2 秒等待窗口**: `PHASE_ESCAPE_WINDOW_MS = 2000`，超时自动确认
- **Progress bar**: 20 字符宽（`BAR_WIDTH = 20`），`█` 已填充 + `░` 未填充
- **摘要显示**: `previousPhaseSummary` 截断到 120 字符（`.slice(0, 120)`），dim 颜色，仅非空时显示
- **键盘**: `[Space]` 立即确认，`[Esc]` 取消（留在当前阶段）
- **样式**: magenta 圆角边框，标题 `⚡ Phase Transition → <nextPhaseId>`
- **回调保护**: 使用 `firedRef` 确保回调只触发一次
- **Countdown timer**: `PHASE_TICK_INTERVAL_MS(100)` interval
- 底部提示：`[Space] confirm transition   [Esc] stay in current phase`

---

### 16. ReclassifyOverlay.tsx — 运行时任务重分类

**来源**: FR-002a (AC-010, AC-011, AC-012)

**Props**:

```ts
interface ReclassifyOverlayProps {
  currentType: string;
  onSelect: (newType: string) => void;
  onCancel: () => void;
}
```

**职责**: Ctrl+R 触发的全屏 overlay，允许用户在 session 运行中更改任务类型。

**关键行为**:
- 使用 `reclassify-overlay.ts` 的纯状态函数管理选择和导航
- **可选类型**: `explore`、`code`、`review`、`debug`（不含 `compound` 和 `discuss`）
- **当前信息显示**: 当前任务类型 `[currentType]` 和描述
- **选择列表**: 每项显示 `[N] type  description`，当前类型标记 `← current`（黄色）
- **键盘**: 将 key 对象转换为字符串（`arrow_down`/`arrow_up`/`enter`/`escape`/原始 input），然后委托给 `handleReclassifyKey`
  - `↑/↓` 循环移动选择
  - `Enter` 确认当前选择
  - `1-4` 数字键直接选中并确认
  - `Esc` 取消（恢复原类型）
- **选中项高亮**: cyan 颜色 + `❯` 前缀 + 加粗
- **样式**: cyan 圆角边框，居中标题 `◈ Reclassify Task`（cyan 加粗）

**类型描述** (`RECLASSIFY_LABELS`):

| 类型 | 描述 |
|------|------|
| `explore` | Explore first, then code |
| `code` | Direct coding implementation |
| `review` | Code review only |
| `debug` | Focused debugging |

---

### 17. SetupWizard.tsx — Setup 向导

**Props**:

```ts
interface SetupWizardProps {
  detected: DetectedCLI[];
  initialConfig?: Partial<SessionConfig>;
  onComplete: (config: SessionConfig) => void;
}
```

**职责**: 完整的交互式 Setup 向导，引导用户完成多步配置流程。

**9 步流程** (`SetupPhase`):

| Phase | 内部组件 | 说明 | 下一步 |
|-------|---------|------|--------|
| `select-dir` | `DirectoryPicker` | 选择项目目录 | -> `select-coder` |
| `select-coder` | `CLISelector` | 选择 Coder CLI | -> `coder-model`（如支持）或 `select-reviewer` |
| `coder-model` | `ModelSelector` | 选择 Coder 模型 | -> `select-reviewer` |
| `select-reviewer` | `CLISelector` | 选择 Reviewer CLI（排除已选 Coder） | -> `reviewer-model`（如支持）或 `select-god` |
| `reviewer-model` | `ModelSelector` | 选择 Reviewer 模型 | -> `select-god` |
| `select-god` | `GodSelector` | 选择 God adapter | -> `god-model`（如支持）或 `enter-task` |
| `god-model` | `ModelSelector` | 选择 God 模型 | -> `enter-task` |
| `enter-task` | `TaskInput` | 输入任务描述 | -> `confirm` |
| `confirm` | `ConfirmScreen` | 确认配置并启动 | -> `onComplete` |

**模型选择跳过逻辑**: `adapterSupportsModel(name)` 通过 `getRegistryEntry(name).modelFlag` 判断适配器是否支持模型选择；不支持时直接跳过 model phase。

**内部子组件**:

- **BrandHeader** — 渲染 ASCII art logo（`DUO` 大字）+ 版本号 + slogan `"Coder writes. Reviewer guards. God decides."`，cyan 加粗，固定宽度 `HEADER_BOX_WIDTH = 70` 字符圆角边框；3 个 feature bullets 使用 `◆` 前缀（cyan）
- **ProgressStepper** — 6 步进度指示器（将 9 个 phase 分组为 6 个 stepper：Project/Coder/Reviewer/God/Task/Confirm），使用 `●`（已完成，绿色）/ `◉`（当前，cyan 加粗）/ `○`（未来，灰色）图标，步骤间用 `─` 连接
- **CLISelector** — 通用 CLI 选择器：过滤 `detected` 列表中已安装且不在 `exclude` 中的项；上下箭头导航 + Enter 选择；选中项 `▸` 前缀（cyan 加粗），显示 `displayName` + 可选的 `(version)`
- **GodSelector** — God adapter 专用选择器：通过 `getInstalledGodAdapters` 获取支持的适配器列表；reviewer 支持作为 God 时显示 `"Same as Reviewer"` 选项（`SAME_AS_REVIEWER` 常量）；推荐 `claude-code`（标记 `★ recommended` 黄色）；提示 God 以 stateless + tools disabled 模式运行
- **ModelSelector** — 模型选择器：通过 `getAdapterModels(cliName)` 获取可用模型列表；首项为 `"Use default"`；包含 `CUSTOM_MODEL_SENTINEL` 时支持切换到自定义输入模式（`mode: 'select' | 'custom'`）；使用 `useRef` 避免 `useInput` 闭包中的 stale 状态问题
- **TaskInput** — 任务描述输入：`▸ ` 前缀（cyan 加粗），Enter 提交（非空 trim），支持 Backspace
- **ConfirmScreen** — 配置确认面板：灰色圆角边框，14 字符宽标签列，显示 Project（路径 `~` 替换）/Coder（蓝色）/Reviewer（绿色）/God（magenta，与 Reviewer 相同时显示 `(same as Reviewer)`）/Task 五项配置，底部提示 `Enter` 启动 / `Esc` 返回

**导出常量**:
- `PHASE_LABELS` — 各步骤标签映射
- `PHASE_ORDER` — 步骤顺序数组（9 个 phase）
- `SAME_AS_REVIEWER` — God 选择中 "Same as Reviewer" 的特殊标记值 `'__same_as_reviewer__'`
- `CUSTOM_MODEL_SENTINEL` — 自定义模型的哨兵值（从 registry 重导出）
- `LOGO_LINES` / `BRAND_SLOGAN` / `FEATURE_BULLETS` / `SEPARATOR_WIDTH` / `HEADER_BOX_WIDTH` / `MAX_HEADER_CONTENT` — BrandHeader 相关常量

---

### 18. TaskAnalysisCard.tsx — God 任务分析卡片

**来源**: FR-001a (AC-004, AC-005, AC-006, AC-007)

**Props**:

```ts
interface TaskAnalysisCardProps {
  analysis: GodTaskAnalysis;
  onConfirm: (taskType: string) => void;
  onTimeout: () => void;
}
```

**职责**: 显示 God 的任务分析结果，让用户确认或修改任务类型。支持 8 秒倒计时自动确认。

**关键行为**:
- 使用 `task-analysis-card.ts` 的纯状态函数管理选择、倒计时和确认
- **国际化**: `isCJK(analysis.reasoning)` 检测是否含有中日韩字符（U+4E00-U+9FFF / U+3040-U+30FF / U+AC00-U+D7AF），选择 `ZH` 或 `EN` 界面字符串集
- **倒计时**: 8 秒，1000ms interval tick；箭头键导航时暂停（state 的 `countdownPaused`）；超时自动确认
- **任务类型列表**: 6 种类型（explore/code/discuss/review/debug/compound），God 推荐类型标记 `★ recommended` / `★ 推荐`（黄色）
- **置信度显示**: `Confidence: N%`（`Math.round(analysis.confidence * 100)`）
- **任务摘要**: 截取 `analysis.reasoning` 前 60 字符，超长添加 `…`，用引号包裹
- **键盘**: 将 key/input 映射为字符串后委托给 `handleKeyPress`
  - `1-9` 数字键直接选中并确认
  - `↑/↓` 移动选择并暂停倒计时
  - `Enter` 确认当前选择
  - `Space` 确认 God 推荐类型
- **Header**: 显示 `◈ TASK ANALYSIS` / `◈ 任务分析`（cyan 加粗） + 右侧状态（confirmed=`已确认` / paused=`已暂停` / `自动开始: Ns`）
- **样式**: cyan 圆角边框
- **回调保护**: 使用 `confirmedRef` 确保 `onConfirm` 只触发一次；`countdown <= 0` 时额外触发 `onTimeout`

---

## Lifecycle 组件（3 个）

### 19. CompletionScreen.tsx — 任务完成屏幕

**Props**:

```ts
interface CompletionScreenProps {
  currentTask: string;
  onContinueCurrentTask: (followUp: string) => void;
  onCreateNewTask: (task: string) => void;
  onExit: () => void;
  variant?: 'fullscreen' | 'inline';  // 默认 'fullscreen'
}
```

**职责**: 任务完成后显示后续操作选择界面，支持三种后续路径：继续当前任务、创建新任务、退出 Duo。

**关键行为**:
- **三阶段模式** (`CompletionMode`): `'menu'` -> `'continue'` / `'new-task'`
- **Menu 模式**: 显示三个选项：
  1. Continue current task — 添加追加需求并继续
  2. Create new task — 全新任务描述
  3. Exit Duo — 退出
  - 支持上下箭头导航、Enter 选择、数字键 `1`/`2`/`3` 直接选择
- **Continue 模式**: 显示文本输入框，用户输入追加需求后按 Enter 提交（调用 `onContinueCurrentTask`），Esc 返回 menu（重置 value 为空）
- **New-task 模式**: 显示文本输入框，用户输入新任务描述后按 Enter 提交（调用 `onCreateNewTask`），Esc 返回 menu
- **两种变体**:
  - `fullscreen`：带 `paddingX={1}` 的完整布局，显示选项描述文本和当前任务上下文，`marginBottom={1}` 间距
  - `inline`：紧凑布局，无 padding/margin，适合嵌入 MainLayout 的 footer 区域
- **标题**: 绿色加粗 `"Task completed"`
- **纯函数**: `processCompletionInput(state, input, key)` 提取为独立纯函数，返回 `CompletionInputAction`

**纯函数输入/输出**:

```ts
interface CompletionScreenState {
  mode: CompletionMode;   // 'menu' | 'continue' | 'new-task'
  selected: number;       // menu 中的选中索引
  value: string;          // 文本输入值
}

type CompletionInputAction =
  | { type: 'set_mode'; mode: CompletionMode }
  | { type: 'set_selected'; selected: number }
  | { type: 'set_value'; value: string }
  | { type: 'submit_continue'; value: string }
  | { type: 'submit_new_task'; value: string }
  | { type: 'exit' }
  | { type: 'noop' };
```

---

### 20. TaskBanner.tsx — 持久任务目标展示

**Props**:

```ts
interface TaskBannerProps {
  taskSummary: string;
  columns: number;
}
```

**职责**: 在状态栏下方持久显示用户的原始任务/请求，确保任务目标在整个执行过程中始终可见。

**关键行为**:
- **固定高度 1 行**: 紧凑的单行显示
- **前缀**: `▸ Task: `（cyan 加粗），使用 `computeStringWidth` 计算前缀的终端宽度
- **CJK 感知截断**: 使用 `truncateText(text, maxWidth)` 函数按终端列宽截断，正确处理双宽度 CJK 字符，超长时末尾添加 `…`（1 列宽）
- **文本规范化**: `text.replace(/\s+/g, ' ').trim()` 将换行和多余空白折叠为单个空格
- **宽度计算**: 可用宽度 = `columns - prefixWidth - 1`（预留右侧 1 字符 padding）

**导出的辅助函数**:

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `truncateText(text, maxWidth)` | 文本 + 最大终端列宽 | `string` | 规范化空白后逐字符累加 `getCharWidth`（从 `message-lines.ts` 导入），超出 `maxWidth - 1`（为 `…` 留位）时截断并添加 `…`；`maxWidth <= 1` 时直接返回 `…` |

---

### 21. ThinkingIndicator.tsx — LLM 思考中指示器

**Props**:

```ts
interface ThinkingIndicatorProps {
  columns: number;
  message?: string;       // 默认 "Thinking..."
  color?: string;         // 默认 "cyan"
  showElapsed?: boolean;  // 默认 false
}
```

**职责**: 在 LLM 运行但尚未产生实质性输出时，显示旋转动画指示 LLM 正在思考。支持上下文感知的自定义消息和颜色。

**关键行为**:
- **Spinner 动画**: 使用 Braille 字符序列 `⣾⣽⣻⢿⡿⣟⣯⣷`，`SPIN_INTERVAL_MS = 80` 间隔旋转
- **文本**: spinner 后跟 `message` 文本（同色），可选 `(Ns)` 经过时间后缀
- **经过时间颜色升级**: `showElapsed` 为 true 时，>= 60s 切换为红色，>= 30s 切换为黄色（覆盖 `color` prop）
- **固定高度 1 行**
- **生命周期**: 挂载时重置 frame 和 elapsedSeconds 到 0 并启动 interval，卸载时清除所有 interval（通过 `useRef` 持有 interval ID）

**导出的判断函数**:

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `shouldShowThinking(isLLMRunning, messages)` | LLM 运行状态 + 消息列表 | `boolean` | LLM 未运行时返回 false；从消息列表末尾向前遍历：空的 streaming placeholder（`isStreaming: true` 且 `content.trim() === ''`）-> true（等待首个 token）；非空的 streaming assistant 消息 -> false（已有输出）；非 streaming 的 assistant 消息 -> true（新 iteration 启动中）；遇到 user 消息 -> true（等待输出）；空数组或仅 system 消息 -> true（首次） |

**使用场景**: MainLayout 通过 `resolveIndicatorConfig(workflowState, isLLMRunning, messages)` 函数决定显示哪种指示器消息和颜色：`task_init` -> "Analyzing task..."（yellow, showElapsed）；`god_deciding` -> "God deciding next step..."（yellow, showElapsed）；`god_convergence` -> "Evaluating convergence..."（yellow, showElapsed）；`classifying_intent` -> "Understanding your input..."（yellow, showElapsed）；`observing` -> "Analyzing output..."（yellow）；`executing` -> "Executing actions..."（yellow）；`llm_running` -> 仅在 `shouldShowThinking` 返回 true 时显示 "Thinking..."（cyan）。同时支持 legacy 路径：无 `workflowState` 时直接使用 `shouldShowThinking`。

---

## 快捷键体系完整列表

| 快捷键 | 说明 | 上下文要求 |
|--------|------|-----------|
| `Ctrl+C` | 有选区时复制文本（OSC52）；无选区时中断 LLM（单次）/ 安全退出（500ms 内双击） | 始终可用 |
| `Cmd+C` (macOS) | 有选区时复制文本（OSC52）；无选区时忽略（不触发中断） | 始终可用（macOS `key.super`） |
| `Ctrl+N` | 新建会话 | 始终可用 |
| `Ctrl+I` | 打开/关闭 Context 上下文摘要 overlay | 始终可用 |
| `Ctrl+V` | 切换 Minimal/Verbose 显示模式 | 始终可用 |
| `Ctrl+T` | 打开/关闭 Timeline 事件时间线 overlay | 始终可用 |
| `Ctrl+R` | 重分类任务类型 | 始终可用（受 workflow state 限制） |
| `Ctrl+L` | 清屏（保留历史，记录 clearedCount） | 始终可用 |
| `j` / `↓` | 向下滚动 1 行 | 无 overlay 且输入为空 |
| `k` / `↑` | 向上滚动 1 行 | 无 overlay 且输入为空 |
| `G` | 跳到最新消息（OpenTUI ScrollBox scrollTo） | 无 overlay 且输入为空 |
| `PageDown` | 向下滚动一页 | 无 overlay |
| `PageUp` | 向上滚动一页 | 无 overlay |
| Mouse wheel | 上下滚动（OpenTUI 原生处理） | 无 overlay |
| `Shift+drag` | 选中文本（拖选结束自动复制到剪贴板） | 始终可用 |
| `Enter` | 展开/折叠代码块 | 无 overlay 且输入为空 |
| `Enter` | 提交输入 | 输入非空 |
| `Alt+Enter` / `Ctrl+Enter` / `Shift+Enter` | 插入换行（多行输入） | 输入区域 |
| `Tab` | 路径自动补全 | 任何时候 |
| `?` | 打开/关闭 Help 快捷键帮助 overlay | 输入为空 |
| `/` | 打开 Search 消息搜索 overlay | 输入为空 |
| `Esc` | 关闭当前 overlay / 返回 menu | 有 overlay 时 / CompletionScreen 输入模式 |
| `a` | Accept（接受） | WAITING_USER |
| `c` | Continue（继续） | DisagreementCard / WAITING_USER |
| `d` | Decide manually（手动决策） | DisagreementCard |
| `b` | Accept Reviewer's（接受 Reviewer 方案） | DisagreementCard |
| `Space` | 立即确认 | PhaseTransitionBanner / TaskAnalysisCard |
| `1-6` | 快速选择任务类型 | TaskAnalysisCard |
| `1-4` | 快速选择重分类类型 | ReclassifyOverlay |
| `1-3` | 快速选择后续操作 | CompletionScreen menu |
