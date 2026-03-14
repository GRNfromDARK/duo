import { describe, expect, it } from 'vitest';
import { buildContinuedTaskPrompt } from '../../ui/completion-flow.js';

describe('buildContinuedTaskPrompt', () => {
  it('preserves the original task and appends the new follow-up requirement', () => {
    expect(
      buildContinuedTaskPrompt(
        'Ship the auth flow',
        'Add audit logging for login failures',
      ),
    ).toBe(
      [
        'Ship the auth flow',
        '',
        'Additional user requirement:',
        'Add audit logging for login failures',
      ].join('\n'),
    );
  });

  it('trims surrounding whitespace from the follow-up requirement', () => {
    expect(
      buildContinuedTaskPrompt(
        'Ship the auth flow',
        '  Add audit logging for login failures  ',
      ),
    ).toContain('Add audit logging for login failures');
  });
});
