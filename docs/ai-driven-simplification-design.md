# AI-Driven Simplification: Remove Fallback Stack

## 1. Background & Motivation

Duo is an AI orchestration system where God (orchestrator), Coder (executor), and Reviewer (observer) collaborate to complete development tasks. The current codebase maintains an extensive "fallback stack" — a set of v1 local heuristic modules designed to keep the system running when the LLM (God) becomes unavailable.

This fallback stack includes:
- **DegradationManager** — 4-level degradation strategy (L1→L4)
- **ContextManager** — v1 prompt builder as fallback for god-prompt-generator
- **ConvergenceService** — v1 local convergence analyzer as fallback for god-convergence
- **ChoiceDetector** — regex-based choice detection as fallback for God's proposal routing
- **withGodFallback / withGodFallbackSync** — dual wrapper pattern for every God call
- **FallbackServices** — bundle interface packaging all v1 modules
- **GodAutoDecision / escape-window** — dead code (escape window = 0)
- **TASK_INIT_SKIP** — skip God initialization and run without task analysis
- **createDegradationObservation** — observation factory for degradation events
- **DegradationState persistence** — save/restore degradation level across sessions

Together these mechanisms account for ~1500+ lines of production code and ~1500+ lines of tests, all dedicated to one scenario: **LLM is unavailable**.

### The Fundamental Problem

**Duo without LLM has zero value.** The entire product is AI-driven orchestration. Maintaining a complex "degraded mode" that runs without God is like building an autopilot system that continues driving after all sensors fail — the correct response is to pull over and stop, not to guess the road with regex.

The fallback stack creates three concrete problems:

1. **Architectural pollution** — Every module must maintain two code paths (God path + fallback path), doubling complexity and making behavior unpredictable.
2. **False safety** — The v1 fallback modules (regex choice detection, heuristic convergence) give the illusion of functionality while producing low-quality decisions that are worse than pausing.
3. **Migration blocker** — Moving toward true AI-driven architecture requires removing these v1 modules, but every module depends on the fallback chain, creating circular dependencies.

## 2. Core Principle

```
LLM available → run
LLM unavailable → retry (max 3, exponential backoff) → pause task
```

No degraded mode. No v1 fallback. No "keep running without a brain."

## 3. Current State Analysis

### 3.1 The Fallback Web

Every God interaction point has a fallback path:

```
TASK_INIT:
  God available? → No → TASK_INIT_SKIP (run without task analysis)
  God call fails? → withGodFallback → Watchdog AI diagnose → retry/fallback → null

CODING (prompt generation):
  withGodFallbackSync → try generateCoderPrompt() → catch → ContextManager.buildCoderPrompt()

REVIEWING (prompt generation):
  withGodFallbackSync → try generateReviewerPrompt() → catch → ContextManager.buildReviewerPrompt()

GOD_DECIDING:
  God available? → No → MANUAL_FALLBACK
  God timeout (610s)? → MANUAL_FALLBACK
  God exception? → MANUAL_FALLBACK
  Circuit breaker (3x route-to-coder)? → MANUAL_FALLBACK
```

### 3.2 WatchdogService (Current)

The current WatchdogService (~312 lines) uses a **separate LLM call** to diagnose God failures:

- `retry_fresh` — clear context, retry
- `retry_with_hint` — retry with correction hint
- `construct_envelope` — build fallback envelope from partial output
- `escalate` — disable God permanently

**Problem:** Using another LLM to diagnose why the LLM failed is circular. If the LLM API is down, the Watchdog LLM call also fails. If the failure is a parsing issue, simple retry is sufficient — no AI diagnosis needed.

### 3.3 DegradationManager (Legacy)

4-level strategy (~210 lines):
- L1: Normal
- L2: Retryable errors → retry 1x → fallback
- L3: Non-retryable errors → correction retry → fallback
- L4: 3 consecutive failures → disable God for entire session

**Problem:** Already replaced by WatchdogService in the main path. Only referenced in tests. Dead weight.

### 3.4 ContextManager (v1 Prompt Builder)

~425 lines providing static template-based prompts as fallback when god-prompt-generator fails.

**Problem:** Without God's task analysis, the prompts lack task type awareness, phase information, and convergence context. A prompt without these is low-quality — running a Coder with a bad prompt produces worse results than pausing and retrying later.

