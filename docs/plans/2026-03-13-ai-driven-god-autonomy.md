# AI-Driven God Autonomy Refactor

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Duo from a human-gated system into a fully AI-driven system where God is the autonomous decision-maker and humans are observers who can intervene via Ctrl+C only.

**Architecture:** Remove all `request_human` and `request_user_input` decision paths. God always decides autonomously (accept or continue_with_instruction). Phase transitions remain explicit and God-driven via routing decisions with full phase context; `App.tsx` must not infer phase transitions from keywords. The `WAITING_USER` state becomes `GOD_DECIDING` (instant auto-execute) backed by two autonomous paths: God-first and a deterministic local fallback for transient L2/L3 failures. `MANUAL_FALLBACK` is reserved for cases where neither autonomous path can safely act (typically L4 degradation or a hard rule-engine block). Human Ctrl+C interrupt triggers a God-mediated clarification dialogue before resuming; `restart` means restarting the current attempt inside the same session, not creating a new session or resetting persisted round history.

**Tech Stack:** TypeScript, xstate v5, Zod, React/Ink, Vitest

---

## File Structure

### Files to Modify
- `src/types/god-schemas.ts` — Remove `request_human` and `request_user_input` from Zod enums
- `src/god/task-init.ts` — Adopt shared God call helper; remove dangling timeout kill behavior
- `src/god/auto-decision.ts` — Remove `request_human`; expand context; God always decides
- `src/god/god-router.ts` — Remove `request_user_input`; God self-resolves questions and disputes; inject phase context into prompts
- `src/god/god-convergence.ts` — Adopt shared God call helper; keep autonomous convergence evaluation aligned with fallback semantics
- `src/god/god-prompt-generator.ts` — Add phase context to `GodDecisionContext` and decision prompts; add conflict detection between phase type and instruction
- `src/engine/workflow-machine.ts` — Rename `WAITING_USER` → `GOD_DECIDING`; add `MANUAL_FALLBACK` state; track consecutive `ROUTE_TO_CODER` loops with a real circuit breaker
- `src/ui/god-decision-banner.ts` — Remove escape window; instant execution
- `src/ui/components/App.tsx` — Rewrite `GOD_DECIDING` effect (instant auto-execute, no banner); keep local autonomous fallback in-process; rewrite interrupt handler (God-mediated clarification); clear `unresolvedIssues` properly; pass phase context to God routing
- `src/ui/session-runner-state.ts` — Update `resolveUserDecision` for new interrupt flow; update `mapRestoreEvent` for renamed states

### Files to Create
- `src/god/god-call.ts` — Shared stateless God adapter call helper with timeout cleanup
- `src/god/interrupt-clarifier.ts` — God-mediated multi-turn clarification dialogue after Ctrl+C interrupt

### Test Files to Modify
- `src/__tests__/god/auto-decision.test.ts`
- `src/__tests__/god/god-convergence.test.ts`
- `src/__tests__/god/god-router.test.ts`
- `src/__tests__/god/god-prompt-generator.test.ts`
- `src/__tests__/god/task-init.test.ts`
- `src/__tests__/engine/workflow-machine.test.ts`
- `src/__tests__/ui/god-decision-banner.test.ts`
- `src/__tests__/ui/god-auto-decision-waiting.test.ts`
- `src/__tests__/ui/session-runner-state.test.ts`
- `src/__tests__/ui/escape-window.test.ts`

### Test Files to Create
- `src/__tests__/god/god-call.test.ts`
- `src/__tests__/god/interrupt-clarifier.test.ts`

---

## Chunk 0: Shared God Call Helper & Timeout Bugfix

### Task 0: Extract shared God call helper and remove dangling timeout kills

**Files:**
- Create: `src/god/god-call.ts`
- Modify: `src/god/task-init.ts`, `src/god/auto-decision.ts`, `src/god/god-router.ts`, `src/god/god-convergence.ts`
- Test: `src/__tests__/god/god-call.test.ts`, `src/__tests__/god/task-init.test.ts`, `src/__tests__/god/auto-decision.test.ts`, `src/__tests__/god/god-router.test.ts`, `src/__tests__/god/god-convergence.test.ts`

- [ ] **Step 1: Write failing tests for the shared helper**

Create `src/__tests__/god/god-call.test.ts` with focused tests for the existing timeout bug:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { collectGodAdapterOutput } from '../../god/god-call.js';

function makeAdapter(chunks: string[]) {
  let killCount = 0;
  return {
    adapter: {
      name: 'codex',
      execute: async function* () {
        for (const chunk of chunks) {
          yield { type: 'text', content: chunk, timestamp: Date.now() };
        }
      },
      kill: async () => { killCount++; },
      isRunning: () => false,
    } as any,
    getKillCount: () => killCount,
  };
}

