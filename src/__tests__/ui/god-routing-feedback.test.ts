import { describe, expect, it } from 'vitest';
import { filterMessages } from '../../ui/display-mode.js';
import { buildPostCodeRoutingFeedback } from '../../ui/god-routing-feedback.js';

describe('buildPostCodeRoutingFeedback', () => {
  it('creates a visible system message when God forwards coder output to reviewer', () => {
    const message = buildPostCodeRoutingFeedback({
      action: 'continue_to_review',
      reviewerName: 'Codex',
      coderName: 'Claude Code',
    });

    expect(message).toMatchObject({
      role: 'system',
      content: 'God routing: coder output approved, forwarding to Codex.',
    });
    expect(message.metadata?.isRoutingEvent).toBeUndefined();

    const visible = filterMessages([
      {
        id: 'msg-1',
        timestamp: Date.now(),
        ...message,
      },
    ], 'minimal');

    expect(visible).toHaveLength(1);
    expect(visible[0]?.content).toContain('forwarding to Codex');
  });

  it('creates a visible system message when God sends the work back to coder', () => {
    const message = buildPostCodeRoutingFeedback({
      action: 'retry_coder',
      reviewerName: 'Codex',
      coderName: 'Claude Code',
    });

    expect(message).toMatchObject({
      role: 'system',
      content: 'God routing: requested another coder pass from Claude Code.',
    });
    expect(message.metadata?.isRoutingEvent).toBeUndefined();
  });
});
