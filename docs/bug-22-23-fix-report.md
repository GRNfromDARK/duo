# BUG-22 / BUG-23 修复报告

**日期**: 2026-03-14
**Session**: `9f5ad612-2db8-4dc2-99e4-50eb759b7520`
**任务**: 模型选择功能（选择 LLM 后再选择具体模型）

---

## 问题发现过程

分析 session `9f5ad612` 的运行日志（god-audit.jsonl、prompt-log.jsonl、history.jsonl），发现两个严重 bug 导致 God Runtime 进入死循环：

- **Round 0-1**: God 成功解析 envelope，正常运转（reviewer 返回 CHANGES_REQUESTED）
- **Round 2+**: Reviewer 返回 APPROVED 后，God 解析失败 → fallback → 观察数据丢失 → 永久卡死
- **Degradation**: L1 → L3，连续失败 5 轮（round 2-6），无任何进展

---

## BUG-22 [P0]: Fallback 死循环 — 观察数据丢失

### 根因分析

```
God 解析失败
  ↓
buildFallbackEnvelope() 返回 actions: []
  ↓
executeActions([]) 返回 results: []
  ↓
workflow-machine: currentObservations = results = []  ← 观察数据永久丢失
  ↓
下一轮 God 调用: ## Recent Observations 为空
  ↓
God 没有上下文 → 产生更差的输出 → 再次解析失败
  ↓
无限循环，永无恢复可能
```

### 修复方案（两处互补）

**修复 A — `god-decision-service.ts:buildFallbackEnvelope()`**

```typescript
// 修复前: actions: []
// 修复后: 包含 wait action，确保执行管道产生观察数据
actions: [
  { type: 'wait', reason: 'God decision parsing failed — will retry with preserved context' },
],
```

**修复 B — `workflow-machine.ts` EXECUTION_COMPLETE 默认处理**

```typescript
// 修复前: 无条件替换观察数据
currentObservations: ({ event }) => (event as ExecutionCompleteEvent).results,

// 修复后: 空结果时保留已有观察数据
currentObservations: ({ context, event }) => {
  const results = (event as ExecutionCompleteEvent).results;
  return results.length > 0 ? results : context.currentObservations;
},
```

### 效果

即使 God 解析失败，下一轮 God 调用仍然能看到原始的 coder/reviewer 观察数据，打破死循环。

---

## BUG-23 [P1]: God 输出解析健壮性不足

### 根因分析

1. **错误信息丢失**: `extractWithRetry` 在所有失败路径返回 `null`，丢失具体错误（没找到 JSON？JSON 解析失败？Zod schema 校验失败？哪个字段？）
2. **JSON 提取过于严格**: 仅匹配小写 `` ```json ``，不匹配 `` ```JSON `` 或 `` ```Json ``
3. **不支持裸 JSON**: LLM 有时直接输出 JSON 而不包裹在代码围栏中

### 修复方案

**修复 A — `god-json-extractor.ts:extractWithRetry()` 返回类型变更**

```typescript
// 修复前: Promise<ExtractResult<T> | null>  ← null 丢失所有错误信息
// 修复后: Promise<ExtractResult<T>>          ← 始终返回具体错误详情

// 无 JSON 时:
{ success: false, error: 'No JSON found in output (no code-fenced block, no bare JSON object). Output length: 1234 chars' }

// 重试后仍失败时:
{ success: false, error: 'Retry validation failed: <Zod错误>. Original error: <原始错误>' }
```

**修复 B — `god-json-extractor.ts:extractGodJson()` 多策略提取**

```
策略 1: 代码围栏 JSON（大小写不敏感）  ```json / ```JSON / ```Json
策略 2: 裸 JSON 对象（首个 { 到最后一个 }）
```

**修复 C — `god-decision-service.ts:makeDecision()` 错误日志增强**

```typescript
// 修复前: 固定消息，无诊断价值
message: 'GodDecisionEnvelope extraction/validation failed after retry'

// 修复后: 包含具体解析/校验错误
message: `GodDecisionEnvelope extraction/validation failed: ${result.error}`
```

---

## 附加修复: 任务输入净化

### 问题

Session 的 task 字符串包含终端转义序列（鼠标事件）：

```
...如何用用户的ui交互非常方便？[<0;168;54M[<0;168;54m
```

这些垃圾字符被注入到 God 的 `## Task Goal` prompt 中。

### 修复

`god-decision-service.ts` 新增 `stripAnsiEscapes()` 函数，在 `buildUserPrompt` 时清理 task 文本：

```typescript
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\[<[0-9;]*[mM]/g;

export function stripAnsiEscapes(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '').trim();
}
```

---

## 修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `src/god/god-decision-service.ts` | BUG-22: fallback envelope 含 wait action；BUG-23: 错误日志增强；附加: ANSI 净化 |
| `src/engine/workflow-machine.ts` | BUG-22: 空结果时保留观察数据 |
| `src/parsers/god-json-extractor.ts` | BUG-23: 多策略 JSON 提取 + 返回类型变更（不再返回 null） |
| `src/__tests__/engine/bug-22-23-regression.test.ts` | 新增 12 个回归测试 |
| `src/__tests__/parsers/god-json-extractor.test.ts` | 更新 2 个测试适配新返回类型 |

---

## 测试结果

```
Test Files:  132 passed (132)
Tests:       2396 passed (2396)
Duration:    23.08s
```

全部通过，无回归。

---

## 此前已修复的问题（同一调试周期）

### P2: Worker 输出工具标记剥离

**问题**: Coder/Reviewer 的输出包含大量工具调用标记（`[Read]`, `[Grep]`, `[Bash]` 等），占据观察数据的字符预算，导致有意义的内容被截断。

**修复**:
- `god-decision-service.ts` 新增 `stripToolMarkers()` 函数
- 在 `buildObservationsSection` 中先剥离标记再截断
- `MAX_OBS_CHARS` 从 2000 提升至 20000（~2.5K tokens）
- 实测: Seq 3 的 coder 输出从 1100 字符工具噪声 → 58 字符有效内容（95% 噪声）

---

## Session 9f5ad612 的完整问题诊断

| 序号 | 问题 | 严重度 | 状态 |
|------|------|--------|------|
| BUG-22 | Fallback 死循环（观察数据丢失） | P0 | 已修复 |
| BUG-23 | God 解析不够健壮 + 错误信息丢失 | P1 | 已修复 |
| P2 | Worker 输出工具标记噪声 | P2 | 已修复（上一轮） |
| 附加 | 任务输入终端转义序列 | P3 | 已修复 |
