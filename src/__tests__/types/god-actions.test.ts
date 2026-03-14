import { describe, it, expect } from 'vitest';
import {
  SendToCoderSchema,
  SendToReviewerSchema,
  StopRoleSchema,
  RetryRoleSchema,
  SwitchAdapterSchema,
  SetPhaseSchema,
  AcceptTaskSchema,
  WaitSchema,
  RequestUserInputSchema,
  ResumeAfterInterruptSchema,
  EmitSummarySchema,
  GodActionSchema,
} from '../../types/god-actions.js';
import type { GodAction } from '../../types/god-actions.js';

describe('Individual GodAction schemas', () => {
  it('should validate send_to_coder', () => {
    const action = { type: 'send_to_coder', message: 'Implement the login page' };
    expect(() => SendToCoderSchema.parse(action)).not.toThrow();
  });

  it('should validate send_to_reviewer', () => {
    const action = { type: 'send_to_reviewer', message: 'Review the implementation' };
    expect(() => SendToReviewerSchema.parse(action)).not.toThrow();
  });

  it('should validate stop_role', () => {
    const action = { type: 'stop_role', role: 'coder', reason: 'Quota exhausted' };
    expect(() => StopRoleSchema.parse(action)).not.toThrow();
  });

  it('should validate stop_role for reviewer', () => {
    const action = { type: 'stop_role', role: 'reviewer', reason: 'Not needed' };
    expect(() => StopRoleSchema.parse(action)).not.toThrow();
  });

  it('should validate retry_role without hint', () => {
    const action = { type: 'retry_role', role: 'coder' };
    expect(() => RetryRoleSchema.parse(action)).not.toThrow();
  });

  it('should validate retry_role with hint', () => {
    const action = { type: 'retry_role', role: 'reviewer', hint: 'Focus on edge cases' };
    const parsed = RetryRoleSchema.parse(action);
    expect(parsed.hint).toBe('Focus on edge cases');
  });

  // AC-7: switch_adapter can specify role: 'god'
  it('AC-7: switch_adapter should accept role god', () => {
    const action = { type: 'switch_adapter', role: 'god', adapter: 'codex', reason: 'Fallback' };
    expect(() => SwitchAdapterSchema.parse(action)).not.toThrow();
  });

  it('should validate switch_adapter for coder', () => {
    const action = { type: 'switch_adapter', role: 'coder', adapter: 'codex', reason: 'Performance' };
    expect(() => SwitchAdapterSchema.parse(action)).not.toThrow();
  });

  it('should validate switch_adapter for reviewer', () => {
    const action = { type: 'switch_adapter', role: 'reviewer', adapter: 'claude-code', reason: 'Quality' };
    expect(() => SwitchAdapterSchema.parse(action)).not.toThrow();
  });

  it('should validate set_phase with summary', () => {
    const action = { type: 'set_phase', phaseId: 'phase-2', summary: 'Moving to review' };
    const parsed = SetPhaseSchema.parse(action);
    expect(parsed.phaseId).toBe('phase-2');
    expect(parsed.summary).toBe('Moving to review');
  });

  it('should validate set_phase without summary', () => {
    const action = { type: 'set_phase', phaseId: 'phase-1' };
    expect(() => SetPhaseSchema.parse(action)).not.toThrow();
  });

  // AC-6: accept_task must carry rationale field — missing rationale fails
  it('AC-6: accept_task should fail without rationale', () => {
    const action = { type: 'accept_task', summary: 'Task done' };
    expect(() => AcceptTaskSchema.parse(action)).toThrow();
  });

  it('should validate accept_task with reviewer_aligned', () => {
    const action = { type: 'accept_task', rationale: 'reviewer_aligned', summary: 'Approved by reviewer' };
    expect(() => AcceptTaskSchema.parse(action)).not.toThrow();
  });

  it('should validate accept_task with god_override', () => {
    const action = { type: 'accept_task', rationale: 'god_override', summary: 'God decided to accept' };
    expect(() => AcceptTaskSchema.parse(action)).not.toThrow();
  });

  it('should validate accept_task with forced_stop', () => {
    const action = { type: 'accept_task', rationale: 'forced_stop', summary: 'Forced stop with partial result' };
    expect(() => AcceptTaskSchema.parse(action)).not.toThrow();
  });

  it('should reject accept_task with invalid rationale', () => {
    const action = { type: 'accept_task', rationale: 'invalid', summary: 'bad' };
    expect(() => AcceptTaskSchema.parse(action)).toThrow();
  });

  it('should validate wait with estimatedSeconds', () => {
    const action = { type: 'wait', reason: 'Rate limited', estimatedSeconds: 300 };
    const parsed = WaitSchema.parse(action);
    expect(parsed.estimatedSeconds).toBe(300);
  });

  it('should validate wait without estimatedSeconds', () => {
    const action = { type: 'wait', reason: 'Rate limited' };
    expect(() => WaitSchema.parse(action)).not.toThrow();
  });

  it('should validate request_user_input', () => {
    const action = { type: 'request_user_input', question: 'Which approach do you prefer?' };
    expect(() => RequestUserInputSchema.parse(action)).not.toThrow();
  });

  it('should validate resume_after_interrupt with continue', () => {
    const action = { type: 'resume_after_interrupt', resumeStrategy: 'continue' };
    expect(() => ResumeAfterInterruptSchema.parse(action)).not.toThrow();
  });

  it('should validate resume_after_interrupt with redirect', () => {
    const action = { type: 'resume_after_interrupt', resumeStrategy: 'redirect' };
    expect(() => ResumeAfterInterruptSchema.parse(action)).not.toThrow();
  });

  it('should validate resume_after_interrupt with stop', () => {
    const action = { type: 'resume_after_interrupt', resumeStrategy: 'stop' };
    expect(() => ResumeAfterInterruptSchema.parse(action)).not.toThrow();
  });

  it('should validate emit_summary', () => {
    const action = { type: 'emit_summary', content: 'Task completed successfully' };
    expect(() => EmitSummarySchema.parse(action)).not.toThrow();
  });
});

