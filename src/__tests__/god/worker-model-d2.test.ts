/**
 * Card D.2: Worker Model & Reviewer Override Enforcement
 * Source: FR-001, FR-002, FR-009, FR-010
 *
 * Tests:
 * - AC-1: Coder output only forms observation, not accept
 * - AC-2: Reviewer output only forms observation, not final veto
 * - AC-3: God can skip/retry/stop/switch workers
 * - AC-4: God references reviewer conclusion in diagnosis
 * - AC-5: God override reviewer requires system_log
 * - AC-6: Audit trail tracks reviewer conclusion + God verdict
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { generateCoderPrompt, generateReviewerPrompt } from '../../god/god-prompt-generator.js';
import {
  buildObservationsSection,
  extractReviewerVerdict,
  REVIEWER_HANDLING_INSTRUCTIONS,
} from '../../god/god-decision-service.js';
import { logReviewerOverrideAudit } from '../../god/god-audit.js';
import type { GodDecisionEnvelope } from '../../types/god-envelope.js';
import type { Observation } from '../../types/observation.js';
import type { GodAuditLogger, GodAuditEntry } from '../../god/god-audit.js';
import { GodDecisionEnvelopeSchema } from '../../types/god-envelope.js';
import { processWorkerOutput } from '../../god/observation-integration.js';

// ── Helpers ──

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    source: 'coder',
    type: 'work_output',
    summary: 'Coder produced code changes',
    severity: 'info',
    timestamp: '2026-03-13T12:00:00.000Z',
    phaseId: 'phase-1',
    ...overrides,
  };
}

function makeReviewerObservation(verdict: 'APPROVED' | 'CHANGES_REQUESTED' = 'APPROVED'): Observation {
  return makeObservation({
    source: 'reviewer',
    type: 'review_output',
    summary: `Reviewer verdict: [${verdict}] — all issues resolved`,
    rawRef: `Review complete. No blocking issues found. [${verdict}]`,
  });
}

function makeEnvelope(overrides: Partial<GodDecisionEnvelope> = {}): GodDecisionEnvelope {
  return {
    diagnosis: {
      summary: 'Test decision',
      currentGoal: 'test goal',
      currentPhaseId: 'phase-1',
      notableObservations: [],
      ...overrides.diagnosis,
    },
    authority: {
      userConfirmation: 'not_required',
      reviewerOverride: false,
      acceptAuthority: 'reviewer_aligned',
      ...overrides.authority,
    },
    actions: overrides.actions ?? [],
    messages: overrides.messages ?? [],
  };
}

function makeMockAuditLogger(): GodAuditLogger & { entries: Omit<GodAuditEntry, 'seq'>[] } {
  const entries: Omit<GodAuditEntry, 'seq'>[] = [];
  return {
    entries,
    append(entry: Omit<GodAuditEntry, 'seq'>, _fullOutput?: unknown): void {
      entries.push(entry);
    },
    getEntries: vi.fn().mockReturnValue([]),
    getSequence: vi.fn().mockReturnValue(0),
  } as unknown as GodAuditLogger & { entries: Omit<GodAuditEntry, 'seq'>[] };
}

// ── AC-1: Coder output only forms observation, not accept ──

describe('AC-1: Coder as pure executor', () => {
  test('coder prompt declares worker role — no accept authority', () => {
    const prompt = generateCoderPrompt({
      taskType: 'code',
      taskGoal: 'Implement login feature',
    });

    // Must contain explicit worker declaration
    expect(prompt).toContain('executor');
    expect(prompt).toMatch(/not.*accept/i);
    expect(prompt).toMatch(/not.*phase.*switch/i);
  });

  test('coder prompt declares worker role for compound task type', () => {
    const prompt = generateCoderPrompt({
      taskType: 'compound',
      taskGoal: 'Multi-phase project',
      phaseId: 'phase-1',
      phaseType: 'code',
    });

    expect(prompt).toContain('executor');
    expect(prompt).toMatch(/not.*accept/i);
  });

  test('coder output classified as work_output forms observation, not accept decision', () => {
    const result = processWorkerOutput(
      'I have implemented the login feature with proper validation.',
      'coder',
      {},
    );

    expect(result.observation.type).toBe('work_output');
    expect(result.observation.source).toBe('coder');
    expect(result.isWork).toBe(true);
    // Observation has no accept/reject field — it's pure data
    expect(result.observation).not.toHaveProperty('accept');
    expect(result.observation).not.toHaveProperty('decision');
  });
});

// ── AC-2: Reviewer output only forms observation, not final veto ──

describe('AC-2: Reviewer as observation provider', () => {
  test('reviewer prompt declares observation role — verdict is informational', () => {
    const prompt = generateReviewerPrompt({
      taskType: 'code',
      taskGoal: 'Implement login feature',
      lastCoderOutput: 'I implemented the login...',
    });

    // Must contain worker role declaration
    expect(prompt).toMatch(/observation|informational/i);
    expect(prompt).toMatch(/God.*final.*decision|God.*decides/i);
  });

  test('reviewer output classified as review_output — verdict is part of observation', () => {
    const result = processWorkerOutput(
      'Review complete. 2 blocking issues found. [CHANGES_REQUESTED]',
      'reviewer',
      {},
    );

    expect(result.observation.type).toBe('review_output');
    expect(result.observation.source).toBe('reviewer');
    expect(result.isWork).toBe(true);
    // Verdict is in the observation text, not a separate decision field
    expect(result.observation).not.toHaveProperty('verdict');
    expect(result.observation).not.toHaveProperty('finalDecision');
  });

  test('reviewer APPROVED verdict does not directly trigger accept', () => {
    const result = processWorkerOutput(
      'All issues resolved. [APPROVED]',
      'reviewer',
      {},
    );

    // Only forms observation — accept must come from God's accept_task Hand
    expect(result.observation.type).toBe('review_output');
    expect(result.isWork).toBe(true);
    expect(result.shouldRouteToGod).toBe(false);
    // No direct accept authority in the observation
    expect(result.observation).not.toHaveProperty('acceptAuthority');
  });
});

// ── AC-3: God can skip/retry/stop/switch workers ──

describe('AC-3: God can manage workers', () => {
  test('God can issue stop_role for coder', () => {
    const envelope = makeEnvelope({
      actions: [{ type: 'stop_role', role: 'coder', reason: 'Coder stuck in loop' }],
    });

    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
    expect(result.data!.actions[0].type).toBe('stop_role');
  });

  test('God can issue retry_role for reviewer', () => {
    const envelope = makeEnvelope({
      actions: [{ type: 'retry_role', role: 'reviewer', hint: 'Focus on security issues' }],
    });

    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
    expect(result.data!.actions[0].type).toBe('retry_role');
  });

  test('God can issue switch_adapter for coder', () => {
    const envelope = makeEnvelope({
      actions: [{ type: 'switch_adapter', role: 'coder', adapter: 'codex', reason: 'Need faster model' }],
    });

    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
    expect(result.data!.actions[0].type).toBe('switch_adapter');
  });

  test('God can skip reviewer and send directly to coder', () => {
    const envelope = makeEnvelope({
      actions: [{ type: 'send_to_coder', message: 'Skip review, proceed with next task' }],
    });

    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
    expect(result.data!.actions[0].type).toBe('send_to_coder');
  });
});

// ── AC-4: God references reviewer conclusion (diagnosis.notableObservations) ──

describe('AC-4: God references reviewer conclusion', () => {
  test('extractReviewerVerdict extracts APPROVED from observation', () => {
    const obs = makeReviewerObservation('APPROVED');
    const verdict = extractReviewerVerdict(obs);

    expect(verdict).toBe('APPROVED');
  });

  test('extractReviewerVerdict extracts CHANGES_REQUESTED from observation', () => {
    const obs = makeReviewerObservation('CHANGES_REQUESTED');
    const verdict = extractReviewerVerdict(obs);

    expect(verdict).toBe('CHANGES_REQUESTED');
  });

  test('extractReviewerVerdict returns null for non-reviewer observation', () => {
    const obs = makeObservation({ source: 'coder', type: 'work_output' });
    const verdict = extractReviewerVerdict(obs);

    expect(verdict).toBeNull();
  });

  test('buildObservationsSection highlights reviewer verdict', () => {
    const observations: Observation[] = [
      makeObservation({ summary: 'Coder produced changes' }),
      makeReviewerObservation('CHANGES_REQUESTED'),
    ];

    const section = buildObservationsSection(observations);

    expect(section).toContain('CHANGES_REQUESTED');
    expect(section).toContain('Reviewer verdict');
  });

  test('buildObservationsSection strips tool markers from coder output', () => {
    const rawCoderOutput = [
      'Let me explore the codebase.',
      '[Agent] {',
      '[Glob] {',
      '[Glob result] 24 lines',
      '[Read] Read SetupWizard.tsx',
      '[Read result] 412 lines',
      '[Grep] {',
      '[Grep result] 12 lines',
      '[Bash] TypeScript type check',
      '[Bash result] 1 lines',
      '[Edit] {',
      '[Edit result] 1 lines',
      '[Write] {',
      '[Write result] 1 lines',
      '[Tool result] 38 lines',
      '[Tool error] Exit code 1',
      'The startup screen is located in SetupWizard.tsx.',
      '## Analysis',
      'The header is only 6 lines tall.',
    ].join('\n');

    const observations: Observation[] = [
      makeObservation({ summary: rawCoderOutput }),
    ];

    const section = buildObservationsSection(observations);

    // Tool markers should be stripped
    expect(section).not.toContain('[Read] Read SetupWizard.tsx');
    expect(section).not.toContain('[Read result] 412 lines');
    expect(section).not.toContain('[Glob] {');
    expect(section).not.toContain('[Glob result] 24 lines');
    expect(section).not.toContain('[Bash] TypeScript type check');
    expect(section).not.toContain('[Bash result] 1 lines');
    expect(section).not.toContain('[Edit] {');
    expect(section).not.toContain('[Edit result] 1 lines');
    expect(section).not.toContain('[Write] {');
    expect(section).not.toContain('[Write result] 1 lines');
    expect(section).not.toContain('[Tool result] 38 lines');
    expect(section).not.toContain('[Tool error] Exit code 1');
    expect(section).not.toContain('[Agent] {');

    // Meaningful content should be preserved
    expect(section).toContain('The startup screen is located in SetupWizard.tsx.');
    expect(section).toContain('## Analysis');
    expect(section).toContain('The header is only 6 lines tall.');
  });

  test('buildObservationsSection strips shell command markers from reviewer output', () => {
    const rawReviewerOutput = [
      'I will review the changes.',
      '[shell] /bin/zsh -lc "sed -n \'1,260p\' src/ui/components/SetupWizard.tsx"',
      '[shell result] 132 lines',
      '[shell] /bin/zsh -lc \'cat package.json\'',
      '[shell result] 36 lines',
      'The header is now 19 lines tall.',
      'Blocking count: 2',
      '[CHANGES_REQUESTED]',
    ].join('\n');

    const observations: Observation[] = [
      makeObservation({
        source: 'reviewer',
        type: 'review_output',
        summary: rawReviewerOutput,
        rawRef: rawReviewerOutput,
      }),
    ];

    const section = buildObservationsSection(observations);

    // Shell markers should be stripped
    expect(section).not.toContain('[shell] /bin/zsh');
    expect(section).not.toContain('[shell result] 132 lines');

    // Meaningful content should be preserved
    expect(section).toContain('The header is now 19 lines tall.');
    expect(section).toContain('Blocking count: 2');
  });

  test('buildObservationsSection does not leave excessive blank lines after stripping', () => {
    const rawOutput = [
      'Start of analysis.',
      '[Read] Read file.ts',
      '[Read result] 100 lines',
      '[Glob] {',
      '[Glob result] 10 lines',
      '',
      'End of analysis.',
    ].join('\n');

    const observations: Observation[] = [
      makeObservation({ summary: rawOutput }),
    ];

    const section = buildObservationsSection(observations);

    // Should not have 3+ consecutive newlines
    expect(section).not.toMatch(/\n{3,}/);
  });

  test('God SYSTEM_PROMPT instructs referencing reviewer conclusions', () => {
    expect(REVIEWER_HANDLING_INSTRUCTIONS).toContain('reviewer');
    expect(REVIEWER_HANDLING_INSTRUCTIONS).toContain('diagnosis');
    expect(REVIEWER_HANDLING_INSTRUCTIONS).toContain('notableObservations');
  });
});

// ── AC-5: God override reviewer requires system_log ──

describe('AC-5: Reviewer override requires system_log', () => {
  test('reviewerOverride=true with system_log is valid', () => {
    const envelope = makeEnvelope({
      authority: {
        userConfirmation: 'not_required',
        reviewerOverride: true,
        acceptAuthority: 'god_override',
      },
      messages: [
        { target: 'system_log', content: 'Overriding reviewer because all issues are cosmetic' },
      ],
    });

    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  test('reviewerOverride=true WITHOUT system_log is rejected by Zod', () => {
    const envelope = makeEnvelope({
      authority: {
        userConfirmation: 'not_required',
        reviewerOverride: true,
        acceptAuthority: 'reviewer_aligned',
      },
      messages: [
        { target: 'user', content: 'Task completed' },
      ],
    });

    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
  });

  test('God accept with reviewer_aligned does NOT require override', () => {
    const envelope = makeEnvelope({
      authority: {
        userConfirmation: 'not_required',
        reviewerOverride: false,
        acceptAuthority: 'reviewer_aligned',
      },
      actions: [{ type: 'accept_task', rationale: 'reviewer_aligned', summary: 'Reviewer approved' }],
      messages: [],
    });

    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });
});

// ── AC-6: Audit trail tracks reviewer conclusion + God verdict ──

describe('AC-6: Audit trail for reviewer override', () => {
  let mockLogger: ReturnType<typeof makeMockAuditLogger>;

  beforeEach(() => {
    mockLogger = makeMockAuditLogger();
  });

  test('logReviewerOverrideAudit records reviewer original conclusion', () => {
    const reviewerObs = makeReviewerObservation('CHANGES_REQUESTED');
    const envelope = makeEnvelope({
      authority: {
        userConfirmation: 'not_required',
        reviewerOverride: true,
        acceptAuthority: 'god_override',
      },
      diagnosis: {
        summary: 'Overriding reviewer — issues are cosmetic',
        currentGoal: 'Complete feature',
        currentPhaseId: 'phase-1',
        notableObservations: ['Reviewer requested changes for cosmetic issues'],
      },
      actions: [{ type: 'accept_task', rationale: 'god_override', summary: 'Issues are cosmetic, accepting' }],
      messages: [
        { target: 'system_log', content: 'Override reason: all reviewer issues are cosmetic naming suggestions' },
      ],
    });

    logReviewerOverrideAudit(mockLogger, {
      reviewerObservation: reviewerObs,
      envelope,
    });

    expect(mockLogger.entries).toHaveLength(1);
    const entry = mockLogger.entries[0];
    expect(entry.decisionType).toBe('reviewer_override');
    expect(entry.inputSummary).toContain('CHANGES_REQUESTED');
    expect(entry.outputSummary).toContain('god_override');
    expect(entry.decision).toHaveProperty('reviewerVerdict', 'CHANGES_REQUESTED');
    expect(entry.decision).toHaveProperty('godVerdict');
    expect(entry.decision).toHaveProperty('overrideReason');
  });

  test('logReviewerOverrideAudit records God aligned verdict', () => {
    const reviewerObs = makeReviewerObservation('APPROVED');
    const envelope = makeEnvelope({
      authority: {
        userConfirmation: 'not_required',
        reviewerOverride: false,
        acceptAuthority: 'reviewer_aligned',
      },
      diagnosis: {
        summary: 'Reviewer approved, accepting task',
        currentGoal: 'Complete feature',
        currentPhaseId: 'phase-1',
        notableObservations: ['Reviewer approved all changes'],
      },
      actions: [{ type: 'accept_task', rationale: 'reviewer_aligned', summary: 'Reviewer approved' }],
      messages: [],
    });

    logReviewerOverrideAudit(mockLogger, {
      reviewerObservation: reviewerObs,
      envelope,
    });

    expect(mockLogger.entries).toHaveLength(1);
    const entry = mockLogger.entries[0];
    expect(entry.decisionType).toBe('reviewer_aligned');
    expect(entry.decision).toHaveProperty('reviewerVerdict', 'APPROVED');
    expect(entry.decision).toHaveProperty('godVerdict', 'reviewer_aligned');
  });

  test('audit records full envelope for traceability', () => {
    const reviewerObs = makeReviewerObservation('CHANGES_REQUESTED');
    const envelope = makeEnvelope({
      authority: {
        userConfirmation: 'not_required',
        reviewerOverride: true,
        acceptAuthority: 'god_override',
      },
      messages: [
        { target: 'system_log', content: 'Override: cosmetic issues only' },
      ],
    });

    logReviewerOverrideAudit(mockLogger, {
      reviewerObservation: reviewerObs,
      envelope,
    });

    const entry = mockLogger.entries[0];
    expect(entry.decision).toHaveProperty('envelope');
  });
});
