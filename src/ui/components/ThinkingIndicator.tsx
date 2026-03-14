import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import type { Message, RoleName } from '../../types/ui.js';

export interface ThinkingIndicatorProps {
  columns: number;
}

const SPINNER_CHARS = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
const SPIN_INTERVAL_MS = 80;

/**
 * Check whether a role represents an LLM assistant (not user, not system).
 */
function isAssistantRole(role: RoleName): boolean {
  return role !== 'user' && role !== 'system';
}

/**
 * Check whether a message is an empty streaming placeholder — the assistant
 * message that App.tsx creates before any tokens arrive.
 */
function isEmptyStreamingPlaceholder(message: Message): boolean {
  return message.isStreaming === true && message.content.trim() === '';
}

/**
 * Determine whether the thinking indicator should be visible.
 *
 * Shows only when the LLM is running AND no *real* assistant output has
 * appeared since the last user message. Walks the message array backwards:
 * - Empty streaming assistant placeholder → skip (not real output yet)
 * - Non-empty assistant message → LLM has started outputting → hide
 * - User message reached → still waiting for output → show
 * - Only system messages or empty array → show (first turn)
 */
export function shouldShowThinking(
  isLLMRunning: boolean,
  messages: Message[],
): boolean {
  if (!isLLMRunning) return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (isAssistantRole(msg.role)) {
      // Empty streaming placeholder doesn't count as real output
      if (isEmptyStreamingPlaceholder(msg)) continue;
      return false;
    }
    if (msg.role === 'user') return true;
  }

  // Empty array or only system messages — LLM is running on first turn
  return true;
}

export function ThinkingIndicator({ columns }: ThinkingIndicatorProps): React.ReactElement {
  const [frame, setFrame] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Reset frame on mount (fresh animation each time indicator appears)
    setFrame(0);

    intervalRef.current = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_CHARS.length);
    }, SPIN_INTERVAL_MS);

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);

  const spinner = SPINNER_CHARS[frame]!;

  return (
    <Box height={1} width={columns}>
      <Text color="cyan">{spinner}</Text>
      <Text dimColor> Thinking...</Text>
    </Box>
  );
}
