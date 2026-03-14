# 输出解析器 (Parsers)

## 模块职责

解析器模块负责将不同 CLI 工具产生的原始输出流解析为统一的 `OutputChunk` 格式。由于各 AI CLI 工具的输出协议各异（NDJSON 事件流、JSONL 行、纯文本），解析器层屏蔽了这些差异，为上层提供一致的 `AsyncIterable<OutputChunk>` 接口。

此外，模块还提供 `GodJsonExtractor`——一个非流式的 JSON 提取工具，用于从 God LLM 的文本输出中提取结构化 JSON 并进行 Zod schema 校验。

---

## 文件清单

| 文件 | 职责 |
|------|------|
| `src/parsers/index.ts` | 统一导出四类解析器 |
| `src/parsers/stream-json-parser.ts` | 解析 NDJSON stream-json 格式 |
| `src/parsers/jsonl-parser.ts` | 解析 JSONL / --json 格式 |
| `src/parsers/text-stream-parser.ts` | 解析纯文本流 |
| `src/parsers/god-json-extractor.ts` | 从 God LLM 输出中提取 JSON 并校验 schema |

---

## 四类解析器

### 1. StreamJsonParser (`stream-json-parser.ts`)

**适用 CLI 工具**：Claude Code、Gemini CLI、Amp、Qwen

**概述**：解析 NDJSON（Newline-Delimited JSON）事件流。这些工具以 `--output-format stream-json` 输出结构化事件，每行一个 JSON 对象，包含丰富的类型信息（assistant 消息、tool_use、tool_result、error、status 等）。

#### 解析流程

1. 从 `ReadableStream<string>` 逐块读取数据
2. 按 `\n` 分行，最后不完整的行保留在 buffer 中
3. 跳过空行
4. 每行尝试 `JSON.parse`，解析失败计入 `malformedLineCount` 并跳过
5. 解析成功后调用 `mapToChunks()` 根据 `type` 字段映射为 `OutputChunk[]`
6. 流结束后处理 buffer 中残余的最后一行

#### 事件类型映射

| 输入 `type` | 输出 `OutputChunk.type` | 映射逻辑 |
|-------------|------------------------|----------|
| `assistant` | `text` / `tool_use` / `tool_result` | 复合映射：优先检查 `message.content` 数组，遍历每项按 `text` / `tool_use` / `tool_result` 分别映射；若无 message，检查 `subtype === 'text'` 或直接取 `content` 字符串 |
| `user` | `tool_result` | 提取 `message.content` 中 `type === 'tool_result'` 的项；支持 `is_error` 标记；fallback 到 `tool_use_result.stdout/stderr` |
| `tool_use` | `tool_use` | 直接映射，`metadata` 包含 `tool` 名称和 `input` |
| `tool_result` | `tool_result` | 直接映射 |
| `error` | `error` | 提取错误消息（支持 `event.error.message`、`event.error` 字符串、`event.message`、`event.content` 多种格式），`metadata.fatal` 默认 `true` |
| `result` / `status` / `system` / `rate_limit_event` | `status` | 状态类事件，content 为完整事件的 JSON 序列化，metadata 为原始事件对象 |
| 其他/未知 | `text` | 若有 `content` 字符串字段则输出为文本，否则忽略（返回空数组） |

#### assistant 事件的多层解析

`assistant` 事件是最复杂的类型，StreamJsonParser 通过 `mapAssistantEvent()` 处理三种格式：

1. **完整消息格式**：`event.message.content` 是数组，每项有独立的 `type`（`text`、`tool_use`、`tool_result`），通过 `mapContentItems()` 逐项映射
2. **简写格式**：`event.subtype === 'text'`，直接取 `event.content` 作为文本
3. **最简格式**：`event.content` 为字符串，直接映射为 text

#### user 事件处理

`user` 事件中提取 `tool_result` 类型的 content 项。对于 `is_error === true` 的项，标记 `metadata.isError = true`，内容 fallback 到 `tool_use_result.stdout` 或 `stderr`。

---

### 2. JsonlParser (`jsonl-parser.ts`)

**适用 CLI 工具**：Codex、Cline、GitHub Copilot、Cursor、Continue

**概述**：解析 JSONL（JSON Lines）格式输出。与 StreamJsonParser 的区别在于事件类型体系不同——JSONL 格式的工具使用更扁平的事件结构，且包含 Codex 特有的 `item.completed` / `item.started` 格式。

#### 解析流程

