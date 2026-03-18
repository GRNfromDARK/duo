# AI-Driven Simplification Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the entire v1 fallback stack (~3000+ lines), replacing complex degradation/fallback mechanisms with a simple retry-then-pause strategy.

**Architecture:** When God (LLM) fails, retry up to 3 times with exponential backoff (2s→4s→8s), then pause the task. No degraded mode. No v1 fallback. The system either runs with AI or pauses.

**Tech Stack:** TypeScript, Vitest, xstate v5, React (Ink)

**Spec:** `docs/ai-driven-simplification-design.md`

---

## Chunk 1: Foundation — Simplify WatchdogService + god-fallback

### Task 1: Rewrite WatchdogService

**Files:**
- Modify: `src/god/watchdog.ts` (rewrite from ~312 to ~60 lines)
- Modify: `src/__tests__/god/watchdog.test.ts` (rewrite tests)

- [ ] **Step 1: Read current watchdog.ts and watchdog.test.ts fully**

Read both files to understand all exports, types, and test patterns before modifying.

- [ ] **Step 2: Write the new WatchdogService**

Replace `src/god/watchdog.ts` entirely. Keep the same class name and file path to minimize downstream changes.

```typescript
/**
 * WatchdogService — simple retry + backoff + pause for God failures.
 *
 * Core principle: LLM down = system pause, not degraded mode.
 * Retry up to 3 times with exponential backoff, then pause.
 */

export class WatchdogService {
  private consecutiveFailures = 0;
  private paused = false;

  static readonly MAX_RETRIES = 3;

  handleSuccess(): void {
    this.consecutiveFailures = 0;
    this.paused = false;
  }

  /**
   * Record a failure and return whether to retry.
   * Call this after each God call failure.
   */
  shouldRetry(): boolean {
    this.consecutiveFailures++;
    if (this.consecutiveFailures > WatchdogService.MAX_RETRIES) {
      this.paused = true;
      return false;
    }
    return true;
  }

  /** Exponential backoff: 2s, 4s, 8s (capped at 10s). */
  getBackoffMs(): number {
    return Math.min(2000 * Math.pow(2, this.consecutiveFailures - 1), 10_000);
  }

  isPaused(): boolean {
    return this.paused;
  }

  isGodAvailable(): boolean {
    return !this.paused;
  }

  /** User chose to retry after pause. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.paused = false;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }
}
```

Note: We intentionally drop all these exports from the old file:
- `WatchdogDecisionSchema`, `WatchdogDecision`, `WatchdogState`
- `WATCHDOG_SYSTEM_PROMPT`, `buildEnvelopeFromWatchdogAction`
- `diagnose()` method (AI-powered diagnosis)
- `serializeState()` (DegradationState persistence)
- `GodAdapter` dependency (no longer needed)
- All zod imports

- [ ] **Step 3: Rewrite watchdog.test.ts**

Replace `src/__tests__/god/watchdog.test.ts`:

```typescript
/**
 * Tests for WatchdogService — simple retry + backoff + pause.
 */
import { describe, it, expect } from 'vitest';
import { WatchdogService } from '../../god/watchdog.js';

describe('WatchdogService', () => {
  describe('shouldRetry', () => {
    it('returns true for first 3 failures', () => {
      const w = new WatchdogService();
      expect(w.shouldRetry()).toBe(true);  // failure 1
      expect(w.shouldRetry()).toBe(true);  // failure 2
      expect(w.shouldRetry()).toBe(true);  // failure 3
    });

    it('returns false on 4th failure and pauses', () => {
      const w = new WatchdogService();
      w.shouldRetry(); // 1
      w.shouldRetry(); // 2
      w.shouldRetry(); // 3
      expect(w.shouldRetry()).toBe(false); // 4 → pause
      expect(w.isPaused()).toBe(true);
    });
  });

  describe('getBackoffMs', () => {
    it('returns exponential backoff: 2s, 4s, 8s', () => {
      const w = new WatchdogService();
      w.shouldRetry(); // failure 1
      expect(w.getBackoffMs()).toBe(2000);
      w.shouldRetry(); // failure 2
      expect(w.getBackoffMs()).toBe(4000);
      w.shouldRetry(); // failure 3
      expect(w.getBackoffMs()).toBe(8000);
    });

    it('caps at 10s', () => {
      const w = new WatchdogService();
      w.shouldRetry(); // 1
      w.shouldRetry(); // 2
      w.shouldRetry(); // 3
      w.shouldRetry(); // 4
      expect(w.getBackoffMs()).toBe(10000);
    });
  });

  describe('handleSuccess', () => {
    it('resets consecutive failures', () => {
      const w = new WatchdogService();
      w.shouldRetry();
      w.shouldRetry();
      w.handleSuccess();
      expect(w.getConsecutiveFailures()).toBe(0);
      expect(w.isPaused()).toBe(false);
    });
  });

  describe('reset', () => {
    it('unpauses after exhaustion', () => {
      const w = new WatchdogService();
      w.shouldRetry(); w.shouldRetry(); w.shouldRetry(); w.shouldRetry();
      expect(w.isPaused()).toBe(true);
      w.reset();
      expect(w.isPaused()).toBe(false);
      expect(w.isGodAvailable()).toBe(true);
    });
  });

  describe('isGodAvailable', () => {
    it('returns true initially', () => {
      expect(new WatchdogService().isGodAvailable()).toBe(true);
    });

    it('returns false when paused', () => {
      const w = new WatchdogService();
      w.shouldRetry(); w.shouldRetry(); w.shouldRetry(); w.shouldRetry();
      expect(w.isGodAvailable()).toBe(false);
    });
  });
});
```

