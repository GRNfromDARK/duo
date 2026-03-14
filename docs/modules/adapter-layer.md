# 适配器层 (Adapter Layer)

## 模块职责

适配器层是 Duo 与外部 AI CLI 工具之间的统一抽象层。其核心职责：

- **统一接口**：将 12 种不同的 AI CLI 工具（Claude Code、Codex、Gemini 等）封装为一致的 `CLIAdapter` 接口
- **进程生命周期管理**：通过 `ProcessManager` 管理子进程的 spawn、kill、超时和心跳检测
- **环境变量隔离**：通过 `buildAdapterEnv` 白名单机制为每个适配器构建最小化环境变量，避免泄露或干扰
- **插件化扩展**：通过注册表 + 工厂模式支持新增适配器，零侵入式扩展
- **输出流广播**：通过 `OutputStreamManager` 支持多消费者同时读取同一输出流

---

## 文件清单

### 基础设施

| 文件 | 职责 |
|------|------|
| `src/types/adapter.ts` | 核心类型定义：`CLIAdapter`、`ExecOptions`、`OutputChunk`、`CLIRegistryEntry` |
| `src/adapters/registry.ts` | 12 个 CLI 工具的静态注册表 |
| `src/adapters/detect.ts` | 并行自动检测已安装的 CLI 工具，加载用户自定义配置 |
| `src/adapters/factory.ts` | 适配器工厂，按名称创建 `CLIAdapter` 实例 |
| `src/adapters/process-manager.ts` | 子进程生命周期管理（spawn、kill、超时、心跳） |
| `src/adapters/env-builder.ts` | 环境变量白名单构建器 |
| `src/adapters/output-stream-manager.ts` | 多消费者输出流广播与缓冲 |

### 适配器实现（12 个）

| 文件 | 工具 | 解析器 |
|------|------|--------|
| `src/adapters/claude-code/adapter.ts` | Claude Code | StreamJsonParser |
| `src/adapters/codex/adapter.ts` | Codex | JsonlParser |
| `src/adapters/gemini/adapter.ts` | Gemini CLI | StreamJsonParser |
| `src/adapters/copilot/adapter.ts` | GitHub Copilot | JsonlParser |
| `src/adapters/aider/adapter.ts` | Aider | TextStreamParser |
| `src/adapters/amazon-q/adapter.ts` | Amazon Q | TextStreamParser |
| `src/adapters/cursor/adapter.ts` | Cursor | JsonlParser |
| `src/adapters/cline/adapter.ts` | Cline | JsonlParser |
| `src/adapters/continue/adapter.ts` | Continue | JsonlParser |
| `src/adapters/goose/adapter.ts` | Goose | TextStreamParser |
| `src/adapters/amp/adapter.ts` | Amp | StreamJsonParser |
| `src/adapters/qwen/adapter.ts` | Qwen | StreamJsonParser |

---

## 插件化架构设计

适配器层采用三层设计：**接口 -> 注册表 -> 工厂**。

### CLIAdapter 接口

```typescript
interface CLIAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly version: string;

  isInstalled(): Promise<boolean>;
  getVersion(): Promise<string>;
  execute(prompt: string, opts: ExecOptions): AsyncIterable<OutputChunk>;
  kill(): Promise<void>;
  isRunning(): boolean;
}
```

所有适配器实现此接口。`execute()` 返回 `AsyncIterable<OutputChunk>`，上层通过 `for await...of` 消费输出流。每个适配器内部组合 `ProcessManager`（进程管理）+ Parser（输出解析）来实现 `execute()`。

### 注册表 (Registry)

`CLI_REGISTRY` 是一个静态 `Record<string, CLIRegistryEntry>`，集中存储每个工具的元数据：

- `command` — 可执行文件名（如 `claude`、`codex`、`gemini`）
- `detectCommand` — 检测版本的命令（如 `claude --version`）
- `execCommand` — 执行提示词的命令模板（如 `claude -p`）
- `outputFormat` — 输出格式标识（`stream-json`、`--json`、`text`）
- `yoloFlag` — 跳过权限确认的标志（如 `--dangerously-skip-permissions`）
- `parserType` — 对应的解析器类型（`stream-json`、`jsonl`、`text`）

导出的辅助函数：`getRegistryEntries()` 返回所有条目数组，`getRegistryEntry(name)` 按名称查找。