describe('collectGodAdapterOutput', () => {
  it('clears the timeout after a successful response', async () => {
    vi.useFakeTimers();
    const { adapter, getKillCount } = makeAdapter(['ok']);

    const promise = collectGodAdapterOutput({
      adapter,
      prompt: 'test',
      systemPrompt: 'system',
      timeoutMs: 30_000,
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(getKillCount()).toBe(0);
    vi.useRealTimers();
  });

  it('embeds the system prompt for non-Claude adapters', async () => {
    const { adapter } = makeAdapter(['ok']);
    await expect(
      collectGodAdapterOutput({
        adapter,
        prompt: 'user prompt',
        systemPrompt: 'system prompt',
        timeoutMs: 30_000,
      }),
    ).resolves.toBe('ok');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/god/god-call.test.ts --reporter=verbose`
Expected: FAIL — helper does not exist yet

- [ ] **Step 3: Implement `src/god/god-call.ts`**

Create a single shared helper used by every stateless God call site:

```typescript
import type { CLIAdapter } from '../types/adapter.js';

export interface GodCallOptions {
  adapter: CLIAdapter;
  prompt: string;
  systemPrompt: string;
  projectDir?: string;
  timeoutMs: number;
}

export async function collectGodAdapterOutput(opts: GodCallOptions): Promise<string> {
  const { adapter, prompt, systemPrompt, projectDir, timeoutMs } = opts;

  if ('hasActiveSession' in adapter && (adapter as any).hasActiveSession?.()) {
    (adapter as any).lastSessionId = null;
  }

  const supportsSystemPrompt = adapter.name === 'claude-code';
  const effectivePrompt = supportsSystemPrompt
    ? prompt
    : `${systemPrompt}\n\n---\n\n${prompt}`;

  const chunks: string[] = [];
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      adapter.kill().catch(() => {});
      reject(new Error(`God adapter timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const collectPromise = (async () => {
    for await (const chunk of adapter.execute(effectivePrompt, {
      cwd: projectDir ?? process.cwd(),
      systemPrompt: supportsSystemPrompt ? systemPrompt : undefined,
      disableTools: true,
    })) {
      if (chunk.type === 'text' || chunk.type === 'code' || chunk.type === 'error') {
        chunks.push(chunk.content);
      }
    }
    return chunks.join('');
  })();

  try {
    return await Promise.race([collectPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
```

- [ ] **Step 4: Replace duplicated helper logic at all God call sites**

In these files, remove the local `collectAdapterOutput()` implementations and import `collectGodAdapterOutput()` instead:

- `src/god/task-init.ts`
- `src/god/auto-decision.ts`
- `src/god/god-router.ts`
- `src/god/god-convergence.ts`

Each file should keep its own timeout constant, but delegate execution to the shared helper.

- [ ] **Step 5: Run targeted regression tests**

Run: `npx vitest run src/__tests__/god/god-call.test.ts src/__tests__/god/task-init.test.ts src/__tests__/god/auto-decision.test.ts src/__tests__/god/god-router.test.ts src/__tests__/god/god-convergence.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/god/god-call.ts src/god/task-init.ts src/god/auto-decision.ts src/god/god-router.ts src/god/god-convergence.ts src/__tests__/god/god-call.test.ts
git commit -m "fix: share God call helper and clear timeout kill race"
```

---

## Chunk 1: Schema & Auto-Decision — Remove `request_human`

### Task 1: Remove `request_human` from GodAutoDecision schema

**Files:**
- Modify: `src/types/god-schemas.ts:67-71`
- Test: `src/__tests__/god/auto-decision.test.ts`

- [ ] **Step 1: Write failing test — schema rejects `request_human`**

In `src/__tests__/god/auto-decision.test.ts`, add:

```typescript
import { GodAutoDecisionSchema } from '../../types/god-schemas.js';

describe('GodAutoDecisionSchema (AI-driven)', () => {
  it('rejects request_human action', () => {
    const result = GodAutoDecisionSchema.safeParse({
      action: 'request_human',
      reasoning: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('accepts accept action', () => {
    const result = GodAutoDecisionSchema.safeParse({
      action: 'accept',
      reasoning: 'task complete',
    });
    expect(result.success).toBe(true);
  });

  it('accepts continue_with_instruction action', () => {
    const result = GodAutoDecisionSchema.safeParse({
      action: 'continue_with_instruction',
      reasoning: 'needs more work',
      instruction: 'fix the bug',
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/god/auto-decision.test.ts --reporter=verbose`
Expected: FAIL — `request_human` is currently accepted by schema

- [ ] **Step 3: Update schema — remove `request_human`**

In `src/types/god-schemas.ts`, change line 68:

```typescript
// Before:
action: z.enum(['accept', 'continue_with_instruction', 'request_human']),

// After:
action: z.enum(['accept', 'continue_with_instruction']),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/god/auto-decision.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types/god-schemas.ts src/__tests__/god/auto-decision.test.ts
git commit -m "refactor: remove request_human from GodAutoDecision schema (AI-driven)"
```

---

### Task 2: Remove `request_user_input` from routing schemas

**Files:**
- Modify: `src/types/god-schemas.ts:32,39`
- Test: `src/__tests__/god/god-router.test.ts`

- [ ] **Step 1: Write failing tests — schemas reject `request_user_input`**

In `src/__tests__/god/god-router.test.ts`, add:

```typescript
import { GodPostCoderDecisionSchema, GodPostReviewerDecisionSchema } from '../../types/god-schemas.js';

describe('Routing schemas (AI-driven)', () => {
  it('GodPostCoderDecision rejects request_user_input', () => {
    const result = GodPostCoderDecisionSchema.safeParse({
      action: 'request_user_input',
      reasoning: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('GodPostReviewerDecision rejects request_user_input', () => {
    const result = GodPostReviewerDecisionSchema.safeParse({
      action: 'request_user_input',
      reasoning: 'test',
      confidenceScore: 0.5,
      progressTrend: 'stagnant',
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/god/god-router.test.ts --reporter=verbose`
Expected: FAIL — `request_user_input` currently accepted

- [ ] **Step 3: Update schemas — remove `request_user_input`**

In `src/types/god-schemas.ts`:

```typescript
// Line 32 — GodPostCoderDecisionSchema:
// Before:
action: z.enum(['continue_to_review', 'retry_coder', 'request_user_input']),
// After:
action: z.enum(['continue_to_review', 'retry_coder']),

// Line 39 — GodPostReviewerDecisionSchema:
// Before:
action: z.enum(['route_to_coder', 'converged', 'phase_transition', 'loop_detected', 'request_user_input']),
// After:
action: z.enum(['route_to_coder', 'converged', 'phase_transition', 'loop_detected']),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/god/god-router.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types/god-schemas.ts src/__tests__/god/god-router.test.ts
git commit -m "refactor: remove request_user_input from routing schemas (AI-driven)"
```

---

### Task 3: Update auto-decision — God always decides, never defers

**Files:**
- Modify: `src/god/auto-decision.ts`
- Test: `src/__tests__/god/auto-decision.test.ts`

- [ ] **Step 1: Write failing tests — expanded context and deterministic local fallback**

In `src/__tests__/god/auto-decision.test.ts`, add/update:

```typescript
describe('AutoDecisionContext (AI-driven)', () => {
  it('includes lastCoderOutput and lastReviewerOutput in context', () => {
    // Verify the interface accepts these fields
    const ctx: AutoDecisionContext = {
      round: 1,
      maxRounds: 10,
      taskGoal: 'implement feature',
      sessionDir: '/tmp/test',
      seq: 1,
      waitingReason: 'converged',
      lastCoderOutput: 'I wrote the code',
      lastReviewerOutput: '[APPROVED]',
    };
    expect(ctx.lastCoderOutput).toBe('I wrote the code');
    expect(ctx.lastReviewerOutput).toBe('[APPROVED]');
  });

  it('includes phase context fields', () => {
    const ctx: AutoDecisionContext = {
      round: 1,
      maxRounds: 10,
      taskGoal: 'compound task',
      sessionDir: '/tmp/test',
      seq: 1,
      waitingReason: 'converged',
      currentPhaseId: 'phase-2',
      currentPhaseType: 'code',
      phases: [
        { id: 'phase-1', name: 'Explore', type: 'explore', description: 'explore' },
        { id: 'phase-2', name: 'Code', type: 'code', description: 'code' },
      ],
    };
    expect(ctx.currentPhaseId).toBe('phase-2');
    expect(ctx.phases).toHaveLength(2);
  });
});

describe('makeLocalAutoDecision', () => {
  it('accepts when reviewer already approved and there are no unresolved issues', () => {
    const result = makeLocalAutoDecision({
      round: 1,
      maxRounds: 10,
      taskGoal: 'implement feature',
      sessionDir: '/tmp/test',
      seq: 1,
      waitingReason: 'converged',
      lastReviewerOutput: '[APPROVED]',
      unresolvedIssues: [],
    }, () => ({ blocked: false, results: [] }));
    expect(result.decision.action).toBe('accept');
  });

  it('continues with instruction when unresolved issues remain', () => {
    const result = makeLocalAutoDecision({
      round: 2,
      maxRounds: 10,
      taskGoal: 'implement feature',
      sessionDir: '/tmp/test',
      seq: 1,
      waitingReason: 'loop_detected',
      unresolvedIssues: ['Fix failing login validation'],
    }, () => ({ blocked: false, results: [] }));
    expect(result.decision.action).toBe('continue_with_instruction');
    expect(result.decision.instruction).toContain('Fix failing login validation');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/god/auto-decision.test.ts --reporter=verbose`
Expected: FAIL — `lastCoderOutput` etc. not in `AutoDecisionContext` type and `makeLocalAutoDecision` does not exist

- [ ] **Step 3: Update `auto-decision.ts` — expand context, remove request_human, add local autonomous fallback**

```typescript
// ── Types ── (replace existing AutoDecisionContext)

export interface AutoDecisionContext {
  round: number;
  maxRounds: number;
  taskGoal: string;
  sessionDir: string;
  seq: number;
  waitingReason: string;
  projectDir?: string;
  // AI-driven: God needs full context to decide autonomously
  lastCoderOutput?: string;
  lastReviewerOutput?: string;
  currentPhaseId?: string;
  currentPhaseType?: string;
  phases?: { id: string; name: string; type: string; description: string }[];
  convergenceLog?: { round: number; classification: string; blockingIssueCount: number }[];
  unresolvedIssues?: string[];
}

// ── Deterministic local fallback — never request_human ──

function buildLocalAutoDecisionDecision(context: AutoDecisionContext): GodAutoDecision {
  if (
    context.lastReviewerOutput?.includes('[APPROVED]') &&
    (context.unresolvedIssues?.length ?? 0) === 0
  ) {
    return {
      action: 'accept',
      reasoning: 'Local fallback: reviewer approved and no unresolved issues remain.',
    };
  }

  const instruction = context.unresolvedIssues && context.unresolvedIssues.length > 0
    ? `Address the remaining issues: ${context.unresolvedIssues.join('; ')}`
    : context.currentPhaseId
      ? `Continue working on phase ${context.currentPhaseId} and make the next concrete improvement.`
      : 'Review the latest coder and reviewer outputs, then continue the task.';

  return {
    action: 'continue_with_instruction',
    reasoning: 'Local fallback: God unavailable for this turn, continuing autonomously.',
    instruction,
  };
}

export function makeLocalAutoDecision(
  context: AutoDecisionContext,
  ruleEngine: (action: ActionContext) => RuleEngineResult,
): AutoDecisionResult {
  const decision = buildLocalAutoDecisionDecision(context);
  const effectiveCwd = context.projectDir ?? process.cwd();

  const ruleCheck = decision.action === 'continue_with_instruction' && decision.instruction
    ? ruleEngine({
        type: 'command_exec',
        command: decision.instruction,
        cwd: effectiveCwd,
        godApproved: true,
      })
    : { blocked: false, results: [] };

  return {
    decision,
    ruleCheck,
    blocked: ruleCheck.blocked,
    reasoning: decision.reasoning,
  };
}

// ── Build prompt — with full context ──

function buildAutoDecisionPrompt(context: AutoDecisionContext): string {
  const sections: string[] = [
    `## Auto Decision`,
    ``,
    `Task: ${context.taskGoal}`,
    `Round: ${context.round}/${context.maxRounds}`,
    `Waiting reason: ${context.waitingReason}`,
  ];

  // Phase context
  if (context.currentPhaseId && context.phases) {
    const phaseList = context.phases.map(p =>
      `${p.id === context.currentPhaseId ? '→ ' : '  '}${p.id} (${p.type}): ${p.description}`
    ).join('\n');
    sections.push(`\nCurrent Phase: ${context.currentPhaseId} (${context.currentPhaseType ?? 'unknown'})`);
    sections.push(`Phases:\n${phaseList}`);
  }

  // Coder/Reviewer output summaries (truncated)
  if (context.lastCoderOutput) {
    const summary = context.lastCoderOutput.length > 1500
      ? context.lastCoderOutput.slice(0, 1500) + '...'
      : context.lastCoderOutput;
    sections.push(`\n## Last Coder Output (summary)\n${summary}`);
  }

  if (context.lastReviewerOutput) {
    const summary = context.lastReviewerOutput.length > 1500
      ? context.lastReviewerOutput.slice(0, 1500) + '...'
      : context.lastReviewerOutput;
    sections.push(`\n## Last Reviewer Output (summary)\n${summary}`);
  }

  // Convergence log
  if (context.convergenceLog && context.convergenceLog.length > 0) {
    const log = context.convergenceLog.map(e =>
      `Round ${e.round}: ${e.classification}, blocking=${e.blockingIssueCount}`
    ).join('\n');
    sections.push(`\n## Convergence History\n${log}`);
  }

  sections.push(``);
  sections.push(`You are the autonomous God orchestrator. You MUST decide — never defer to humans.`);
  sections.push(`Decide the next action. Output a JSON code block:`);
  sections.push('```json');
  sections.push(`{`);
  sections.push(`  "action": "accept" | "continue_with_instruction",`);
  sections.push(`  "reasoning": "...",`);
  sections.push(`  "instruction": "..."  // required if action is continue_with_instruction`);
  sections.push(`}`);
  sections.push('```');

  return sections.join('\n');
}

const SYSTEM_PROMPT = `You are the God orchestrator — the autonomous decision-maker for this AI coding system.
You MUST always make a decision. You have two options:
- "accept": The task is complete and the output is satisfactory.
- "continue_with_instruction": More work is needed. Provide a clear instruction for the next iteration.

You are NEVER allowed to defer to a human. You are the sole decision-maker.
If a Coder asks a question or proposes options, YOU choose the best option based on the task goal.
If there is a disagreement between Coder and Reviewer, YOU arbitrate and decide the direction.

For compound tasks with phases, evaluate whether the current phase goal is met.
If met, set instruction to advance to the next phase (e.g. "Phase explore complete. Begin implementation.").
Output a JSON code block with your decision.`;

// In makeAutoDecision(), if extraction fails, use makeLocalAutoDecision(context, ruleEngine)
// instead of a static placeholder decision.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/god/auto-decision.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/god/auto-decision.ts src/__tests__/god/auto-decision.test.ts
git commit -m "refactor: auto-decision always decides autonomously with deterministic local fallback"
```

---

### Task 4: Update god-router — remove `request_user_input`, God self-resolves

**Files:**
- Modify: `src/god/god-router.ts:60-88,258-297`
- Test: `src/__tests__/god/god-router.test.ts`

- [ ] **Step 1: Write failing tests — no NEEDS_USER_INPUT event, God resolves questions**

```typescript
describe('godActionToEvent (AI-driven)', () => {
  it('does not map request_user_input (removed)', () => {
    // request_user_input no longer exists in the action enum
    // This test verifies the mapping function only handles valid actions
    expect(() => godActionToEvent({ action: 'request_user_input' as any, reasoning: '' }))
      .toThrow('Unknown God action');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/god/god-router.test.ts --reporter=verbose`
Expected: FAIL — currently `request_user_input` maps to `NEEDS_USER_INPUT`

- [ ] **Step 3: Update `god-router.ts`**

Remove the `request_user_input` case from `godActionToEvent()`:

```typescript
export function godActionToEvent(
  decision: GodPostCoderDecision | GodPostReviewerDecision,
): WorkflowEvent {
  switch (decision.action) {
    case 'continue_to_review':
      return { type: 'ROUTE_TO_REVIEW' };
    case 'retry_coder':
      return { type: 'ROUTE_TO_CODER' };
    case 'route_to_coder':
      return { type: 'ROUTE_TO_CODER' };
    case 'converged':
      return { type: 'CONVERGED' };
    case 'phase_transition': {
      const d = decision as GodPostReviewerDecision;
      return {
        type: 'PHASE_TRANSITION',
        nextPhaseId: d.nextPhaseId ?? 'next',
        summary: d.reasoning ?? '',
      };
    }
    case 'loop_detected':
      return { type: 'LOOP_DETECTED' };
    default:
      throw new Error(`Unknown God action: ${(decision as Record<string, unknown>).action}`);
  }
}
```

Update `buildRoutingSystemPrompt('POST_CODER')` — remove `request_user_input` option, add autonomous instruction:

```typescript
function buildRoutingSystemPrompt(decisionPoint: 'POST_CODER' | 'POST_REVIEWER'): string {
  if (decisionPoint === 'POST_CODER') {
    return `You are the God orchestrator. Analyze the Coder's output and decide the next routing action.
You are fully autonomous — never defer to humans.

Output a JSON code block with your decision:
\`\`\`json
{
  "action": "continue_to_review" | "retry_coder",
  "reasoning": "...",
  "retryHint": "..." // only if action is retry_coder
}
\`\`\`

Actions:
- continue_to_review: Default. Coder produced substantive output, send to Reviewer.
- retry_coder: Coder crashed or produced empty/garbage output.

If the Coder asks a question or proposes options, YOU decide the best option and route to review.
Do NOT pause for human input.`;
  }

  return `You are the God orchestrator. Analyze the Reviewer's output and decide the next routing action.
You are fully autonomous — never defer to humans.

Output a JSON code block with your decision:
\`\`\`json
{
  "action": "route_to_coder" | "converged" | "phase_transition" | "loop_detected",
  "reasoning": "...",
  "unresolvedIssues": ["..."],  // required if action is route_to_coder
  "confidenceScore": 0.0-1.0,
  "progressTrend": "improving" | "stagnant" | "declining",
  "nextPhaseId": "..."  // required if action is phase_transition
}
\`\`\`

Actions:
- route_to_coder: Reviewer found blocking issues. MUST include non-empty unresolvedIssues.
- converged: Reviewer approved and all termination criteria are met.
- phase_transition: Current phase criteria met, transition to next phase. MUST specify nextPhaseId.
- loop_detected: Same issues recurring without progress.

If Coder and Reviewer disagree, YOU arbitrate. Never defer to humans.
For compound tasks, actively evaluate whether the current phase is complete and trigger phase_transition when appropriate.`;
}
```

Update default fallback for POST_CODER:

```typescript
const DEFAULT_POST_CODER: GodPostCoderDecision = {
  action: 'continue_to_review',
  reasoning: 'Fallback: defaulting to review (God extraction failed)',
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/god/god-router.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/god/god-router.ts src/__tests__/god/god-router.test.ts
git commit -m "refactor: god-router removes request_user_input, God self-resolves all decisions"
```

---

## Chunk 2: Phase Context in God Decisions & Prompt Conflict Resolution

### Task 5: Add phase context to God decision prompts

**Files:**
- Modify: `src/god/god-prompt-generator.ts:32-41,247-274`
- Test: `src/__tests__/god/god-prompt-generator.test.ts`

- [ ] **Step 1: Write failing test — GodDecisionContext includes phase fields**

```typescript
describe('generateGodDecisionPrompt (AI-driven)', () => {
  it('includes phase context in POST_REVIEWER prompt', () => {
    const prompt = generateGodDecisionPrompt({
      decisionPoint: 'POST_REVIEWER',
      round: 2,
      maxRounds: 10,
      taskGoal: 'implement feature',
      lastReviewerOutput: '[APPROVED]',
      currentPhaseId: 'phase-1',
      currentPhaseType: 'explore',
      phases: [
        { id: 'phase-1', name: 'Explore', type: 'explore', description: 'explore the codebase' },
        { id: 'phase-2', name: 'Code', type: 'code', description: 'implement changes' },
      ],
    });
    expect(prompt).toContain('phase-1');
    expect(prompt).toContain('phase-2');
    expect(prompt).toContain('Explore');
    expect(prompt).toContain('→'); // current phase marker
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/god/god-prompt-generator.test.ts --reporter=verbose`
Expected: FAIL — `currentPhaseId` not in `GodDecisionContext`

- [ ] **Step 3: Update `god-prompt-generator.ts`**

Expand `GodDecisionContext`:

```typescript
export interface GodDecisionContext {
  decisionPoint: 'POST_CODER' | 'POST_REVIEWER' | 'CONVERGENCE';
  round: number;
  maxRounds: number;
  taskGoal: string;
  lastCoderOutput?: string;
  lastReviewerOutput?: string;
  unresolvedIssues?: string[];
  convergenceLog?: ConvergenceLogEntry[];
  // AI-driven: phase context for compound tasks
  currentPhaseId?: string;
  currentPhaseType?: string;
  phases?: { id: string; name: string; type: string; description: string }[];
}
```

Update `generateGodDecisionPrompt()` to add phase section:

```typescript
export function generateGodDecisionPrompt(ctx: GodDecisionContext): string {
  const sections: string[] = [];

  sections.push(`## Decision Point: ${ctx.decisionPoint}`);
  sections.push(`## Task\n${ctx.taskGoal}`);
  sections.push(`## Round Info\nRound ${ctx.round} of ${ctx.maxRounds}`);

  // Phase context for compound tasks
  if (ctx.phases && ctx.phases.length > 0 && ctx.currentPhaseId) {
    const phaseList = ctx.phases.map(p =>
      `${p.id === ctx.currentPhaseId ? '→ ' : '  '}${p.id} (${p.type}): ${p.name} — ${p.description}`
    ).join('\n');
    sections.push(`## Compound Task Phases\nCurrent: ${ctx.currentPhaseId} (${ctx.currentPhaseType ?? 'unknown'})\n\n${phaseList}`);
  }

  if (ctx.lastCoderOutput) {
    sections.push(`## Last Coder Output\n${ctx.lastCoderOutput}`);
  }

  if (ctx.lastReviewerOutput) {
    sections.push(`## Last Reviewer Output\n${ctx.lastReviewerOutput}`);
  }

  if (ctx.unresolvedIssues && ctx.unresolvedIssues.length > 0) {
    sections.push(`## Unresolved Issues\n${ctx.unresolvedIssues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}`);
  }

  if (ctx.convergenceLog && ctx.convergenceLog.length > 0) {
    const log = ctx.convergenceLog
      .map(e => `Round ${e.round}: ${e.blockingIssueCount} blocking issues (${e.classification})`)
      .join('\n');
    sections.push(`## Convergence Log\n${log}`);
  }

  return enforceMaxLength(sections.join('\n\n'));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/god/god-prompt-generator.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/god/god-prompt-generator.ts src/__tests__/god/god-prompt-generator.test.ts
git commit -m "feat: add phase context to God decision prompts for compound tasks"
```

---

### Task 6: Phase-aware Coder prompt — resolve instruction/phase conflicts

**Files:**
- Modify: `src/god/god-prompt-generator.ts:106-183`
- Test: `src/__tests__/god/god-prompt-generator.test.ts`

- [ ] **Step 1: Write failing test — instruction overrides phase type when conflicting**

```typescript
describe('generateCoderPrompt (phase conflict resolution)', () => {
  it('uses code instructions when God instruction implies implementation in explore phase', () => {
    const prompt = generateCoderPrompt({
      taskType: 'compound',
      round: 3,
      maxRounds: 10,
      taskGoal: 'build feature',
      phaseId: 'phase-1',
      phaseType: 'explore',
      instruction: '同意，请开始实现',
    });
    // Should NOT contain "Do NOT modify any files"
    expect(prompt).not.toContain('Do NOT modify any files');
    // Should contain code instructions
    expect(prompt).toContain('Implement');
  });

  it('keeps explore instructions when God instruction is non-conflicting', () => {
    const prompt = generateCoderPrompt({
      taskType: 'compound',
      round: 1,
      maxRounds: 10,
      taskGoal: 'analyze codebase',
      phaseId: 'phase-1',
      phaseType: 'explore',
      instruction: '请更深入地分析数据库模块',
    });
    expect(prompt).toContain('Do NOT modify any files');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/god/god-prompt-generator.test.ts --reporter=verbose`
Expected: FAIL — currently no conflict detection

- [ ] **Step 3: Add conflict detection to `generateCoderPrompt`**

In `src/god/god-prompt-generator.ts`, add a helper and modify `generateCoderPrompt`:

```typescript
// ── Instruction/Phase conflict detection ──

const IMPLEMENTATION_KEYWORDS = /实现|开发|编写|修改|implement|build|write|code|create|fix|develop|modify/i;

function resolveEffectiveType(
  phaseType: string | undefined,
  instruction: string | undefined,
): string {
  if (!instruction || !phaseType) return phaseType ?? 'code';

  // If God instruction implies implementation but phase is read-only, upgrade to code
  if ((phaseType === 'explore' || phaseType === 'discuss') && IMPLEMENTATION_KEYWORDS.test(instruction)) {
    return 'code';
  }
  return phaseType;
}
```

Then in `generateCoderPrompt`, replace the effectiveType calculation:

```typescript
export function generateCoderPrompt(ctx: PromptContext, audit?: AuditOptions): string {
  // For compound type: resolve conflicts between phase type and God instruction
  const rawPhaseType = ctx.taskType === 'compound' && ctx.phaseType
    ? ctx.phaseType
    : ctx.taskType;
  const effectiveType = ctx.taskType === 'compound'
    ? resolveEffectiveType(rawPhaseType, ctx.instruction)
    : rawPhaseType;

  // ... rest of function unchanged, using effectiveType
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/god/god-prompt-generator.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/god/god-prompt-generator.ts src/__tests__/god/god-prompt-generator.test.ts
git commit -m "feat: resolve phase/instruction conflicts — God instruction can upgrade phase type"
```

---

## Chunk 3: State Machine Refactor — `GOD_DECIDING` + Retry Circuit Breaker

### Task 7: Rename `WAITING_USER` → `GOD_DECIDING`, add `MANUAL_FALLBACK`

**Files:**
- Modify: `src/engine/workflow-machine.ts`
- Test: `src/__tests__/engine/workflow-machine.test.ts`

- [ ] **Step 1: Write failing tests for new state names**

```typescript
describe('workflow machine (AI-driven states)', () => {
  it('has GOD_DECIDING state instead of WAITING_USER', () => {
    const actor = createActor(workflowMachine, { input: { maxRounds: 5 } });
    actor.start();
    actor.send({ type: 'START_TASK', prompt: 'test' });
    actor.send({ type: 'TASK_INIT_COMPLETE' });
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'ROUTE_TO_REVIEW' });
    actor.send({ type: 'REVIEW_COMPLETE', output: '[APPROVED]' });
    actor.send({ type: 'CONVERGED' });
    expect(actor.getSnapshot().value).toBe('GOD_DECIDING');
  });

  it('has MANUAL_FALLBACK state reachable from GOD_DECIDING', () => {
    const actor = createActor(workflowMachine, { input: { maxRounds: 5 } });
    actor.start();
    actor.send({ type: 'START_TASK', prompt: 'test' });
    actor.send({ type: 'TASK_INIT_COMPLETE' });
    actor.send({ type: 'CODE_COMPLETE', output: 'done' });
    actor.send({ type: 'ROUTE_TO_REVIEW' });
    actor.send({ type: 'REVIEW_COMPLETE', output: '[APPROVED]' });
    actor.send({ type: 'CONVERGED' });
    // GOD_DECIDING transitions to MANUAL_FALLBACK via MANUAL_FALLBACK_REQUIRED event
    actor.send({ type: 'MANUAL_FALLBACK_REQUIRED' });
    expect(actor.getSnapshot().value).toBe('MANUAL_FALLBACK');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/engine/workflow-machine.test.ts --reporter=verbose`
Expected: FAIL — no `GOD_DECIDING` state

- [ ] **Step 3: Refactor workflow-machine.ts**

Key changes:
1. Rename `WAITING_USER` → `GOD_DECIDING`
2. Add `MANUAL_FALLBACK` state
3. Add `MANUAL_FALLBACK_REQUIRED` event
4. Add `consecutiveRouteToCoder` to context
5. Add a retry circuit breaker that counts consecutive `ROUTE_TO_CODER` decisions without any progress signal

```typescript
// Add to event types:
type ManualFallbackRequiredEvent = { type: 'MANUAL_FALLBACK_REQUIRED' };

// Add to WorkflowContext:
interface WorkflowContext {
  // ... existing fields
  consecutiveRouteToCoder: number;
}

// In context factory, add:
consecutiveRouteToCoder: input?.consecutiveRouteToCoder ?? 0,

// Add guard:
retryLimitReachedOnRouteToCoder: ({ context }) => context.consecutiveRouteToCoder + 1 >= 3,

// Rename WAITING_USER → GOD_DECIDING, keep same transitions for USER_CONFIRM:
GOD_DECIDING: {
  on: {
    CLEAR_PENDING_PHASE: {
      actions: assign({
        pendingPhaseId: () => null,
        pendingPhaseSummary: () => null,
      }),
    },
    MANUAL_FALLBACK_REQUIRED: {
      target: 'MANUAL_FALLBACK',
    },
    USER_CONFIRM: [
      // ... same transitions as before
    ],
  },
},

// New state:
MANUAL_FALLBACK: {
  on: {
    USER_CONFIRM: [
      // ... same transitions as GOD_DECIDING.USER_CONFIRM
    ],
  },
},

// Update both ROUTE_TO_CODER transitions to track loops:
ROUTE_TO_CODER: [
  {
    guard: 'retryLimitReachedOnRouteToCoder',
    target: 'GOD_DECIDING', // force God to re-evaluate after 3 retries
    actions: assign({
      consecutiveRouteToCoder: () => 0,
    }),
  },
  {
    guard: 'canContinueRounds',
    target: 'CODING',
    actions: assign({
      round: ({ context }) => context.round + 1,
      activeProcess: () => 'coder' as const,
      consecutiveRouteToCoder: ({ context }) => context.consecutiveRouteToCoder + 1,
    }),
  },
  {
    target: 'GOD_DECIDING',
  },
],

// All other states referencing WAITING_USER → update to GOD_DECIDING:
// CONVERGED → GOD_DECIDING
// NEEDS_USER_INPUT → GOD_DECIDING (keep for backward compat, will be unused)
// LOOP_DETECTED → GOD_DECIDING
// PHASE_TRANSITION → GOD_DECIDING
// ERROR RECOVERY → GOD_DECIDING
```

Also update all transitions from `ROUTING_POST_CODE` and `ROUTING_POST_REVIEW` that previously targeted `WAITING_USER` to target `GOD_DECIDING`.

Reset `consecutiveRouteToCoder` only when the loop has actually been broken by progress, not merely because Reviewer responded. Good reset points:

```typescript
// Reset to 0 on transitions that represent progress or a fresh decision boundary:
// - ROUTE_TO_REVIEW
// - ROUTE_TO_EVALUATE
// - CONVERGED / PHASE_TRANSITION / LOOP_DETECTED
// - TASK_INIT_COMPLETE
// - USER_CONFIRM continue/accept from GOD_DECIDING or MANUAL_FALLBACK
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/engine/workflow-machine.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Fix all other tests referencing `WAITING_USER`**

Run: `npx vitest run --reporter=verbose 2>&1 | head -100`

Search for `WAITING_USER` in all test files and update to `GOD_DECIDING` or `MANUAL_FALLBACK` as appropriate. Key files:
- `src/__tests__/ui/god-auto-decision-waiting.test.ts`
- `src/__tests__/ui/session-runner-state.test.ts`
- `src/__tests__/engine/workflow-machine-bugfix-regression.test.ts`
- `src/__tests__/engine/bug-19-20-21-regression.test.ts`
- `src/__tests__/ui/c3-integration.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/engine/workflow-machine.ts src/__tests__/engine/
git commit -m "refactor: WAITING_USER → GOD_DECIDING + MANUAL_FALLBACK, add retry circuit breaker"
```

---

## Chunk 4: App.tsx — Instant God Execution & Interrupt Clarification

### Task 8: Create interrupt clarifier — God-mediated clarification after Ctrl+C

**Files:**
- Create: `src/god/interrupt-clarifier.ts`
- Test: `src/__tests__/god/interrupt-clarifier.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { classifyInterruptIntent, type InterruptClassification } from '../../god/interrupt-clarifier.js';

describe('classifyInterruptIntent', () => {
  function makeAdapter(payload: InterruptClassification) {
    return {
      name: 'claude-code',
      execute: async function* () {
        yield {
          type: 'text',
          content: '```json\n' + JSON.stringify(payload) + '\n```',
          timestamp: Date.now(),
        };
      },
      kill: async () => {},
      isRunning: () => false,
    } as any;
  }

  it('classifies restart intent as a soft restart of the current attempt', async () => {
    const result = await classifyInterruptIntent(makeAdapter({
      intent: 'restart',
      instruction: 'Discard the current approach and restart the attempt with Zustand.',
      reasoning: 'The user wants to change approach completely.',
      needsClarification: false,
    }), {
      userInput: '重新开始，用 Zustand',
      taskGoal: 'build login feature',
      round: 2,
      sessionDir: '/tmp/test',
      seq: 1,
    });
    expect(result.intent).toBe('restart');
  });

  it('classifies redirect intent', async () => {
    const result = await classifyInterruptIntent(makeAdapter({
      intent: 'redirect',
      instruction: 'Keep current progress but switch the state layer to Zustand.',
      reasoning: 'The user is redirecting the implementation.',
      needsClarification: false,
    }), {
      userInput: '不要用 Redux，改用 Zustand',
      taskGoal: 'build state management',
      round: 2,
      sessionDir: '/tmp/test',
      seq: 1,
    });
    expect(result.intent).toBe('redirect');
  });

  it('classifies continue intent', async () => {
    const result = await classifyInterruptIntent(makeAdapter({
      intent: 'continue',
      instruction: 'Continue, but handle the failing test first.',
      reasoning: 'The user wants a small tactical adjustment.',
      needsClarification: false,
    }), {
      userInput: '继续，但是先处理错误',
      taskGoal: 'fix bugs',
      round: 2,
      sessionDir: '/tmp/test',
      seq: 1,
    });
    expect(result.intent).toBe('continue');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/god/interrupt-clarifier.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `interrupt-clarifier.ts`**

```typescript
/**
 * Interrupt Clarifier — God-mediated clarification after human Ctrl+C interrupt.
 *
 * When user interrupts and provides text, God analyzes the intent:
 * - restart: User wants to restart the current attempt with a different approach
 * - redirect: User wants to change direction → continue with new instruction
 * - continue: User wants to continue with minor adjustment → resume current role
 *
 * God can ask follow-up questions via multi-turn dialogue if intent is unclear.
 */

import type { CLIAdapter } from '../types/adapter.js';
import { appendAuditLog, type GodAuditEntry } from './god-audit.js';
import { collectGodAdapterOutput } from './god-call.js';

export interface InterruptClassification {
  intent: 'restart' | 'redirect' | 'continue';
  instruction: string;
  reasoning: string;
  /** If true, God needs more info — instruction contains a clarifying question */
  needsClarification: boolean;
}

export interface InterruptContext {
  userInput: string;
  taskGoal: string;
  round: number;
  currentPhaseId?: string;
  lastCoderOutput?: string;
  lastReviewerOutput?: string;
  sessionDir: string;
  seq: number;
  projectDir?: string;
}

const GOD_TIMEOUT_MS = 15_000;

/**
 * Classify the user's interrupt intent using God.
 * Returns an instruction for the system to execute.
 */
export async function classifyInterruptIntent(
  godAdapter: CLIAdapter,
  context: InterruptContext,
): Promise<InterruptClassification> {
  const prompt = buildInterruptPrompt(context);
  const systemPrompt = INTERRUPT_SYSTEM_PROMPT;

  try {
    const rawOutput = await collectGodAdapterOutput({
      adapter: godAdapter,
      prompt,
      systemPrompt,
      projectDir: context.projectDir,
      timeoutMs: GOD_TIMEOUT_MS,
    });
    const parsed = parseInterruptResponse(rawOutput);

    // Audit
    const entry: GodAuditEntry = {
      seq: context.seq,
      timestamp: new Date().toISOString(),
      round: context.round,
      decisionType: 'INTERRUPT_CLASSIFICATION',
      inputSummary: context.userInput.slice(0, 500),
      outputSummary: JSON.stringify(parsed).slice(0, 500),
      decision: parsed,
    };
    appendAuditLog(context.sessionDir, entry);

    return parsed;
  } catch {
    // Fallback: treat as redirect with user's raw input as instruction
    return {
      intent: 'redirect',
      instruction: context.userInput,
      reasoning: 'Fallback: God unavailable, using user input as redirect instruction',
      needsClarification: false,
    };
  }
}

function buildInterruptPrompt(ctx: InterruptContext): string {
  return [
    `## Interrupt Classification`,
    `The human observer has interrupted the AI coding session.`,
    ``,
    `**User says:** "${ctx.userInput}"`,
    `**Task:** ${ctx.taskGoal}`,
    `**Round:** ${ctx.round}`,
    ctx.currentPhaseId ? `**Phase:** ${ctx.currentPhaseId}` : '',
    ``,
    `Classify the user's intent and provide an instruction for the system.`,
    `Output a JSON code block:`,
    '```json',
    `{`,
    `  "intent": "restart" | "redirect" | "continue",`,
    `  "instruction": "clear instruction for the system",`,
    `  "reasoning": "why this classification",`,
    `  "needsClarification": false`,
    `}`,
    '```',
  ].filter(Boolean).join('\n');
}

const INTERRUPT_SYSTEM_PROMPT = `You are the God orchestrator classifying a human observer's interrupt.
The human rarely interrupts — treat their input as important directional guidance.

- "restart": User wants to restart the current attempt with a different approach
- "redirect": User wants to change direction but keep current progress
- "continue": User wants to continue with a minor tweak or additional instruction

Always provide a clear, actionable instruction the system can execute.
If the user's message is ambiguous, set needsClarification=true and put a clarifying question in instruction.`;

function parseInterruptResponse(raw: string): InterruptClassification {
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      return {
        intent: parsed.intent ?? 'redirect',
        instruction: parsed.instruction ?? '',
        reasoning: parsed.reasoning ?? '',
        needsClarification: parsed.needsClarification ?? false,
      };
    } catch { /* fall through */ }
  }

  return {
    intent: 'redirect',
    instruction: raw.trim(),
    reasoning: 'Could not parse God response, using raw output',
    needsClarification: false,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/god/interrupt-clarifier.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/god/interrupt-clarifier.ts src/__tests__/god/interrupt-clarifier.test.ts
git commit -m "feat: interrupt-clarifier — God classifies human interrupt intent"
```

---

### Task 9: Update god-decision-banner — instant execution, no escape window

**Files:**
- Modify: `src/ui/god-decision-banner.ts`
- Test: `src/__tests__/ui/god-decision-banner.test.ts`

- [ ] **Step 1: Write failing test — no countdown, instant execution**

```typescript
describe('GodDecisionBanner (AI-driven: instant execution)', () => {
  it('ESCAPE_WINDOW_MS is 0', () => {
    expect(ESCAPE_WINDOW_MS).toBe(0);
  });

  it('createGodDecisionBannerState sets executed immediately', () => {
    const state = createGodDecisionBannerState({
      action: 'accept',
      reasoning: 'done',
    });
    expect(state.executed).toBe(true);
    expect(state.countdown).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ui/god-decision-banner.test.ts --reporter=verbose`
Expected: FAIL — currently `ESCAPE_WINDOW_MS` is 2000

- [ ] **Step 3: Update `god-decision-banner.ts` — instant execution**

```typescript
export const ESCAPE_WINDOW_MS = 0;
export const TICK_INTERVAL_MS = 100;

export function createGodDecisionBannerState(
  decision: GodAutoDecision,
): GodDecisionBannerState {
  return {
    decision,
    countdown: 0,
    cancelled: false,
    executed: true, // instant execution — AI-driven, no human gate
  };
}

// Remove 'request_human' from formatDecisionSummary:
export function formatDecisionSummary(decision: GodAutoDecision): string {
  switch (decision.action) {
    case 'accept':
      return 'God: accepting output';
    case 'continue_with_instruction':
      return `God: continuing — "${decision.instruction ?? ''}"`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/ui/god-decision-banner.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/god-decision-banner.ts src/__tests__/ui/god-decision-banner.test.ts
git commit -m "refactor: god-decision-banner instant execution, no escape window"
```

---

### Task 10: Rewrite App.tsx GOD_DECIDING effect — instant auto-execute

**Files:**
- Modify: `src/ui/components/App.tsx:1333-1421`

- [ ] **Step 1: Rewrite the WAITING_USER/GOD_DECIDING effect**

Replace the `WAITING_USER` useEffect (lines 1333-1421) with:

```typescript
// ── GOD_DECIDING: God auto-decision — instant execution (AI-driven) ──
useEffect(() => {
  if (stateValue !== 'GOD_DECIDING') return;

  // Phase transition banner takes priority (already handled separately)
  if (showPhaseTransition) return;

  let cancelled = false;

  (async () => {
    // God disabled (L4 degradation) → MANUAL_FALLBACK
    if (!degradationManagerRef.current.isGodAvailable()) {
      send({ type: 'MANUAL_FALLBACK_REQUIRED' });
      addMessage({
        role: 'system',
        content: 'God unavailable. Waiting for your decision. Type [c] to continue, [a] to accept, or enter instructions.',
        timestamp: Date.now(),
      });
      return;
    }

    const autoDecisionContext: AutoDecisionContext = {
      round: ctx.round,
      maxRounds: ctx.maxRounds,
      taskGoal: config.task,
      sessionDir: path.join(config.projectDir, '.duo', 'sessions', sessionIdRef.current ?? 'unknown'),
      seq: ++auditSeqRef.current,
      waitingReason: 'god_deciding',
      projectDir: config.projectDir,
      // AI-driven: full context for God
      lastCoderOutput: ctx.lastCoderOutput?.slice(0, 2000) ?? undefined,
      lastReviewerOutput: ctx.lastReviewerOutput?.slice(0, 2000) ?? undefined,
      currentPhaseId: currentPhaseId ?? undefined,
      currentPhaseType: currentPhaseId
        ? taskAnalysis?.phases?.find(p => p.id === currentPhaseId)?.type
        : undefined,
      phases: taskAnalysis?.phases,
      convergenceLog: convergenceLogRef.current.map(e => ({
        round: e.round,
        classification: e.classification,
        blockingIssueCount: e.blockingIssueCount,
      })),
      unresolvedIssues: lastUnresolvedIssuesRef.current,
    };

    const { result, usedGod, notification } = await withGodFallback(
      degradationManagerRef.current,
      async () => makeAutoDecision(godAdapterRef.current, autoDecisionContext, evaluateRules),
      () => makeLocalAutoDecision(autoDecisionContext, evaluateRules),
      'process_exit',
    );

    if (cancelled) return;

    if (notification) {
      addMessage({ role: 'system', content: notification.message, timestamp: Date.now() });
    }

    // result is always an AutoDecisionResult here:
    // - usedGod=true  => real God result
    // - usedGod=false => deterministic local autonomous fallback
    const autoResult = result as AutoDecisionResult;

    if (autoResult.blocked) {
      send({ type: 'MANUAL_FALLBACK_REQUIRED' });
      addMessage({
        role: 'system',
        content: `Autonomous decision blocked by rule engine. Manual fallback.`,
        timestamp: Date.now(),
      });
      return;
    }

    // INSTANT EXECUTION — no escape window, no banner
    const decision = autoResult.decision;

    if (decision.action === 'accept') {
      addMessage({
        role: 'system',
        content: `${usedGod ? 'God' : 'Local fallback'}: accepting output. ${decision.reasoning}`,
        timestamp: Date.now(),
      });
      addTimelineEvent('converged', 'God auto-decision: accept');
      send({ type: 'USER_CONFIRM', action: 'accept' });
    } else if (decision.action === 'continue_with_instruction') {
      pendingInstructionRef.current = decision.instruction ?? null;

      // Clear stale unresolved issues when God gives new instruction
      lastUnresolvedIssuesRef.current = [];

      addMessage({
        role: 'system',
        content: `${usedGod ? 'God' : 'Local fallback'}: continue → "${decision.instruction ?? ''}"`,
        timestamp: Date.now(),
      });
      addTimelineEvent('coding', `God auto-decision: continue_with_instruction`);
      send({ type: 'USER_CONFIRM', action: 'continue' });
    }
  })();

  return () => { cancelled = true; };
}, [stateValue, showPhaseTransition, reclassifyTrigger]);
```

Do **not** infer phase transitions in `App.tsx`. Phase changes remain explicit via `PHASE_TRANSITION` events from God routing.

- [ ] **Step 2: Update stateValue checks throughout App.tsx**

Replace all `stateValue === 'WAITING_USER'` with `stateValue === 'GOD_DECIDING' || stateValue === 'MANUAL_FALLBACK'` or just the appropriate one depending on context.

Key places:
- `handleInputSubmit` — only allow manual text input in `MANUAL_FALLBACK`
- `mapStateToStatus` — add `GOD_DECIDING` → `'routing'`, `MANUAL_FALLBACK` → `'waiting'`
- `handleReclassify` — update `canTriggerReclassify`
- State persistence — update status string

- [ ] **Step 3: Update unresolvedIssues clearing in ROUTING_POST_REVIEW handler**

In the `ROUTING_POST_REVIEW` useEffect (around line 1042), ensure issues are **replaced** not accumulated:

```typescript
if (godResult.decision.action === 'route_to_coder') {
  lastUnresolvedIssuesRef.current = godResult.decision.unresolvedIssues ?? [];
} else {
  // converged, phase_transition, loop_detected — clear stale issues
  lastUnresolvedIssuesRef.current = [];
}
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run --reporter=verbose`
Expected: Fix any remaining `WAITING_USER` references

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/App.tsx
git commit -m "refactor: GOD_DECIDING instant auto-execute, clear stale issues, phase-aware"
```

---

### Task 11: Rewrite interrupt handler — God-mediated clarification

**Files:**
- Modify: `src/ui/components/App.tsx:1423-1488,1490-1549`

- [ ] **Step 1: Update `handleInputSubmit` for INTERRUPTED state**

When user types in INTERRUPTED state, instead of immediately resuming, send the input to God's interrupt clarifier:

```typescript
if (stateValue === 'INTERRUPTED') {
  // God-mediated clarification
  const interruptCtx: InterruptContext = {
    userInput: text,
    taskGoal: config.task,
    round: ctx.round,
    currentPhaseId: currentPhaseId ?? undefined,
    lastCoderOutput: ctx.lastCoderOutput?.slice(0, 1000) ?? undefined,
    lastReviewerOutput: ctx.lastReviewerOutput?.slice(0, 1000) ?? undefined,
    sessionDir: path.join(config.projectDir, '.duo', 'sessions', sessionIdRef.current ?? 'unknown'),
    seq: ++auditSeqRef.current,
  };

  if (degradationManagerRef.current.isGodAvailable()) {
    (async () => {
      try {
        const classification = await classifyInterruptIntent(
          godAdapterRef.current,
          interruptCtx,
        );

        if (classification.needsClarification) {
          // God needs more info — show clarifying question, stay in INTERRUPTED
          addMessage({
            role: 'system',
            content: `God asks: ${classification.instruction}`,
            timestamp: Date.now(),
          });
          return; // Stay in INTERRUPTED for next user input
        }

        if (classification.intent === 'restart') {
          // Soft restart: restart the current attempt in-place, same session/history
          pendingInstructionRef.current = classification.instruction;
          lastUnresolvedIssuesRef.current = [];
          setPendingPhaseTransition(null);
          addMessage({
            role: 'system',
            content: `God: restarting current attempt — ${classification.instruction}`,
            timestamp: Date.now(),
          });
          send({ type: 'USER_INPUT', input: classification.instruction, resumeAs: 'coder' });
        } else {
          // redirect or continue — resume with God's processed instruction
          pendingInstructionRef.current = classification.instruction;
          addMessage({
            role: 'system',
            content: `God: ${classification.intent} — ${classification.instruction}`,
            timestamp: Date.now(),
          });
          send({
            type: 'USER_INPUT',
            input: classification.instruction,
            resumeAs: lastInterruptedRoleRef.current ?? 'coder',
          });
        }
      } catch {
        // God unavailable — fall back to direct resume
        pendingInstructionRef.current = text;
        send({
          type: 'USER_INPUT',
          input: text,
          resumeAs: lastInterruptedRoleRef.current ?? 'coder',
        });
      }
    })();
  } else {
    // God unavailable — direct resume (v1 behavior)
    pendingInstructionRef.current = text;
    send({
      type: 'USER_INPUT',
      input: text,
      resumeAs: lastInterruptedRoleRef.current ?? 'coder',
    });
  }
  return;
}
```

- [ ] **Step 2: Update MANUAL_FALLBACK input handling**

```typescript
if (stateValue === 'MANUAL_FALLBACK') {
  const decision = resolveUserDecision(
    'MANUAL_FALLBACK',
    text,
    lastInterruptedRoleRef.current,
  );
  if (decision?.type === 'confirm') {
    if (decision.pendingInstruction) {
      pendingInstructionRef.current = decision.pendingInstruction;
    }
    send({ type: 'USER_CONFIRM', action: decision.action });
  }
  return;
}
```

- [ ] **Step 3: Update `resolveUserDecision` in `session-runner-state.ts`**

```typescript
export function resolveUserDecision(
  stateValue: string,
  text: string,
  lastInterruptedRole: 'coder' | 'reviewer' | null,
): UserDecision | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // MANUAL_FALLBACK replaces WAITING_USER for human interaction
  if (stateValue === 'MANUAL_FALLBACK' || stateValue === 'WAITING_USER') {
    if (lower === 'a' || lower === 'accept') {
      return { type: 'confirm', action: 'accept' };
    }
    if (lower === 'c' || lower === 'continue') {
      return { type: 'confirm', action: 'continue' };
    }
    return {
      type: 'confirm',
      action: 'continue',
      pendingInstruction: trimmed,
    };
  }

  if (stateValue === 'INTERRUPTED' && trimmed) {
    return {
      type: 'resume',
      input: text,
      resumeAs: lastInterruptedRole ?? 'coder',
    };
  }

  return null;
}
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run --reporter=verbose`
Expected: PASS (fix any remaining references)

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/App.tsx src/ui/session-runner-state.ts
git commit -m "feat: God-mediated interrupt clarification, MANUAL_FALLBACK for degraded mode"
```

---

## Chunk 5: Pass Phase Context Through Routing Calls

### Task 12: Pass phase context to `routePostCoder` and `routePostReviewer`

**Files:**
- Modify: `src/ui/components/App.tsx:742-801,1008-1123` (routing effects)
- Modify: `src/god/god-router.ts:142-182,191-254` (routing functions)

- [ ] **Step 1: Update RoutingContext to include phase fields**

In `src/god/god-router.ts`:

```typescript
export interface RoutingContext {
  round: number;
  maxRounds: number;
  taskGoal: string;
  sessionDir: string;
  seq: number;
  convergenceLog?: ConvergenceLogEntry[];
  unresolvedIssues?: string[];
  projectDir?: string;
  // AI-driven: phase context
  currentPhaseId?: string;
  currentPhaseType?: string;
  phases?: { id: string; name: string; type: string; description: string }[];
}
```

- [ ] **Step 2: Pass phase info to `generateGodDecisionPrompt` calls**

In `routePostCoder`:

```typescript
const godPrompt = generateGodDecisionPrompt({
  decisionPoint: 'POST_CODER',
  round: context.round,
  maxRounds: context.maxRounds,
  taskGoal: context.taskGoal,
  lastCoderOutput: coderOutput,
  convergenceLog: context.convergenceLog,
  currentPhaseId: context.currentPhaseId,
  currentPhaseType: context.currentPhaseType,
  phases: context.phases,
});
```

In `routePostReviewer`:

```typescript
const godPrompt = generateGodDecisionPrompt({
  decisionPoint: 'POST_REVIEWER',
  round: context.round,
  maxRounds: context.maxRounds,
  taskGoal: context.taskGoal,
  lastReviewerOutput: reviewerOutput,
  unresolvedIssues: context.unresolvedIssues,
  convergenceLog: context.convergenceLog,
  currentPhaseId: context.currentPhaseId,
  currentPhaseType: context.currentPhaseType,
  phases: context.phases,
});
```

- [ ] **Step 3: Update App.tsx routing effects to pass phase context**

In `ROUTING_POST_CODE` effect:

```typescript
async () => routePostCoder(
  godAdapterRef.current,
  output,
  {
    round: ctx.round,
    maxRounds: ctx.maxRounds,
    taskGoal: config.task,
    sessionDir,
    seq: ctx.round + 1,
    projectDir: config.projectDir,
    currentPhaseId: currentPhaseId ?? undefined,
    currentPhaseType: currentPhaseId
      ? taskAnalysis?.phases?.find(p => p.id === currentPhaseId)?.type
      : undefined,
    phases: taskAnalysis?.phases,
  },
),
```

Same for `ROUTING_POST_REVIEW` effect.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/god/god-router.ts src/ui/components/App.tsx
git commit -m "feat: pass phase context to God routing for compound task awareness"
```

---

## Chunk 6: Final Cleanup & Integration Test

### Task 13: Update session-runner-state `mapRestoreEvent`

**Files:**
- Modify: `src/ui/session-runner-state.ts:505-523`

- [ ] **Step 1: Update mapRestoreEvent for renamed states**

```typescript
function mapRestoreEvent(state: SessionState): RestoreEventType {
  switch (state.status) {
    case 'created':
    case 'coding':
      return 'RESTORED_TO_CODING';
    case 'reviewing':
    case 'routing_post_code':
      return 'RESTORED_TO_REVIEWING';
    case 'interrupted':
      return 'RESTORED_TO_INTERRUPTED';
    case 'routing_post_review':
    case 'evaluating':
    case 'waiting_user':      // backward compat with old sessions
    case 'god_deciding':
    case 'manual_fallback':
    case 'error':
    case 'done':
    default:
      return 'RESTORED_TO_WAITING';
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/session-runner-state.ts
git commit -m "fix: mapRestoreEvent handles new state names with backward compat"
```

---

### Task 14: Remove NEEDS_USER_INPUT event handling from workflow machine

**Files:**
- Modify: `src/engine/workflow-machine.ts`

- [ ] **Step 1: Remove or keep NEEDS_USER_INPUT for backward compatibility**

Since Zod schemas no longer produce `request_user_input`, the `NEEDS_USER_INPUT` event is dead code. Keep it in the type union for session resume backward compatibility but remove active transitions to it. The `godActionToEvent` function no longer maps anything to it, so no live code path reaches it.

No code change needed if we want backward compat. If we want clean removal:

```typescript
// Remove from ROUTING_POST_CODE.on:
// NEEDS_USER_INPUT: { target: 'GOD_DECIDING' },  // dead path

// Remove from ROUTING_POST_REVIEW.on:
// NEEDS_USER_INPUT: { target: 'GOD_DECIDING' },  // dead path
```

Decision: keep the event type but remove the transitions (they're unreachable now). This avoids TypeScript breakage in any code that references the event type.

- [ ] **Step 2: Commit**

```bash
git add src/engine/workflow-machine.ts
git commit -m "cleanup: remove dead NEEDS_USER_INPUT transitions (unreachable after AI-driven refactor)"
```

---

### Task 15: Run full test suite and fix regressions

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run --reporter=verbose`

- [ ] **Step 2: Fix any failing tests**

Common fixes needed:
- Tests referencing `'request_human'` or `'request_user_input'` — update expectations
- Tests referencing `'WAITING_USER'` state name — update to `'GOD_DECIDING'` or `'MANUAL_FALLBACK'`
- Tests for escape window countdown behavior — update to instant execution
- Tests mocking `resolveUserDecision` with `'WAITING_USER'` — add `'MANUAL_FALLBACK'`

- [ ] **Step 3: Run tests again to verify green**

Run: `npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "fix: update all tests for AI-driven God autonomy refactor"
```

---

## Summary of Changes

| Change | Impact | Files |
|--------|--------|-------|
| Shared God call helper | Fixes dangling timeout kill race and de-duplicates stateless God execution | `god-call.ts`, `task-init.ts`, `auto-decision.ts`, `god-router.ts`, `god-convergence.ts` |
| Remove `request_human` | God never defers to human | `god-schemas.ts`, `auto-decision.ts` |
| Remove `request_user_input` | God self-resolves questions/disputes | `god-schemas.ts`, `god-router.ts` |
| Expand auto-decision context | God sees Coder/Reviewer output + phases | `auto-decision.ts` |
| Deterministic local auto-decision | L2/L3 failures remain autonomous instead of dropping straight to human | `auto-decision.ts`, `App.tsx` |
| Phase context in routing | God knows about compound task phases | `god-prompt-generator.ts`, `god-router.ts` |
| Phase/instruction conflict resolution | God instruction can upgrade phase type | `god-prompt-generator.ts` |
| `WAITING_USER` → `GOD_DECIDING` | Instant auto-execute, no human gate | `workflow-machine.ts`, `App.tsx` |
| `MANUAL_FALLBACK` state | Only when no autonomous path can safely execute | `workflow-machine.ts`, `App.tsx` |
| Retry circuit breaker | 3 consecutive retries → God re-evaluates | `workflow-machine.ts` |
| Instant execution | No 2s escape window | `god-decision-banner.ts` |
| Interrupt clarifier | God processes human Ctrl+C intent; `restart` is a soft in-session restart | `interrupt-clarifier.ts` (new) |
| Clear stale issues | Issues replaced per-round, cleared on converge | `App.tsx` |