- [ ] **Step 4: Run watchdog tests to verify they pass**

Run: `npx vitest run src/__tests__/god/watchdog.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Fix downstream compilation errors**

The rewrite removes many exports. Fix all files that import from `watchdog.ts`:
- `src/__tests__/helpers/mock-watchdog.ts` — rewrite helper: `export function createMockWatchdog() { return new WatchdogService(); }` (remove GodAdapter param, WatchdogDecision import)
- `src/__tests__/god/god-decision-service.test.ts` — update `createMockWatchdog()` call (no adapter arg), remove dummy GodAdapter factory
- `src/__tests__/god/god-decision-service-resume.test.ts` — same: update `createMockWatchdog()` call
- `src/__tests__/engine/bug-22-23-regression.test.ts` — imports `createMockWatchdog` from helper, should work after helper update
- `src/__tests__/ui/god-fallback-watchdog.test.ts` — update to use new WatchdogService API
- `src/ui/components/App.tsx` — update WatchdogService constructor: `new WatchdogService()` (remove `watchdogAdapterRef` param and model/restoredState options)

Strategy: `grep -r "from.*watchdog" src/` to find all imports, then fix each.

- [ ] **Step 6: Run full test suite to verify no regressions**

Run: `npx vitest run`
Expected: All tests PASS (some tests may need temporary stubs — fix them)

- [ ] **Step 7: Commit**

```bash
git add src/god/watchdog.ts src/__tests__/god/watchdog.test.ts
# Also add any other files fixed in Step 5
git commit -m "refactor: simplify WatchdogService to retry+backoff+pause

Remove AI-powered diagnosis, construct_envelope, and escalation logic.
WatchdogService now does one thing: count failures, provide backoff
timing, and signal pause after 3 retries."
```

---

### Task 2: Simplify god-fallback.ts

**Files:**
- Modify: `src/ui/god-fallback.ts` (rewrite from ~137 to ~40 lines)
- Modify: `src/__tests__/ui/god-fallback.test.ts` (rewrite tests)

- [ ] **Step 1: Read god-fallback.ts and god-fallback.test.ts fully**

- [ ] **Step 2: Write the new withRetry**

Replace `src/ui/god-fallback.ts`:

```typescript
/**
 * withRetry — simple retry wrapper for God calls.
 *
 * Core principle: retry up to 3x with backoff, then pause.
 * No fallback. No degraded mode.
 */

import { WatchdogService } from '../god/watchdog.js';

export interface RetryResult<T> {
  result: T;
  retryCount: number;
}

export interface PausedResult {
  paused: true;
  retryCount: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wrap an async operation with retry + exponential backoff.
 * Returns { result } on success or { paused: true } when retries exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  watchdog: WatchdogService,
): Promise<RetryResult<T> | PausedResult> {
  let retryCount = 0;
  while (true) {
    try {
      const result = await fn();
      watchdog.handleSuccess();
      return { result, retryCount };
    } catch {
      if (!watchdog.shouldRetry()) {
        return { paused: true, retryCount: ++retryCount };
      }
      retryCount++;
      await sleep(watchdog.getBackoffMs());
    }
  }
}