### 工厂 (Factory)

`createAdapter(name: string): CLIAdapter` 通过 `ADAPTER_CONSTRUCTORS` 映射表根据名称实例化对应适配器。包含全部 12 个适配器的构造函数。传入未知名称时抛出异常并列出所有可用适配器。

---

## ProcessManager 详解

**文件**：`src/adapters/process-manager.ts`

ProcessManager 继承自 `EventEmitter`，管理 CLI 子进程的完整生命周期。每个适配器在构造函数中创建自己的 ProcessManager 实例。

### ProcessTimeoutError

当进程因超时被终止时抛出的自定义错误类。适配器通过此错误类型通知编排层分发 TIMEOUT 事件到状态机。

```typescript
class ProcessTimeoutError extends Error {
  name = 'ProcessTimeoutError';
}
```

### spawn

```typescript
spawn(command, args, opts, heartbeatOpts?): ChildProcess
```

- 使用 `detached: true` 创建独立进程组，便于通过 `-pid` 向整个进程组发信号
- stdio 配置：`['ignore', 'pipe', 'pipe']`（stdin 忽略，stdout/stderr 管道捕获）
- 环境变量处理：若 `opts.replaceEnv === true` 且提供了 `opts.env`，则完全替换 `process.env`；否则合并
- 输出缓冲区上限 50MB（`DEFAULT_MAX_BUFFER_BYTES`），超出时丢弃旧数据只保留最新的 50MB，并正确处理 UTF-8 多字节字符截断（跳过 continuation bytes `0x80-0xBF`）
- 注册 `process.on('exit')` 处理器，确保父进程退出时通过 `SIGKILL` 杀死子进程组

同一时刻只允许一个进程运行，重复调用 `spawn()` 会抛出异常。

### kill（优雅终止）

两阶段终止流程：

```
SIGTERM(-pid) → 等待 5s (SIGTERM_GRACE_MS) → SIGKILL(-pid) → 等待 3s (SIGKILL_TIMEOUT_MS)
```

1. 向进程组发送 `SIGTERM`（`process.kill(-pid, 'SIGTERM')`），给子进程及其子进程树清理的机会
2. 通过 `Promise.race` 等待进程在 5 秒内自行退出
3. 若 5 秒后仍未退出，升级为 `SIGKILL`（不可忽略的强制终止信号）
4. SIGKILL 后再等待 3 秒作为硬超时兜底，防止无限挂起
5. 最终标记 `running = false`，清理 `parentExitHandler`

### close vs exit 事件

ProcessManager 监听子进程的 `close` 事件而非 `exit` 事件。两者的关键区别：

- `exit` — 进程结束时立即触发，但此时 stdio 流可能尚未完全刷新
- `close` — 在所有 stdio 流关闭之后才触发，确保不会丢失尾部输出数据

`close` 回调中的处理逻辑：
1. 标记 `running = false`，清除所有定时器
2. 若退出码非零，触发 `process-error` 事件（携带 `ProcessErrorInfo`）
3. 始终触发 `process-complete` 事件（携带 `{ exitCode, signal, timedOut }`）——适配器据此关闭 ReadableStream 的 controller
4. resolve `exitPromise`，唤醒所有 `waitForExit()` 调用者

此外，`error` 事件处理 spawn 失败（如命令不存在），同样触发 `process-error` + `process-complete`。

### dispose（异步清理）

```typescript
async dispose(): Promise<void>
```

完整清理 ProcessManager 实例，释放所有资源：

1. 清除定时器（timeout、heartbeat），但保留 `parentExitHandler` 直到进程确认终止
2. 若进程仍在运行，先调用 `kill()` 等待其终止
3. kill 完成后移除 `parentExitHandler`，防止内存泄漏
4. 移除 child 的 stdout/stderr 及自身的所有事件监听器
5. 调用 `this.removeAllListeners()` 清理 EventEmitter

### 超时与心跳

| 机制 | 默认值 | 行为 |
|------|--------|------|
| 全局超时 | 10 分钟（`DEFAULT_TIMEOUT_MS`） | 超时后标记 `timedOut = true`，触发 `timeout` 事件并自动调用 `kill()` |
| 心跳间隔 | 30 秒（`DEFAULT_HEARTBEAT_INTERVAL_MS`） | 定时检查最后输出时间 |
| 心跳超时 | 60 秒（`DEFAULT_HEARTBEAT_TIMEOUT_MS`） | 无输出超过此时间触发 `heartbeat-warning` 事件（携带 `silentMs`） |

