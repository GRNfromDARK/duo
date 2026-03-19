# Duo — Multi-AI Coding Assistant Collaboration Platform

<p align="center">
  <strong>Coder + Reviewer + God LLM = Autonomous Code Quality</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.9-blue" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A520-green" alt="Node.js">
  <img src="https://img.shields.io/badge/XState-v5-purple" alt="XState">
  <img src="https://img.shields.io/badge/Tests-951-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/License-ISC-yellow" alt="License">
</p>

---

## What is Duo?

Duo is a **multi-AI coding assistant collaboration platform** that orchestrates two AI coding tools — one as **Coder**, one as **Reviewer** — in an automated code-review loop, supervised by a **God LLM** (an independent LLM acting as an intelligent dispatcher).

```
User Task → God Dispatches → Coder Works → God Routes to Reviewer → Reviewer Evaluates → God Decides Next → ... → Done
```

Unlike single-agent coding tools, Duo ensures **every code change is reviewed before it ships** — by another AI with a different perspective.

## Key Features

### Three-Party Collaboration

| Role | Responsibility | Supported Tools |
|------|---------------|-----------------|
| **Coder** | Writes code, implements features, fixes bugs | Claude Code, Codex, Gemini |
| **Reviewer** | Reviews code, finds issues, provides feedback | Claude Code, Codex, Gemini |
| **God LLM** | Dispatches work, routes decisions, accepts results | Claude Code, Codex, Gemini |

### Dynamic Dispatch Workflow

God dynamically chooses the right mode for each dispatch — no pre-planned phases:

| dispatchType | Coder Mode | When Used |
|---|---|---|
| **explore** | Read-only investigation, no file changes | Investigation, analysis, queries |
| **discuss** | Evaluate options, recommend approach | Technical design, trade-off analysis |
| **code** | Implement, refactor, write tests | Feature development, refactoring |
| **debug** | Diagnose root cause, minimal fix | Bug fixes, performance optimization |

A typical task flows naturally through modes:

```
explore (investigate) → reviewer (confirm findings) → code (implement) → reviewer (verify) → done
```

### 5 God Actions

God is a lightweight dispatcher with exactly 5 actions:

| Action | Purpose |
|--------|---------|
| `send_to_coder(dispatchType, message)` | Send work to coder with mode selection |
| `send_to_reviewer(message)` | Send coder's work for review |
| `accept_task(summary)` | Task is done |
| `wait(reason)` | Pause before next decision |
| `request_user_input(question)` | Ask the human (used sparingly) |

### 3 Supported AI Tools

| Tool | CLI Command | Output Format | Role Support |
|------|-------------|---------------|-------------|
| Claude Code | `claude` | stream-json | Coder / Reviewer / God |
| Codex | `codex` | jsonl | Coder / Reviewer / God |
| Gemini | `gemini` | stream-json | Coder / Reviewer / God |

Mix and match any combination — e.g., Claude Code as Coder + Codex as Reviewer + Gemini as God.

### God LLM Orchestration

- **Dynamic dispatchType**: God selects explore/code/debug/discuss each dispatch — no rigid phases
- **Findings validation**: Exploration results go to reviewer before implementation begins
- **Branch enforcement**: Code/debug work must use feature branches; merge required before accept
- **Language matching**: God responds in the same language as the user's task description
- **Reviewer feedback forwarding**: Coder receives reviewer's original analysis, not God's summary
- **Watchdog service**: Retry + exponential backoff + pause on God failures

### State Machine Architecture

11-state workflow powered by XState v5:

```
IDLE → GOD_DECIDING → EXECUTING → CODING / REVIEWING / CLARIFYING / DONE
            ↑                          ↓
            ←──── OBSERVING ←──────────┘
```

States: IDLE, CODING, REVIEWING, OBSERVING, GOD_DECIDING, EXECUTING, CLARIFYING, PAUSED, RESUMING, DONE, ERROR

### Clean LLM Output Separation

Duo separates LLM output into two streams:
- **llmText**: Pure LLM text (text + code chunks only) — used for classification and God decisions
- **fullText**: Complete output including tool markers and status JSON — used for history logs only

This ensures God and reviewer see clean content, not tool call noise.

### Terminal UI

Modern terminal interface built with React + Ink (21 components):
- Group-chat style message stream (color-coded by role)
- Real-time streaming LLM output with paste support
- Smart scroll lock with mouse wheel support
- Code block auto-collapse (>10 lines)
- Overlay panels (Help, Context, Timeline, Search)
- Interactive setup wizard with CLI model discovery

### Session Persistence

- Atomic writes (write-tmp-rename) for crash consistency
- Session save & restore (`duo resume`)
- God audit log viewer (`duo log`)
- JSONL append-mode history

## Quick Start

```bash
# Install dependencies
npm install

# Development mode
npm run dev

# Build
npm run build

# Run tests
npm test
```

## CLI Commands

