# Duo — 多 AI 编程助手协作平台

## 项目简介

Duo 是一个**多 AI 编程助手协作平台**，通过将两个 AI 编程工具分别担任 **Coder**（编码者）和 **Reviewer**（审查者）角色，在自动化的编码-审查迭代循环中完成编程任务。

核心创新在于引入了 **God LLM 智能编排层**：一个独立的 LLM 充当"上帝"角色，自主完成任务分析、路由决策、收敛判断和异常处理，实现 **Coder + Reviewer + God 三方协作**的全自动编程工作流。

```
用户任务 → God 分析 → Coder 编码 → God 路由 → Reviewer 审查 → God 收敛判断 → 完成/继续迭代
```

## 核心特性

### 三方协作架构
- **Coder**：负责编写代码、实现功能
- **Reviewer**：负责代码审查、发现问题
- **God LLM**：智能编排器，自主决策任务路由、收敛判断、循环检测

### 多 AI 工具支持
支持 12 种主流 AI 编程工具作为 Coder/Reviewer：
Claude Code、Codex、Gemini、Copilot、Cursor、Aider、Amazon Q、Cline、Continue、Goose、Amp、Qwen

### God LLM 智能编排
- **任务意图解析**：自动分类任务类型（explore/code/discuss/review/debug/compound）
- **动态轮次调整**：根据任务类型智能设定最大迭代轮次
- **路由决策**：Coder/Reviewer 输出后自主决定下一步动作
- **收敛判断**：判断任务是否完成，支持终止标准追踪
- **循环检测**：识别死循环并介入干预
- **漂移检测**：监控 God 决策质量，防止过度宽松
- **降级管理**：God 失败时自动降级到规则引擎
- **一致性校验**：检测 God 输出中的逻辑矛盾

### 状态机驱动
基于 XState v5 的 11 状态工作流状态机，支持序列化/反序列化、会话恢复

### 终端 UI
基于 Ink + React 的现代终端界面，支持实时流式输出、滚动、搜索、Overlay 面板

### 会话持久化
支持会话保存、恢复（`duo resume`）、God 审计日志查看（`duo log`）

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js (ESM) |
| 语言 | TypeScript 5.9 |
| 状态管理 | XState v5 |
| UI 框架 | Ink 6 + React 19 |
| Schema 校验 | Zod 4 |
| 构建工具 | tsup |
| 测试框架 | Vitest 4 |
| 包管理 | npm |

## 项目结构

