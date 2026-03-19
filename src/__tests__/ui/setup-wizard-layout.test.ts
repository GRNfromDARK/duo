import { describe, expect, it } from 'vitest';
import {
  buildSetupHeroLayout,
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

  it('compacts the branded hero on short terminals so the active panel stays visible', () => {
    expect(buildSetupHeroLayout(24)).toEqual({
      compact: true,
      showBullets: false,
      showSubhead: true,
      showVersionLine: false,
      topMargin: 0,
    });

    expect(buildSetupHeroLayout(34)).toEqual({
      compact: false,
      showBullets: true,
      showSubhead: true,
      showVersionLine: true,
      topMargin: 1,
    });
  });
});