/** Type guard: check if result is paused. */
export function isPaused<T>(r: RetryResult<T> | PausedResult): r is PausedResult {
  return 'paused' in r && r.paused === true;
}
```

- [ ] **Step 3: Rewrite god-fallback.test.ts**

Replace `src/__tests__/ui/god-fallback.test.ts`:

```typescript
/**
 * Tests for withRetry — simple retry wrapper.
 */
import { describe, test, expect, vi } from 'vitest';
import { withRetry, isPaused } from '../../ui/god-fallback.js';
import { WatchdogService } from '../../god/watchdog.js';

describe('withRetry', () => {
  test('returns result on first success', async () => {
    const w = new WatchdogService();
    const r = await withRetry(async () => 'ok', w);
    expect(isPaused(r)).toBe(false);
    if (!isPaused(r)) {
      expect(r.result).toBe('ok');
      expect(r.retryCount).toBe(0);
    }
  });

  test('retries on failure and returns result on success', async () => {
    const w = new WatchdogService();
    let calls = 0;
    const r = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return 'ok';
    }, w);
    expect(isPaused(r)).toBe(false);
    if (!isPaused(r)) {
      expect(r.result).toBe('ok');
      expect(r.retryCount).toBe(2);
    }
  });

  test('returns paused after exhausting retries', async () => {
    const w = new WatchdogService();
    const r = await withRetry(async () => { throw new Error('always fail'); }, w);
    expect(isPaused(r)).toBe(true);
    if (isPaused(r)) {
      expect(r.retryCount).toBe(4);
    }
  });

  test('resets failure count on success', async () => {
    const w = new WatchdogService();
    // Fail twice then succeed
    let calls = 0;
    await withRetry(async () => {
      calls++;
      if (calls <= 2) throw new Error('fail');
      return 'ok';
    }, w);
    expect(w.getConsecutiveFailures()).toBe(0);
  });
});

describe('isPaused', () => {
  test('returns true for paused result', () => {
    expect(isPaused({ paused: true, retryCount: 4 })).toBe(true);
  });

  test('returns false for success result', () => {
    expect(isPaused({ result: 'ok', retryCount: 0 })).toBe(false);
  });
});
```

- [ ] **Step 4: Run god-fallback tests**

Run: `npx vitest run src/__tests__/ui/god-fallback.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Fix downstream imports**

Files importing from god-fallback.ts need updates:

**`src/ui/components/App.tsx` — critical changes:**
- Replace `import { withGodFallback, withGodFallbackSync }` with `import { withRetry, isPaused }`
- For `withGodFallback` call sites (async God calls): replace with `withRetry(fn, watchdogRef.current)`, check `isPaused(result)` instead of `result.usedGod`
- For `withGodFallbackSync` call sites (prompt generation at lines ~714, ~996): replace with **direct call** — `generateCoderPrompt(...)` / `generateReviewerPrompt(...)`. Prompt generation is a pure template function (no LLM call), so it doesn't need retry/fallback. The ContextManager fallback path it previously used is being deleted in Task 6.
- Remove `GodRetryController` / `GodAvailabilityGuard` imports
- Keep contextManagerRef/convergenceRef/choiceDetectorRef for now (removed in later tasks)

**`src/god/task-init.ts`** — replace `withGodFallback` with `withRetry`, handle `isPaused()` return
**`src/__tests__/ui/god-fallback-watchdog.test.ts`** — update or delete (may be redundant after simplification)
**`src/__tests__/god/task-init.test.ts`** — update expectations for new return type

Strategy: `grep -r "from.*god-fallback" src/` to find all imports, then update each.

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/ui/god-fallback.ts src/__tests__/ui/god-fallback.test.ts
# Also add any other files fixed in Step 5
git commit -m "refactor: replace withGodFallback/Sync with simple withRetry

