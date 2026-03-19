# OpenTUI Hybrid UI Repair Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the OpenTUI session UI so the header stays compact while the transcript, code blocks, and input composer become clearly readable again.

**Architecture:** Replace the current flattened line-based transcript rendering with structured message blocks inside the existing `ScrollBox`. Keep the OpenTUI runtime and scroll behavior, but move visual hierarchy decisions into small pure helper modules so the repaired layout is testable without relying on brittle terminal snapshots.

**Tech Stack:** Node, Bun, OpenTUI, React, Vitest, TypeScript

---

## Chunk 1: Header And Theme Structure

### Task 1: Extract status bar layout rules into a pure helper

**Files:**
- Create: `src/ui/status-bar-layout.ts`
- Modify: `src/ui/components/StatusBar.tsx`
- Test: `src/__tests__/ui/status-bar-layout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/ui/status-bar-layout.test.ts` covering:
- keeps status and token segments when width is narrow
- truncates project path before dropping critical status segments
- preserves left/right grouping order

- [ ] **Step 2: Run test to verify it fails**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/status-bar-layout.test.ts`
Expected: FAIL because `src/ui/status-bar-layout.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/status-bar-layout.ts` with:
- segment type definitions
- grouping/truncation helpers
- deterministic width fitting logic

Update `StatusBar.tsx` to consume the helper instead of doing inline segment removal logic.

- [ ] **Step 4: Run test to verify it passes**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/status-bar-layout.test.ts`
Expected: PASS

- [ ] **Step 5: Run broader related verification**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/keybindings.test.ts src/__tests__/ui/git-diff-stats.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/ui/status-bar-layout.ts src/ui/components/StatusBar.tsx src/__tests__/ui/status-bar-layout.test.ts
git commit -m "refactor: rebuild status bar layout for OpenTUI"
```

### Task 2: Tighten task strip presentation

**Files:**
- Modify: `src/ui/components/TaskBanner.tsx`
- Test: `src/__tests__/ui/task-banner-layout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/ui/task-banner-layout.test.ts` covering:
- single-line truncation remains CJK-safe
- prefix and body widths remain balanced in narrow terminals

- [ ] **Step 2: Run test to verify it fails**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/task-banner-layout.test.ts`
Expected: FAIL before the refined layout helpers exist.

- [ ] **Step 3: Write minimal implementation**

Adjust `TaskBanner.tsx` to:
- keep the strip visually separate from the status bar
- preserve compact height
- ensure truncation logic matches the new hybrid header spacing

- [ ] **Step 4: Run test to verify it passes**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/task-banner-layout.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/TaskBanner.tsx src/__tests__/ui/task-banner-layout.test.ts
git commit -m "refactor: tighten hybrid task strip layout"
```

## Chunk 2: Structured Transcript Rendering

### Task 3: Replace flattened line rendering with structured message blocks

**Files:**
- Create: `src/ui/message-blocks.ts`
- Modify: `src/ui/components/MainLayout.tsx`
- Modify: `src/ui/components/MessageView.tsx`
- Modify: `src/ui/message-lines.ts` or remove its transcript responsibility if no longer needed
- Test: `src/__tests__/ui/message-blocks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/ui/message-blocks.test.ts` covering:
- one message maps to one transcript block
- message header metadata stays separate from body blocks
- system messages receive lighter styling metadata than assistant messages

- [ ] **Step 2: Run test to verify it fails**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/message-blocks.test.ts`
Expected: FAIL because the structured block helper does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/message-blocks.ts` with pure block-building helpers.

Update `MainLayout.tsx` to:
- stop rendering transcript rows from `buildRenderedMessageLines(...)`
- render a stack of `MessageView` blocks inside `ScrollBox`
- keep scroll and keyboard behavior unchanged

Update `MessageView.tsx` to:
- render a single message container
- show one light body rail
- keep headers compact

- [ ] **Step 4: Run test to verify it passes**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/message-blocks.test.ts`
Expected: PASS