心跳不会自动 kill 进程，只是发出警告事件，由上层决定如何处理。

### 输出缓冲

ProcessManager 内部维护输出缓冲区用于 `collectOutput()` 和 `getBufferedOutput()`。当缓冲区超过 `maxBufferBytes`（默认 50MB，可通过构造函数 `ProcessManagerOptions` 配置）时，自动淘汰旧数据，只保留最新的 50MB 内容。截断操作会正确处理 UTF-8 边界，避免产生非法字符。

### 事件列表

| 事件 | 载荷 | 触发时机 |
|------|------|----------|
| `process-error` | `ProcessErrorInfo` (`exitCode`, `signal`, `message`) | 非零退出码或 spawn 失败 |
| `process-complete` | `{ exitCode, signal, timedOut }` | 进程结束（正常或异常均触发） |
| `timeout` | 无 | 全局超时触发 |
| `heartbeat-warning` | `{ silentMs }` | 无输出时间超过阈值 |

---

## EnvBuilder 详解

**文件**：`src/adapters/env-builder.ts`

### 设计理念

不盲目转发父进程的全量 `process.env`，而是通过白名单机制为每个适配器构建最小化、显式的环境变量集合。这样做的好处：

- 避免 API Key 泄露到不需要它的 CLI 工具
- 防止环境变量冲突（如 Duo 自身的变量干扰子进程）
- 每个适配器显式声明自己的依赖，便于审计

### BASE_ENV_VARS

所有适配器共享的系统变量白名单（13 个）：

```
PATH, HOME, SHELL, LANG, TERM, USER, LOGNAME,
TMPDIR, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME,
LC_ALL, LC_CTYPE
```

这些是 CLI 工具正常运行所需的基础系统变量。

### buildAdapterEnv 函数

```typescript
function buildAdapterEnv(opts: BuildAdapterEnvOptions):
  { env: Record<string, string>; replaceEnv: true }
```

接受三个可选参数：

| 参数 | 说明 | 示例 |
|------|------|------|
| `requiredVars` | 精确变量名白名单 | — |
| `requiredPrefixes` | 前缀模式匹配，遍历 `process.env` 中以该前缀开头的所有变量 | `'ANTHROPIC_'` 匹配 `ANTHROPIC_API_KEY` 等 |
| `extraEnv` | 适配器注入的额外变量（优先级最高，覆盖一切） | `{ GOOSE_MODE: 'auto' }` |

构建顺序（后者覆盖前者）：

```
BASE_ENV_VARS → requiredVars → requiredPrefixes → extraEnv
```

返回值始终包含 `replaceEnv: true`，传递给 ProcessManager 的 `spawn()` 时完全替换 `process.env`，不会有意外的环境变量泄入。

### requiredEnvVars 契约

每个适配器在 `execute()` 中通过 `requiredPrefixes` 声明自己需要的环境变量前缀，形成明确的依赖契约：

| 适配器 | requiredPrefixes | 说明 |
|--------|------------------|------|
| Claude Code | `ANTHROPIC_`, `CLAUDE_` | Anthropic API 密钥 + Claude 配置 |
| Codex | `OPENAI_` | OpenAI API 密钥 |
| Gemini | `GOOGLE_`, `GEMINI_` | Google / Gemini API 密钥 |
| Copilot | `GITHUB_`, `COPILOT_` | GitHub 认证 + Copilot 配置 |
| Aider | `OPENAI_`, `ANTHROPIC_`, `AIDER_` | 多后端支持 + Aider 自身配置 |
| Amazon Q | `AWS_`, `AMAZON_` | AWS 凭证 |
| Cursor | `CURSOR_` | Cursor 配置 |
| Cline | `OPENAI_`, `ANTHROPIC_`, `CLINE_` | 多后端支持 + Cline 配置 |
| Continue | `CONTINUE_` | Continue 配置 |
| Goose | `GOOSE_` | Goose 配置（`GOOSE_MODE=auto` 通过 extraEnv 注入） |
| Amp | `AMP_` | Amp 配置 |
| Qwen | `QWEN_`, `DASHSCOPE_` | Qwen / DashScope API 密钥 |

---

