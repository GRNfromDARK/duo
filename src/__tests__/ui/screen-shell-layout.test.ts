import { describe, expect, it } from 'vitest';
import {
  computeOverlaySurfaceWidth,
  computeSessionContentWidth,
  computeSetupDividerWidth,
  computeSetupSurfaceWidth,
  OVERLAY_SURFACE_MAX_WIDTH,
  SESSION_CONTENT_MAX_WIDTH,
  SETUP_SURFACE_MAX_WIDTH,
} from '../../ui/screen-shell-layout.js';

describe('screen shell layout', () => {
  it('keeps setup surfaces aligned to the branded frame on wide terminals', () => {
    expect(computeSetupSurfaceWidth(120)).toBe(SETUP_SURFACE_MAX_WIDTH);
    expect(computeSetupDividerWidth(SETUP_SURFACE_MAX_WIDTH)).toBe(60);
  });

  it('shrinks setup surfaces on narrower terminals without collapsing below a usable width', () => {
    expect(computeSetupSurfaceWidth(56)).toBe(50);
    expect(computeSetupSurfaceWidth(40)).toBe(44);
  });

  it('caps overlay and session reading columns independently', () => {
    expect(computeOverlaySurfaceWidth(140)).toBe(OVERLAY_SURFACE_MAX_WIDTH);
    expect(computeSessionContentWidth(140)).toBe(SESSION_CONTENT_MAX_WIDTH);
    expect(computeOverlaySurfaceWidth(60)).toBe(54);
    expect(computeSessionContentWidth(60)).toBe(54);
  });
});
