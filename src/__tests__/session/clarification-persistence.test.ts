/**
 * Card E.2: Session persistence for clarification context.
 * Source: FR-012, FR-013 — clarification context preserved for duo resume.
 */
import { describe, it, expect } from 'vitest';
import type { SessionState } from '../../session/session-manager.js';
import { restoreGodSession } from '../../god/god-session-persistence.js';

describe('Card E.2: session persistence for clarification', () => {
  it('SessionState supports clarification field', () => {
    const state: SessionState = {
      status: 'clarifying',
      currentRole: 'coder',
      clarification: {
        frozenActiveProcess: 'coder',
        clarificationRound: 2,
      },
    };
    expect(state.clarification).toBeDefined();
    expect(state.clarification!.frozenActiveProcess).toBe('coder');
    expect(state.clarification!.clarificationRound).toBe(2);
  });

  it('SessionState without clarification is backward compatible', () => {
    const state: SessionState = {
      status: 'coding',
      currentRole: 'coder',
    };
    expect(state.clarification).toBeUndefined();
  });

  it('restoreGodSession still returns null (intentionally disabled)', async () => {
    const state: SessionState = {
      status: 'clarifying',
      currentRole: 'coder',
      clarification: {
        frozenActiveProcess: 'reviewer',
        clarificationRound: 1,
      },
    };
    const result = await restoreGodSession(state, () => ({} as any));
    expect(result).toBeNull();
  });
});