```
duo/
├── package.json                          # 项目配置、依赖、脚本
├── tsconfig.json                         # TypeScript 配置
├── docs/                                 # 项目文档
│   ├── README.md                         # 本文件 — 项目总览
│   ├── architecture.md                   # 系统架构文档
│   ├── modules/                          # 模块详细文档
│   │   ├── cli-entry.md                  # CLI 入口模块
│   │   ├── type-system.md                # 类型系统
│   │   ├── adapter-layer.md              # Adapter 适配层
│   │   ├── parsers.md                    # 输出解析器
│   │   ├── session-management.md         # 会话管理
│   │   ├── decision-engine.md            # 决策引擎（旧版规则）
│   │   ├── workflow-engine.md            # 工作流状态机
│   │   ├── ui-state.md                   # UI 状态管理
│   │   └── ui-components.md              # UI 组件
│   ├── plans/                            # 开发计划
│   └── requirements/                     # 需求文档
│
└── src/                                  # 源代码 (~17,255 行, ~100 个文件)
    ├── index.ts                          # 版本导出
    ├── cli.ts                            # CLI 入口 — 命令解析、Ink 渲染启动
    ├── cli-commands.ts                   # CLI 命令处理器 (start/resume/log)
    │
    ├── types/                            # 核心类型定义
    │   ├── adapter.ts                    # CLIAdapter 接口、OutputChunk、ExecOptions
    │   ├── session.ts                    # SessionConfig、StartArgs、ValidationResult
    │   ├── ui.ts                         # RoleName、RoleStyle — 12 种 AI 工具的显示样式
    │   ├── god-adapter.ts          [NEW] # GodAdapter 接口 — God 专用适配器类型
    │   └── god-schemas.ts          [NEW] # God 输出 Zod Schema — 5 种决策结构定义
    │
    ├── adapters/                         # AI 工具适配层
    │   ├── registry.ts                   # CLI 工具注册表 — 12 种工具的命令/参数配置
    │   ├── detect.ts                     # CLI 工具自动检测 — 扫描已安装工具
    │   ├── factory.ts                    # Adapter 工厂 — 按名称创建 CLIAdapter 实例
    │   ├── process-manager.ts            # 子进程管理 — 启动/杀死 CLI 进程
    │   ├── output-stream-manager.ts      # 输出流管理 — 实时收集 CLI 输出
    │   ├── env-builder.ts                # 环境变量构建器
    │   ├── claude-code/                  # Claude Code 适配器
    │   ├── codex/                        # OpenAI Codex 适配器
    │   ├── gemini/                       # Google Gemini 适配器
    │   ├── copilot/                      # GitHub Copilot 适配器
    │   ├── cursor/                       # Cursor 适配器
    │   ├── aider/                        # Aider 适配器
    │   ├── amazon-q/                     # Amazon Q 适配器
    │   ├── cline/                        # Cline 适配器
    │   ├── continue/                     # Continue 适配器
    │   ├── goose/                        # Goose 适配器
    │   ├── amp/                          # Amp 适配器
    │   └── qwen/                         # Qwen 适配器
    │
    ├── parsers/                          # 输出解析器
    │   ├── index.ts                      # 解析器导出
    │   ├── stream-json-parser.ts         # 流式 JSON 解析器 (Claude Code 格式)
    │   ├── jsonl-parser.ts               # JSONL 解析器 (Codex 格式)
    │   ├── text-stream-parser.ts         # 纯文本流解析器
    │   └── god-json-extractor.ts   [NEW] # God JSON 提取器 — 从 God 输出中提取 JSON 并校验
    │
    ├── session/                          # 会话管理
    │   ├── session-starter.ts            # 会话启动 — 参数解析、配置创建
    │   ├── session-manager.ts            # 会话持久化 — 保存/加载/恢复会话快照
    │   └── context-manager.ts            # 上下文管理 — Coder/Reviewer 的提示词构建（旧版）
    │
    ├── decision/                         # 决策引擎（旧版规则，God 降级后的 fallback）
    │   ├── choice-detector.ts            # 选择检测 — 识别 LLM 输出中的提问/选项
    │   └── convergence-service.ts        # 收敛服务 — 基于规则的收敛判断
    │
    ├── engine/                           # 工作流引擎
    │   ├── workflow-machine.ts           # XState v5 状态机 — 11 状态、25+ 事件
    │   └── interrupt-handler.ts          # 中断处理 — Ctrl+C、文本中断、双击退出
    │
    ├── god/                        [NEW] # God LLM 智能编排模块 (23 个文件)
    │   ├── adapters/                     # God 专用适配器实现
    │   │   ├── claude-code-god-adapter.ts  # Claude Code 作为 God 的适配器
    │   │   └── codex-god-adapter.ts        # Codex 作为 God 的适配器
    │   ├── god-adapter-config.ts         # God 适配器配置 — 支持的 God 工具列表
    │   ├── god-adapter-factory.ts        # God 适配器工厂 — 按名称创建 GodAdapter
    │   ├── god-call.ts                   # God 调用封装 — 统一的 God LLM 调用接口
    │   ├── god-system-prompt.ts          # God 系统提示词 — 编排器角色指令
    │   ├── god-prompt-generator.ts       # 动态提示词生成 — 按轮次/阶段生成 Coder/Reviewer 提示词
    │   ├── god-context-manager.ts        # God 上下文管理 — 增量提示、token 估算、会话重建
    │   ├── task-init.ts                  # 任务初始化 — 意图解析、任务分类、动态轮次
    │   ├── god-router.ts                 # God 路由器 — PostCoder/PostReviewer 输出分析与路由
    │   ├── god-convergence.ts            # 收敛判断 — Reviewer 权威的收敛评估
    │   ├── auto-decision.ts              # 自主决策 — GOD_DECIDING 状态下的 accept/continue 决策
    │   ├── rule-engine.ts                # 规则引擎 — 不可委托场景的同步规则（< 5ms）
    │   ├── consistency-checker.ts        # 一致性校验 — God 输出的逻辑矛盾检测与自动修正
    │   ├── loop-detector.ts              # 循环检测 — 死循环识别与干预策略
    │   ├── drift-detector.ts             # 漂移检测 — God 决策质量监控
    │   ├── degradation-manager.ts        # 降级管理 — 四级降级策略（L1-L4）
    │   ├── alert-manager.ts              # 告警管理 — 延迟/停滞/错误三种告警
    │   ├── phase-transition.ts           # 阶段转换 — compound 任务的多阶段管理
    │   ├── interrupt-clarifier.ts        # 中断分类 — God 分析用户中断意图
    │   ├── god-audit.ts                  # 审计日志 — append-only JSONL 审计记录
    │   ├── god-session-persistence.ts    # God 会话持久化 — 恢复兼容性（当前禁用）
    │   └── tri-party-session.ts          # 三方会话协调 — Coder/Reviewer/God 的独立恢复
    │
    └── ui/                               # 终端 UI 层
        ├── 状态管理文件
        │   ├── scroll-state.ts           # 滚动状态
        │   ├── round-summary.ts          # 轮次摘要
        │   ├── display-mode.ts           # 显示模式切换
        │   ├── directory-picker-state.ts # 目录选择器状态
        │   ├── keybindings.ts            # 快捷键绑定
        │   ├── overlay-state.ts          # Overlay 面板状态
        │   ├── markdown-parser.ts        # Markdown 解析（终端渲染）
        │   ├── git-diff-stats.ts         # Git diff 统计
        │   ├── session-runner-state.ts   # 会话运行状态（核心状态驱动）
        │   ├── message-lines.ts          # 消息行计算
        │   ├── escape-window.ts    [NEW] # Escape 窗口 — God 决策前的用户干预窗口
        │   ├── god-decision-banner.ts [NEW] # God 决策横幅状态
        │   ├── god-fallback.ts     [NEW] # God 降级 fallback 状态
        │   ├── god-message-style.ts [NEW] # God 消息样式
        │   ├── god-overlay.ts      [NEW] # God Overlay 面板状态
        │   ├── phase-transition-banner.ts [NEW] # 阶段转换横幅状态
        │   ├── reclassify-overlay.ts [NEW] # 重分类 Overlay 状态
        │   ├── resume-summary.ts   [NEW] # 恢复摘要
        │   └── task-analysis-card.ts [NEW] # 任务分析卡片状态
        │
        └── components/                   # React (Ink) 组件
            ├── App.tsx                   # 根组件 — 状态机集成、会话生命周期
            ├── MainLayout.tsx            # 主布局 — 消息列表、输入区、状态栏
            ├── SetupWizard.tsx     [NEW] # 交互式设置向导
            ├── StatusBar.tsx             # 状态栏 — 轮次/状态/God 信息
            ├── InputArea.tsx             # 输入区 — 用户输入、中断操作
            ├── StreamRenderer.tsx        # 流式渲染器 — 实时 LLM 输出
            ├── MessageView.tsx           # 消息视图 — 单条消息渲染
            ├── CodeBlock.tsx             # 代码块渲染
            ├── SystemMessage.tsx         # 系统消息渲染
            ├── ScrollIndicator.tsx       # 滚动指示器
            ├── DirectoryPicker.tsx       # 目录选择器
            ├── ConvergenceCard.tsx        # 收敛卡片
            ├── DisagreementCard.tsx       # 分歧卡片
            ├── HelpOverlay.tsx           # 帮助 Overlay
            ├── ContextOverlay.tsx        # 上下文 Overlay
            ├── TimelineOverlay.tsx       # 时间线 Overlay
            ├── SearchOverlay.tsx         # 搜索 Overlay
            ├── GodDecisionBanner.tsx [NEW] # God 决策横幅组件
            ├── PhaseTransitionBanner.tsx [NEW] # 阶段转换横幅组件
            ├── ReclassifyOverlay.tsx [NEW] # 任务重分类 Overlay 组件
            └── TaskAnalysisCard.tsx [NEW] # 任务分析展示卡片
```

