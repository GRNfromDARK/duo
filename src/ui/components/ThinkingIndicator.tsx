import React, { useState, useEffect, useRef } from 'react';
import { Text } from '../../tui/primitives.js';
import type { Message, RoleName } from '../../types/ui.js';
import { Row } from '../tui-layout.js';

export interface ThinkingIndicatorProps {
  columns: number;
  /** Custom message to display (default: "Thinking...") */
  message?: string;
  /** Spinner/message color (default: "cyan") */
  color?: string;
  /** Whether to show elapsed time counter (default: false) */
  showElapsed?: boolean;
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
 * appeared for the current turn. Walks the message array backwards:
 * - Empty streaming assistant placeholder → show (waiting for first token)
 * - Actively streaming with content → LLM producing output → hide
 * - Completed (non-streaming) assistant message → new iteration starting,
 *   streaming message not yet created → show
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
      // Empty streaming placeholder = waiting for first token → show
      if (isEmptyStreamingPlaceholder(msg)) return true;
      // Actively streaming with content = LLM producing output → hide
      if (msg.isStreaming) return false;
      // Completed message (not streaming) while LLM is running =
      // new iteration starting, streaming message not yet created → show
      return true;
    }
    if (msg.role === 'user') return true;
  }

  // Empty array or only system messages — LLM is running on first turn
  return true;
}

export function ThinkingIndicator({
  columns,
  message = 'Thinking...',
  color = 'cyan',
  showElapsed = false,
}: ThinkingIndicatorProps): React.ReactElement {
  const [frame, setFrame] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Reset frame on mount (fresh animation each time indicator appears)
    setFrame(0);
    setElapsedSeconds(0);

    intervalRef.current = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_CHARS.length);
    }, SPIN_INTERVAL_MS);

    if (showElapsed) {
      elapsedRef.current = setInterval(() => {
        setElapsedSeconds((s) => s + 1);
      }, 1000);
    }

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (elapsedRef.current !== null) {
        clearInterval(elapsedRef.current);
        elapsedRef.current = null;
      }
    };
  }, [showElapsed]);

  const spinner = SPINNER_CHARS[frame]!;

  // Color escalation for long waits when showing elapsed time
  const effectiveColor = showElapsed && elapsedSeconds >= 60
    ? 'red'
    : showElapsed && elapsedSeconds >= 30
      ? 'yellow'
      : color;

  const elapsedSuffix = showElapsed ? ` (${elapsedSeconds}s)` : '';

  return (
    <Row height={1} width={columns}>
      <Text color={effectiveColor}>{spinner}</Text>
      <Text color={effectiveColor}> {message}{elapsedSuffix}</Text>
    </Row>
  );
}