与 StreamJsonParser 结构一致：逐块读取 → 分行 → JSON.parse → `mapToChunk()` 映射。但 `mapToChunk()` 返回单个 `OutputChunk | null`（而非数组），因为 JSONL 事件通常一对一映射。

#### 事件类型映射

| 输入 `type` | 输出 `OutputChunk.type` | 映射逻辑 |
|-------------|------------------------|----------|
| `message` / `text` | `text` | 取 `event.content` |
| `code` / `patch` | `code` | 取 `event.content`，可附带 `metadata.language` |
| `function_call` / `tool_use` | `tool_use` | 取 `event.arguments` 或序列化整个事件，`metadata.tool` 取 `name` 或 `tool` |
| `tool_result` / `function_result` | `tool_result` | 取 `event.content` 或 `event.output` |
| `error` | `error` / `status` | 通过 `mapErrorLikeEvent()` 区分真实错误与瞬态网络问题 |
| `status` / `done` / `completion` | `status` | 通用状态事件 |
| `thread.started` / `turn.started` / `turn.completed` | `status` | Codex 线程/轮次生命周期事件，metadata 保留原始事件 |
| `item.completed` | `text` / `tool_result` / `error` | **Codex 特有格式**——见下方详解 |
| `item.started` | `tool_use` | **Codex 特有格式**——`command_execution` 开始时映射为 tool_use |
| 其他/未知 | `text` | 若有 `content` 字段则输出为文本，否则返回 null（忽略） |

#### Codex 特有事件格式

Codex 使用 `item.completed` 和 `item.started` 包装事件，内嵌 `item` 对象：

- **`item.completed` + `item.type === 'agent_message'`** → `text`（取 `item.text`）
- **`item.completed` + `item.type === 'command_execution'`** → `tool_result`（取 `item.aggregated_output`，metadata 包含 `tool: 'shell'` 和 `command`）
- **`item.completed` + `item.type === 'error'`** → `error`（通过 `mapErrorLikeEvent` 处理）
- **`item.started` + `item.type === 'command_execution'`** → `tool_use`（取 `item.command`，`metadata.tool = 'shell'`）

#### 瞬态错误检测

`mapErrorLikeEvent()` 方法识别两类传输层瞬态错误：

- `Reconnecting... N/N` 格式的重连消息
- `Falling back from WebSockets to HTTPS transport` 降级消息

匹配到这些模式时，事件类型从 `error` 降级为 `status`，`metadata.transient = true`，避免上层误报为致命错误。

---

### 3. TextStreamParser (`text-stream-parser.ts`)

**适用 CLI 工具**：Aider、Amazon Q、Goose

**概述**：解析纯文本流。无需 JSON 解析，通过正则匹配实现代码块识别和错误模式检测。

#### 解析流程

```
读取 ReadableStream 数据块
       |
  按 \n 分行（最后不完整行保留在 buffer 中）
       |
  遍历每行 ──────────────────┐
       |                     |
  当前在代码块中?             |
    是 → 遇到 ``` 结束标记?  |
      是 → 输出 code chunk   |
      否 → 行加入 codeLines  |
    否 → 行匹配 ``` 开始?    |
      是 → flush textBuffer, 进入代码块模式
      否 → 行匹配错误模式?   |
        是 → flush textBuffer, 输出 error chunk
        否 → 行加入 textBuffer
       |                     |
  流结束 ←───────────────────┘
       |
  处理 buffer 残余内容
  flush 剩余 textBuffer
  flush 未闭合的 codeLines
```

#### 代码块识别

使用 Markdown 风格的代码围栏（code fence）：

- **开始标记**：`` /^```(\w*)$/ `` — 匹配 `` ``` `` 或 `` ```python `` 等，捕获语言标识存入 `codeLanguage`
- **结束标记**：`` /^```$/ `` — 匹配独立的 `` ``` ``

检测到开始标记时先 flush 已累积的 textBuffer 为一个 `text` chunk，然后进入代码块模式。遇到结束标记时将 `codeLines` 合并输出为一个 `code` chunk，`metadata.language` 记录语言标识。

若流结束时代码块未闭合，仍然输出已积累的代码内容（不丢弃）。

#### 错误模式检测

内置 6 种正则模式，对非代码块中的每行逐一匹配：

```typescript
const ERROR_PATTERNS = [
  /^Error:/i,        // 通用错误
  /^fatal:/i,        // Git fatal 错误
  /^exception:/i,    // 异常
  /^traceback/i,     // Python traceback
  /^panic:/i,        // Go/Rust panic
  /^FAIL/,           // 测试失败
];
```

匹配到错误模式时先 flush textBuffer，再将当前行作为 `error` 类型 chunk 输出。

#### 输出类型

| 输出 `OutputChunk.type` | 触发条件 |
|------------------------|----------|
| `text` | 普通文本行（累积后 flush） |
| `code` | 被 `` ``` `` 围栏包围的代码块，`metadata.language` 记录语言 |
| `error` | 匹配 ERROR_PATTERNS 的行 |

