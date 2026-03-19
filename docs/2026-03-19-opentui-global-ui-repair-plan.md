# OpenTUI Global UI Repair Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify the entire OpenTUI UI under one shared layout/theme layer so startup, session, completion, and overlays all render correctly and consistently.

**Architecture:** Introduce a small `tui-layout` primitives layer that makes row/column/panel semantics explicit in OpenTUI, then migrate setup, session, completion, and overlays onto those primitives. Keep the startup hero branded and large, but make every other region share the same hybrid operational theme.

**Tech Stack:** Bun, OpenTUI, React, TypeScript, Vitest

---

## Chunk 1: Shared Layout Foundation

### Task 1: Add shared TUI layout primitives

**Files:**
- Create: `src/ui/tui-layout.tsx`
- Test: `src/__tests__/ui/tui-layout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/ui/tui-layout.test.ts` covering:
- row primitive enforces horizontal direction metadata
- panel/divider helpers expose stable theme tokens
- selection row model distinguishes selected and inactive states

- [ ] **Step 2: Run test to verify it fails**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/tui-layout.test.ts`
Expected: FAIL because `src/ui/tui-layout.tsx` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/tui-layout.tsx` with:
- theme constants
- small pure helper exports for layout models
- shared React primitives for row/column/panel/divider/title/selection/prompt/footer hint

- [ ] **Step 4: Run test to verify it passes**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/tui-layout.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui-layout.tsx src/__tests__/ui/tui-layout.test.ts
git commit -m "refactor: add shared OpenTUI layout primitives"
```

### Task 2: Add startup copy model

**Files:**
- Create: `src/ui/setup-copy.ts`
- Test: `src/__tests__/ui/setup-copy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/ui/setup-copy.test.ts` covering:
- slogan copy emphasizes coder/reviewer/god workflow
- hero bullets stay concise enough for narrow terminals
- subhead communicates convergence-oriented collaboration

- [ ] **Step 2: Run test to verify it fails**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/setup-copy.test.ts`
Expected: FAIL because `src/ui/setup-copy.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/setup-copy.ts` with exported copy constants for the setup hero.

- [ ] **Step 4: Run test to verify it passes**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/setup-copy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/setup-copy.ts src/__tests__/ui/setup-copy.test.ts
git commit -m "refactor: define workflow-focused setup copy"
```

## Chunk 2: Setup Flow Repair

### Task 3: Rebuild SetupWizard using shared layout primitives

**Files:**
- Modify: `src/ui/components/SetupWizard.tsx`
- Modify: `src/ui/components/DirectoryPicker.tsx`
- Test: `src/__tests__/ui/setup-copy.test.ts`

- [ ] **Step 1: Extend failing tests**

Add cases covering:
- setup hero uses the new copy exports
- progress stepper renders as one horizontal row model
- directory/task/model selection rows use explicit row primitives

- [ ] **Step 2: Run tests to verify they fail**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/setup-copy.test.ts`
Expected: FAIL before the components consume the shared primitives.

- [ ] **Step 3: Write minimal implementation**

Update setup components to:
- keep the large hero frame and logo
- move active step content into a consistent work panel
- use shared row/prompt/selection/footer primitives everywhere
- tighten spacing and remove accidental vertical drift

- [ ] **Step 4: Run test to verify it passes**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/setup-copy.test.ts`
Expected: PASS

- [ ] **Step 5: Run focused verification**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/integration/opentui-bootstrap.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/SetupWizard.tsx src/ui/components/DirectoryPicker.tsx src/ui/setup-copy.ts src/__tests__/ui/setup-copy.test.ts
git commit -m "refactor: unify setup wizard under OpenTUI theme"
```

## Chunk 3: Session And Footer Repair

### Task 4: Migrate live session chrome and transcript rows to shared primitives

**Files:**
- Modify: `src/ui/components/MainLayout.tsx`
- Modify: `src/ui/components/StatusBar.tsx`
- Modify: `src/ui/components/TaskBanner.tsx`
- Modify: `src/ui/components/MessageView.tsx`
- Modify: `src/ui/components/SystemMessage.tsx`
- Modify: `src/ui/components/ThinkingIndicator.tsx`
- Test: `src/__tests__/ui/status-bar-layout.test.ts`
- Test: `src/__tests__/ui/message-blocks.test.ts`
- Test: `src/__tests__/ui/stream-renderer-layout.test.ts`

- [ ] **Step 1: Add failing test coverage**

Extend the existing layout tests to cover:
- status and task rows stay horizontal in the render model
- message headers and system rows use explicit row grouping
- thinking indicator uses the shared footer/status tone instead of ad hoc layout