Single retry wrapper: try → fail → backoff → retry (up to 3x) → pause.
No fallback path. No sync variant. No degradation notifications."
```

---

## Chunk 2: Delete v1 Decision Modules

### Task 3: Delete degradation-manager.ts + types

**Files:**
- Delete: `src/god/degradation-manager.ts`
- Delete: `src/__tests__/god/degradation-manager.test.ts`
- Modify: `src/types/degradation.ts` (strip down to minimal)
- Modify: `src/god/observation-classifier.ts` (remove `createDegradationObservation`)
- Modify: `src/session/session-manager.ts` (remove DegradationState persistence)
- Update: 7 test files (see spec Step 3)

- [ ] **Step 1: Delete production and test files**

```bash
rm src/god/degradation-manager.ts src/__tests__/god/degradation-manager.test.ts
```

- [ ] **Step 2: Simplify degradation.ts**

Replace `src/types/degradation.ts` with:

```typescript
/**
 * Minimal types retained for backward compatibility with saved sessions.
 * Old sessions may have a degradationState field — it is silently ignored.
 */

export type GodErrorKind = 'process_exit' | 'timeout' | 'parse_failure' | 'schema_validation';
```

Note: `DegradationLevel`, `DegradationState`, `DegradationNotification` are all deleted.

- [ ] **Step 3: Remove createDegradationObservation from observation-classifier.ts**

Open `src/god/observation-classifier.ts`, find and delete the `createDegradationObservation` function and any imports it uses that are now orphaned.

- [ ] **Step 4: Update session-manager.ts and session-runner-state.ts**

In `src/session/session-manager.ts`: Remove `DegradationState` import and any persistence logic. Grep for `degradationState` and `DegradationState` in the file — remove all references.

In `src/ui/session-runner-state.ts`: Remove `import type { DegradationState } from '../types/degradation.js'` (line 3) and remove `degradationState?: DegradationState;` field from `RestoredSessionRuntime` interface (line 69).

The session JSON field `degradationState` in existing saved sessions is silently ignored (no migration needed).

- [ ] **Step 5: Fix all downstream imports**

Run: `grep -r "DegradationManager\|DegradationState\|DegradationLevel\|DegradationNotification\|FallbackServices\|degradation-manager\|createDegradationObservation" src/ --include="*.ts" --include="*.tsx"`

Fix each file:
- Remove imports of deleted types
- Remove usage of deleted functions/classes
- For test files: remove DegradationManager instantiation, remove FallbackServices construction

Key test files to update:
- `src/__tests__/session/session-manager.test.ts`
- `src/__tests__/god/incident-management.test.ts`
- `src/__tests__/god/audit-bug-regressions.test.ts`
- `src/__tests__/integration/god-workflow.test.ts`
- `src/__tests__/integration/sovereign-runtime.test.ts`
- `src/__tests__/god/god-prompt-integration.test.ts`
- `src/__tests__/ui/god-convergence-evaluating.test.ts`

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add -u  # stages all modifications and deletions
git commit -m "refactor: delete DegradationManager and fallback types

Remove 4-level degradation strategy, FallbackServices interface,
DegradationState persistence, and createDegradationObservation.
Simplified WatchdogService is now the sole failure handler."
```

---

### Task 4: Delete choice-detector.ts

**Files:**
- Delete: `src/decision/choice-detector.ts`
- Delete: `src/__tests__/decision/choice-detector.test.ts`
- Modify: `src/ui/session-runner-state.ts` (remove choice routing)
- Modify: `src/ui/components/App.tsx` (remove choiceDetectorRef)
- Update: 2 test files

- [ ] **Step 1: Delete production and test files**

```bash
rm src/decision/choice-detector.ts src/__tests__/decision/choice-detector.test.ts
```

- [ ] **Step 2: Remove choice routing from session-runner-state.ts**

Open `src/ui/session-runner-state.ts`:
- Remove `import { ChoiceDetector }` or `ChoiceDetectorLike`
- Remove `ChoiceRoute` interface
- Remove `decidePostCodeRoute` function
- Remove `decidePostReviewRoute` function
- Remove any other ChoiceDetector references

- [ ] **Step 3: Remove choiceDetectorRef from App.tsx**

Open `src/ui/components/App.tsx`:
- Remove `import { ChoiceDetector }`
- Remove `choiceDetectorRef` initialization
- Remove any usage of `choiceDetectorRef.current` in handlers

- [ ] **Step 4: Fix test files**

- `src/__tests__/ui/session-runner-state.test.ts` — remove all choice routing tests
- `src/__tests__/ui/god-convergence-evaluating.test.ts` — remove ChoiceDetector references

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add -u
git commit -m "refactor: delete ChoiceDetector — God handles choice routing