## 注册表 12 个工具信息

| 名称 | displayName | command | execCommand | outputFormat | yoloFlag | parserType |
|------|-------------|---------|-------------|-------------|----------|------------|
| `claude-code` | Claude Code | `claude` | `claude -p` | `stream-json` | `--dangerously-skip-permissions` | `stream-json` |
| `codex` | Codex | `codex` | `codex exec` | `--json` | `--yolo` | `jsonl` |
| `gemini` | Gemini CLI | `gemini` | `gemini -p` | `stream-json` | `--yolo` | `stream-json` |
| `copilot` | GitHub Copilot | `copilot` | `copilot -p` | `JSON` | `--allow-all-tools` | `jsonl` |
| `aider` | Aider | `aider` | `aider -m` | `text` | `--yes-always` | `text` |
| `amazon-q` | Amazon Q | `q` | `q chat --no-interactive` | `text` | `--trust-all-tools` | `text` |
| `cursor` | Cursor | `cursor` | `cursor agent -p` | `JSON` | `--auto-approve` | `jsonl` |
| `cline` | Cline | `cline` | `cline -y` | `--json` | `-y` | `jsonl` |
| `continue` | Continue | `cn` | `cn -p` | `--format json` | `--allow` | `jsonl` |
| `goose` | Goose | `goose` | `goose run -t` | `text` | `GOOSE_MODE=auto` | `text` |
| `amp` | Amp | `amp` | `amp -x` | `stream-json` | _(空，内置自动模式)_ | `stream-json` |
| `qwen` | Qwen | `qwen` | `qwen -p` | `stream-json` | `--yolo` | `stream-json` |

---

## 自动检测机制

**文件**：`src/adapters/detect.ts`

### 检测流程

1. 从注册表获取全部条目，合并用户自定义条目（`additionalEntries`），排除 `disabledNames` 中指定的适配器
2. 使用 `Promise.all` 对每个条目并行检测：
   - 先通过 `which <command>` 判断命令是否存在
   - 若存在，解析并执行 `detectCommand`（如 `claude --version`）获取版本号
3. 所有检测受 `DETECT_TIMEOUT_MS = 3000`（3 秒）超时限制
4. 返回 `DetectedCLI[]`，包含 `name`、`displayName`、`command`、`installed`（boolean）、`version`（string | null）

### 用户自定义配置

通过 `loadAdaptersConfig(projectDir)` 从 `.duo/adapters.json` 加载：

```typescript
interface AdaptersConfig {
  custom: CLIRegistryEntry[];  // 自定义适配器条目，参与检测
  disabled: string[];          // 禁用的适配器名称，从检测中排除
}
```

支持两种格式：
- **对象格式**：`{ "custom": [...], "disabled": [...] }`
- **数组格式**（向后兼容）：`[...CLIRegistryEntry]`，视为全部是 `custom`

若文件不存在或解析失败，静默返回空配置。`loadCustomAdapters()` 已标记 `@deprecated`，请使用 `loadAdaptersConfig()`。

---

## 各适配器实现要点

每个适配器的 `execute()` 方法遵循统一模式：构建参数 → 构建环境变量 → spawn 子进程 → 将 stdout 包装为 `ReadableStream<string>` → 交给对应 Parser 解析 → yield `OutputChunk`。以下记录各适配器的关键差异点。

### ReadableStream 包装模式

所有适配器将 Node.js 的 `child.stdout` Readable 流转换为 Web `ReadableStream<string>`。stream controller 的生命周期由 ProcessManager 的 `process-complete` 事件驱动：

- 正常结束时调用 `controller.close()`
- 超时（`timedOut === true`）时调用 `controller.error(new ProcessTimeoutError())`
- stderr 数据根据适配器类型以不同格式注入流（JSON 包装或纯文本前缀）

### Claude Code (`claude-code`)

