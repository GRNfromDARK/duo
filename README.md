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

| 工具 | CLI 命令 | 输出格式 |
|------|---------|---------|
| Claude Code | `claude` | stream-json |
| Codex | `codex` | jsonl |
| Gemini | `gemini` | stream-json |
| Copilot | `copilot` | json |
| Cursor | `cursor` | json |
| Aider | `aider` | text |
| Amazon Q | `q` | text |
| Cline | `cline` | jsonl |
| Continue | `cn` | json |
| Goose | `goose` | text |
| Amp | `amp` | stream-json |
| Qwen | `qwen` | stream-json |

### God LLM 智能编排
- **任务意图解析**：自动分类任务类型（explore/code/discuss/review/debug/compound）
- **动态轮次调整**：根据任务类型智能设定最大迭代轮次
- **路由决策**：Coder/Reviewer 输出后自主决定下一步动作
- **收敛判断**：判断任务是否完成，支持终止标准追踪
- **循环检测**：识别死循环并介入干预
- **漂移检测**：监控 God 决策质量，防止过度宽松
- **降级管理**：God 失败时自动降级到规则引擎（四级降级 L1-L4）
- **一致性校验**：检测 God 输出中的逻辑矛盾

### 状态机驱动
基于 XState v5 的 12 状态工作流状态机，支持序列化/反序列化、会话恢复

### 终端 UI
基于 Ink + React 的现代终端界面：
- 群聊式消息流（按角色着色）
- 实时流式 LLM 输出渲染
- Smart Scroll Lock 智能滚动
- 代码块自动折叠（>10 行）
- Overlay 面板（帮助、上下文、时间线、搜索、God 详情）
- God 决策横幅和任务分析卡片
- Minimal/Verbose 显示模式切换

### 会话持久化
- 原子写入（write-tmp-rename）保证崩溃一致性
- 支持会话保存、恢复（`duo resume`）
- God 审计日志查看（`duo log`）
- JSONL 追加模式历史记录

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js ≥20 (ESM) |
| 语言 | TypeScript 5.9 (strict mode) |
| 状态管理 | XState v5 |
| UI 框架 | Ink 6 + React 19 |
| Schema 校验 | Zod 4 |
| 构建工具 | tsup |
| 测试框架 | Vitest 4 |
| 包管理 | npm |

## 项目结构