Remove regex-based choice detection. God reads worker output
natively and decides whether to use autonomousResolutions,
send_to_reviewer, or request_user_input."
```

---

### Task 5: Delete convergence-service.ts + update consistency-checker

**Files:**
- Delete: `src/decision/convergence-service.ts`
- Delete: `src/__tests__/decision/convergence-service.test.ts`
- Modify: `src/god/consistency-checker.ts` (crossValidate → audit-only)
- Modify: `src/ui/components/App.tsx` (remove convergenceRef)
- Update: 4 test files

- [ ] **Step 1: Delete production and test files**

```bash
rm src/decision/convergence-service.ts src/__tests__/decision/convergence-service.test.ts
```

- [ ] **Step 2: Update consistency-checker.ts**

Change `crossValidate()` from "local wins" to "audit-only":

```typescript
/**
 * Cross-validate God's classification against a local heuristic.
 * Audit-only: logs disagreement but God is authoritative.
 */
export function crossValidate(
  godClassification: string,
  localClassification: string,
): { agree: boolean; source: 'god' } {
  const normalizedGod = normalize(godClassification);
  const normalizedLocal = normalize(localClassification);

  return {
    agree: normalizedGod === normalizedLocal,
    source: 'god',  // God always authoritative — local is audit-only
  };
}
```

Note: return type changes from `'god' | 'local'` to just `'god'`. All callers that checked `source === 'local'` need updating.

- [ ] **Step 3: Remove convergenceRef from App.tsx**

Remove `import { ConvergenceService }`, `convergenceRef`, and all usage.

- [ ] **Step 4: Fix test files**

- `src/__tests__/god/consistency-checker.test.ts` — update all `expect(result.source).toBe('local')` to `expect(result.source).toBe('god')` (God is now always authoritative on disagreement)
- `src/__tests__/ui/god-convergence-evaluating.test.ts` — remove ConvergenceService fallback tests
- `src/__tests__/ui/c3-integration.test.ts` — remove convergence service references
- `src/__tests__/god/bug-14-15-16-regression.test.ts` — update convergence expectations
- `src/__tests__/god/bug-17-18-regression.test.ts` — update convergence expectations

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add -u
git commit -m "refactor: delete ConvergenceService, make God authoritative

Remove v1 local convergence analyzer. crossValidate() now audit-only:
logs disagreements but God classification is always authoritative."
```

---

## Chunk 3: Delete Remaining Modules + Prompt Changes

### Task 6: Delete context-manager.ts (with RoundRecord relocation)

**Files:**
- Create: `src/types/session.ts` (if needed — relocate RoundRecord)
- Delete: `src/session/context-manager.ts`
- Delete: `src/__tests__/session/context-manager.test.ts`
- Modify: `src/ui/session-runner-state.ts` (update RoundRecord import)
- Modify: `src/ui/components/App.tsx` (remove contextManagerRef, update import)
- Modify: `src/god/phase-transition.ts` (update RoundRecord reference)
- Update: 1 test file

- [ ] **Step 1: Check if src/types/session.ts exists**

Run: `ls src/types/session.ts 2>/dev/null || echo "NEEDS_CREATION"`

- [ ] **Step 2: Relocate RoundRecord type**

If `src/types/session.ts` exists, add `RoundRecord` to it. If not, create it:

```typescript
/**
 * Session-related types shared across modules.
 */

export interface RoundRecord {
  index: number;
  coderOutput: string;
  reviewerOutput: string;
  summary?: string;
  timestamp: number;
}
```

- [ ] **Step 3: Update all RoundRecord imports**

Find all files importing RoundRecord from context-manager:

```bash
grep -r "RoundRecord.*context-manager\|context-manager.*RoundRecord" src/ --include="*.ts" --include="*.tsx"
```

Update each to import from `../../types/session.js` (adjust relative path per file).

Note: `src/god/phase-transition.ts` has only a JSDoc comment reference to RoundRecord (not an actual import). No code change needed there.

- [ ] **Step 4: Delete context-manager files**

```bash
rm src/session/context-manager.ts src/__tests__/session/context-manager.test.ts
```

- [ ] **Step 5: Remove contextManagerRef from App.tsx**

Remove `import { ContextManager }`, `contextManagerRef`, and all `contextManagerRef.current.buildCoderPrompt()` / `buildReviewerPrompt()` / `generateSummary()` calls.