- **命令**：`claude -p <prompt> --output-format stream-json --verbose`
- **权限跳过**：`--dangerously-skip-permissions`
- **项目目录**：通过 `--add-dir <cwd>` 指定（而非依赖子进程 cwd）
- **System Prompt**：通过 `--system-prompt` 传递，但在 resume 模式下跳过（会话中已包含）
- **Tool 控制**：`opts.disableTools` 为 true 时传递 `--tools ''` 禁用所有工具（用于 God orchestrator 的纯 JSON 调用）
- **环境变量特殊处理**：调用 `buildAdapterEnv()` 后额外 `delete env.CLAUDECODE`，防止 Claude Code 检测到嵌套运行而拒绝启动
- **会话管理**：
  - 从 result 事件的 `metadata.session_id` 中捕获 session ID
  - 后续调用自动使用 `--resume <session_id>` 恢复会话
  - 不使用 `--continue` 以避免交叉污染
  - 恢复会话时跳过 `--system-prompt`（会话中已包含）
  - resume 失败时清除过期 session_id，下次从新会话开始
  - 若 resume 成功但未获取到新 session_id，也清除旧 ID
- **对外暴露**：`hasActiveSession()`、`getLastSessionId()`、`restoreSessionId(id)` 供上层管理会话持久化
- **stderr 处理**：以 JSON `{ type: 'error', content: msg }` 格式注入流

### Codex (`codex`)

- **命令**：`codex exec <prompt> --json --full-auto`（`--full-auto` 替代已废弃的 `--yolo`）
- **恢复模式**：`codex exec resume <thread_id> <prompt> --json`
- **Git 检查**：执行前调用 `git rev-parse --is-inside-work-tree` 检测 cwd 是否为 git 仓库；非 git 仓库时 yield warning 并传递 `--skip-git-repo-check`
- **会话管理**：从 `thread.started` 事件中捕获 `thread_id`，逻辑与 Claude Code 类似（resume 失败清除、无新 ID 时清除）
- **stderr 处理**：以 JSON `{ type: 'status', content, source: 'stderr' }` 格式注入流

### Gemini (`gemini`)

- **命令**：`gemini -p <prompt> --output-format stream-json --non-interactive --yolo`
- **最简单的适配器之一**：无会话管理，无 git 依赖
- **环境变量前缀**：`GOOGLE_`、`GEMINI_`
- **stderr 处理**：以 JSON `{ type: 'error', content: msg }` 格式注入流

### Copilot (`copilot`)

- **命令**：`copilot -p <prompt> --allow-all-tools`
- **环境变量前缀**：`GITHUB_`、`COPILOT_`

### Aider (`aider`)

- **命令**：`aider -m <prompt> --yes-always`
- **多后端支持**：环境变量前缀同时包含 `OPENAI_`、`ANTHROPIC_`、`AIDER_`
- **stderr 处理**：前缀 `Error: ` 后作为纯文本写入流（与 JSON 适配器不同，不做 JSON 包装）

### Amazon Q (`amazon-q`)

- **命令**：`q chat --no-interactive --trust-all-tools <prompt>`（prompt 放在末尾）
- **可执行文件名**：`q`（不是 `amazon-q`）
- **版本检测特殊性**：使用 `q version`（无 `--` 前缀，与其他工具不同）
- **环境变量前缀**：`AWS_`、`AMAZON_`
- **stderr 处理**：与 Aider 相同，`Error: ` 前缀纯文本

### Cursor (`cursor`)

- **命令**：`cursor agent -p <prompt> --auto-approve`
- **子命令**：使用 `agent` 子命令进入 agent 模式

### Cline (`cline`)

- **命令**：`cline -y <prompt> --json`
- **特殊设计**：`-y` 既是执行命令的一部分也兼作 yolo 标志（自动确认）
- **环境变量前缀**：`OPENAI_`、`ANTHROPIC_`、`CLINE_`（多后端支持）

### Continue (`continue`)

- **命令**：`cn -p <prompt> --format json --allow`
- **可执行文件名**：`cn`（不是 `continue`）

### Goose (`goose`)

- **命令**：`goose run -t <prompt>`
- **YOLO 模式特殊性**：通过环境变量 `GOOSE_MODE=auto` 实现（非 CLI 标志），在独立的 `buildEnv()` 方法中注入到 `extraEnv`
- **独立的 `buildEnv()` 方法**：该方法封装了 Goose 特有的环境变量逻辑，暴露为 public 以便测试
- **stderr 处理**：与 Aider、Amazon Q 相同，`Error: ` 前缀纯文本

### Amp (`amp`)

- **命令**：`amp -x <prompt>`
- **无 yolo 标志**：Amp 内置自动模式（design decision 记录在注释中），`buildArgs()` 忽略 `permissionMode`
- **环境变量前缀**：`AMP_`

### Qwen (`qwen`)