## 模块文档导航

详细模块文档位于 `docs/modules/` 目录：

| 文档 | 描述 |
|------|------|
| [cli-entry.md](modules/cli-entry.md) | CLI 入口、命令解析 |
| [type-system.md](modules/type-system.md) | 核心类型系统（含 God 类型） |
| [adapter-layer.md](modules/adapter-layer.md) | AI 工具适配层 |
| [parsers.md](modules/parsers.md) | 输出解析器 |
| [session-management.md](modules/session-management.md) | 会话管理与持久化 |
| [decision-engine.md](modules/decision-engine.md) | 决策引擎（旧版规则，降级 fallback） |
| [workflow-engine.md](modules/workflow-engine.md) | XState 工作流状态机 |
| [ui-state.md](modules/ui-state.md) | UI 状态管理 |
| [ui-components.md](modules/ui-components.md) | UI 组件 |

系统架构详见 [architecture.md](architecture.md)。

## 快速开始

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

### 构建

```bash
npm run build
```

### 测试

```bash
npm test
```

## CLI 命令

### `duo start` — 启动新会话

```bash
# 交互式模式（SetupWizard 向导）
duo start

# 直接指定参数
duo start --dir ./my-project --coder claude-code --reviewer codex --task "Add JWT auth"
```

参数说明：
- `--dir <path>`：项目目录（默认当前目录）
- `--coder <cli>`：编码者工具名称
- `--reviewer <cli>`：审查者工具名称
- `--task <desc>`：任务描述

