import { describe, expect, it } from 'vitest';
import {
  SETUP_FEATURE_BULLETS,
  SETUP_HERO_SLOGAN,
  SETUP_HERO_SUBHEAD,
} from '../../ui/setup-copy.js';

describe('setup copy', () => {
  it('emphasizes coder, reviewer, and god workflow', () => {
    expect(SETUP_HERO_SLOGAN).toContain('Coder');
    expect(SETUP_HERO_SLOGAN).toContain('Reviewer');
    expect(SETUP_HERO_SLOGAN).toContain('God');
  });

  it('communicates convergence-oriented collaboration', () => {
    expect(SETUP_HERO_SUBHEAD.toLowerCase()).toContain('conver');
  });

  it('keeps hero bullets concise for terminal width', () => {
    expect(SETUP_FEATURE_BULLETS).toHaveLength(3);
    for (const bullet of SETUP_FEATURE_BULLETS) {
      expect(bullet.length).toBeLessThanOrEqual(56);
    }
  });
});