- **命令**：`qwen -p <prompt> --output-format stream-json --yolo`
- **环境变量前缀**：`QWEN_`、`DASHSCOPE_`

---

## OutputStreamManager 多消费者广播

**文件**：`src/adapters/output-stream-manager.ts`

### 架构

OutputStreamManager 接收一个 `AsyncIterable<OutputChunk>` 作为数据源（通常来自 `adapter.execute()`），通过内部 `pump()` 循环将每个 chunk 广播给所有已注册的 Consumer。

### 核心 API

| 方法 | 说明 |
|------|------|
| `start(source)` | 开始从 source 读取并广播，启动内部 pump 循环 |
| `consume()` | 创建一个新的 `AsyncIterable<OutputChunk>` 消费者（可在 start 前后调用） |
| `interrupt()` | 请求中断流，已接收的输出保留在 buffer 中 |
| `getBuffer()` | 获取所有已缓冲 chunk 的副本 |
| `getBufferedText()` | 获取所有 chunk 的 content 以空格拼接的文本 |
| `isStreaming()` | 是否正在流式传输 |
| `isInterrupted()` | 是否被中断（包括手动中断和异常中断） |
| `reset()` | 重置所有状态（buffer、consumers、标志位），支持实例复用 |

### Consumer 机制

每个 `consume()` 调用创建一个独立的 `AsyncIterableIterator`，内部维护自己的 queue 和 `done` 标志。当 pump 推送新 chunk 时，通过 `consumer.push()` 写入各 queue 并唤醒等待中的 `next()` Promise。流结束时调用 `consumer.end()` 终止迭代。

**Late Consumer 支持**：在 `start()` 之后调用 `consume()` 创建的消费者，会先收到 buffer 中所有已有 chunk 的重放（replay），然后继续接收新 chunk。若流已结束（`started && !streaming`），late consumer 会立即收到 end 信号。

Consumer 的 `return()` 方法支持提前退出迭代（如 `break` 语句触发），会标记自身 done 并释放 Promise。

### 中断处理

调用 `interrupt()` 设置 `interruptRequested` 标志。pump 循环在下一次 `for await` 迭代时检测到标志后 break，标记 `interrupted = true`，然后在 `finally` 中正常结束所有 consumer。已经写入 buffer 的数据不丢失，可通过 `getBuffer()` / `getBufferedText()` 获取。

异常同样标记为 interrupted，走相同的 finally 清理路径。

---

## 扩展方式

### 添加新适配器

1. **注册表**：在 `registry.ts` 的 `CLI_REGISTRY` 中添加条目，填写 `name`、`command`、`detectCommand`、`execCommand`、`outputFormat`、`yoloFlag`、`parserType`
2. **实现**：创建 `src/adapters/<name>/adapter.ts`，实现 `CLIAdapter` 接口
   - 构造函数中初始化 `ProcessManager` 和对应的 Parser（StreamJsonParser / JsonlParser / TextStreamParser）
   - `buildArgs()` 构建 CLI 参数（public 暴露以便单元测试）
   - `execute()` 中调用 `buildAdapterEnv({ requiredPrefixes })` → `processManager.spawn()` → 创建 `ReadableStream<string>` → `parser.parse(stream)` → yield chunks
   - 监听 ProcessManager 的 `process-complete` 事件来驱动 ReadableStream 的 close/error（超时时传递 `ProcessTimeoutError`）
   - `finally` 中检查并 kill 仍在运行的进程
3. **工厂注册**：在 `factory.ts` 的 `ADAPTER_CONSTRUCTORS` 中添加 `'<name>': () => new XxxAdapter()` 映射

### 禁用适配器

在项目目录的 `.duo/adapters.json` 中配置：

```json
{
  "disabled": ["adapter-name"]
}
```

该适配器将从自动检测结果中排除。

### 用户自定义适配器条目

通过 `.duo/adapters.json` 的 `custom` 字段添加工具条目（仅支持注册表级别元数据，工厂仍需代码中注册构造函数才能使用 `createAdapter()`）：

```json
{
  "custom": [
    {
      "name": "my-tool",
      "displayName": "My Tool",
      "command": "mytool",
      "detectCommand": "mytool --version",
      "execCommand": "mytool run -p",
      "outputFormat": "text",
      "yoloFlag": "--yes",
      "parserType": "text"
    }
  ]
}
```
