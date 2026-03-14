# UI 组件

> 路径: `src/ui/components/*.tsx`

## 技术框架

Duo 的终端 UI 基于以下技术栈：

- **Ink** (React for CLI) — 使用 React 组件模型渲染终端界面，提供 `Box`, `Text`, `useInput`, `useApp`, `useStdout` 等原语
- **@xstate/react** — 通过 `useMachine` hook 驱动工作流状态机 (`workflowMachine`)，实现 CODING -> ROUTING -> REVIEWING -> EVALUATING 等状态转换
- **纯函数状态层** — 所有复杂逻辑提取到 `src/ui/*.ts`（见 `ui-state.md`），组件仅负责渲染和事件绑定

整个 UI 组件层共 **24 个组件**，分为三组：
- **Core 组件**（16 个）— 通用 UI 组件：布局、输入、消息渲染、Overlay、状态栏等
- **God LLM 组件**（5 个）— God 决策层专用组件：决策 banner、阶段切换、重分类、Setup 向导、任务分析
- **新增组件**（3 个）— 任务完成屏幕、任务 banner、思考指示器

## 组件树结构

```
App (根组件)
├── [Setup 阶段]
│   └── SetupWizard
│       ├── BrandHeader (内部)         — ASCII art logo + 版本号
│       ├── ProgressStepper (内部)     — 6 步进度指示器
│       ├── DirectoryPicker            — 项目目录选择
│       ├── CLISelector (内部)         — Coder/Reviewer 选择
│       ├── GodSelector (内部)         — God adapter 选择
│       ├── TaskInput (内部)           — 任务描述输入
│       └── ConfirmScreen (内部)       — 配置确认
│
└── [Session 阶段] SessionRunner (App 内部)
    ├── TaskAnalysisCard               — God 任务分析卡片
    ├── GodDecisionBanner              — God 决策 escape window
    ├── PhaseTransitionBanner          — 阶段切换 escape window
    ├── ReclassifyOverlay              — 运行时任务重分类
    ├── CompletionScreen (NEW)         — 任务完成后续选择
    └── MainLayout
        ├── StatusBar                  — 顶部状态栏（含 God 信息）
        ├── TaskBanner (NEW)           — 持久任务目标展示
        ├── RenderedLineView[]         — 消息行列表（基于 message-lines.ts）
        │   └── LineSpan 渲染          — 逐 span 着色
        ├── ThinkingIndicator (NEW)    — LLM 思考中动画
        ├── ScrollIndicator            — 新输出提示条
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
  ├── ConvergenceCard          — 收敛卡片
  └── DisagreementCard         — 分歧卡片
```

---

## Core 组件（16 个）

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
- 通过 `useMachine(workflowMachine)` 创建 xstate actor，`MAX_ROUNDS = 20`
- 持有 adapter（coder、reviewer、god）、ContextManager、ConvergenceService、ChoiceDetector、SessionManager、OutputStreamManager、DegradationManager 等服务的 `useRef`
- 管理 `messages`（`Message[]`）、`tokenCount`、`timelineEvents` 等 UI 状态
- 管理 God 相关状态：`godTaskAnalysis`、`godConvergenceLog`、`degradationState`、`currentPhaseId`
- 监听 `CODING` 状态：启动 coder adapter 流式执行，通过 `createStreamAggregation` + `applyOutputChunk` 聚合输出
- 监听 `REVIEWING` 状态：与 CODING 对称
- 监听 `GOD_DECIDING` 状态：调用 God adapter 进行自动决策，显示 `GodDecisionBanner`
- 监听 `EVALUATING`：执行收敛检查，插入 round summary
- 处理 God 任务分析：session 启动时显示 `TaskAnalysisCard`
- 处理阶段切换：compound 任务显示 `PhaseTransitionBanner`
- 处理 Ctrl+R：显示 `ReclassifyOverlay`
- 处理任务完成：`DONE` 状态显示 `CompletionScreen`，支持 continue/new-task/exit 三种后续操作
- 处理用户输入和中断
- 会话持久化（含 God 状态恢复）
- 向 App 注册全局 Ctrl+C handler（`registerGlobalCtrlCHandlers`），提供 interrupt 和 safeExit 回调