### 3.5 ConvergenceService (v1 Convergence Analyzer)

~286 lines doing local convergence classification via regex pattern matching.

**Problem:** The primary convergence path is already `god-convergence.ts` → `evaluateConvergence()`. The ConvergenceService only exists as a fallback AND is used by `consistency-checker.ts` to override God's judgment when they disagree ("local wins" rule). This undermines AI-driven architecture.

### 3.6 ChoiceDetector (v1 Choice Router)

~100 lines using regex to detect A/B/C, 1/2/3, 方案一/方案二 patterns in worker output.

**Problem:** God already handles proposal routing via `PROPOSAL_ROUTING_INSTRUCTIONS`. The regex detector and God can conflict when both fire on the same output. God's contextual understanding is strictly superior to pattern matching.

### 3.7 resolveEffectiveType (Local Strategy Override)

In `god-prompt-generator.ts`, this function uses keyword matching to detect when God's instruction conflicts with the current phase type, and overrides the template selection locally.

**Problem:** This is the prompt generator second-guessing God. If God says "explore" but the instruction mentions "implement," God should have specified "code" — the local override masks a God prompt quality issue instead of fixing it.

## 4. Target State

### 4.1 LLM Failure Handling

```
God call
  ├─ Success → continue
  └─ Failure → wait 2s → retry
      ├─ Success → continue
      └─ Failure → wait 4s → retry
          ├─ Success → continue
          └─ Failure → wait 8s → retry
              ├─ Success → continue
              └─ Failure → PAUSED
                  └─ User: r(retry) / q(quit)
```

### 4.2 Simplified WatchdogService

```typescript
// ~40 lines replacing ~312 lines
class WatchdogService {
  private consecutiveFailures = 0;
  private static MAX_RETRIES = 3;

  handleSuccess(): void {
    this.consecutiveFailures = 0;
  }

  shouldRetry(): boolean {
    this.consecutiveFailures++;
    return this.consecutiveFailures <= WatchdogService.MAX_RETRIES;
  }

  getBackoffMs(): number {
    return Math.min(2000 * Math.pow(2, this.consecutiveFailures - 1), 10000);
  }

  isPaused(): boolean {
    return this.consecutiveFailures > WatchdogService.MAX_RETRIES;
  }

  reset(): void {
    this.consecutiveFailures = 0;
  }
}
```

### 4.3 Simplified god-fallback

```typescript
// Single retry wrapper replacing withGodFallback + withGodFallbackSync
async function withRetry<T>(
  fn: () => Promise<T>,
  watchdog: WatchdogService,
): Promise<{ result: T } | { paused: true }> {
  while (true) {
    try {
      const result = await fn();
      watchdog.handleSuccess();
      return { result };
    } catch (err) {
      if (!watchdog.shouldRetry()) {
        return { paused: true };
      }
      await sleep(watchdog.getBackoffMs());
    }
  }
}
```

### 4.4 MANUAL_FALLBACK → PAUSED

The workflow machine's `MANUAL_FALLBACK` state is renamed to `PAUSED` with simplified transitions:

- Entry: God call exhausted retries OR user interrupt
- Exit: `USER_RETRY` → back to previous state (retry God) / `USER_QUIT` → DONE

The current MANUAL_FALLBACK menu offers: continue with custom instruction (c), accept task as done (a), and phase transition. These are removed because they only make sense in "God is dead, user takes over" mode. In the new PAUSED state, the LLM is temporarily unavailable — the correct actions are retry or quit, not manual orchestration. When LLM recovers, the system resumes from where it paused.

### 4.5 Capability Migration

Deleted modules' capabilities are already covered by God:

| Deleted Module | Capability | Covered By |
|---|---|---|
| ChoiceDetector | Detect worker choice questions | God reads worker output natively; add explicit choice-handling instruction to God prompt |
| ConvergenceService | Classify convergence | `god-convergence.ts` `evaluateConvergence()` (already primary) |
| ContextManager | Generate worker prompts | `god-prompt-generator.ts` (already primary) |
| resolveEffectiveType | Override template by keyword | God specifies mode directly in instruction |
| crossValidate "local wins" | Override God convergence | Remove override; audit-only logging |