- [ ] **Step 5: Run integration coverage**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/integration/opentui-bootstrap.test.ts src/__tests__/integration/opentui-resume-smoke.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/ui/message-blocks.ts src/ui/components/MainLayout.tsx src/ui/components/MessageView.tsx src/ui/message-lines.ts src/__tests__/ui/message-blocks.test.ts
git commit -m "refactor: render structured transcript blocks in OpenTUI"
```

### Task 4: Restyle system messages and activity summaries

**Files:**
- Modify: `src/ui/components/SystemMessage.tsx`
- Modify: `src/ui/components/StreamRenderer.tsx`
- Test: `src/__tests__/ui/stream-renderer-layout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/ui/stream-renderer-layout.test.ts` covering:
- activity summary compaction in minimal mode
- system message emphasis is lighter than agent message emphasis
- paragraphs and block separation metadata are preserved

- [ ] **Step 2: Run test to verify it fails**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/stream-renderer-layout.test.ts`
Expected: FAIL before the new block spacing logic exists.

- [ ] **Step 3: Write minimal implementation**

Update `StreamRenderer.tsx` and `SystemMessage.tsx` so:
- block spacing is explicit
- activity summaries keep operational color without overpowering prose
- system messages are visually distinct but lower weight than assistant output

- [ ] **Step 4: Run test to verify it passes**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/stream-renderer-layout.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/SystemMessage.tsx src/ui/components/StreamRenderer.tsx src/__tests__/ui/stream-renderer-layout.test.ts
git commit -m "refactor: rebalance transcript block emphasis"
```

## Chunk 3: Code Surface And Composer

### Task 5: Rebuild code block surface styling

**Files:**
- Modify: `src/ui/components/CodeBlock.tsx`
- Test: `src/__tests__/ui/code-block-layout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/ui/code-block-layout.test.ts` covering:
- folded and expanded states remain intact
- code lines are grouped into one surface model instead of per-line heavy stripes
- language label remains optional and compact

- [ ] **Step 2: Run test to verify it fails**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/code-block-layout.test.ts`
Expected: FAIL before the layout helper/state changes.

- [ ] **Step 3: Write minimal implementation**

Update `CodeBlock.tsx` to:
- switch to a lighter code surface
- keep folding controls compact
- avoid visually shouting over surrounding prose

- [ ] **Step 4: Run test to verify it passes**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/code-block-layout.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/CodeBlock.tsx src/__tests__/ui/code-block-layout.test.ts
git commit -m "refactor: rebuild OpenTUI code block surface"
```

### Task 6: Repair composer/footer identity

**Files:**
- Modify: `src/ui/components/InputArea.tsx`
- Modify: `src/ui/components/MainLayout.tsx`
- Test: `src/__tests__/ui/input-area-layout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/ui/input-area-layout.test.ts` covering:
- placeholder/running states remain compact
- multi-line input preserves prompt alignment
- footer separation metadata remains stable

- [ ] **Step 2: Run test to verify it fails**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/input-area-layout.test.ts`
Expected: FAIL before the composer presentation is refined.

- [ ] **Step 3: Write minimal implementation**

Update `InputArea.tsx` and footer handling in `MainLayout.tsx` so the composer:
- always reads as the dedicated interaction zone
- keeps the prompt visible in a compact form
- remains slightly tighter than the browser mockup, per approved direction

- [ ] **Step 4: Run test to verify it passes**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/input-area-layout.test.ts`
Expected: PASS

- [ ] **Step 5: Run final regression suite**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test`
Expected: PASS

- [ ] **Step 6: Run final build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/ui/components/InputArea.tsx src/ui/components/MainLayout.tsx src/__tests__/ui/input-area-layout.test.ts
git commit -m "refactor: restore hybrid OpenTUI composer layout"
```

## Execution Notes

- Keep each change set visually scoped; avoid mixing UI polish with workflow changes.
- Prefer pure layout helpers for regression coverage over renderer snapshots.
- Preserve mouse-wheel behavior and existing OpenTUI runtime entry.
- If `src/ui/message-lines.ts` becomes obsolete after transcript restructuring, remove only the parts no longer used and keep unrelated helpers intact until final cleanup.