// AC-5: All 11 Hand types have Zod schema and pass parse validation
describe('AC-5: GodAction discriminated union', () => {
  const validActions: GodAction[] = [
    { type: 'send_to_coder', message: 'code this' },
    { type: 'send_to_reviewer', message: 'review this' },
    { type: 'stop_role', role: 'coder', reason: 'done' },
    { type: 'retry_role', role: 'reviewer' },
    { type: 'switch_adapter', role: 'god', adapter: 'codex', reason: 'fallback' },
    { type: 'set_phase', phaseId: 'phase-1' },
    { type: 'accept_task', rationale: 'reviewer_aligned', summary: 'approved' },
    { type: 'wait', reason: 'rate limited' },
    { type: 'request_user_input', question: 'what next?' },
    { type: 'resume_after_interrupt', resumeStrategy: 'continue' },
    { type: 'emit_summary', content: 'summary text' },
  ];

  it('should have exactly 11 action types', () => {
    expect(validActions).toHaveLength(11);
  });

  it.each(validActions.map((a) => [a.type, a]))('should validate %s via union schema', (_type, action) => {
    expect(() => GodActionSchema.parse(action)).not.toThrow();
  });

  it('should reject unknown action type', () => {
    expect(() => GodActionSchema.parse({ type: 'unknown_action' })).toThrow();
  });

  it('should reject action with wrong type field value', () => {
    expect(() => GodActionSchema.parse({ type: 'send_to_coder' })).toThrow(); // missing message
  });
});

// AC-8: No natural-language implicit path for set_phase/accept_task
// (This is ensured by the type system — set_phase requires phaseId, accept_task requires rationale+summary)
describe('AC-8: Structural schema prevents implicit completion', () => {
  it('set_phase requires phaseId — cannot be triggered by just a message', () => {
    expect(() => SetPhaseSchema.parse({ type: 'set_phase' })).toThrow();
    expect(() => SetPhaseSchema.parse({ type: 'set_phase', message: 'go to phase 3' })).toThrow();
  });

  it('accept_task requires rationale and summary — cannot be triggered by just a message', () => {
    expect(() => AcceptTaskSchema.parse({ type: 'accept_task' })).toThrow();
    expect(() => AcceptTaskSchema.parse({ type: 'accept_task', message: 'accept it' })).toThrow();
  });
});
