/**
 * Tests for GodDecisionEnvelope + Authority types.
 * Card: A.2
 * Covers: AC-1 through AC-9
 */

import { describe, it, expect } from 'vitest';

// Will be implemented in src/types/god-envelope.ts
import { GodDecisionEnvelopeSchema } from '../../types/god-envelope.js';

/** Helper: build a valid envelope base for testing. */
function validEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    diagnosis: {
      summary: 'Coder completed implementation',
      currentGoal: 'Implement login feature',
      currentPhaseId: 'phase-1',
      notableObservations: ['work_output received from coder'],
    },
    authority: {
      userConfirmation: 'not_required' as const,
      reviewerOverride: false,
      acceptAuthority: 'reviewer_aligned' as const,
    },
    actions: [
      { type: 'send_to_reviewer', message: 'Please review the implementation' },
    ],
    messages: [
      { target: 'system_log' as const, content: 'Routing to reviewer after coder output' },
    ],
    ...overrides,
  };
}

describe('GodDecisionEnvelope', () => {
  // AC-1: God can express userConfirmation = 'god_override'
  it('AC-1: accepts userConfirmation = god_override', () => {
    const envelope = validEnvelope({
      authority: {
        userConfirmation: 'god_override',
        reviewerOverride: false,
        acceptAuthority: 'reviewer_aligned',
      },
      messages: [
        { target: 'system_log', content: 'God overriding user confirmation: task is straightforward' },
      ],
    });
    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  // AC-2: God can express reviewerOverride = true
  it('AC-2: accepts reviewerOverride = true with system_log message', () => {
    const envelope = validEnvelope({
      authority: {
        userConfirmation: 'not_required',
        reviewerOverride: true,
        acceptAuthority: 'god_override',
      },
      messages: [
        { target: 'system_log', content: 'Override reason: reviewer feedback is cosmetic, not blocking' },
      ],
    });
    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  // AC-3: actions and messages can coexist in one envelope
  it('AC-3: actions and messages coexist in one envelope', () => {
    const envelope = validEnvelope({
      actions: [
        { type: 'send_to_coder', message: 'Fix the typo in line 42' },
        { type: 'set_phase', phaseId: 'phase-2', summary: 'Moving to review phase' },
      ],
      messages: [
        { target: 'user', content: 'Starting phase 2' },
        { target: 'system_log', content: 'Phase transition logged' },
      ],
    });
    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.actions).toHaveLength(2);
      expect(result.data.messages).toHaveLength(2);
    }
  });

  // AC-4: Zod refine rejects reviewerOverride=true without system_log message
  it('AC-4: rejects reviewerOverride=true without system_log message', () => {
    const envelope = validEnvelope({
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
    if (!result.success) {
      const errorMessage = result.error.issues.map((i: { message: string }) => i.message).join('; ');
      expect(errorMessage).toMatch(/reviewerOverride.*system_log/i);
    }
  });

  // AC-5: Zod refine rejects acceptAuthority='god_override' without system_log message
  it('AC-5: rejects acceptAuthority=god_override without system_log message', () => {
    const envelope = validEnvelope({
      authority: {
        userConfirmation: 'not_required',
        reviewerOverride: false,
        acceptAuthority: 'god_override',
      },
      messages: [
        { target: 'user', content: 'Done' },
      ],
    });
    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMessage = result.error.issues.map((i: { message: string }) => i.message).join('; ');
      expect(errorMessage).toMatch(/acceptAuthority.*god_override.*system_log/i);
    }
  });

  // AC-6: Zod refine rejects acceptAuthority='forced_stop' without user target message
  it('AC-6: rejects acceptAuthority=forced_stop without user target message', () => {
    const envelope = validEnvelope({
      authority: {
        userConfirmation: 'not_required',
        reviewerOverride: false,
        acceptAuthority: 'forced_stop',
      },
      messages: [
        { target: 'system_log', content: 'Forced stop due to max rounds' },
      ],
    });
    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMessage = result.error.issues.map((i: { message: string }) => i.message).join('; ');
      expect(errorMessage).toMatch(/forced_stop.*user/i);
    }
  });

  // AC-7: Type-level separation — messages type does not overlap with action types
  it('AC-7: messages target is limited to coder|reviewer|user|system_log, no action types leak', () => {
    const envelope = validEnvelope();
    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
    if (result.success) {
      // Verify messages have 'target' + 'content' structure (not 'type' like actions)
      for (const msg of result.data.messages) {
        expect(msg).toHaveProperty('target');
        expect(msg).toHaveProperty('content');
        expect(msg).not.toHaveProperty('type');
      }
    }
  });

  // AC-4 additional: reviewerOverride=true with system_log but empty content should still pass
  // (the constraint is "must have system_log message", content is freeform)
  it('AC-4 edge: reviewerOverride=true with system_log message passes', () => {
    const envelope = validEnvelope({
      authority: {
        userConfirmation: 'not_required',
        reviewerOverride: true,
        acceptAuthority: 'reviewer_aligned',
      },
      messages: [
        { target: 'system_log', content: 'Override: reviewer nitpick, not blocking' },
      ],
    });
    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  // AC-6 additional: forced_stop WITH user message should pass
  it('AC-6 edge: forced_stop with user target message passes', () => {
    const envelope = validEnvelope({
      authority: {
        userConfirmation: 'not_required',
        reviewerOverride: false,
        acceptAuthority: 'forced_stop',
      },
      messages: [
        { target: 'user', content: 'Task stopped: max rounds reached. Summary: partial implementation completed.' },
        { target: 'system_log', content: 'forced_stop triggered' },
      ],
    });
    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  // Structural validation: invalid target in messages
  it('rejects invalid message target', () => {
    const envelope = validEnvelope({
      messages: [
        { target: 'invalid_target', content: 'hello' },
      ],
    });
    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
  });

  // Structural validation: invalid action in actions array
  it('rejects invalid action type in actions', () => {
    const envelope = validEnvelope({
      actions: [
        { type: 'nonexistent_action', foo: 'bar' },
      ],
    });
    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
  });

  // Empty actions array is valid (God may only send messages)
  it('accepts empty actions array', () => {
    const envelope = validEnvelope({
      actions: [],
    });
    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  // Empty messages array is valid (when no override/forced_stop constraints apply)
  it('accepts empty messages array when no authority constraints require messages', () => {
    const envelope = validEnvelope({
      messages: [],
    });
    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  // Combined constraint: both reviewerOverride and god_override need system_log
  it('accepts envelope satisfying both reviewerOverride and god_override with single system_log', () => {
    const envelope = validEnvelope({
      authority: {
        userConfirmation: 'god_override',
        reviewerOverride: true,
        acceptAuthority: 'god_override',
      },
      messages: [
        { target: 'system_log', content: 'God override: reviewer feedback is cosmetic; user confirmation not needed for this routine task' },
      ],
    });
    const result = GodDecisionEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });
});
