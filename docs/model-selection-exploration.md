# LLM 模型选择功能 — Phase-1 探索报告

**Duo Session**: `9f5ad612-2db8-4dc2-99e4-50eb759b7520`
**日期**: 2026-03-14
**Coder**: claude-code | **Reviewer**: codex | **God**: claude-code
**状态**: Phase-1 (Explore) 完成，Reviewer APPROVED，可进入 Phase-2 (Design & Implement)

---

## 任务目标

> 当前选择了 LLM 后，应该再次选择 LLM 所要调用的模型。例如 claude 就有 opus 和 sonnet；chatgpt 也有 codex 和正常的 gpt，同时现在还有 codex 的快速模型 spark。需要研究：
> 1. 如何获得这些模型列表？
> 2. 更新机制，不要每次都获得？
> 3. 如何只保留推荐的模型而不是所有模型 — 1个最好的模型，1个次好的模型，1个快速模型？
> 4. 如何让用户的 UI 交互非常方便？

---

## 1. 当前代码架构

### 1.1 Provider 选择流程

```
User → duo start
  ↓
SetupWizard (src/ui/components/SetupWizard.tsx)
  Phase 1: select-dir    → DirectoryPicker
  Phase 2: select-coder  → CLISelector (↑↓ arrows, Enter)
  Phase 3: select-reviewer → CLISelector (exclude coder)
  Phase 4: select-god    → GodSelector (claude-code|codex only)
  Phase 5: enter-task    → TaskInput
  Phase 6: confirm       → ConfirmScreen → SessionConfig
  ↓
App.tsx: createAdapter(config.coder), createAdapter(config.reviewer), createGodAdapter(config.god)
  ↓
adapter.execute(prompt, { cwd, permissionMode }) ← 当前没有传 model
```

**关键发现：当前完全没有模型选择步骤。** 用户选择 CLI 工具（provider）后，duo 使用该工具的默认模型，从未传递 `--model` 参数。

### 1.2 支持的 12 个 Adapter

| # | Name | CLI | 已安装 | 适配器文件 |
|---|------|-----|--------|-----------|
| 1 | **claude-code** | `claude` | Yes | `src/adapters/claude-code/adapter.ts` |
| 2 | **codex** | `codex` | Yes | `src/adapters/codex/adapter.ts` |
| 3 | gemini | `gemini` | No | `src/adapters/gemini/adapter.ts` |
| 4 | copilot | `copilot` | No | `src/adapters/copilot/adapter.ts` |
| 5 | aider | `aider` | No | `src/adapters/aider/adapter.ts` |
| 6 | amazon-q | `q` | No | `src/adapters/amazon-q/adapter.ts` |
| 7 | cursor | `cursor` | No | `src/adapters/cursor/adapter.ts` |
| 8 | cline | `cline` | No | `src/adapters/cline/adapter.ts` |
| 9 | continue | `cn` | No | `src/adapters/continue/adapter.ts` |
| 10 | goose | `goose` | No | `src/adapters/goose/adapter.ts` |
| 11 | amp | `amp` | No | `src/adapters/amp/adapter.ts` |
| 12 | qwen | `qwen` | No | `src/adapters/qwen/adapter.ts` |

God 角色仅支持 `claude-code` 和 `codex`。

### 1.3 当前配置结构（均无 model 字段）

- **SessionConfig** (`src/types/session.ts:8-14`): `{ projectDir, coder, reviewer, god, task }`
- **SessionMetadata** (`session-manager.ts:22-31`): 持久化到 `.duo/sessions/<id>/snapshot.json`
- **ExecOptions** (`types/adapter.ts:6-16`): `{ cwd, systemPrompt?, env?, timeout?, permissionMode?, disableTools? }`
- **GodExecOptions** (`types/god-adapter.ts:6-10`): `{ cwd, systemPrompt, timeoutMs }`

**12 个 adapter 的 `buildArgs()` 方法均未传递 `--model` 参数。**

---

## 2. Provider 模型列表研究

### 2.1 Claude Code (Anthropic)

**本地模型缓存**: 无。`~/.claude/` 目录无模型相关 JSON/TOML 文件。

**API 端点**: `GET https://api.anthropic.com/v1/models` 存在（返回 `401`，非 `404`），但 duo 走 CLI 通道，不持有 API key，不可依赖。

**CLI `--model` 标志** (from `claude --help`):
```
--model <model>  Model for the current session. Provide an alias for the
                 latest model (e.g. 'sonnet' or 'opus') or a model's full
                 name (e.g. 'claude-sonnet-4-6').
```

**实测验证的模型名称** (2026-03-14, 通过 `claude --model <alias> --print "say hi" --output-format json` 的 `modelUsage` 字段):

