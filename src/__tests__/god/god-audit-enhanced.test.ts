/**
 * Tests for Card F.2: Enhanced GodAuditLogger — God Decision Explanation
 * Source: FR-018 (AC-053..AC-056), NFR-002, NFR-006
 *
 * Tests cover:
 * - AC-1: God override of user confirmation traceable (userConfirmation = 'god_override')
 * - AC-2: God override of reviewer traceable (reviewerOverride = true, includes reviewer original conclusion)
 * - AC-3: God switch_adapter / wait / stop traceable
 * - AC-4: God accept/stop rationale traceable
 * - AC-5: Audit entry contains input observations + diagnosis + authority + actions + messages
 * - AC-6: JSONL format backward compatible (extended fields, no breaking changes)
 * - AC-7: All tests pass
 * - AC-8: Existing audit tests adapted and still pass
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { GodAuditLogger, logEnvelopeDecision } from '../../god/god-audit.js';
import type { GodAuditEntry } from '../../god/god-audit.js';
import type { GodDecisionEnvelope } from '../../types/god-envelope.js';
import type { Observation } from '../../types/observation.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'god-audit-f2-'));
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    source: 'coder',
    type: 'work_output',
    summary: 'Coder produced output',
    severity: 'info',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeEnvelope(overrides: Partial<GodDecisionEnvelope> = {}): GodDecisionEnvelope {
  return {
    diagnosis: {
      summary: 'Task proceeding normally',
      currentGoal: 'Implement feature X',
      currentPhaseId: 'coding',
      notableObservations: ['coder output looks good'],
    },
    authority: {
      userConfirmation: 'not_required',
      reviewerOverride: false,
      acceptAuthority: 'reviewer_aligned',
    },
    actions: [{ type: 'send_to_coder', message: 'continue working' }],
    messages: [{ target: 'system_log', content: 'normal progression' }],
    ...overrides,
  };
}

describe('Card F.2: logEnvelopeDecision — enhanced audit logging', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── AC-5: Audit entry contains observations + diagnosis + authority + actions + messages ──

  it('AC-5: audit entry includes input observations with summary, severity, type', () => {
    const logger = new GodAuditLogger(tmpDir);
    const observations = [
      makeObservation({ type: 'work_output', severity: 'info', summary: 'code generated' }),
      makeObservation({ type: 'quota_exhausted', severity: 'error', summary: 'rate limit hit' }),
    ];
    const envelope = makeEnvelope();

    logEnvelopeDecision(logger, {
      observations,
      envelope,
      executionResults: [],
    });

    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    const decision = entries[0].decision as Record<string, unknown>;

    // observations summary present
    const obsEntries = decision.observations as Array<{ type: string; severity: string; summary: string }>;
    expect(obsEntries).toHaveLength(2);
    expect(obsEntries[0]).toMatchObject({ type: 'work_output', severity: 'info', summary: 'code generated' });
    expect(obsEntries[1]).toMatchObject({ type: 'quota_exhausted', severity: 'error', summary: 'rate limit hit' });
  });

  it('AC-5: audit entry includes diagnosis from envelope', () => {
    const logger = new GodAuditLogger(tmpDir);
    const envelope = makeEnvelope({
      diagnosis: {
        summary: 'Coder output needs review',
        currentGoal: 'Fix bug #42',
        currentPhaseId: 'review',
        notableObservations: ['tests failing', 'coverage low'],
      },
    });

    logEnvelopeDecision(logger, {
      observations: [makeObservation()],
      envelope,
      executionResults: [],
    });

    const entries = logger.getEntries();
    const decision = entries[0].decision as Record<string, unknown>;
    const diagnosis = decision.diagnosis as Record<string, unknown>;
    expect(diagnosis.summary).toBe('Coder output needs review');
    expect(diagnosis.currentGoal).toBe('Fix bug #42');
    expect(diagnosis.currentPhaseId).toBe('review');
    expect(diagnosis.notableObservations).toEqual(['tests failing', 'coverage low']);
  });

  it('AC-5: audit entry includes authority from envelope', () => {
    const logger = new GodAuditLogger(tmpDir);
    const envelope = makeEnvelope({
      authority: {
        userConfirmation: 'god_override',
        reviewerOverride: true,
        acceptAuthority: 'god_override',
      },
      messages: [{ target: 'system_log', content: 'override reason' }],
    });

    logEnvelopeDecision(logger, {
      observations: [makeObservation()],
      envelope,
      executionResults: [],
    });

    const entries = logger.getEntries();
    const decision = entries[0].decision as Record<string, unknown>;
    const authority = decision.authority as Record<string, unknown>;
    expect(authority.userConfirmation).toBe('god_override');
    expect(authority.reviewerOverride).toBe(true);
    expect(authority.acceptAuthority).toBe('god_override');
  });

  it('AC-5: audit entry includes actions from envelope', () => {
    const logger = new GodAuditLogger(tmpDir);
    const envelope = makeEnvelope({
      actions: [
        { type: 'set_phase', phaseId: 'review' },
        { type: 'send_to_reviewer', message: 'review this code' },
      ],
    });

    logEnvelopeDecision(logger, {
      observations: [makeObservation()],
      envelope,
      executionResults: [],
    });

    const entries = logger.getEntries();
    const decision = entries[0].decision as Record<string, unknown>;
    const actions = decision.actions as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ type: 'set_phase', phaseId: 'review' });
    expect(actions[1]).toMatchObject({ type: 'send_to_reviewer', message: 'review this code' });
  });

  it('AC-5: audit entry includes messages from envelope', () => {
    const logger = new GodAuditLogger(tmpDir);
    const envelope = makeEnvelope({
      messages: [
        { target: 'user', content: 'Task is progressing' },
        { target: 'system_log', content: 'internal note' },
      ],
    });

    logEnvelopeDecision(logger, {
      observations: [makeObservation()],
      envelope,
      executionResults: [],
    });

    const entries = logger.getEntries();
    const decision = entries[0].decision as Record<string, unknown>;
    const messages = decision.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ target: 'user', content: 'Task is progressing' });
    expect(messages[1]).toMatchObject({ target: 'system_log', content: 'internal note' });
  });

  it('AC-5: audit entry includes execution results', () => {
    const logger = new GodAuditLogger(tmpDir);
    const execResults: Observation[] = [
      makeObservation({ source: 'runtime', type: 'phase_progress_signal', summary: 'set_phase: coding → review', severity: 'info' }),
      makeObservation({ source: 'runtime', type: 'runtime_invariant_violation', summary: 'stop_role failed: no adapter', severity: 'error' }),
    ];

    logEnvelopeDecision(logger, {
      observations: [makeObservation()],
      envelope: makeEnvelope(),
      executionResults: execResults,
    });

    const entries = logger.getEntries();
    const decision = entries[0].decision as Record<string, unknown>;
    const results = decision.executionResults as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ type: 'phase_progress_signal', summary: 'set_phase: coding → review', severity: 'info' });
    expect(results[1]).toMatchObject({ type: 'runtime_invariant_violation', summary: 'stop_role failed: no adapter', severity: 'error' });
  });

  // ── AC-1: God override of user confirmation traceable ──

  it('AC-1: god_override userConfirmation produces override audit with reason', () => {
    const logger = new GodAuditLogger(tmpDir);
    const envelope = makeEnvelope({
      authority: {
        userConfirmation: 'god_override',
        reviewerOverride: false,
        acceptAuthority: 'reviewer_aligned',
      },
      messages: [{ target: 'system_log', content: 'User confirmation not needed — task is low risk' }],
    });

    logEnvelopeDecision(logger, {
      observations: [makeObservation()],
      envelope,
      executionResults: [],
    });

    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    // decisionType should indicate god_decision with override tracking
    const decision = entries[0].decision as Record<string, unknown>;
    expect(decision.overrides).toBeDefined();
    const overrides = decision.overrides as Record<string, unknown>;
    expect(overrides.userConfirmationOverride).toBe(true);
    expect(overrides.userConfirmationOverrideReason).toBe('User confirmation not needed — task is low risk');
  });

  // ── AC-2: God override of reviewer traceable ──

  it('AC-2: reviewerOverride=true produces audit with reviewer original conclusion', () => {
    const logger = new GodAuditLogger(tmpDir);
    const reviewerObs = makeObservation({
      source: 'reviewer',
      type: 'review_output',
      summary: 'Code has issues — [CHANGES_REQUESTED]',
      severity: 'warning',
    });
    const envelope = makeEnvelope({
      authority: {
        userConfirmation: 'not_required',
        reviewerOverride: true,
        acceptAuthority: 'god_override',
      },
      actions: [{ type: 'accept_task', rationale: 'god_override', summary: 'Issues are cosmetic, accepting anyway' }],
      messages: [{ target: 'system_log', content: 'Reviewer requested changes but issues are cosmetic and non-blocking' }],
    });

    logEnvelopeDecision(logger, {
      observations: [reviewerObs],
      envelope,
      executionResults: [],
    });

    const entries = logger.getEntries();
    const decision = entries[0].decision as Record<string, unknown>;
    const overrides = decision.overrides as Record<string, unknown>;
    expect(overrides.reviewerOverride).toBe(true);
    expect(overrides.reviewerOriginalConclusion).toBe('CHANGES_REQUESTED');
    expect(overrides.reviewerOverrideReason).toBe('Reviewer requested changes but issues are cosmetic and non-blocking');
  });

  it('AC-2: reviewer override without review_output observation still records override', () => {
    const logger = new GodAuditLogger(tmpDir);
    const envelope = makeEnvelope({
      authority: {
        userConfirmation: 'not_required',
        reviewerOverride: true,
        acceptAuthority: 'god_override',
      },
      messages: [{ target: 'system_log', content: 'Override without reviewer obs' }],
    });

    logEnvelopeDecision(logger, {
      observations: [makeObservation()],
      envelope,
      executionResults: [],
    });

    const entries = logger.getEntries();
    const decision = entries[0].decision as Record<string, unknown>;
    const overrides = decision.overrides as Record<string, unknown>;
    expect(overrides.reviewerOverride).toBe(true);
    expect(overrides.reviewerOriginalConclusion).toBe('unknown');
  });

  // ── AC-3: God switch_adapter / wait / stop traceable ──

  it('AC-3: switch_adapter action is traceable in audit', () => {
    const logger = new GodAuditLogger(tmpDir);
    const envelope = makeEnvelope({
      actions: [{ type: 'switch_adapter', role: 'coder', adapter: 'gemini-2.5-pro', reason: 'Claude quota exhausted' }],
      messages: [{ target: 'system_log', content: 'switching adapter' }],
    });

    logEnvelopeDecision(logger, {
      observations: [makeObservation({ type: 'quota_exhausted', severity: 'error' })],
      envelope,
      executionResults: [makeObservation({ source: 'runtime', type: 'phase_progress_signal', summary: 'switch_adapter: coder → gemini-2.5-pro' })],
    });

    const entries = logger.getEntries();
    const decision = entries[0].decision as Record<string, unknown>;
    const actions = decision.actions as Array<Record<string, unknown>>;
    expect(actions.some(a => a.type === 'switch_adapter')).toBe(true);
    const switchAction = actions.find(a => a.type === 'switch_adapter') as Record<string, unknown>;
    expect(switchAction.adapter).toBe('gemini-2.5-pro');
    expect(switchAction.reason).toBe('Claude quota exhausted');
  });

  it('AC-3: wait action is traceable in audit', () => {
    const logger = new GodAuditLogger(tmpDir);
    const envelope = makeEnvelope({
      actions: [{ type: 'wait', reason: 'Rate limit cooldown', estimatedSeconds: 60 }],
      messages: [{ target: 'user', content: 'Waiting 60s for rate limit' }, { target: 'system_log', content: 'wait' }],
    });

    logEnvelopeDecision(logger, {
      observations: [makeObservation({ type: 'quota_exhausted', severity: 'error' })],
      envelope,
      executionResults: [],
    });

    const entries = logger.getEntries();
    const decision = entries[0].decision as Record<string, unknown>;
    const actions = decision.actions as Array<Record<string, unknown>>;
    expect(actions.some(a => a.type === 'wait')).toBe(true);
  });

  it('AC-3: stop_role action is traceable in audit', () => {
    const logger = new GodAuditLogger(tmpDir);
    const envelope = makeEnvelope({
      actions: [{ type: 'stop_role', role: 'coder', reason: 'Coder stuck in loop' }],
      messages: [{ target: 'system_log', content: 'stopping coder' }],
    });

    logEnvelopeDecision(logger, {
      observations: [makeObservation()],
      envelope,
      executionResults: [],
    });

    const entries = logger.getEntries();
    const decision = entries[0].decision as Record<string, unknown>;
    const actions = decision.actions as Array<Record<string, unknown>>;
    expect(actions.some(a => a.type === 'stop_role')).toBe(true);
    const stopAction = actions.find(a => a.type === 'stop_role') as Record<string, unknown>;
    expect(stopAction.reason).toBe('Coder stuck in loop');
  });

  // ── AC-4: God accept/stop rationale traceable ──

  it('AC-4: accept_task rationale and summary traceable', () => {
    const logger = new GodAuditLogger(tmpDir);
    const envelope = makeEnvelope({
      authority: {
        userConfirmation: 'not_required',
        reviewerOverride: false,
        acceptAuthority: 'reviewer_aligned',
      },
      actions: [{ type: 'accept_task', rationale: 'reviewer_aligned', summary: 'All tests pass, reviewer approved' }],
    });

    logEnvelopeDecision(logger, {
      observations: [makeObservation({ source: 'reviewer', type: 'review_output', summary: '[APPROVED] looks good' })],
      envelope,
      executionResults: [],
    });

    const entries = logger.getEntries();
    const decision = entries[0].decision as Record<string, unknown>;
    const actions = decision.actions as Array<Record<string, unknown>>;
    const acceptAction = actions.find(a => a.type === 'accept_task') as Record<string, unknown>;
    expect(acceptAction.rationale).toBe('reviewer_aligned');
    expect(acceptAction.summary).toBe('All tests pass, reviewer approved');
  });

  it('AC-4: forced_stop rationale traceable with user message', () => {
    const logger = new GodAuditLogger(tmpDir);
    const envelope = makeEnvelope({
      authority: {
        userConfirmation: 'not_required',
        reviewerOverride: false,
        acceptAuthority: 'forced_stop',
      },
      actions: [{ type: 'accept_task', rationale: 'forced_stop', summary: 'Max rounds exceeded, stopping' }],
      messages: [
        { target: 'user', content: 'Task stopped: max rounds exceeded' },
        { target: 'system_log', content: 'forced stop after 10 rounds' },
      ],
    });

    logEnvelopeDecision(logger, {
      observations: [makeObservation()],
      envelope,
      executionResults: [],
    });

    const entries = logger.getEntries();
    const decision = entries[0].decision as Record<string, unknown>;
    const actions = decision.actions as Array<Record<string, unknown>>;
    const acceptAction = actions.find(a => a.type === 'accept_task') as Record<string, unknown>;
    expect(acceptAction.rationale).toBe('forced_stop');
    expect(acceptAction.summary).toBe('Max rounds exceeded, stopping');
  });

  // ── AC-6: JSONL format backward compatible ──

  it('AC-6: enhanced entries still have all original GodAuditEntry fields', () => {
    const logger = new GodAuditLogger(tmpDir);

    logEnvelopeDecision(logger, {
      observations: [makeObservation()],
      envelope: makeEnvelope(),
      executionResults: [],
    });

    const entries = logger.getEntries();
    const entry = entries[0];

    // Original fields must be present
    expect(entry.seq).toBe(1);
    expect(entry.timestamp).toBeDefined();
    expect(entry.decisionType).toBeDefined();
    expect(entry.inputSummary).toBeDefined();
    expect(entry.outputSummary).toBeDefined();
    expect(entry.decision).toBeDefined();
  });

  it('AC-6: existing append() still works alongside logEnvelopeDecision', () => {
    const logger = new GodAuditLogger(tmpDir);

    // Old-style append
    logger.append({
      timestamp: new Date().toISOString(),
      decisionType: 'post_coder',
      inputSummary: 'legacy input',
      outputSummary: 'legacy output',
      decision: { action: 'continue' },
    });

    // New-style logEnvelopeDecision
    logEnvelopeDecision(logger, {
      observations: [makeObservation()],
      envelope: makeEnvelope(),
      executionResults: [],
    });

    const entries = logger.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].seq).toBe(1);
    expect(entries[0].decisionType).toBe('post_coder');
    expect(entries[1].seq).toBe(2);
    expect(entries[1].decisionType).toBe('god_decision');
  });

  it('AC-6: inputSummary and outputSummary preserve up to 2000 chars', () => {
    const logger = new GodAuditLogger(tmpDir);
    const shortStr = 'x'.repeat(600);
    logger.append({
      timestamp: new Date().toISOString(),
      decisionType: 'test',
      inputSummary: shortStr,
      outputSummary: shortStr,
      decision: {},
    });

    const entries = logger.getEntries();
    expect(entries[0].inputSummary.length).toBe(600);
    expect(entries[0].outputSummary.length).toBe(600);
  });

  it('AC-6: inputSummary and outputSummary are truncated at 2000 chars', () => {
    const logger = new GodAuditLogger(tmpDir);
    const longStr = 'x'.repeat(3000);
    logger.append({
      timestamp: new Date().toISOString(),
      decisionType: 'test',
      inputSummary: longStr,
      outputSummary: longStr,
      decision: {},
    });

    const entries = logger.getEntries();
    expect(entries[0].inputSummary.length).toBe(2000);
    expect(entries[0].outputSummary.length).toBe(2000);
    expect(entries[0].inputSummary.endsWith('…')).toBe(true);
  });

  it('AC-6: truncation does not break surrogate pairs (emoji at boundary)', () => {
    const logger = new GodAuditLogger(tmpDir);
    // 1998 'a's + '😀' (surrogate pair at code-unit positions 1998-1999) + 'x'
    // Total length = 2001 code units > 2000, triggers truncation
    // slice(0, 1999) would cut inside the surrogate pair, leaving a lone high surrogate
    const input = 'a'.repeat(1998) + '😀' + 'x';
    expect(input.length).toBe(2001); // sanity check

    logger.append({
      timestamp: new Date().toISOString(),
      decisionType: 'test',
      inputSummary: input,
      outputSummary: input,
      decision: {},
    });

    const entries = logger.getEntries();
    // Should not contain a lone high surrogate — must end cleanly with '…'
    expect(entries[0].inputSummary.endsWith('…')).toBe(true);
    // The lone high surrogate should be dropped: 1998 'a's + '…' = 1999 chars
    expect(entries[0].inputSummary.length).toBe(1999);
    // Verify no broken characters: round-trip through JSON
    const roundTripped = JSON.parse(JSON.stringify(entries[0].inputSummary));
    expect(roundTripped).toBe(entries[0].inputSummary);
  });

  // ── Full JSON archive ──

  it('logEnvelopeDecision stores full envelope in god-decisions/', () => {
    const logger = new GodAuditLogger(tmpDir);
    const envelope = makeEnvelope({
      diagnosis: {
        summary: 'detailed analysis here',
        currentGoal: 'goal',
        currentPhaseId: 'p1',
        notableObservations: ['obs1', 'obs2'],
      },
    });

    logEnvelopeDecision(logger, {
      observations: [makeObservation()],
      envelope,
      executionResults: [],
    });

    const entries = logger.getEntries();
    expect(entries[0].outputRef).toBeDefined();
    expect(entries[0].outputRef).toMatch(/^god-decisions\//);

    // Verify file contains full envelope + observations
    const refPath = path.join(tmpDir, entries[0].outputRef!);
    expect(fs.existsSync(refPath)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(refPath, 'utf-8'));
    expect(stored.envelope).toBeDefined();
    expect(stored.observations).toBeDefined();
    expect(stored.executionResults).toBeDefined();
  });

  // ── NFR-006: God decision log readability ──

  it('NFR-006: inputSummary is human-readable with observation types and severities', () => {
    const logger = new GodAuditLogger(tmpDir);
    const observations = [
      makeObservation({ type: 'quota_exhausted', severity: 'error', summary: 'rate limit' }),
      makeObservation({ type: 'work_output', severity: 'info', summary: 'code ok' }),
    ];

    logEnvelopeDecision(logger, {
      observations,
      envelope: makeEnvelope(),
      executionResults: [],
    });

    const entries = logger.getEntries();
    // inputSummary should mention observation types
    expect(entries[0].inputSummary).toContain('quota_exhausted');
    expect(entries[0].inputSummary).toContain('work_output');
  });

  it('NFR-006: outputSummary includes diagnosis and action types', () => {
    const logger = new GodAuditLogger(tmpDir);
    const envelope = makeEnvelope({
      diagnosis: { summary: 'Switching adapter due to quota', currentGoal: 'g', currentPhaseId: 'p', notableObservations: [] },
      actions: [
        { type: 'switch_adapter', role: 'coder', adapter: 'gemini', reason: 'quota' },
        { type: 'send_to_coder', message: 'retry' },
      ],
    });

    logEnvelopeDecision(logger, {
      observations: [makeObservation()],
      envelope,
      executionResults: [],
    });

    const entries = logger.getEntries();
    expect(entries[0].outputSummary).toContain('switch_adapter');
    expect(entries[0].outputSummary).toContain('send_to_coder');
    expect(entries[0].outputSummary).toContain('Switching adapter due to quota');
  });

  // ── No overrides when not applicable ──

  it('no overrides section when authority is standard', () => {
    const logger = new GodAuditLogger(tmpDir);
    const envelope = makeEnvelope({
      authority: {
        userConfirmation: 'not_required',
        reviewerOverride: false,
        acceptAuthority: 'reviewer_aligned',
      },
    });

    logEnvelopeDecision(logger, {
      observations: [makeObservation()],
      envelope,
      executionResults: [],
    });

    const entries = logger.getEntries();
    const decision = entries[0].decision as Record<string, unknown>;
    expect(decision.overrides).toBeUndefined();
  });
});