For prompt generation sites that previously used `withGodFallbackSync` with ContextManager fallback: replace with direct call to `generateCoderPrompt()` / `generateReviewerPrompt()` wrapped in the `withRetry` from Task 2.

- [ ] **Step 6: Fix test file**

- `src/__tests__/god/god-prompt-integration.test.ts` — remove ContextManager fallback tests

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add -u
git add src/types/session.ts  # if newly created
git commit -m "refactor: delete ContextManager, relocate RoundRecord

Remove v1 prompt builder. Prompt generation now has no fallback —
failure goes through withRetry → pause. RoundRecord type moved
to src/types/session.ts."
```

---

### Task 7: Delete GodAutoDecision + escape-window + GodDecisionBanner

**Files:**
- Delete: `src/ui/escape-window.ts`, `src/__tests__/ui/escape-window.test.ts`
- Delete: `src/ui/god-decision-banner.ts`, `src/__tests__/ui/god-decision-banner.test.ts`
- Delete: `src/ui/components/GodDecisionBanner.tsx`
- Modify: `src/types/god-schemas.ts` (remove GodAutoDecisionSchema)
- Modify: `src/types/god-envelope.ts` (remove GodAutoDecision reference)
- Modify: `src/ui/components/App.tsx` (remove godDecision state, banner rendering)
- Update: 1 test file

- [ ] **Step 1: Delete files**

```bash
rm src/ui/escape-window.ts src/__tests__/ui/escape-window.test.ts
rm src/ui/god-decision-banner.ts src/__tests__/ui/god-decision-banner.test.ts
rm src/ui/components/GodDecisionBanner.tsx
```

- [ ] **Step 2: Remove GodAutoDecision from type files**

In `src/types/god-schemas.ts`: delete `GodAutoDecisionSchema` and `GodAutoDecision` type.
In `src/types/god-envelope.ts`: remove any `GodAutoDecision` reference.

- [ ] **Step 3: Remove from App.tsx**

Remove `godDecision` state, `GodDecisionBanner` import/rendering, and any escape-window imports.

- [ ] **Step 4: Fix test**

- `src/__tests__/parsers/god-json-extractor.test.ts` — remove GodAutoDecision parsing tests

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add -u
git commit -m "refactor: delete GodAutoDecision, escape-window, GodDecisionBanner

Remove dead code: escape window was disabled (=0), GodAutoDecision
was unused, and GodDecisionBanner had no purpose without them."
```

---

### Task 8: Delete resolveEffectiveType from god-prompt-generator

**Files:**
- Modify: `src/god/god-prompt-generator.ts` (remove function + IMPLEMENTATION_KEYWORDS)
- Modify: `src/__tests__/god/god-prompt-generator.test.ts` (update tests)

- [ ] **Step 1: Read god-prompt-generator.ts fully**

Understand how `resolveEffectiveType` is called and by whom.

- [ ] **Step 2: Remove resolveEffectiveType**

In `src/god/god-prompt-generator.ts`:
- Delete the `IMPLEMENTATION_KEYWORDS` regex constant
- Delete the `resolveEffectiveType()` function
- At the call site (in `generateCoderPrompt`), replace:
  ```typescript
  const effectiveType = resolveEffectiveType(ctx.phaseType, ctx.instruction);
  ```
  with:
  ```typescript
  const effectiveType = ctx.phaseType ?? ctx.taskType;
  ```

This means the prompt generator uses the phase type directly (or task type as fallback) without second-guessing God's instruction.

- [ ] **Step 3: Update tests**

In `src/__tests__/god/god-prompt-generator.test.ts`:
- Remove the "Phase Conflict Resolution" / "resolveEffectiveType" test section
- Remove IMPLEMENTATION_KEYWORDS narrowing tests
- Keep all other tests, adjusting expectations where `resolveEffectiveType` was indirectly tested

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/__tests__/god/god-prompt-generator.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/god/god-prompt-generator.ts src/__tests__/god/god-prompt-generator.test.ts
git commit -m "refactor: remove resolveEffectiveType from prompt generator

