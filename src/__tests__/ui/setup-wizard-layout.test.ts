import { describe, expect, it } from 'vitest';
import {
  SETUP_PANEL_WIDTH,
  buildSetupStepperModel,
} from '../../ui/setup-wizard-layout.js';

describe('setup wizard layout', () => {
  it('marks the current grouped step as active', () => {
    const steps = buildSetupStepperModel('reviewer-model');

    expect(steps.map((step) => step.state)).toEqual([
      'complete',
      'complete',
      'active',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('keeps the work panel width aligned with the branded startup frame', () => {
    expect(SETUP_PANEL_WIDTH).toBe(70);
  });
});