#### ReadableStream 错误处理

`reader.read()` 调用被 try-catch 包裹。若流出错（如子进程崩溃导致 ReadableStream error），错误会被暂存到 `streamError`，待正常清理（flush buffer、flush textBuffer、flush codeLines）完成后再抛出，确保已接收的数据不丢失。

---

### 4. GodJsonExtractor (`god-json-extractor.ts`)

**用途**：从 God LLM（编排层 LLM）的文本输出中提取结构化 JSON 数据

**概述**：与前三类流式解析器不同，GodJsonExtractor 是一个非流式工具函数集。God LLM 的输出通常是自然语言文本中嵌入一个 `` ```json ... ``` `` 代码块，GodJsonExtractor 负责提取最后一个 JSON 代码块并通过 Zod schema 校验其结构正确性。

#### 核心函数

##### extractGodJson

```typescript
function extractGodJson<T>(
  output: string,
  schema: z.ZodSchema<T>,
): ExtractResult<T> | null
```

从完整的 CLI 文本输出中提取最后一个 `` ```json ... ``` `` 代码块，解析 JSON 并通过 Zod schema 校验。

**返回值语义**：
- `null` — 未找到 JSON 代码块（纯文本输出，非错误）
- `{ success: true, data: T }` — 提取并校验成功
- `{ success: false, error: string }` — JSON 解析失败或 schema 校验失败，error 包含具体原因

**提取策略**：使用正则 `` /```json\s*\n([\s\S]*?)```/g `` 全局匹配，取最后一个匹配结果。选择"最后一个"是因为 God LLM 可能在推理过程中输出多个 JSON 块，最终结果通常在最后。

##### extractWithRetry

```typescript
async function extractWithRetry<T>(
  output: string,
  schema: z.ZodSchema<T>,
  retryFn: (errorHint: string) => Promise<string>,
): Promise<ExtractResult<T> | null>
```

带重试的提取函数。当首次提取失败（JSON 解析错误或 schema 校验失败）时，将错误信息作为 hint 传递给 `retryFn`（通常是重新调用 God LLM 让其修正输出），然后对重试输出再做一次提取。

**重试策略**：
- 纯文本输出（无 JSON 块）→ **不重试**，直接返回 `null`
- 首次提取成功 → 返回结果（附带 `sourceOutput` 字段记录原始输出）
- 首次提取失败 → 调用 `retryFn(error)` 获取新输出 → 再次提取
- 重试仍失败 → 返回 `null`

最多重试 1 次，避免无限循环。

#### ExtractResult 类型

```typescript
type ExtractResult<T> =
  | { success: true; data: T; sourceOutput?: string }
  | { success: false; error: string };
```

`sourceOutput` 仅在 `extractWithRetry` 成功时填充，记录产生最终数据的原始 CLI 输出文本。

#### Zod 校验错误格式化

内部 `formatZodError()` 将 Zod 的 `ZodError` 转换为可读字符串，格式为：

```
Schema validation failed: field.path: error message; another.path: error message
```

路径为空时显示 `(root)`。这个格式化后的字符串可以直接作为 `retryFn` 的 hint 传递给 God LLM，帮助其理解哪些字段不符合预期。

#### 与流式解析器的对比

| 特性 | StreamJsonParser / JsonlParser / TextStreamParser | GodJsonExtractor |
|------|--------------------------------------------------|------------------|
| 输入 | `ReadableStream<string>`（流式） | `string`（完整文本） |
| 输出 | `AsyncIterable<OutputChunk>` | `ExtractResult<T> \| null` |
| 用途 | 解析 CLI 工具的实时输出流 | 从 God LLM 输出中提取结构化决策 |
| Schema 校验 | 无（基于事件类型映射） | Zod schema 严格校验 |
| 重试机制 | 无（跳过 malformed line 继续） | 支持 1 次自动重试 |

---