| 别名 | 解析后真实 ID | 上下文窗口 | 已验证 |
|------|-------------|-----------|--------|
| `opus` | `claude-opus-4-6` | 200K | Yes |
| `sonnet` | `claude-sonnet-4-6` | 200K | Yes |
| `haiku` | `claude-haiku-4-5-20251001` | 200K | Yes |

**推荐策略**: 硬编码 3 个稳定别名。别名自动解析到最新版本（Anthropic 管理更新）。

### 2.2 Codex (OpenAI)

**本地模型缓存**: 存在！`~/.codex/models_cache.json` (235KB, Codex CLI 自动维护)

**缓存结构**:
```typescript
{
  fetched_at: "2026-03-14T08:07:46.909219Z",  // 上次刷新时间
  etag: "W/\"99ea47a4632d188d44d512946f2740e2\"",
  client_version: "0.114.0",
  models: [
    {
      slug: "gpt-5.4",            // ← 传给 --model 的值
      display_name: "gpt-5.4",
      description: "Latest frontier agentic coding model.",
      priority: 0,                 // ← 越小越好
      visibility: "list" | "hide", // ← "list" = 显示, "hide" = 旧版
      context_window: 272000,
      shell_type: "shell_command",
      supported_in_api: true,
      // ... 更多字段
    },
    // ... 共 12 个模型
  ]
}
```

**全部 12 个模型** (来自实际缓存):

| priority | slug | visibility | 上下文 | 描述 |
|----------|------|------------|-------|------|
| 0 | `gpt-5.4` | **list** | 272K | Latest frontier agentic coding model |
| 3 | `gpt-5.3-codex` | **list** | 272K | Frontier Codex-optimized |
| 5 | `gpt-5.3-codex-spark` | **list** | 128K | **Ultra-fast** coding model |
| 7 | `gpt-5.2-codex` | **list** | 272K | Frontier agentic coding model |
| 8 | `gpt-5.2` | **list** | 272K | Professional work & long agents |
| 9 | `gpt-5.1-codex-max` | **list** | 272K | Deep and fast reasoning |
| 10 | `gpt-5.1-codex` | hide | — | — |
| 11 | `gpt-5.1` | hide | — | — |
| 14 | `gpt-5-codex` | hide | — | — |
| 15 | `gpt-5` | hide | — | — |
| 18 | `gpt-5.1-codex-mini` | **list** | 272K | Cheaper, faster, less capable |
| 19 | `gpt-5-codex-mini` | hide | — | — |

**用户默认配置** (`~/.codex/config.toml`): `model = "gpt-5.4"`

**推荐策略**: 读取 `~/.codex/models_cache.json`，按 `visibility === 'list'` 过滤 + `priority` 排序，取 top 3 映射到三档。

### 2.3 其他 Provider

| Adapter | 有 `--model`？ | 模型选择策略 | MVP 支持？ |
|---------|---------------|-------------|-----------|
| gemini | 可能 | 硬编码 3 档 | Phase 2 |
| aider | Yes (`--model`) | 跨 provider，复杂 | Phase 2 |
| copilot | 未知 | GitHub 控制 | No |
| cursor | 未知 | Cursor 管理 | No |
| amazon-q | No | 单一模型 | No |
| 其他 | 未知 | — | No |

---

## 3. 三档模型分类

| Provider | Best (最强) | Good (推荐默认 ★) | Fast (最快) |
|----------|-----------|-------------------|------------|
| **Claude Code** | `opus` → claude-opus-4-6 | `sonnet` → claude-sonnet-4-6 ★ | `haiku` → claude-haiku-4-5 |
| **Codex** | `gpt-5.4` (priority=0) | `gpt-5.3-codex` (priority=3) ★ | `gpt-5.3-codex-spark` (priority=5) |

---

## 4. 缓存策略

| Provider | 缓存策略 | 缓存位置 | 更新机制 | duo 维护成本 |
|----------|---------|---------|---------|------------|
| **Claude** | 硬编码 3 个别名 | 代码内 (`model-registry.ts`) | 别名自动解析到最新版 | **零** |
| **Codex** | 读现有本地缓存 | `~/.codex/models_cache.json` | Codex CLI 自动刷新 | **零** |
| **其他** | 暂不需要 | — | — | — |

**不需要新的缓存基础设施。** Claude 使用稳定别名（无需缓存），Codex 使用其 CLI 自己维护的缓存（只读）。

---

## 5. UI 交互方案

**推荐方案: Tab 轮换内联到 CLISelector**

```
Select Coder (writes code):
   ▸ Claude Code (Sonnet ★)     ← Tab/→ 循环: Opus | Sonnet ★ | Haiku
     Codex
     Gemini CLI
     Aider
```