### 4.6 God Prompt Enhancements

To compensate for deleted v1 modules, two additions to God's system prompt:

**Choice handling (replaces ChoiceDetector):**
```
When Worker output contains multiple approaches/options:
- If approaches are similar with a clear winner → use autonomousResolutions to select
- If professional evaluation needed → send_to_reviewer for judgment
- If user preference involved → request_user_input
```

**Mode specification (replaces resolveEffectiveType):**
God instructions to workers should explicitly specify the execution mode when the default (derived from phase type) is not appropriate. The prompt generator selects the corresponding template based on God's explicit mode, not local keyword matching.

## 5. Deletion Plan

### 5.1 Files to Delete

| File | Lines | Reason |
|---|---|---|
| `src/god/degradation-manager.ts` | ~210 | Replaced by simplified WatchdogService |
| `src/session/context-manager.ts` | ~425 | v1 fallback prompt builder, no longer needed |
| `src/decision/convergence-service.ts` | ~286 | v1 fallback convergence, God already primary |
| `src/decision/choice-detector.ts` | ~100 | v1 regex choice detection, God already capable |
| `src/ui/escape-window.ts` | ~80 | Dead code (escape window = 0) |
| `src/ui/god-decision-banner.ts` | ~60 | Tightly coupled to GodAutoDecision, dead code |
| `src/ui/components/GodDecisionBanner.tsx` | ~80 | React component for deleted GodAutoDecision banner |
| `src/__tests__/god/degradation-manager.test.ts` | ~300 | Tests for deleted module |
| `src/__tests__/session/context-manager.test.ts` | ~400 | Tests for deleted module |
| `src/__tests__/decision/convergence-service.test.ts` | ~486 | Tests for deleted module |
| `src/__tests__/decision/choice-detector.test.ts` | ~200 | Tests for deleted module |
| `src/__tests__/ui/escape-window.test.ts` | ~100 | Tests for deleted module |
| `src/__tests__/ui/god-decision-banner.test.ts` | ~58 | Tests for deleted GodDecisionBanner |

### 5.2 Files to Simplify

| File | Change |
|---|---|
| `src/god/watchdog.ts` | Rewrite: ~312 → ~40 lines. Remove AI diagnosis, keep retry+backoff+pause. |
| `src/ui/god-fallback.ts` | Rewrite: remove withGodFallbackSync, simplify withGodFallback to withRetry. |
| `src/god/god-prompt-generator.ts` | Delete `resolveEffectiveType()`. Prompt generator uses God-specified mode or phase type directly. |
| `src/god/consistency-checker.ts` | Change `crossValidate()` from "local wins on disagreement" to "audit-only logging." |
| `src/god/observation-classifier.ts` | Delete `createDegradationObservation()`. |
| `src/god/task-init.ts` | Remove `withGodFallback` usage; use `withRetry` instead. Remove null-fallback path. |
| `src/types/degradation.ts` | Delete `DegradationLevel`, `DegradationState`. Keep minimal pause state if needed. |
| `src/types/god-schemas.ts` | Delete `GodAutoDecisionSchema` and `GodAutoDecision` type. |
| `src/types/god-envelope.ts` | Remove `GodAutoDecision` reference. |
| `src/engine/workflow-machine.ts` | Rename `MANUAL_FALLBACK` → `PAUSED`. Remove `TASK_INIT_SKIP`. Simplify PAUSED transitions. |
| `src/ui/components/App.tsx` | Remove contextManagerRef, convergenceRef, choiceDetectorRef, GodDecisionBanner. Remove all withGodFallbackSync call sites. Simplify godRetryControllerRef. Remove TASK_INIT_SKIP handling. Remove GodAutoDecision state. |
| `src/ui/session-runner-state.ts` | Remove `decidePostCodeRoute` / `decidePostReviewRoute` choice routing. Remove `ChoiceRoute` type. |
| `src/ui/reclassify-overlay.ts` | Rename `MANUAL_FALLBACK` references to `PAUSED`. |
| `src/ui/components/StatusBar.tsx` | Remove L2/L3/L4 degradation indicators and `degradationLevel` prop. Simplify to running/paused display. |
| `src/session/session-manager.ts` | Remove `DegradationState` import and persistence. Existing sessions with saved `degradationState` field are silently ignored (field becomes unused, no migration needed — session schema is additive). |