```bash
# Interactive startup (SetupWizard)
duo start

# Start with specific configuration
duo start --dir ./my-project --coder claude-code --reviewer codex --task "Add JWT auth"

# Model overrides
duo start --coder claude-code --coder-model sonnet --reviewer codex --reviewer-model gpt-5.4 --task "Fix bug"

# List resumable sessions
duo resume

# Resume a specific session
duo resume <session-id>

# View God audit log
duo log <session-id>

# Version
duo --version
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 1: CLI Entry          cli.ts — command parsing          │
├──────────────────────────────────────────────────────────────┤
│  Layer 2: UI Layer           21 components + state modules     │
├──────────────────────────────────────────────────────────────┤
│  Layer 3: God Orchestrator   5 actions, dynamic dispatchType   │
├──────────────────────────────────────────────────────────────┤
│  Layer 4: Workflow Engine    XState v5 (11 states)             │
├──────────────────────────────────────────────────────────────┤
│  Layer 5: Session Manager    Persistence, atomic writes        │
├──────────────────────────────────────────────────────────────┤
│  Layer 6: Adapter Layer      3 AI tool adapters + parsers      │
└──────────────────────────────────────────────────────────────┘
```

See [docs/architecture.md](docs/architecture.md) for the full architecture document.

## Project Structure

```
src/
├── cli.ts                     # CLI entry — command parsing, rendering
├── cli-commands.ts            # Command handlers (start/resume/log)
├── types/                     # Core type definitions
│   ├── god-schemas.ts         # 4 task types, GodTaskAnalysis
│   ├── god-actions.ts         # 5 God actions with dispatchType
│   ├── god-envelope.ts        # GodDecisionEnvelope (diagnosis + actions + messages)
│   └── observation.ts         # 6 observation types
├── adapters/                  # AI tool adapters + model discovery
├── parsers/                   # Output parsers (stream-json / jsonl / text)
├── session/                   # Session management & persistence
├── engine/                    # XState v5 workflow state machine
├── god/                       # God Orchestrator
│   ├── god-decision-service   # Unified decision: observations → envelope
│   ├── god-prompt-generator   # Dynamic coder/reviewer prompts
│   ├── observation-factory    # Observation construction (no classifier)
│   ├── hand-executor          # 5 action execution
│   ├── watchdog               # Retry + backoff + pause
│   ├── god-audit              # Decision audit logging
│   └── message-dispatcher     # NL message routing
└── ui/                        # Terminal UI (React + Ink)
    ├── components/ (21)       # App, MainLayout, Overlays, etc.
    └── *.ts                   # Pure-function state management
```

## How It Works

### Example: Bug Fix Task

```
1. User:     "Fix the scroll event not propagating in dashboard"
2. God:      send_to_coder(explore) — "Investigate the scroll issue"
3. Coder:    Reads code, identifies root cause
4. God:      send_to_reviewer — "Validate coder's diagnosis"
5. Reviewer: Confirms root cause, identifies edge case → [CHANGES_REQUESTED]
6. God:      send_to_coder(debug) — "Fix on feature branch, address reviewer's edge case"
7. Coder:    Creates branch, implements fix, commits
8. God:      send_to_reviewer — "Verify the fix"
9. Reviewer: Implementation looks good → [APPROVED]
10. God:     send_to_coder(code) — "Merge branch to main"
11. Coder:   Merges branch
12. God:     accept_task — "Bug fixed and merged"
```

### God Decision Envelope

Every God decision produces a structured `GodDecisionEnvelope`:

```json
{
  "diagnosis": {
    "summary": "Coder identified root cause, reviewer confirmed",
    "currentGoal": "Implement the fix",
    "notableObservations": ["Reviewer approved the diagnosis"]
  },
  "actions": [
    { "type": "send_to_coder", "dispatchType": "debug", "message": "Fix on a feature branch" }
  ],
  "messages": [
    { "target": "system_log", "content": "Switching from explore to debug after reviewer validation" }
  ]
}
```

All decisions are auditable via `duo log <session-id>`.

## Documentation

| Document | Description |
|----------|-------------|
| [architecture.md](docs/architecture.md) | System architecture, data flow, state machine |
| [god-orchestrator.md](docs/modules/god-orchestrator.md) | God LLM orchestrator |
| [workflow-engine.md](docs/modules/workflow-engine.md) | XState workflow state machine |
| [adapter-layer.md](docs/modules/adapter-layer.md) | AI tool adapter layer |
| [ui-components.md](docs/modules/ui-components.md) | UI components |
| [session-management.md](docs/modules/session-management.md) | Session management |
| [type-system.md](docs/modules/type-system.md) | Core type system |
| [parsers.md](docs/modules/parsers.md) | Output parsers |
| [cli-entry.md](docs/modules/cli-entry.md) | CLI entry & commands |
| [ui-state.md](docs/modules/ui-state.md) | UI state management |

## Tech Stack

| Category | Technology |
|----------|-----------|
| Runtime | Node.js ≥20 (ESM) |
| Language | TypeScript 5.9 (strict mode) |
| State Management | XState v5 |
| UI Framework | Ink 6 + React 19 |
| Schema Validation | Zod 4 |
| Build Tool | tsup |
| Test Framework | Vitest 4 (951 tests) |
| Package Manager | npm |

## License

ISC
