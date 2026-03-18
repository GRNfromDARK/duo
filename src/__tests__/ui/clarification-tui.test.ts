/**
 * Card E.2: TUI tests for CLARIFYING state display.
 * Source: FR-012, AC-8 (TUI 显示 God 追问和输入框)
 */
import { describe, it, expect } from 'vitest';
import {
  formatGodMessage,
  shouldShowGodMessage,
  type GodMessageType,
} from '../../ui/god-message-style.js';
import { createObservation } from '../../god/observation-classifier.js';

describe('Card E.2: TUI clarification', () => {
  describe('god-message-style: clarification type', () => {
    it('formatGodMessage supports clarification type', () => {
      const lines = formatGodMessage('What files should I modify?', 'clarification' as GodMessageType);
      expect(lines.length).toBeGreaterThan(2); // top + content + bottom
      expect(lines.some(l => l.includes('Clarification'))).toBe(true);
    });

    it('shouldShowGodMessage returns true for clarification', () => {
      expect(shouldShowGodMessage('clarification' as GodMessageType)).toBe(true);
    });
  });

  describe('clarification observation creation', () => {
    it('creates clarification_answer observation from user input', () => {
      const obs = createObservation('clarification_answer', 'human', 'Please modify the auth module', {
        severity: 'info',
        rawRef: 'Please modify the auth module',
      });
      expect(obs.type).toBe('clarification_answer');
      expect(obs.source).toBe('human');
      expect(obs.severity).toBe('info');
      expect(obs.summary).toBe('Please modify the auth module');
    });
  });
});