### 5.3 Files Architecturally Intact (minor edits only)

These files retain their current architecture and responsibility. Some receive minor edits (renames, import path updates, prompt additions) but no structural changes.

| File | Reason |
|---|---|
| `src/god/hand-executor.ts` | Action execution boundary, no changes |
| `src/parsers/god-json-extractor.ts` | Protocol validation, no changes |
| `src/god/god-decision-service.ts` | Primary decision brain; receives prompt enhancements (Step 9) but architecture unchanged |
| `src/adapters/process-manager.ts` | Process lifecycle, no changes |
| `src/god/rule-engine.ts` | Security boundary, no changes |
| `src/god/message-dispatcher.ts` | Message routing, no changes |

## 6. Migration Steps

Each step maintains all tests passing. Test updates are folded into each step (not deferred to a monolithic cleanup step).

### Step 1: Simplify WatchdogService
- Rewrite `src/god/watchdog.ts` to simple retry+backoff+pause (~312 → ~40 lines)
- Delete `diagnose()`, `construct_envelope` logic, AI-powered triage
- Update tests:
  - `src/__tests__/god/watchdog.test.ts` — rewrite to match new interface
  - `src/__tests__/ui/god-fallback-watchdog.test.ts` — update Watchdog usage
  - `src/__tests__/god/god-decision-service.test.ts` — update WatchdogService mock

### Step 2: Simplify god-fallback.ts
- Replace `withGodFallback` + `withGodFallbackSync` with single `withRetry` in `src/ui/god-fallback.ts`
- Update `src/god/task-init.ts` to use `withRetry`, remove null-fallback path
- Update tests:
  - `src/__tests__/ui/god-fallback.test.ts` — rewrite to match withRetry interface
  - `src/__tests__/god/task-init.test.ts` — update fallback expectations
- Depends on: Step 1

### Step 3: Delete degradation-manager.ts
- Delete `src/god/degradation-manager.ts` and `src/__tests__/god/degradation-manager.test.ts`
- Delete `FallbackServices` interface from deleted file
- Simplify `src/types/degradation.ts` — delete `DegradationLevel`, `DegradationState`; keep minimal pause state type
- Update `src/session/session-manager.ts` — remove `DegradationState` import/persistence (existing sessions with `degradationState` field are silently ignored)
- Delete `createDegradationObservation()` from `src/god/observation-classifier.ts`
- Update tests:
  - `src/__tests__/session/session-manager.test.ts` — remove degradation state assertions
  - `src/__tests__/god/incident-management.test.ts` — remove degradation references
  - `src/__tests__/god/audit-bug-regressions.test.ts` — remove DegradationManager usage
  - `src/__tests__/integration/god-workflow.test.ts` — remove FallbackServices/DegradationManager
  - `src/__tests__/integration/sovereign-runtime.test.ts` — remove degradation tests
  - `src/__tests__/god/god-prompt-integration.test.ts` — remove DegradationManager import/instantiation (keep ContextManager references for Step 6)
  - `src/__tests__/ui/god-convergence-evaluating.test.ts` — remove DegradationManager import/instantiation (keep ConvergenceService references for Step 5)
- Depends on: Step 1

### Step 4: Delete choice-detector.ts
- Delete `src/decision/choice-detector.ts` and `src/__tests__/decision/choice-detector.test.ts`
- Remove `choiceDetectorRef` from `src/ui/components/App.tsx`
- Remove `decidePostCodeRoute`, `decidePostReviewRoute`, `ChoiceRoute` from `src/ui/session-runner-state.ts`
- Update tests:
  - `src/__tests__/ui/session-runner-state.test.ts` — remove choice routing tests
  - `src/__tests__/ui/god-convergence-evaluating.test.ts` — remove ChoiceDetector references