**交互逻辑**:
1. **↑↓** = 选择 CLI 工具
2. **Tab 或 ←→** = 在当前 CLI 的 3 个模型间轮换
3. **Enter** = 确认 CLI + 当前模型
4. 不支持模型选择的 CLI = 不显示括号，Tab 无反应
5. 默认选中 **good** 档 (★ 标记)

**ConfirmScreen 增强显示**:
```
Session Configuration
├ Project   ~/my-project
├ Coder     Claude Code · Sonnet ★
├ Reviewer  Codex · gpt-5.3-codex
├ God       Claude Code · Opus
└ Task      Fix the login bug
```

---

## 6. God 执行链与 Model 集成点

### 6.1 God 调用汇聚点

**所有 God adapter 调用汇聚到一个函数**:

```typescript
// src/god/god-call.ts:21-62
export async function collectGodAdapterOutput(options: GodCallOptions): Promise<string> {
  // L39: adapter.execute(prompt, { cwd, systemPrompt, timeoutMs })
  //                                     ↑ GodExecOptions — 需要加 model 字段
}
```

**5 个调用者 → 1 个汇聚点 → 1 个 adapter.execute()**:

| 调用者 | 位置 | 来源 |
|--------|------|------|
| `initializeTask()` | task-init.ts:83 | App.tsx:534 |
| `GodDecisionService.makeDecision()` | god-decision-service.ts:333 | App.tsx:345 |
| `classifyInterruptIntent()` | interrupt-clarifier.ts:43 | App.tsx:1491 |
| `routePostCoder/Reviewer()` | god-router.ts:118/192 | deprecated |
| `makeAutoDecision()` | auto-decision.ts:200 | workflow machine |

### 6.2 Model 参数穿透路径

```
SessionConfig.godModel / coderModel / reviewerModel
    ↓
    ├── Coder: App.tsx:733 execOpts → adapter.execute() → buildArgs() → --model
    ├── Reviewer: App.tsx:1004 execOpts → adapter.execute() → buildArgs() → --model
    └── God: GodDecisionService → collectGodAdapterOutput → god-call.ts:39 → --model
```

### 6.3 Resume 路径

`cli.ts:88-94` 当前缺少 model 字段恢复：
```typescript
const initialConfig: SessionConfig = {
  projectDir: result.session.metadata.projectDir,
  coder: result.session.metadata.coder,
  reviewer: result.session.metadata.reviewer,
  god: resolvedGod.god,
  task: result.session.metadata.task,
  // ✗ coderModel, reviewerModel, godModel 均未恢复
};
```

---

## 7. 完整文件变更清单

### 新建文件 (1)
- `src/adapters/model-registry.ts` — 模型注册表 (Claude 硬编码 + Codex 缓存读取)

### 修改文件 (19)

| 类别 | 文件 | 行号 | 修改内容 |
|------|------|------|---------|
| **类型 (3)** | `src/types/session.ts` | L8-22 | SessionConfig + StartArgs 加 `coderModel?`, `reviewerModel?`, `godModel?` |
| | `src/types/adapter.ts` | L6-16 | ExecOptions 加 `model?: string` |
| | `src/types/god-adapter.ts` | L6-10 | GodExecOptions 加 `model?: string` |
| **God 管道 (6)** | `src/god/god-call.ts` | L11-18, L39-43 | GodCallOptions 加 model, execute() 传入 |
| | `src/god/god-decision-service.ts` | L305-312 | 构造函数加 model?, makeDecision 传入 |
| | `src/god/task-init.ts` | L75-81 | initializeTask 加 godModel 参数 |
| | `src/god/interrupt-clarifier.ts` | L12-22 | InterruptContext 加 godModel |
| | `src/god/auto-decision.ts` | L37-52 | AutoDecisionContext 加 godModel |
| | `src/god/god-router.ts` | L26-35 | RoutingContext 加 godModel (deprecated 兼容) |
| **Adapter (4)** | `src/adapters/claude-code/adapter.ts` | L80-117 | buildArgs 加 `--model` |
| | `src/adapters/codex/adapter.ts` | L82-100 | buildArgs 加 `--model` |
| | `src/god/adapters/claude-code-god-adapter.ts` | L44-52 | buildArgs 加 `--model` |
| | `src/god/adapters/codex-god-adapter.ts` | L62-81 | buildArgs 加 `--model` |
| **Session (2)** | `src/session/session-manager.ts` | L22-31, L180-189 | SessionMetadata 加 model 字段 |
| | `src/session/session-starter.ts` | L23-50 | parseStartArgs 加 `--coder-model` 等 |
| **CLI (2)** | `src/cli.ts` | L88-94, L127-141 | resume 恢复 model + 帮助文本 |
| | `src/cli-commands.ts` | L82-84 | 日志打印 model |
| **UI (1)** | `src/ui/components/SetupWizard.tsx` | L132-185, L291-351 | Tab 轮换模型 + ConfirmScreen 显示 |
| **App (1)** | `src/ui/components/App.tsx` | L345, L534, L733, L1004, L1491 | 所有执行点传入 model |

