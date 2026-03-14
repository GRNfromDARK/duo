/**
 * Tests for the upgraded startup screen header.
 *
 * Verifies:
 * - All content lines fit within 80-column terminals
 * - BrandHeader renders logo, slogan, version, and feature bullets
 * - Layout constants are consistent
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  LOGO_LINES,
  BRAND_SLOGAN,
  FEATURE_BULLETS,
  SEPARATOR_WIDTH,
  MAX_HEADER_CONTENT,
  HEADER_BOX_WIDTH,
  BrandHeader,
} from '../../ui/components/SetupWizard.js';

// Box border (2 chars) + paddingX={3} on each side (6 chars) = 8 chars overhead
const BOX_OVERHEAD = 8;

describe('Startup header — width constraints', () => {
  it('MAX_HEADER_CONTENT + BOX_OVERHEAD fits within 80 columns', () => {
    expect(MAX_HEADER_CONTENT + BOX_OVERHEAD).toBeLessThanOrEqual(80);
  });

  it('every logo line fits within MAX_HEADER_CONTENT', () => {
    for (const line of LOGO_LINES) {
      expect(line.length).toBeLessThanOrEqual(MAX_HEADER_CONTENT);
    }
  });

  it('slogan with indent fits within MAX_HEADER_CONTENT', () => {
    // Rendered as "  " + BRAND_SLOGAN
    const rendered = '  ' + BRAND_SLOGAN;
    expect(rendered.length).toBeLessThanOrEqual(MAX_HEADER_CONTENT);
  });

  it('separator with indent fits within MAX_HEADER_CONTENT', () => {
    const rendered = '  ' + '─'.repeat(SEPARATOR_WIDTH);
    expect(rendered.length).toBeLessThanOrEqual(MAX_HEADER_CONTENT);
  });

  it('every feature bullet with prefix fits within MAX_HEADER_CONTENT', () => {
    const PREFIX = '  ◆ '; // 4 chars
    for (const bullet of FEATURE_BULLETS) {
      expect(PREFIX.length + bullet.length).toBeLessThanOrEqual(MAX_HEADER_CONTENT);
    }
  });

  it('HEADER_BOX_WIDTH fits within 80 columns', () => {
    expect(HEADER_BOX_WIDTH).toBeLessThanOrEqual(80);
  });
});

describe('Startup header — content constants', () => {
  it('LOGO_LINES has 6 rows (block-style ASCII art)', () => {
    expect(LOGO_LINES).toHaveLength(6);
  });

  it('FEATURE_BULLETS has 3 entries', () => {
    expect(FEATURE_BULLETS).toHaveLength(3);
  });

  it('BRAND_SLOGAN is non-empty', () => {
    expect(BRAND_SLOGAN.length).toBeGreaterThan(0);
  });
});

describe('BrandHeader — rendering', () => {
  it('renders the ASCII logo', () => {
    const { lastFrame } = render(<BrandHeader version="1.0.0" />);
    const output = lastFrame()!;
    // Check a distinctive part of the block-letter D
    expect(output).toContain('██████╗');
  });

  it('renders the brand slogan', () => {
    const { lastFrame } = render(<BrandHeader version="1.0.0" />);
    const output = lastFrame()!;
    expect(output).toContain(BRAND_SLOGAN);
  });

  it('renders the version number', () => {
    const { lastFrame } = render(<BrandHeader version="2.5.0" />);
    const output = lastFrame()!;
    expect(output).toContain('v2.5.0');
  });

  it('renders the product tagline', () => {
    const { lastFrame } = render(<BrandHeader version="1.0.0" />);
    const output = lastFrame()!;
    expect(output).toContain('Multi-AI Collaborative Coding Engine');
  });

  it('renders all feature bullets', () => {
    const { lastFrame } = render(<BrandHeader version="1.0.0" />);
    const output = lastFrame()!;
    for (const bullet of FEATURE_BULLETS) {
      expect(output).toContain(bullet);
    }
  });

  it('renders the diamond bullet marker', () => {
    const { lastFrame } = render(<BrandHeader version="1.0.0" />);
    const output = lastFrame()!;
    expect(output).toContain('◆');
  });

  it('renders at least 15 lines (taller banner)', () => {
    const { lastFrame } = render(<BrandHeader version="1.0.0" />);
    const output = lastFrame()!;
    const lines = output.split('\n');
    // The upgraded header should be significantly taller than the original 6 lines
    expect(lines.length).toBeGreaterThanOrEqual(15);
  });

  it('no rendered line exceeds 80 columns', () => {
    const { lastFrame } = render(<BrandHeader version="1.0.0" />);
    const output = lastFrame()!;
    const lines = output.split('\n');
    for (const line of lines) {
      // Strip ANSI escape codes for accurate width measurement
      const stripped = line.replace(/\x1B\[[0-9;]*m/g, '');
      expect(stripped.length).toBeLessThanOrEqual(80);
    }
  });
});
