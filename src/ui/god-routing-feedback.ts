import type { Message } from '../types/ui.js';
import type { GodPostCoderDecision } from '../types/god-schemas.js';

interface PostCodeRoutingFeedbackInput {
  action: GodPostCoderDecision['action'];
  reviewerName: string;
  coderName: string;
}

type SystemMessageDraft = Omit<Message, 'id' | 'timestamp'>;

export function buildPostCodeRoutingFeedback({
  action,
  reviewerName,
  coderName,
}: PostCodeRoutingFeedbackInput): SystemMessageDraft {
  switch (action) {
    case 'continue_to_review':
      return {
        role: 'system',
        content: `God routing: coder output approved, forwarding to ${reviewerName}.`,
      };
    case 'retry_coder':
      return {
        role: 'system',
        content: `God routing: requested another coder pass from ${coderName}.`,
      };
  }
}