- [ ] **Step 2: Run tests to verify they fail**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/status-bar-layout.test.ts src/__tests__/ui/message-blocks.test.ts src/__tests__/ui/stream-renderer-layout.test.ts`
Expected: FAIL before the components are migrated.

- [ ] **Step 3: Write minimal implementation**

Update session components to consume shared row/divider/title/footer primitives while preserving current scroll and state behavior.

- [ ] **Step 4: Run tests to verify they pass**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/status-bar-layout.test.ts src/__tests__/ui/message-blocks.test.ts src/__tests__/ui/stream-renderer-layout.test.ts`
Expected: PASS

- [ ] **Step 5: Run focused integration coverage**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/integration/opentui-resume-smoke.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/MainLayout.tsx src/ui/components/StatusBar.tsx src/ui/components/TaskBanner.tsx src/ui/components/MessageView.tsx src/ui/components/SystemMessage.tsx src/ui/components/ThinkingIndicator.tsx src/__tests__/ui/status-bar-layout.test.ts src/__tests__/ui/message-blocks.test.ts src/__tests__/ui/stream-renderer-layout.test.ts
git commit -m "refactor: align session layout with shared OpenTUI theme"
```

### Task 5: Unify completion footer

**Files:**
- Modify: `src/ui/components/CompletionScreen.tsx`
- Modify: `src/ui/components/MainLayout.tsx`
- Test: `src/__tests__/ui/input-area-layout.test.ts`

- [ ] **Step 1: Add failing test coverage**

Extend `src/__tests__/ui/input-area-layout.test.ts` or add closely related assertions covering:
- completion footer uses the same prompt/list layout model as the composer
- inline completion options remain compact and aligned

- [ ] **Step 2: Run tests to verify they fail**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/input-area-layout.test.ts`
Expected: FAIL before completion uses the shared primitives.

- [ ] **Step 3: Write minimal implementation**

Refactor inline completion to use shared list/input/footer primitives and match the session footer theme.

- [ ] **Step 4: Run test to verify it passes**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/input-area-layout.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/CompletionScreen.tsx src/ui/components/MainLayout.tsx src/__tests__/ui/input-area-layout.test.ts
git commit -m "refactor: unify completion footer with composer theme"
```

## Chunk 4: Overlay And Card Theme Unification

### Task 6: Migrate overlays and full-replacement cards to shared primitives

**Files:**
- Modify: `src/ui/components/HelpOverlay.tsx`
- Modify: `src/ui/components/SearchOverlay.tsx`
- Modify: `src/ui/components/ContextOverlay.tsx`
- Modify: `src/ui/components/TimelineOverlay.tsx`
- Modify: `src/ui/components/ReclassifyOverlay.tsx`
- Modify: `src/ui/components/TaskAnalysisCard.tsx`
- Modify: `src/ui/components/PhaseTransitionBanner.tsx`
- Modify: `src/ui/components/DisagreementCard.tsx`

- [ ] **Step 1: Write the failing test**

Create or extend a focused overlay/layout test covering:
- overlay rows use explicit label/value or time/value row models
- replacement cards use explicit horizontal action and metadata rows

- [ ] **Step 2: Run test to verify it fails**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/reclassify-overlay.test.ts src/__tests__/ui/task-analysis-card.test.ts src/__tests__/ui/phase-transition-banner.test.ts`
Expected: FAIL before components are migrated.

- [ ] **Step 3: Write minimal implementation**

Update all overlays and replacement cards to consume the shared primitives with consistent panel/title/footer styling.

- [ ] **Step 4: Run tests to verify they pass**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test -- src/__tests__/ui/reclassify-overlay.test.ts src/__tests__/ui/task-analysis-card.test.ts src/__tests__/ui/phase-transition-banner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/HelpOverlay.tsx src/ui/components/SearchOverlay.tsx src/ui/components/ContextOverlay.tsx src/ui/components/TimelineOverlay.tsx src/ui/components/ReclassifyOverlay.tsx src/ui/components/TaskAnalysisCard.tsx src/ui/components/PhaseTransitionBanner.tsx src/ui/components/DisagreementCard.tsx src/__tests__/ui/reclassify-overlay.test.ts src/__tests__/ui/task-analysis-card.test.ts src/__tests__/ui/phase-transition-banner.test.ts
git commit -m "refactor: unify overlay and card theme in OpenTUI"
```

## Chunk 5: Final Verification

### Task 7: Run full verification and smoke tests

**Files:**
- Modify as needed: any file from earlier tasks

- [ ] **Step 1: Run full test suite**

Run: `DUO_BUN_BINARY=/Users/rex/Documents/Program2026/duo/.local/bun/bin/bun npm test`
Expected: PASS

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Run manual TUI smoke checks**

Verify in a real terminal session:
- setup hero and step panel alignment
- directory/model/task rows stay aligned
- session header/transcript/composer alignment
- completion footer alignment
- overlays render with consistent panel structure

- [ ] **Step 4: Commit any final polish**

```bash
git add <relevant-files>
git commit -m "fix: polish OpenTUI global UI consistency"
```