### Step 5: Delete convergence-service.ts
- Delete `src/decision/convergence-service.ts` and `src/__tests__/decision/convergence-service.test.ts`
- Remove `convergenceRef` from `src/ui/components/App.tsx`
- Change `crossValidate()` in `src/god/consistency-checker.ts` to audit-only (log divergence, don't override God)
- Update tests:
  - `src/__tests__/god/consistency-checker.test.ts` — update all `source: 'local'` expectations to `source: 'god'`
  - `src/__tests__/ui/god-convergence-evaluating.test.ts` — remove ConvergenceService fallback tests
  - `src/__tests__/ui/c3-integration.test.ts` — remove convergence service references
  - `src/__tests__/god/bug-14-15-16-regression.test.ts` — update convergence expectations
  - `src/__tests__/god/bug-17-18-regression.test.ts` — update convergence expectations

### Step 6: Delete context-manager.ts
- **Relocate `RoundRecord` type** before deleting: `context-manager.ts` exports `RoundRecord` which is imported by `session-runner-state.ts`, `App.tsx`, and referenced in `phase-transition.ts`. Move `RoundRecord` type definition to `src/types/session.ts` (or create if it doesn't exist). Update all import paths.
- Delete `src/session/context-manager.ts` and `src/__tests__/session/context-manager.test.ts`
- Remove `contextManagerRef` from `src/ui/components/App.tsx`
- Remove all `withGodFallbackSync` call sites — prompt generation failures now go through `withRetry` → pause
- Update imports in:
  - `src/ui/session-runner-state.ts` — import `RoundRecord` from new location
  - `src/ui/components/App.tsx` — import `RoundRecord` from new location
  - `src/god/phase-transition.ts` — update `RoundRecord` reference
- Update tests:
  - `src/__tests__/god/god-prompt-integration.test.ts` — remove ContextManager fallback tests
- Depends on: Step 2

### Step 7: Delete GodAutoDecision + escape-window + GodDecisionBanner
- Delete `GodAutoDecisionSchema` and `GodAutoDecision` type from `src/types/god-schemas.ts`
- Remove `GodAutoDecision` reference from `src/types/god-envelope.ts`
- Delete `src/ui/escape-window.ts` and `src/__tests__/ui/escape-window.test.ts`
- Delete `src/ui/god-decision-banner.ts` (pure state logic for auto-decision banner)
- Delete `src/ui/components/GodDecisionBanner.tsx` (React component for auto-decision banner)
- Remove `godDecision` state and GodDecisionBanner rendering from `src/ui/components/App.tsx`
- Update tests:
  - Delete `src/__tests__/ui/god-decision-banner.test.ts`
  - `src/__tests__/parsers/god-json-extractor.test.ts` — remove GodAutoDecision parsing tests

### Step 8: Delete resolveEffectiveType from god-prompt-generator.ts
- Remove `resolveEffectiveType()` function and keyword matching logic from `src/god/god-prompt-generator.ts`
- Prompt generator uses God-specified mode or falls through to phase type directly
- Update tests:
  - `src/__tests__/god/god-prompt-generator.test.ts` — remove resolveEffectiveType tests, update strategy selection tests

### Step 9: God prompt enhancements
- Add choice-handling instruction to `src/god/god-decision-service.ts` system prompt
- Add mode-specification guidance to God prompt (God explicitly specifies worker mode in instruction)
- Update tests:
  - `src/__tests__/god/god-decision-service.test.ts` — add tests for new prompt sections
- Depends on: Step 4, Step 8

### Step 10: Workflow machine + App.tsx cleanup
- Rename `MANUAL_FALLBACK` state → `PAUSED` in `src/engine/workflow-machine.ts`
- Rename `MANUAL_FALLBACK_REQUIRED` event → `PAUSE_REQUIRED` in workflow-machine.ts and all App.tsx send() sites
- Simplify PAUSED transitions: only `USER_RETRY` → resume, `USER_QUIT` → DONE
- Remove `TASK_INIT_SKIP` event and transition
- Update `src/ui/reclassify-overlay.ts` — rename `MANUAL_FALLBACK` references to `PAUSED`
- Update `src/ui/session-runner-state.ts` — rename `MANUAL_FALLBACK` reference (line 191) to `PAUSED`
- Final cleanup of `src/ui/components/App.tsx` — remove all remaining deleted module refs/imports
- Simplify StatusBar (remove L2/L3/L4 degradation indicators)
- Update tests:
  - `src/__tests__/engine/workflow-machine.test.ts` — rename MANUAL_FALLBACK → PAUSED
  - `src/__tests__/engine/workflow-machine-d1-refactor.test.ts` — same rename
  - `src/__tests__/engine/workflow-machine-bugfix-regression.test.ts` — same rename
  - `src/__tests__/engine/workflow-machine-e2-clarifying.test.ts` — same rename
  - `src/__tests__/engine/bug-11-12-regression.test.ts` — update fallback references
  - `src/__tests__/engine/bug-19-20-21-regression.test.ts` — update fallback references
  - `src/__tests__/engine/bug-22-23-regression.test.ts` — update fallback references
  - `src/__tests__/ui/reclassify-overlay.test.ts` — rename MANUAL_FALLBACK → PAUSED
  - `src/__tests__/ui/session-runner-state.test.ts` — rename MANUAL_FALLBACK → PAUSED
  - `src/__tests__/ui/c3-integration.test.ts` — rename MANUAL_FALLBACK → PAUSED
  - `src/__tests__/god/bug-14-15-16-regression.test.ts` — rename MANUAL_FALLBACK → PAUSED
  - `src/__tests__/god/bug-17-18-regression.test.ts` — rename MANUAL_FALLBACK → PAUSED
  - `src/__tests__/god/audit-bug-regressions.test.ts` — rename MANUAL_FALLBACK → PAUSED
  - `src/__tests__/integration/god-workflow.test.ts` — rename MANUAL_FALLBACK → PAUSED
  - `src/__tests__/ui/StatusBar.test.tsx` — remove degradation indicator tests
  - `src/__tests__/ui/status-bar.test.tsx` — remove degradation indicator tests
- Depends on: Steps 1-9

### Step 11: Full regression
- Run full vitest suite
- Verify all tests pass
- Depends on: Step 10

## 7. Guardrails That Survive

These are **not** LLM-availability fallbacks. They are decision-quality guards:

| Guardrail | Purpose | Location |
|---|---|---|
| `maxRounds` | Prevent infinite task loops | workflow-machine.ts |
| `consecutiveRouteToCoder` circuit breaker | Prevent God routing loops (3+) | workflow-machine.ts |
| `consistency-checker` (audit-only) | Log God vs heuristic divergence for debugging | consistency-checker.ts |
| `god-json-extractor` schema validation | Reject malformed God output | god-json-extractor.ts |
| `rule-engine` security rules | Block dangerous operations | rule-engine.ts |
| `hand-executor` action boundaries | AI proposes, code executes | hand-executor.ts |

## 8. Testing Strategy

### 8.1 Deleted Module Test Migration

For each deleted v1 module, its test cases become **acceptance criteria for God**:

- ChoiceDetector test cases → Integration tests verifying God correctly handles worker choice output
- ConvergenceService test cases → Integration tests verifying `evaluateConvergence()` handles all edge cases
- ContextManager → Not needed (god-prompt-generator already has full test coverage)

### 8.2 New Tests

| Test | Verifies |
|---|---|
| WatchdogService retry+backoff | 3 retries with exponential backoff, then pause |
| withRetry wrapper | Success on first/second/third try, pause after exhaustion |
| PAUSED state transitions | retry → resume, quit → DONE |
| God choice handling | God correctly routes worker proposals (integration test) |
| No fallback regression | God failure → pause (not silent degradation) |

## 9. Risk Mitigation

| Risk | Mitigation |
|---|---|
| God API downtime causes complete halt | By design — pausing is correct behavior. User retries when API recovers. |
| Prompt generation failure blocks task | withRetry covers transient failures. Persistent failure → pause → user aware. |
| God convergence judgment incorrect | maxRounds hard cap + circuit breaker still active. audit-only crossValidate logs divergence. |
| God mishandles worker choices | God prompt explicitly instructs choice handling. Integration tests verify. |
| Large deletion breaks something | Step-by-step migration, each step maintains passing tests. |

## 10. Success Metrics

After completion:
- **~3000+ lines deleted** (production + tests)
- **Zero v1 fallback paths** remaining
- **Single decision brain**: GodDecisionService
- **Single failure mode**: retry → pause (no silent degradation)
- **All existing tests pass** (minus deleted module tests)
- **App.tsx significantly simplified** (fewer refs, fewer branches, clearer flow)