Prompt generator no longer second-guesses God's phase type based on
keyword matching. Uses phase type directly; God specifies mode
explicitly in instruction when override is needed."
```

---

### Task 9: God prompt enhancements

**Files:**
- Modify: `src/god/god-decision-service.ts` (add choice-handling + mode instructions)
- Modify: `src/__tests__/god/god-decision-service.test.ts` (add tests)

- [ ] **Step 1: Read SYSTEM_PROMPT section of god-decision-service.ts**

Find where `PROPOSAL_ROUTING_INSTRUCTIONS` and other prompt constants are defined.

- [ ] **Step 2: Add choice-handling instruction**

Add after `PROPOSAL_ROUTING_INSTRUCTIONS` export (~line 341) in `src/god/god-decision-service.ts`.
Then include `${CHOICE_HANDLING_INSTRUCTIONS}` in `SYSTEM_PROMPT` after the `${PROPOSAL_ROUTING_INSTRUCTIONS}` line (~line 359):

```typescript
export const CHOICE_HANDLING_INSTRUCTIONS = `Worker choice handling:
- When Worker output contains multiple approaches/options/方案:
  - If approaches are similar with a clear winner → use autonomousResolutions to select the best approach and direct Worker to implement it
  - If approaches differ significantly and need professional evaluation → send_to_reviewer for design judgment
  - If the choice involves user preference or project-specific trade-offs → request_user_input
- Do NOT ignore Worker questions — always resolve them through one of the three paths above`;
```

Include this in the `SYSTEM_PROMPT` template string.

- [ ] **Step 3: Add mode specification guidance**

Add after `CHOICE_HANDLING_INSTRUCTIONS` in `src/god/god-decision-service.ts`.
Include `${MODE_SPECIFICATION_INSTRUCTIONS}` in `SYSTEM_PROMPT` before `${PROXY_DECISION_INSTRUCTIONS}` (~line 361):

```typescript
export const MODE_SPECIFICATION_INSTRUCTIONS = `Worker mode specification:
- When sending instructions to Coder, if the current phase type does not match the intended work, explicitly specify the execution mode in your instruction
- Example: if the phase is "explore" but you want Coder to implement, include "mode: implement" or "请开始实现" in your instruction
- The prompt generator will use your explicit mode over the default phase type`;
```

- [ ] **Step 4: Write tests**

In `src/__tests__/god/god-decision-service.test.ts`, add:

```typescript
describe('CHOICE_HANDLING_INSTRUCTIONS', () => {
  it('is included in SYSTEM_PROMPT', () => {
    expect(SYSTEM_PROMPT).toContain('Worker choice handling');
    expect(SYSTEM_PROMPT).toContain('autonomousResolutions');
    expect(SYSTEM_PROMPT).toContain('request_user_input');
  });
});