## Malformed Line 处理机制

StreamJsonParser 和 JsonlParser 共享相同的 malformed line 处理策略：

### 处理流程

1. **逐行 JSON.parse**：解析失败时不抛出异常，而是递增 `malformedLineCount` 计数器
2. **warn 日志**：每遇到一个 malformed line，输出 `console.warn` 日志（截断到前 100 字符以防日志爆炸）
3. **继续处理**：跳过该行，继续解析后续行（不会因单行损坏而终止整个解析）
4. **尾部数据**：流结束后若 buffer 中有残余数据也尝试解析，失败同样计入 malformed

### 汇总 status chunk

解析完成后，若 `malformedLineCount > 0`，自动 yield 一个汇总性质的 `status` chunk：

```typescript
{
  type: 'status',
  content: '[StreamJsonParser] 3 malformed JSON line(s) skipped',
  timestamp: Date.now(),
}
```

JsonlParser 格式相同，前缀为 `[JsonlParser]`。

这个汇总 chunk 在 `finally` 释放 reader lock 之后 yield，确保：
- 上层能感知到解析过程中存在数据质量问题
- 不中断正常的输出流
- 提供可操作的诊断信息（跳过了多少行）

---

## 解析器选择逻辑

解析器的选择由 `registry.ts` 中每个 CLI 工具条目的 `parserType` 字段决定。各适配器在构造函数中直接实例化对应的 Parser：

| `parserType` | 解析器类 | 适用工具 |
|--------------|----------|----------|
| `stream-json` | `StreamJsonParser` | Claude Code, Gemini CLI, Amp, Qwen |
| `jsonl` | `JsonlParser` | Codex, GitHub Copilot, Cursor, Cline, Continue |
| `text` | `TextStreamParser` | Aider, Amazon Q, Goose |
| _(非流式)_ | `GodJsonExtractor` | God LLM 编排层输出 |

选择依据：
- **stream-json**：工具原生支持 `--output-format stream-json`，输出丰富的结构化事件（assistant/user/tool_use/result 等）
- **jsonl**：工具支持 `--json` 或类似标志，输出每行一个 JSON 对象，但事件类型体系与 stream-json 不同
- **text**：工具仅输出纯文本（无结构化 JSON 选项），需通过正则提取代码块和错误
- **GodJsonExtractor**：非流式使用场景，从 God LLM 的完整输出中提取 JSON 决策并进行 schema 校验

---

## 统一输出接口

三类流式解析器的 `parse()` 方法签名完全一致：

```typescript
async *parse(stream: ReadableStream<string>): AsyncIterable<OutputChunk>
```

`OutputChunk` 是统一的输出单元：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'text' \| 'code' \| 'tool_use' \| 'tool_result' \| 'error' \| 'status'` | chunk 语义类型 |
| `content` | `string` | 主体内容 |
| `timestamp` | `number` | 生成时间戳（`Date.now()`） |
| `metadata` | `Record<string, unknown>` (可选) | 附加元信息，如 `language`（代码语言）、`tool`（工具名）、`fatal`（是否致命）、`session_id`、`thread_id`、`transient`（是否瞬态）、`isError`（tool_result 是否失败）等 |

六种 type 的语义：

| type | 语义 |
|------|------|
| `text` | AI 助手的文本输出 |
| `code` | 代码块（含语言标识） |
| `tool_use` | AI 调用工具（函数调用） |
| `tool_result` | 工具执行结果 |
| `error` | 错误（致命或可恢复） |
| `status` | 状态信息（会话事件、rate limit、malformed 汇总等） |

上层模块（如 `OutputStreamManager`）消费 `AsyncIterable<OutputChunk>` 即可，无需关心底层 CLI 的输出协议差异。

GodJsonExtractor 则使用独立的 `ExtractResult<T>` 类型，通过 Zod schema 泛型参数 `T` 提供类型安全的结构化输出。

---

## 导出清单

`src/parsers/index.ts` 统一导出：

```typescript
export { StreamJsonParser } from './stream-json-parser.js';
export { JsonlParser } from './jsonl-parser.js';
export { TextStreamParser } from './text-stream-parser.js';
export { extractGodJson, extractWithRetry } from './god-json-extractor.js';
export type { ExtractResult } from './god-json-extractor.js';
```

GodJsonExtractor 导出的是函数（`extractGodJson`、`extractWithRetry`）和类型（`ExtractResult`），而非 class 实例，因为它是无状态的纯函数工具。