**副作用管理模式**: 每个 xstate 状态对应一个 `useEffect`，依赖 `stateValue` 变化。CODING 和 REVIEWING 的 effect 包含 cleanup 函数（`cancelled = true; osm.interrupt()`），确保组件卸载或状态切换时中断进程。

---

### 2. MainLayout.tsx — 主布局组件

**Props**:

```ts
interface MainLayoutProps {
  messages: Message[];
  statusText?: string;
  columns: number;
  rows: number;
  isLLMRunning?: boolean;
  onInputSubmit?: (text: string) => void;
  onNewSession?: () => void;
  onInterrupt?: () => void;
  onClearScreen?: () => void;
  onReclassify?: () => void;
  statusBarProps?: {
    projectPath: string;
    round: number;
    maxRounds: number;
    status: WorkflowStatus;
    activeAgent: string | null;
    tokenCount: number;
    taskType?: string;
    currentPhase?: string;
    godAdapter?: string;
    reviewerAdapter?: string;
    degradationLevel?: string;
    godLatency?: number;
  };
  contextData?: {
    roundNumber: number;
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

**职责**: Session 阶段的核心布局组件，整合所有 UI 状态模块，管理消息区滚动、显示模式、Overlay 和输入。

**布局结构**（从上到下）:

| 区域 | 高度 | 内容 |
|------|------|------|
| Status Bar | 1 行 | `StatusBar` 组件或 fallback `<Text inverse bold>` |
| Task Banner | 0-1 行 | `TaskBanner` 组件（仅当有 `taskSummary` 时显示） |
| 分隔线 + 滚动位置 | 1 行 | `─` 填充 + 可选的 `L45/120` 滚动位置标识 |
| 消息区 | 动态行 | 滚动窗口内的 `RenderedLineView` 列表 + ThinkingIndicator + ScrollIndicator + 可选 scrollbar |
| 分隔线 | 1 行 | `─` 重复 `columns` 次 |
| InputArea / Footer | 3 行或自定义 | 用户输入区域或自定义 footer（如 CompletionScreen） |

高度计算: `messageAreaHeight = max(1, rows - STATUS_BAR_HEIGHT(1) - bannerHeight(0|1) - activeFooterHeight(3|N) - SEPARATOR_LINES(2))`

**关键行为**:

- **消息渲染管线**: `messages` -> `filterMessages(displayMode)` -> `.slice(clearedCount)` -> `buildRenderedMessageLines(columns)` -> `renderedLines[effectiveOffset..effectiveOffset+visibleSlots]` -> `RenderedLineView` 组件
- **Scrollbar**: 当消息行数超过可见区域时，在消息区右侧显示单字符宽的滚动条（`█` 表示 thumb，`┃` 表示轨道），cyan 颜色高亮 thumb
- **鼠标滚轮支持**: 通过 stdin data handler 解析 SGR 和 legacy X10 鼠标事件序列，支持鼠标滚轮上下滚动（每次 3 行）
- **滚动状态**: 持有 `ScrollState`（来自 `scroll-state.ts`），通过 `computeScrollView` 计算可见窗口
- **显示模式**: 持有 `DisplayMode`（默认 `'minimal'`），通过 `toggleDisplayMode` 切换
- **Overlay 状态**: 持有 `OverlayState`（来自 `overlay-state.ts`），有 overlay 时全屏替换正常布局
- **清屏功能**: `Ctrl+L` 记录 `clearedCount`（当前已过滤消息数），后续只显示新消息，不删除历史
- **键盘处理**: `useInput` -> `processKeybinding(input, key, ctx)` -> `handleAction(action)`，分发到各状态更新函数；`suspendGlobalKeys` 为 true 时忽略所有按键（用于 TaskAnalysisCard 等阶段暂停全局快捷键）
- **Search overlay 输入**: 当 search overlay 打开时，额外将文本输入路由到 `updateSearchQuery`
- **ThinkingIndicator 集成**: 当 `isLLMRunning` 为 true 且无实质性 assistant 输出时显示思考动画
- **Footer 插槽**: `footer` prop 允许替换默认 InputArea 为自定义内容（如 CompletionScreen inline 模式）
- **InputArea 集成**: InputArea 为非受控模式（管理自身 value/cursor 状态），通过 `onValueChange` 通知 MainLayout 输入是否为空（用于快捷键路由判断），`disabled` 在 overlay 打开时为 true

---

### 3. StatusBar.tsx — 状态栏

**Props**:

```ts
interface StatusBarProps {
  projectPath: string;
  round: number;
  maxRounds: number;
  status: WorkflowStatus;    // 'idle' | 'active' | 'error' | 'routing' | 'interrupted' | 'done'
  activeAgent: string | null;
  tokenCount: number;
  columns: number;
  godAdapter?: string;
  reviewerAdapter?: string;
  taskType?: string;
  currentPhase?: string;
  degradationLevel?: string;  // L1/L2/L3/L4
  godLatency?: number;        // God 决策延迟 (ms)
}
```

**职责**: 渲染顶部 1 行状态栏，固定高度。

**布局**: ` Duo  <项目路径>  Round N/Max  <Agent> <icon> <status>  [taskType]  φ:phase  God:X  ↓L2  Nms  Ntok`

**关键行为**:
- 状态图标和颜色由 `STATUS_CONFIG` 映射：active=绿色 `◆`，idle=白色 `◇`，error=红色 `⚠`，routing=黄色 `◈`，interrupted=白色 `⏸`，done=绿色 `◇`
- 进度条使用 `buildProgressBar(current, max, barWidth)` 生成 `[████░░]` 样式
- token 计数 >= 1000 时显示为 `Nk` 格式（如 `1.5k`）
- 使用 `<Text inverse bold>` 实现反色高亮背景
- **优先级自适应宽度**: 每个段使用 priority（1-5）标记重要度，终端宽度不足时从最低优先级开始隐藏
- **God 信息显示**：
  - `taskType` — cyan 颜色显示 `[taskType]`
  - `currentPhase` — magenta 颜色显示 `φ:phase`
  - `godAdapter` — 仅与 reviewer 不同时显示 `God:X`（magenta）
  - `degradationLevel` — L4 显示红色 `God:disabled`（整行红底白字）；L2/L3 显示黄色 `↓L2`/`↓L3`；L1 隐藏
  - `godLatency` — dim 颜色显示延迟毫秒数

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
- 超过 10 行时默认折叠，显示前 5 行 + `[▶ Expand · N lines]` 提示
- 展开状态下显示 `[▼ Collapse · N lines]`
- 代码行以 `backgroundColor="gray" color="white"` 渲染
- 语言标签以 dim 颜色显示在代码块上方

---

### 5. ScrollIndicator.tsx — 新输出提示条

**Props**:

```ts
interface ScrollIndicatorProps {
  visible: boolean;
  columns: number;
  newMessageCount?: number;
}
```

**职责**: 当用户向上滚动且有新消息到达时，在消息区底部显示提示。

**关键行为**:
- `visible` 为 false 时返回 `null`（不渲染）
- 提示文本: `↓ New output (N new) (press G to follow)`，居中显示，cyan 加粗
- `newMessageCount` 大于 0 时显示 `(N new)` 计数
- 固定高度 1 行

---

### 6. DirectoryPicker.tsx — 目录选择器

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
- **路径输入** — 用户可直接输入路径，Tab 键触发自动补全
- **Tab 补全** — 单个匹配直接填入（末尾加 `/`），多个匹配显示补全列表
- **MRU 列表** — 从 `~/.duo/recent.json` 加载最近使用的目录，选择后更新
- **Git 仓库发现** — 扫描 `DEFAULT_SCAN_DIRS` 下的一级子目录，发现含 `.git` 的目录
- **非 Git 警告** — 选择非 Git 仓库时显示黄色警告 `Warning: Selected directory is not a git repository (Codex requires git)`
- **导航** — 上下箭头在 MRU + discovered 合并列表中切换，Enter 选择，Esc 取消
- 外框 `borderStyle="single"`，标题 `Select Project Directory`
- 路径中的 `$HOME` 显示为 `~`
- 列表去重：discovered 中已在 MRU 的条目不重复显示

---

### 7. HelpOverlay.tsx — 快捷键帮助

**Props**:

```ts
interface HelpOverlayProps {
  columns: number;
  rows: number;
}
```

**职责**: 显示完整的快捷键列表。

**关键行为**:
- 数据源为 `keybindings.ts` 的 `KEYBINDING_LIST`（15 项，含 God 相关快捷键）
- 圆角边框 (`borderStyle="round"`)，cyan 边框色
- 快捷键列宽 18 字符，黄色加粗；描述为默认颜色
- 根据终端行数限制可见条目数 (`rows - 6`)
- 底部提示 `Press Esc to close`

---

### 8. ContextOverlay.tsx — 会话上下文信息

**Props**:

```ts
interface ContextOverlayProps {
  columns: number;
  rows: number;
  roundNumber: number;
  coderName: string;
  reviewerName: string;
  taskSummary: string;
  tokenEstimate: number;
}
```

**职责**: 显示当前会话的上下文摘要信息。

**关键行为**:
- 标签列宽 16 字符，显示 5 项信息：Round、Coder（蓝色）、Reviewer（绿色）、Task、Tokens
- 圆角边框，cyan 边框色
- 底部提示 `Press Esc to close`

---

### 9. TimelineOverlay.tsx — 事件时间线

**Props**:

```ts
interface TimelineOverlayProps {
  columns: number;
  rows: number;
  events: TimelineEvent[];  // { timestamp, type, description }
}
```

**`TimelineEvent.type`**: `'task_start'` | `'coding'` | `'reviewing'` | `'converged'` | `'interrupted'` | `'error'`

**职责**: 按时间顺序展示工作流事件历史。

**关键行为**:
- 每个事件类型有对应颜色：task_start=白色，coding=蓝色，reviewing=绿色，converged=青色，interrupted=黄色，error=红色
- 时间列宽 12 字符，显示 `toLocaleTimeString()` 格式
- 只显示最近 `rows - 6` 条事件（从尾部截取）
- 无事件时显示 `No events yet`
- 圆角边框，cyan 边框色

---

### 10. SearchOverlay.tsx — 消息搜索

**Props**:

```ts
interface SearchOverlayProps {
  columns: number;
  rows: number;
  query: string;
  results: Message[];
}
```

**职责**: 搜索消息历史并展示匹配结果。

**关键行为**:
- 搜索栏前缀 `/ `（黄色加粗），空查询时显示占位符 `Type to search...`
- 结果列表：左侧 10 字符宽显示角色名（使用 `ROLE_STYLES` 配色），右侧显示消息预览
- 消息预览根据终端宽度截断（`columns - 20`），超长时末尾添加 `...`
- 最大结果数 `rows - 7`
- 搜索逻辑在 `overlay-state.ts` 的 `computeSearchResults` 中实现（大小写不敏感子串匹配）
- 圆角边框，cyan 边框色

---

### 11. InputArea.tsx — 用户输入区域

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
- **非受控模式**：组件内部通过 `useState` 管理 `InputState`（`value` + `cursorPos`），通过 `onValueChange` 通知外部值变化
- **提交**: Enter 提交（非空时），提交后清空输入
- **多行**: Alt+Enter / Ctrl+Enter / Shift+Enter 插入换行，最多 `maxLines` 行
- **光标移动**: 左右箭头移动光标；Home/End 跳到行首/行尾；Ctrl+A/Ctrl+E 同 Home/End
- **行编辑**: Ctrl+K 删除光标到行尾的内容；Backspace 删除光标前字符
- **鼠标序列过滤**: 使用正则 `MOUSE_SEQUENCE_RE` 过滤终端鼠标模式下泄漏的 escape 序列
- **特殊键**: 输入为空时按 `?` 或 `/` 触发 `onSpecialKey` 回调（用于打开 overlay）
- **占位符**: LLM 运行中显示 `Type to interrupt, or wait for completion...`；空闲时显示 `Type a message...`
- 输入提示符: LLM 运行中 `◆`（黄色），空闲时 `▸`（cyan）
- `disabled` 为 true 时忽略所有输入事件

**纯函数 `processInput(currentValue, cursorPos, input, key, maxLines)`**:
- 提取为独立纯函数以便测试
- 返回 `InputAction`: `submit` | `update` | `special` | `noop`

**辅助函数**:
- `getDisplayLines(value, maxLines)` — 按 `\n` 分割并截取前 `maxLines` 行用于渲染
- `getCursorLineCol(value, cursorPos)` — 计算光标所在的行号和列号

---

### 12. SystemMessage.tsx — 系统消息

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
| `routing` | `· [Router] Choice detected → Forwarding to <Agent>` | 额外显示 question 和 choices 列表（缩进 + 编号） |
| `interrupt` | `⚠ INTERRUPTED - <Agent> process terminated (output: N chars)` | 同上 |
| `waiting` | `> Waiting for your instructions...` | 同上 |

- routing 消息全部为黄色
- interrupt 消息为黄色 `⚠` 标记
- waiting 消息为白色 `>` 前缀

---

### 13. ConvergenceCard.tsx — 收敛卡片

**Props**:

```ts
interface ConvergenceCardProps {
  roundCount: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  onAction: (action: ConvergenceAction) => void;  // 'accept' | 'continue' | 'review'
}
```

**职责**: 当 Coder 和 Reviewer 达成一致时显示收敛信息和操作选项。

**关键行为**:
- 绿色圆角边框，标题 `✓ CONVERGED after N rounds`
- 显示变更统计：`Files modified: N  Lines changed: +N / -N`（insertions 绿色，deletions 红色）
- 三个操作按钮：`[A] Accept`、`[C] Continue`、`[R] Review Changes`
- 键盘 `a`/`c`/`r`（不区分大小写）触发对应 action

---

### 14. DisagreementCard.tsx — 分歧卡片

**Props**:

```ts
interface DisagreementCardProps {
  currentRound: number;
  agreedPoints: number;
  totalPoints: number;
  onAction: (action: DisagreementAction) => void;  // 'continue' | 'decide' | 'accept_coder' | 'accept_reviewer'
}
```

**职责**: 当 Coder 和 Reviewer 存在分歧时显示分歧信息和操作选项。

**关键行为**:
- 黄色圆角边框，标题 `⚡ DISAGREEMENT · Round N`
- 显示一致度统计：`Agreed: M/N    Disputed: K/N`（K = totalPoints - agreedPoints）
- 四个操作按钮分两行：`[C] Continue` `[D] Decide manually` / `[A] Accept Coder's` `[B] Accept Reviewer's`
- 键盘 `c`/`d`/`a`/`b`（不区分大小写）触发对应 action

---

### 15. MessageView.tsx — 消息渲染

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
- **Verbose 模式额外信息**: 时间戳精确到秒，显示 token 计数，显示 CLI 命令
- **内容委托**: 将 `message.content` 和 `message.isStreaming` 传递给 `StreamRenderer` 渲染

---

### 16. StreamRenderer.tsx — Markdown 流式渲染

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
- **Activity block 压缩** (Minimal 模式): 连续的 `activity_block` 在 minimal 模式下压缩为单个 `activity_summary`，格式 `⏺ N actions · M results · K errors · latest <title>: <summary>`
- **代码块状态管理**: 使用 `expandedBlocks` (`Record<number, boolean>`) 追踪每个代码块的展开/折叠状态
- **流式指示器**: `isStreaming` 为 true 时在内容末尾显示旋转 spinner（`⣾⣽⣻⢿⡿⣟⣯⣷`），字符基于 `content.length % 8` 选择（确保测试输出确定性）
- **Segment 渲染映射**:

| Segment 类型 | 渲染方式 |
|-------------|---------|
| `text` | 按 `\n` 分行，每行一个 `<Text>` |
| `code_block` | 委托给 `<CodeBlock>`，传入 `expanded` 和 `onToggle` |
| `activity_block` | 根据 kind 显示图标（`⏺`/`⎿`/`⚠`）+ 标题摘要；verbose 模式下展开为 CodeBlock |
| `activity_summary` | 单行摘要 `<Text color={color}>{icon} {summary}</Text>` |
| `inline_code` | 灰底白字 |
| `bold` | `<Text bold>` |
| `italic` | `<Text italic>` |
| `list_item` | `*`/`-` 显示为 `  •`，有序列表保留标记 |
| `table` | 动态列宽，`-+-` 分隔线 |

---

## God LLM 组件（5 个）

### 17. GodDecisionBanner.tsx — God 决策 Escape Window

**来源**: FR-008 (AC-025, AC-026, AC-027)

**Props**:

```ts
interface GodDecisionBannerProps {
  decision: GodAutoDecision;
  onExecute: () => void;
  onCancel: () => void;
}
```

**职责**: 显示 God 自动决策的 escape window，允许用户确认或取消。

**关键行为**:
- 使用 `god-decision-banner.ts` 的纯状态函数管理 countdown、key press、tick
- **AI-driven 模式**: `ESCAPE_WINDOW_MS = 0`，决策创建即执行，`onExecute` 立即触发
- **Progress bar**: 20 字符宽，`█` 已填充 + `░` 未填充，显示剩余秒数
- **决策摘要**: `formatDecisionSummary` 生成 `"God: accepting output"` 或 `"God: continuing - \"instruction\""`
- **键盘**: `[Space]` 立即执行，`[Esc]` 取消
- **样式**: 黄色圆角边框，标题 `⚡ GOD 决策`
- **回调保护**: 使用 `firedRef` 确保 `onExecute`/`onCancel` 只触发一次
- **Countdown timer**: 100ms interval tick，通过 `useEffect` 管理生命周期

---

### 18. PhaseTransitionBanner.tsx — 阶段切换 Escape Window

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
- **Progress bar**: 同 GodDecisionBanner，20 字符宽
- **摘要显示**: `previousPhaseSummary` 截断到 120 字符，dim 颜色
- **键盘**: `[Space]` 立即确认，`[Esc]` 取消（留在当前阶段）
- **样式**: magenta 圆角边框，标题 `⚡ Phase Transition → <nextPhaseId>`
- **回调保护**: 使用 `firedRef` 确保回调只触发一次

---

### 19. ReclassifyOverlay.tsx — 运行时任务重分类

**来源**: FR-002a (AC-010, AC-011, AC-012)

**Props**:

```ts
interface ReclassifyOverlayProps {
  currentType: string;
  currentRound: number;
  onSelect: (newType: string) => void;
  onCancel: () => void;
}
```

**职责**: Ctrl+R 触发的全屏 overlay，允许用户在 session 运行中更改任务类型。

**关键行为**:
- 使用 `reclassify-overlay.ts` 的纯状态函数管理选择和导航
- **可选类型**: `explore`、`code`、`review`、`debug`（不含 `compound`）
- **当前信息显示**: 当前任务类型和当前轮次
- **选择列表**: 每项显示 `[N] type  description`，当前类型标记 `← current`
- **键盘**:
  - `↑/↓` 移动选择
  - `Enter` 确认当前选择
  - `1-4` 数字键直接选中并确认
  - `Esc` 取消（恢复原类型）
- **选中项高亮**: cyan 颜色 + `❯` 前缀
- **样式**: cyan 圆角边框，标题 `◈ Reclassify Task`

**类型描述**:

| 类型 | 描述 |
|------|------|
| `explore` | Explore first, then code |
| `code` | Direct coding implementation |
| `review` | Code review only |
| `debug` | Focused debugging |

---

### 20. SetupWizard.tsx — Setup 向导

**来源**: v2 Setup 交互重构

**Props**:

```ts
interface SetupWizardProps {
  detected: DetectedCLI[];
  initialConfig?: Partial<SessionConfig>;
  onComplete: (config: SessionConfig) => void;
}
```

**职责**: 完整的交互式 Setup 向导，引导用户完成 6 步配置流程，替代 App 内部的分散 Setup 逻辑。

**6 步流程** (`SetupPhase`):

| 步骤 | Phase | 内部组件 | 说明 |
|------|-------|---------|------|
| 1 | `select-dir` | `DirectoryPicker` | 选择项目目录 |
| 2 | `select-coder` | `CLISelector` | 选择 Coder CLI |
| 3 | `select-reviewer` | `CLISelector` | 选择 Reviewer CLI（排除已选 Coder） |
| 4 | `select-god` | `GodSelector` | 选择 God adapter |
| 5 | `enter-task` | `TaskInput` | 输入任务描述 |
| 6 | `confirm` | `ConfirmScreen` | 确认配置并启动 |

**内部子组件**:

- **BrandHeader** — 渲染 ASCII art logo（`Duo`）+ 版本号 + slogan `"Coder writes. Reviewer guards. God decides."`，cyan 加粗，固定宽度 70 字符边框
- **ProgressStepper** — 6 步进度指示器，使用 `●`（已完成，绿色）/ `◉`（当前，cyan）/ `○`（未来，灰色）图标，步骤间用 `─` 连接
- **CLISelector** — 通用 CLI 选择器，过滤已安装的 CLI，支持 `exclude` 排除已选项，上下箭头 + Enter 选择
- **GodSelector** — God adapter 专用选择器，显示 `"Same as Reviewer"` 选项（如果 reviewer 支持作为 God），推荐 `claude-code`（标记 `★ recommended`），提示 God 以 stateless + tools disabled 模式运行
- **TaskInput** — 任务描述输入，`▸` 前缀，Enter 提交
- **ConfirmScreen** — 配置确认面板，圆角灰色边框，显示 Project/Coder/Reviewer/God/Task 五项配置，God 与 Reviewer 相同时显示 `(same as Reviewer)`，Enter 启动 / Esc 返回

**导出常量**:
- `PHASE_LABELS` — 各步骤标签映射
- `PHASE_ORDER` — 步骤顺序数组
- `SAME_AS_REVIEWER` — God 选择中 "Same as Reviewer" 的特殊标记值

---

### 21. TaskAnalysisCard.tsx — God 任务分析卡片

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
- **国际化**: 自动检测 CJK 字符（`analysis.reasoning`），选择中文或英文界面
- **倒计时**: 8 秒，1 秒 interval tick；箭头键导航时暂停；超时自动确认
- **任务类型列表**: 6 种类型（explore/code/discuss/review/debug/compound），God 推荐类型标记 `★ recommended` / `★ 推荐`
- **置信度显示**: `Confidence: N%`、`Rounds: N`、`Criteria: ...`
- **键盘**:
  - `1-6` 数字键直接选中并确认
  - `↑/↓` 移动选择并暂停倒计时
  - `Enter` 确认当前选择
  - `Space` 确认 God 推荐类型
- **Header**: 显示 `◈ TASK ANALYSIS` / `◈ 任务分析` + 状态（confirmed/paused/auto-start: Ns）
- **任务摘要**: 截取 `analysis.reasoning` 前 60 字符
- **样式**: cyan 圆角边框
- **回调保护**: 使用 `confirmedRef` 确保 `onConfirm` 只触发一次；超时时额外触发 `onTimeout`

---

## 新增组件（3 个）

### 22. CompletionScreen.tsx — 任务完成屏幕

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
- **Menu 模式**: 显示三个选项（1. Continue current task / 2. Create new task / 3. Exit Duo），支持上下箭头导航、Enter 选择、数字键直接选择
- **Continue 模式**: 显示文本输入框，用户输入追加需求后按 Enter 提交（调用 `onContinueCurrentTask`），Esc 返回 menu
- **New-task 模式**: 显示文本输入框，用户输入新任务描述后按 Enter 提交（调用 `onCreateNewTask`），Esc 返回 menu
- **两种变体**:
  - `fullscreen`：带 padding 的完整布局，显示选项描述文本和当前任务上下文
  - `inline`：紧凑布局，适合嵌入 MainLayout 的 footer 区域
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

### 23. TaskBanner.tsx — 持久任务目标展示

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
- **前缀**: `▸ Task: `（cyan 加粗）
- **CJK 感知截断**: 使用 `truncateText(text, maxWidth)` 函数按终端列宽截断，正确处理双宽度 CJK 字符，超长时末尾添加 `…`
- **文本规范化**: 将换行和多余空白折叠为单个空格
- **宽度计算**: 可用宽度 = `columns - prefixWidth - 1`（预留右侧 1 字符）

**导出的辅助函数**:

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `truncateText(text, maxWidth)` | 文本 + 最大终端列宽 | `string` | 规范化空白，逐字符累加 `getCharWidth`，超出时截断并添加 `…`（1 列宽） |

---

### 24. ThinkingIndicator.tsx — LLM 思考中指示器

**Props**:

```ts
interface ThinkingIndicatorProps {
  columns: number;
}
```

**职责**: 在 LLM 运行但尚未产生实质性输出时，显示旋转动画指示 LLM 正在思考。

**关键行为**:
- **Spinner 动画**: 使用 Braille 字符序列 `⣾⣽⣻⢿⡿⣟⣯⣷`，80ms 间隔旋转
- **文本**: spinner 后跟 dim 颜色的 ` Thinking...`
- **固定高度 1 行**
- **生命周期**: 挂载时重置帧到 0 并启动 interval，卸载时清除 interval

**导出的判断函数**:

| 函数 | 输入 | 输出 | 关键逻辑 |
|------|------|------|----------|
| `shouldShowThinking(isLLMRunning, messages)` | LLM 运行状态 + 消息列表 | `boolean` | LLM 未运行时返回 false；从消息列表末尾向前遍历：跳过空的 streaming placeholder（`isStreaming: true` 且 `content` 为空）；遇到非空 assistant 消息返回 false（已有输出）；遇到 user 消息返回 true（等待输出）；空数组或仅 system 消息时返回 true（首轮） |

**使用场景**: MainLayout 在消息区底部、ScrollIndicator 之上有条件地渲染 ThinkingIndicator，仅在 `shouldShowThinking` 返回 true 时显示。

---

## 快捷键体系完整列表

| 快捷键 | 说明 | 上下文要求 |
|--------|------|-----------|
| `Ctrl+C` | 中断 LLM（单次）/ 安全退出（500ms 内双击） | 始终可用 |
| `Ctrl+N` | 新建会话 | 始终可用 |
| `Ctrl+I` | 打开/关闭 Context 上下文摘要 overlay | 始终可用 |
| `Ctrl+V` | 切换 Minimal/Verbose 显示模式 | 始终可用 |
| `Ctrl+T` | 打开/关闭 Timeline 事件时间线 overlay | 始终可用 |
| `Ctrl+G` | 打开/关闭 God 控制面板 overlay | 始终可用 |
| `Ctrl+R` | 重分类任务类型 | 始终可用（受 workflow state 限制） |
| `Ctrl+L` | 清屏（保留历史，记录 clearedCount） | 始终可用 |
| `j` / `↓` | 向下滚动 1 行 | 无 overlay 且输入为空 |
| `k` / `↑` | 向上滚动 1 行 | 无 overlay 且输入为空 |
| `G` | 跳到最新消息（重新启用 auto-follow） | 无 overlay 且输入为空 |
| `PageDown` | 向下滚动一页（pageSize = messageAreaHeight） | 无 overlay |
| `PageUp` | 向上滚动一页 | 无 overlay |
| Mouse wheel | 上下滚动 3 行 | 无 overlay |
| `Enter` | 展开/折叠代码块 | 无 overlay 且输入为空 |
| `Enter` | 提交输入 | 输入非空 |
| `Alt+Enter` / `Ctrl+Enter` / `Shift+Enter` | 插入换行（多行输入） | 输入区域 |
| `Tab` | 路径自动补全 | 任何时候 |
| `?` | 打开/关闭 Help 快捷键帮助 overlay | 输入为空 |
| `/` | 打开 Search 消息搜索 overlay | 输入为空 |
| `Esc` | 关闭当前 overlay / 返回 menu | 有 overlay 时 / CompletionScreen 输入模式 |
| `a` | Accept（接受） | ConvergenceCard / WAITING_USER |
| `c` | Continue（继续） | ConvergenceCard / DisagreementCard / WAITING_USER |
| `r` | Review Changes（查看变更） | ConvergenceCard |
| `d` | Decide manually（手动决策） | DisagreementCard |
| `b` | Accept Reviewer's（接受 Reviewer 方案） | DisagreementCard |
| `Space` | 立即执行/确认 | GodDecisionBanner / PhaseTransitionBanner / TaskAnalysisCard |
| `1-6` | 快速选择任务类型 | TaskAnalysisCard / ReclassifyOverlay |
| `1-3` | 快速选择后续操作 | CompletionScreen menu |
| `R/S/F/P` | God overlay 手动干预 | God Overlay (Ctrl+G) |
