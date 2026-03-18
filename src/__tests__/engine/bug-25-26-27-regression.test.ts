/**
 * Regression tests for BUG-25, BUG-26, BUG-27.
 *
 * BUG-25 [P1]: CODE_INSTRUCTIONS must require writing tests for new functionality.
 *   Coder implemented 14 files without any new tests. Phase-4 self-check ran only
 *   existing tests (all pass) and declared "no issues" — reviewer then found 3 blockers.
 *   Fix: (a) Coder prompt includes baseline test-writing instruction.
 *        (b) God's decision reflection checks coder output for test coverage.
 *
 * BUG-26 [P2]: God must not exclude user-named scope items.
 *   User said "upgrade coder, reviewer, god" — God's MVP excluded godModel.
 *   Fix: God's decision reflection includes scope verification against user request.
 *
 * BUG-27 [P3]: When skipping phases via multiple set_phase, God should explain.
 *   Fix: God's decision reflection includes phase integrity check.
 */

import { describe, it, expect } from 'vitest';
import { generateCoderPrompt } from '../../god/god-prompt-generator.js';
import {
  SYSTEM_PROMPT,
  DECISION_REFLECTION_INSTRUCTIONS,
} from '../../god/god-decision-service.js';

// ══════════════════════════════════════════════════════════════════
// BUG-25: CODE_INSTRUCTIONS must require test writing
// ══════════════════════════════════════════════════════════════════

describe('BUG-25: code phase prompt requires writing tests for new functionality', () => {
  it('code-type prompt contains test-writing requirement', () => {
    const prompt = generateCoderPrompt({
      taskType: 'code',
      taskGoal: 'Implement model selection feature',
      isPostReviewerRouting: true,
    });

    // Must tell coder to write tests, not just run existing ones
    expect(prompt.toLowerCase()).toMatch(/write.*test|test.*new.*func|test.*cover/i);
  });

  it('compound code phase prompt also contains test-writing requirement', () => {
    const prompt = generateCoderPrompt({
      taskType: 'compound',
      taskGoal: 'Implement model selection feature',
      phaseType: 'code',
      phaseId: 'phase-3',
      isPostReviewerRouting: true,
    });

    expect(prompt.toLowerCase()).toMatch(/write.*test|test.*new.*func|test.*cover/i);
  });

  it('explore-type prompt does NOT require writing tests', () => {
    const prompt = generateCoderPrompt({
      taskType: 'explore',
      taskGoal: 'Explore codebase',
    });

    // Explore phase should not mention writing tests
    expect(prompt).not.toMatch(/Write tests for new/i);
  });

  it('God reflection includes quality gate for coder test coverage', () => {
    // God should check whether coder wrote tests, not just rely on coder self-policing
    expect(DECISION_REFLECTION_INSTRUCTIONS).toMatch(/test/i);
    expect(DECISION_REFLECTION_INSTRUCTIONS).toMatch(/send_to_coder/i);
  });
});

// ══════════════════════════════════════════════════════════════════
// BUG-26: God must not exclude user-named scope items
// ══════════════════════════════════════════════════════════════════

describe('BUG-26: God decision reflection prevents excluding user-named scope', () => {
  it('reflection instructions require verifying user-named items are in scope', () => {
    // God's self-check should catch scope narrowing
    expect(DECISION_REFLECTION_INSTRUCTIONS).toMatch(/named/i);
    expect(DECISION_REFLECTION_INSTRUCTIONS).toMatch(/scope|narrow/i);
  });

  it('reflection is included in the God system prompt', () => {
    // The reflection must actually be part of what God sees
    expect(SYSTEM_PROMPT).toContain('Decision reflection');
  });
});

// ══════════════════════════════════════════════════════════════════
// BUG-27: Phase skip must be explained
// ══════════════════════════════════════════════════════════════════

describe('BUG-27: God decision reflection requires explanation for phase skips', () => {
  it('reflection instructions mention phase skip explanation in system_log', () => {
    expect(DECISION_REFLECTION_INSTRUCTIONS).toMatch(/skip/i);
    expect(DECISION_REFLECTION_INSTRUCTIONS).toMatch(/system_log|explain/i);
  });
});