God LLM 会自动选择（默认使用与 Reviewer 相同的 CLI 工具，若不支持则降级）。

### `duo resume` — 恢复会话

```bash
# 列出可恢复的会话
duo resume

# 恢复指定会话
duo resume <session-id>
```

### `duo log` — 查看 God 审计日志

```bash
# 查看完整审计日志
duo log <session-id>

# 按决策类型过滤
duo log <session-id> --type ROUTING_POST_CODE
```

审计日志包含：序号、时间戳、轮次、决策类型、输入/输出摘要、延迟统计、类型分布。

### `duo --version` — 查看版本

```bash
duo --version
```

## 依赖说明

### 运行时依赖

| 包 | 版本 | 用途 |
|----|------|------|
| `xstate` | ^5.28.0 | 工作流状态机引擎 |
| `@xstate/react` | ^6.1.0 | XState React 绑定 |
| `ink` | ^6.8.0 | React 终端 UI 框架 |
| `react` | ^19.2.4 | UI 组件框架 |
| `zod` | ^4.3.6 | God 输出 Schema 校验 |

### 开发依赖

| 包 | 版本 | 用途 |
|----|------|------|
| `typescript` | ^5.9.3 | 类型系统 |
| `tsup` | ^8.5.1 | 构建打包 |
| `tsx` | ^4.21.0 | TypeScript 直接执行 |
| `vitest` | ^4.0.18 | 测试框架 |
| `eslint` | ^10.0.3 | 代码检查 |
| `ink-testing-library` | ^4.0.0 | Ink 组件测试 |
| `@types/node` | ^25.4.0 | Node.js 类型 |
| `@types/react` | ^19.2.14 | React 类型 |