---

## 8. Model Registry 设计

```typescript
// src/adapters/model-registry.ts

export interface ModelTier {
  id: string;           // 传给 --model 的值
  displayName: string;  // UI 显示名
  tier: 'best' | 'good' | 'fast';
  description: string;
}

// Claude: 硬编码稳定别名（自动解析到最新版本）
const CLAUDE_MODELS: ModelTier[] = [
  { id: 'opus',   displayName: 'Opus',   tier: 'best', description: '最强推理 (claude-opus-4-6)' },
  { id: 'sonnet', displayName: 'Sonnet', tier: 'good', description: '性价比最优 (claude-sonnet-4-6)' },
  { id: 'haiku',  displayName: 'Haiku',  tier: 'fast', description: '最快速度 (claude-haiku-4-5)' },
];

// Codex: 读本地缓存
function loadCodexModels(): ModelTier[] {
  // 读取 ~/.codex/models_cache.json
  // 过滤: visibility === 'list'
  // 排序: priority 升序
  // 映射 top 3 到 best/good/fast
  // 回退: 文件不存在时使用硬编码默认值
}

export function getModelsForAdapter(adapterName: string): ModelTier[] {
  switch (adapterName) {
    case 'claude-code': return CLAUDE_MODELS;
    case 'codex':       return loadCodexModels();
    default:            return []; // 该 adapter 暂不支持模型选择
  }
}

export function getDefaultModel(adapterName: string): string | undefined {
  const models = getModelsForAdapter(adapterName);
  return models.find(m => m.tier === 'good')?.id;
}
```

---

## 9. 核心设计决策

| 决策 | 推荐 | 理由 |
|------|------|------|
| Codex 模型来源 | 读 `~/.codex/models_cache.json` | 已存在、Codex CLI 自动更新、含丰富元数据 |
| Claude 模型来源 | 硬编码 3 档别名 | 无本地缓存，别名稳定且自动指向最新版 |
| 缓存更新 | Codex 由 CLI 自管理；Claude 随 duo 版本更新 | 零维护成本 |
| UI 交互 | Tab 轮换内联到 CLISelector | 不增加步骤数，交互直观 |
| 默认档位 | good (★) | 性价比最优 |
| 字段可选性 | 全部 optional | 向后兼容旧 snapshot 和 CLI |
| MVP 范围 | claude-code + codex | 两个最核心 adapter，也是仅有的 God adapter |

---

## 10. Reviewer 审核历程

| Round | Reviewer 结论 | 说明 |
|-------|--------------|------|
| 0 | CHANGES_REQUESTED | 3 个 blocking: Codex 缓存被忽略、变更面不完整、provider 范围不充分 |
| 1 | CHANGES_REQUESTED | 2 个 blocking: God 执行链未摸清、Claude 硬编码未充分论证 |
| 2 | **APPROVED** (PASS_WITH_NOTES) | God/Resume 执行链已补全，Claude alias 策略已验证 |
| 3 | **APPROVED** (PASS_WITH_NOTES) | 最终报告完整，可进入 Phase-2 |
| 4 | **APPROVED** (PASS_WITH_NOTES) | API 端点细节已补充，缓存策略已确认 |

### Reviewer 关键反馈

1. **Codex 有本地模型缓存** — 不能说"只能硬编码"，`~/.codex/models_cache.json` 是更好的数据源
2. **God 调用链汇聚点是 `god-call.ts:39`** — 不是 App.tsx，model 需要穿透到这个统一入口
3. **Resume 路径** (`cli.ts:88`) 也需要恢复 model 字段
4. **Claude 别名需要实测验证** — 不能仅从文档推断，需要通过 `claude --model <alias>` 实际调用确认
5. **Codex 模型名不能靠猜** — `o3/o4-mini/codex-mini` 已过时，实际是 `gpt-5.4/gpt-5.3-codex/gpt-5.3-codex-spark`
6. **建议加缓存缺失回退** — Codex 缓存读取应有硬编码 fallback

---

## 下一步: Phase-2

进入 **Design Model Tier System & Caching Strategy** 阶段：
1. 实现 `model-registry.ts`（硬编码 + 缓存读取）
2. 扩展 `SessionConfig`/`ExecOptions`/`GodExecOptions` 类型
3. 4 个 adapter 的 `buildArgs()` 支持 `--model`
4. SetupWizard UI 增加模型选择
5. Session 持久化和 Resume 恢复 model 字段
