/**
 * Natural-Language Message Dispatcher — routes GodDecisionEnvelope messages.
 * Message dispatch MUST NOT trigger any state change.
 * Only allowed side effects are displayToUser() and auditLogger writes.
 */

import type { EnvelopeMessage } from '../types/god-envelope.js';
import type { GodAuditLogger } from './god-audit.js';
import { formatGodMessage } from '../ui/god-message-style.js';

// ── Types ──

export interface DispatchContext {
  pendingCoderMessage: string | null;
  pendingReviewerMessage: string | null;
  displayToUser: (message: string) => void;
  auditLogger: GodAuditLogger;
}

export interface DispatchResult {
  pendingCoderMessage: string | null;
  pendingReviewerMessage: string | null;
}

// ── Main Function ──

export function dispatchMessages(
  messages: EnvelopeMessage[],
  context: DispatchContext,
): DispatchResult {
  let pendingCoderMessage: string | null = null;
  let pendingReviewerMessage: string | null = null;

  for (const msg of messages) {
    switch (msg.target) {
      case 'coder':
        pendingCoderMessage = pendingCoderMessage
          ? `${pendingCoderMessage}\n${msg.content}`
          : msg.content;
        break;

      case 'reviewer':
        pendingReviewerMessage = pendingReviewerMessage
          ? `${pendingReviewerMessage}\n${msg.content}`
          : msg.content;
        break;

      case 'user': {
        const formatted = formatGodMessage(msg.content, 'auto_decision');
        context.displayToUser(formatted.join('\n'));
        break;
      }

      case 'system_log':
        context.auditLogger.append({
          timestamp: new Date().toISOString(),
          decisionType: 'message_dispatch',
          inputSummary: `system_log message dispatched`,
          outputSummary: msg.content,
          decision: { target: 'system_log', content: msg.content },
        });
        break;
    }
  }

  return { pendingCoderMessage, pendingReviewerMessage };
}