describe('MODE_SPECIFICATION_INSTRUCTIONS', () => {
  it('is included in SYSTEM_PROMPT', () => {
    expect(SYSTEM_PROMPT).toContain('Worker mode specification');
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/__tests__/god/god-decision-service.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/god/god-decision-service.ts src/__tests__/god/god-decision-service.test.ts
git commit -m "feat: add choice-handling and mode-specification to God prompt

God now explicitly handles Worker choice questions (autonomousResolutions /
send_to_reviewer / request_user_input) and can specify execution mode
in instructions to override default phase type."
```

---

## Chunk 4: Workflow Machine Cleanup + Final Regression

### Task 10: Rename MANUAL_FALLBACK → PAUSED + App.tsx cleanup

**Files:**
- Modify: `src/engine/workflow-machine.ts` (rename state + event + simplify transitions)
- Modify: `src/ui/components/App.tsx` (final cleanup)
- Modify: `src/ui/reclassify-overlay.ts` (rename reference)
- Modify: `src/ui/session-runner-state.ts` (rename reference)
- Modify: `src/ui/components/StatusBar.tsx` (remove degradation indicators)
- Update: test files (see step 5 below)

- [ ] **Step 1: Rename in workflow-machine.ts**

Global find-replace in `src/engine/workflow-machine.ts`:
- State: `MANUAL_FALLBACK` → `PAUSED`
- Event type: `ManualFallbackRequiredEvent` → `PauseRequiredEvent`, `{ type: 'MANUAL_FALLBACK_REQUIRED' }` → `{ type: 'PAUSE_REQUIRED' }`
- Event: `TASK_INIT_SKIP` → delete entirely
- `TaskInitSkipEvent` type → delete
- Update `WorkflowEvent` union type: replace `ManualFallbackRequiredEvent` with `PauseRequiredEvent`

Simplify PAUSED transitions (keep `USER_CONFIRM` event type, simplify actions):
- Keep `USER_CONFIRM` with `action: 'continue'` → back to GOD_DECIDING (retry)
- Keep `USER_CONFIRM` with `action: 'accept'` → DONE (quit)
- Remove `confirmContinueWithPhase` guard and complex phase-transition handling from PAUSED

- [ ] **Step 2: Rename in UI files**

In `src/ui/reclassify-overlay.ts`: `MANUAL_FALLBACK` → `PAUSED`
In `src/ui/session-runner-state.ts`: `MANUAL_FALLBACK` → `PAUSED`

- [ ] **Step 3: Final App.tsx cleanup**

- Remove all remaining imports of deleted modules
- Remove any remaining refs (contextManagerRef, convergenceRef, choiceDetectorRef should be gone from earlier tasks)
- **Replace all** `send({ type: 'MANUAL_FALLBACK_REQUIRED' })` → `send({ type: 'PAUSE_REQUIRED' })` (grep for `MANUAL_FALLBACK_REQUIRED` to find all call sites)
- Remove `TASK_INIT_SKIP` handling
- Remove GodAutoDecision state if not already removed
- Ensure `watchdogRef` uses the new simplified WatchdogService

- [ ] **Step 4: Simplify StatusBar**

In `src/ui/components/StatusBar.tsx`:
- Remove `degradationLevel?: string;` from `StatusBarProps` interface (line 30)
- Remove `degradationLevel` from destructured props (line 85)
- Remove all `degradationLevel` usage in the component body (lines ~106-109, ~128, ~159)
- Simplify to show: running / paused status only

In `src/ui/components/App.tsx`: Remove `degradationLevel` prop from all `<StatusBar>` JSX call sites.

- [ ] **Step 5: Update all 17 test files**

Strategy: use `grep -r "MANUAL_FALLBACK" src/__tests__/` to find all references, then global find-replace.

For `MANUAL_FALLBACK` → `PAUSED` and `MANUAL_FALLBACK_REQUIRED` → `PAUSE_REQUIRED` rename (files with confirmed references):
- `src/__tests__/engine/workflow-machine.test.ts` (3 refs)
- `src/__tests__/engine/workflow-machine-d1-refactor.test.ts` (13 refs)
- `src/__tests__/engine/bug-19-20-21-regression.test.ts` (9 refs)
- `src/__tests__/ui/reclassify-overlay.test.ts` (4 refs)
- `src/__tests__/ui/c3-integration.test.ts` (4 refs)
- `src/__tests__/god/bug-14-15-16-regression.test.ts` (14 refs)
- `src/__tests__/god/bug-17-18-regression.test.ts` (8 refs)
- `src/__tests__/god/audit-bug-regressions.test.ts` (2 refs)
- `src/__tests__/integration/god-workflow.test.ts` (5 refs)

For StatusBar:
- `src/__tests__/ui/StatusBar.test.tsx` — remove degradation indicator tests, remove `degradationLevel` prop from test renders
- `src/__tests__/ui/status-bar.test.tsx` — remove degradation indicator tests, remove `degradationLevel` prop from test renders

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add -u
git commit -m "refactor: rename MANUAL_FALLBACK → PAUSED, final cleanup

Rename state and events. Remove TASK_INIT_SKIP. Simplify PAUSED
transitions to retry/quit only. Remove degradation indicators
from StatusBar. Complete v1 fallback stack removal."
```

---

### Task 11: Full Regression + Verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL tests PASS, 0 failures

- [ ] **Step 2: Verify no remaining fallback references**

```bash
grep -r "DegradationManager\|DegradationState\|DegradationLevel\|FallbackServices\|ContextManager\|ConvergenceService\|ChoiceDetector\|GodAutoDecision\|withGodFallbackSync\|MANUAL_FALLBACK\|TASK_INIT_SKIP\|createDegradationObservation\|escape-window\|god-decision-banner" src/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".test." || echo "CLEAN"
```

Expected: `CLEAN` (no matches in production code)

- [ ] **Step 3: Count deleted lines**

```bash
git diff --stat HEAD~10..HEAD  # adjust range to cover all commits
```

Expected: ~3000+ lines deleted net

- [ ] **Step 4: TypeScript compilation check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Final commit (if any fixups needed)**

```bash
git add -u
git commit -m "chore: final cleanup after fallback stack removal"
```