```
src/
├── index.ts                          # 版本导出
├── cli.ts                            # CLI 入口 — 命令解析、Ink 渲染启动
├── cli-commands.ts                   # CLI 命令处理器 (start/resume/log)
│
├── types/                            # 核心类型定义
│   ├── adapter.ts                    # CLIAdapter 接口、OutputChunk、ExecOptions
│   ├── session.ts                    # SessionConfig、StartArgs、ValidationResult
│   ├── ui.ts                         # RoleName、RoleStyle — 角色显示样式
│   ├── god-adapter.ts                # GodAdapter 接口
│   ├── god-schemas.ts                # God 输出 Zod Schema (5 种决策结构)
│   ├── god-actions.ts                # God 动作类型
│   ├── god-envelope.ts               # God 消息信封
│   └── observation.ts                # 观察事件类型
│
├── adapters/                         # AI 工具适配层
│   ├── registry.ts                   # CLI 工具注册表 (12 种工具)
│   ├── detect.ts                     # CLI 工具自动检测
│   ├── factory.ts                    # Adapter 工厂
│   ├── process-manager.ts            # 子进程生命周期管理
│   ├── output-stream-manager.ts      # 输出流多消费者广播
│   ├── env-builder.ts                # 环境变量白名单构建
│   └── <tool-name>/adapter.ts        # 12 个具体适配器实现
│
├── parsers/                          # 输出解析器
│   ├── stream-json-parser.ts         # 流式 JSON (Claude/Gemini/Amp/Qwen)
│   ├── jsonl-parser.ts               # JSONL (Codex/Cline)
│   ├── text-stream-parser.ts         # 纯文本 (Aider/Amazon Q/Goose)
│   └── god-json-extractor.ts         # God JSON 提取与 Zod 校验
│
├── session/                          # 会话管理
│   ├── session-starter.ts            # 会话启动与参数验证
│   ├── session-manager.ts            # 会话持久化 (原子写入)
│   ├── context-manager.ts            # Prompt 模板与上下文构建
│   └── prompt-log.ts                 # Prompt 日志记录
│
├── decision/                         # 决策引擎 (God 降级 fallback)
│   ├── choice-detector.ts            # 选择题检测
│   └── convergence-service.ts        # 规则收敛判定
│
├── engine/                           # 工作流引擎
│   ├── workflow-machine.ts           # XState v5 状态机
│   └── interrupt-handler.ts          # 中断处理
│
├── god/                              # God LLM 智能编排 (23+ 文件)
│   ├── adapters/                     # God 专用适配器
│   ├── god-call.ts                   # 统一 God 调用接口
│   ├── god-system-prompt.ts          # God 系统提示词
│   ├── god-prompt-generator.ts       # 动态 Coder/Reviewer 提示词
│   ├── god-context-manager.ts        # God 上下文与 token 管理
│   ├── task-init.ts                  # 任务分析与分类
│   ├── god-router.ts                 # 路由决策
│   ├── god-convergence.ts            # 收敛判断
│   ├── auto-decision.ts              # 自主 accept/continue 决策
│   ├── rule-engine.ts                # 同步规则引擎 (<5ms)
│   ├── consistency-checker.ts        # God 输出一致性校验
│   ├── loop-detector.ts              # 死循环检测与干预
│   ├── drift-detector.ts             # 决策质量漂移检测
│   ├── degradation-manager.ts        # 四级降级管理 (L1-L4)
│   ├── alert-manager.ts              # 告警管理
│   ├── phase-transition.ts           # 多阶段任务管理
│   ├── interrupt-clarifier.ts        # 中断意图分类
│   ├── god-audit.ts                  # 审计日志 (JSONL)
│   ├── god-session-persistence.ts    # God 会话持久化
│   ├── tri-party-session.ts          # 三方会话协调
│   ├── god-decision-service.ts       # 决策服务
│   ├── hand-executor.ts              # Hand 执行器
│   ├── message-dispatcher.ts         # 消息分发
│   ├── observation-classifier.ts     # 观察分类
│   └── observation-integration.ts    # 观察集成
│
└── ui/                               # 终端 UI 层
    ├── (19 个状态管理文件)            # 滚动、显示模式、God 横幅等
    └── components/ (21 个组件)        # App、MainLayout、各 Overlay 等
```

## 模块文档

详细模块文档位于 `docs/` 目录：

| 文档 | 描述 |
|------|------|
| [architecture.md](docs/architecture.md) | 系统架构（8 层、数据流、状态机） |
| [cli-entry.md](docs/modules/cli-entry.md) | CLI 入口、命令解析 |
| [type-system.md](docs/modules/type-system.md) | 核心类型系统（含 God 类型） |
| [adapter-layer.md](docs/modules/adapter-layer.md) | AI 工具适配层 |
| [parsers.md](docs/modules/parsers.md) | 输出解析器 |
| [session-management.md](docs/modules/session-management.md) | 会话管理与持久化 |
| [decision-engine.md](docs/modules/decision-engine.md) | 决策引擎（降级 fallback） |
| [workflow-engine.md](docs/modules/workflow-engine.md) | XState 工作流状态机 |
| [god-orchestrator.md](docs/modules/god-orchestrator.md) | God LLM 编排器 |
| [ui-state.md](docs/modules/ui-state.md) | UI 状态管理 |
| [ui-components.md](docs/modules/ui-components.md) | UI 组件 |

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build

# 测试
npm test
```

## CLI 命令

```bash
# 交互式启动（SetupWizard 向导）
duo start

# 指定参数启动
duo start --dir ./my-project --coder claude-code --reviewer codex --task "Add JWT auth"

# 列出可恢复的会话
duo resume

# 恢复指定会话
duo resume <session-id>

# 查看 God 审计日志
duo log <session-id>

# 查看版本
duo --version
```

## License

ISC
