#!/usr/bin/env bun
/**
 * Real-render regression: mouse-select + Ctrl/Cmd+C copy with identity-based cache.
 *
 * Run:  bun src/__tests__/ui/selection-copy-regression.tsx
 * Also: npm run test:selection
 *
 * Validates the critical paths for the copy fix:
 *
 *   Path 1  – drag finish → 'selection' event writes cache AND auto-copies to clipboard
 *   Path 2  – 5× rapid re-renders → identity preserved (same Selection object)
 *   Path 3  – Ctrl+C with selection → copies text, no interrupt
 *   Path 4  – FORCED FALLBACK: after re-renders, live getSelectedText() returns ''
 *             → Ctrl+C uses cached text via identity-validated fallback
 *   Path 5  – Command+C (key.super, macOS) with selection → copies, no interrupt
 *   Path 6  – Command+C forced fallback → copies cached text
 *   Path 7  – clearSelection → new selection doesn't reuse old cache
 *   Path 8  – no selection + Ctrl+C → interrupt
 *   Path 9  – no selection + Command+C → no-op
 *
 * Key harness details:
 *   - exitOnCtrlC:false prevents renderer.destroy() on Ctrl+C
 *   - Fallback is forced by monkey-patching selection.getSelectedText() to return ''
 *     after re-renders, reliably exercising the cache branch every run
 */

import React, { useState, useEffect, useRef } from 'react';
import { testRender } from '@opentui/react/test-utils';
import { Box, Text, ScrollBox, useInput, useRenderer } from '../../tui/primitives.js';
import { Column, Row, Divider } from '../../ui/tui-layout.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const W = 80;
const H = 24;

// ── Observable state ──────────────────────────────────────────────────────────
let copyPayload: string | null = null;
let interruptFired = false;
let cachedText = '';
let cachedSelObj: object | null = null;
let triggerRerender: (() => void) | null = null;
// Direct spy on renderer.copyToClipboardOSC52 — records every real call
let osc52Calls: string[] = [];

function reset() { copyPayload = null; interruptFired = false; osc52Calls = []; }

// ── Test component: mirrors App.tsx logic including key.super fix ─────────────
function TestApp() {
  const renderer = useRenderer();
  const [counter, setCounter] = useState(0);
  const cacheTextRef = useRef('');
  const cacheSelRef = useRef<object | null>(null);

  triggerRerender = () => setCounter((c) => c + 1);

  // Wrap renderer.copyToClipboardOSC52 to record all calls.
  // This lets us assert the real clipboard API was invoked, not a shadow variable.
  useEffect(() => {
    const origCopy = renderer.copyToClipboardOSC52.bind(renderer);
    renderer.copyToClipboardOSC52 = (text: string, ...args: any[]) => {
      osc52Calls.push(text);
      return origCopy(text, ...args);
    };
  }, [renderer]);

  useEffect(() => {
    const onSelectionFinish = (selection: { getSelectedText?: () => string } | null) => {
      const text = selection?.getSelectedText?.() ?? '';
      cacheTextRef.current = text;
      cacheSelRef.current = selection;
      cachedText = text;
      cachedSelObj = cacheSelRef.current;
      // Auto-copy on selection (mirrors App.tsx)
      if (text) {
        renderer.copyToClipboardOSC52(text);
      }
    };
    renderer.on('selection', onSelectionFinish);
    return () => { renderer.off('selection', onSelectionFinish); };
  }, [renderer]);

  // Mirrors App.tsx: key.super added for macOS Command key
  useInput((input, key) => {
    const isCopyKey = (key.ctrl || key.meta || key.super) && input === 'c';
    if (!isCopyKey) return;

    if (renderer.hasSelection) {
      const currentSel = renderer.getSelection();
      const liveText = currentSel?.getSelectedText() ?? '';
      const cacheValid = currentSel != null && currentSel === cacheSelRef.current;
      const text = liveText || (cacheValid ? cacheTextRef.current : '');
      if (text) {
        renderer.copyToClipboardOSC52(text);
        copyPayload = text;
      }
      return;
    }

    if (!key.ctrl) return;
    interruptFired = true;
  });

  return (
    <Column width={W} height={H}>
      <Row height={1} width={W}><Text inverse>{` Status ${counter} `}</Text></Row>
      <Row height={1}><Divider width={W - 1} /></Row>
      <ScrollBox
        height={H - 5} width={W}
        stickyScroll stickyStart="bottom" scrollY
        viewportCulling={false}
        scrollbarOptions={{ backgroundColor: 'black' }}
      >
        <Row width={W} justifyContent="center">
          <Column width={W - 4}>
            <Row><Text color="cyan" bold>Assistant</Text><Text color="gray"> · 12:00</Text></Row>
            <Row marginTop={1}>
              <Box width={W - 5} flexDirection="column" paddingLeft={1}>
                <Text>Hello World selectable text render={counter}</Text>
              </Box>
            </Row>
            <Row marginTop={1}>
              <Box width={W - 5} flexDirection="column" paddingLeft={1}>
                <Text>Streaming chunk #{counter}</Text>
              </Box>
            </Row>
          </Column>
        </Row>
      </ScrollBox>
      <Column height={3}>
        <Row height={1}><Divider width={W - 1} /></Row>
        <Row height={2}><Text>{' ▸ '}</Text></Row>
      </Column>
    </Column>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(label: string, cond: boolean, detail?: string) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

async function settle(s: any, n = 3) {
  for (let i = 0; i < n; i++) {
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 10));
  }
}

function findText(s: any, search: string): { row: number; col: number } {
  const lines = s.captureCharFrame().split('\n');
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i]!.indexOf(search);
    if (c !== -1) return { row: i, col: c };
  }
  return { row: -1, col: -1 };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Selection + Copy regression (identity-based cache + key.super fix) ===\n');

  // kittyKeyboard: true matches production default (useKittyKeyboard ?? true in renderer).
  // Without it, pressKey('c', { super: true }) won't encode the super modifier,
  // and Command+C tests would silently pass as plain 'c' keypresses.
  const s = await testRender(<TestApp />, { width: W, height: H, exitOnCtrlC: false, kittyKeyboard: true });
  await settle(s, 5);

  const { row: tRow, col: tCol } = findText(s, 'Hello World');
  assert('Text rendered', tRow >= 0);

  // ── Path 1: drag finish → selection event writes cache + auto-copies ─────
  console.log('\n--- Path 1: selection event caches text AND auto-copies at drag-finish ---');
  cachedText = ''; cachedSelObj = null; osc52Calls = [];
  await s.mockMouse.drag(tCol, tRow, tCol + 11, tRow);
  await settle(s);

  assert('hasSelection after drag', s.renderer.hasSelection === true);
  assert('selection event wrote cachedText', cachedText.length > 0, `"${cachedText}"`);
  assert('cachedText contains "Hello"', cachedText.includes('Hello'), `"${cachedText}"`);
  assert('cachedSelObj is set', cachedSelObj !== null);
  // Auto-copy: assert the REAL renderer.copyToClipboardOSC52 was called on drag finish
  assert('AUTO-COPY: copyToClipboardOSC52 called on drag finish',
    osc52Calls.length > 0, `osc52Calls.length=${osc52Calls.length}`);
  assert('AUTO-COPY: OSC52 payload contains "Hello"',
    osc52Calls.some(t => t.includes('Hello')),
    `osc52Calls=${JSON.stringify(osc52Calls)}`);
  assert('AUTO-COPY: OSC52 payload matches cached text',
    osc52Calls.includes(cachedText),
    `osc52Calls=${JSON.stringify(osc52Calls)}, cached="${cachedText}"`);

  const selAfterDrag = s.renderer.getSelection();
  assert('identity: getSelection() === cachedSelObj', selAfterDrag === cachedSelObj);

  // ── Path 2: 5× rapid re-render → identity preserved ────────────────────
  console.log('\n--- Path 2: identity survives rapid re-renders ---');
  const savedCache = cachedText;
  const savedSelObj = cachedSelObj;

  for (let i = 0; i < 5; i++) {
    triggerRerender?.();
    await s.renderOnce();
  }
  await settle(s, 2);

  assert('hasSelection still true', s.renderer.hasSelection === true);
  const selAfterRerenders = s.renderer.getSelection();
  assert('identity preserved: same Selection object', selAfterRerenders === savedSelObj);
  assert('cache text unchanged', cachedText === savedCache);

  // ── Path 3: Ctrl+C with selection → copy (live), no interrupt ───────────
  console.log('\n--- Path 3: Ctrl+C with selection → copy, no interrupt ---');
  reset();
  s.mockInput.pressCtrlC();
  await settle(s, 2);

  assert('copyPayload is non-empty', copyPayload !== null && copyPayload.length > 0,
    `"${copyPayload}"`);
  assert('no interrupt fired', interruptFired === false);

  // ── Path 4: FORCED FALLBACK — monkey-patch getSelectedText to return '' ──
  console.log('\n--- Path 4: forced fallback — Ctrl+C with stale live text ---');
  // Re-select to get a fresh drag + cache
  s.renderer.clearSelection();
  await settle(s);
  await s.mockMouse.drag(tCol, tRow, tCol + 11, tRow);
  await settle(s);

  const selForFallback = s.renderer.getSelection();
  assert('selection exists for fallback test', selForFallback !== null);
  assert('cache matches current selection', selForFallback === cachedSelObj);
  const expectedCacheText = cachedText;
  assert('cache text is non-empty', expectedCacheText.length > 0, `"${expectedCacheText}"`);

  // Monkey-patch: simulate the real failure mode where rapid re-renders
  // cause getSelectedText() to return '' while hasSelection remains true.
  const origGetText = selForFallback!.getSelectedText.bind(selForFallback);
  (selForFallback as any).getSelectedText = () => '';

  // Verify the patch works
  assert('patched getSelectedText returns empty', selForFallback!.getSelectedText() === '');
  assert('hasSelection still true after patch', s.renderer.hasSelection === true);

  reset();
  s.mockInput.pressCtrlC();
  await settle(s, 2);

  assert('FALLBACK: copyPayload matches cached text', copyPayload === expectedCacheText,
    `payload="${copyPayload}", expected="${expectedCacheText}"`);
  assert('FALLBACK: no interrupt', interruptFired === false);

  // Restore
  (selForFallback as any).getSelectedText = origGetText;

  // ── Path 5: Command+C (key.super) with selection → copy ─────────────────
  console.log('\n--- Path 5: Command+C (super) with selection → copy ---');
  s.renderer.clearSelection();
  await settle(s);
  await s.mockMouse.drag(tCol, tRow, tCol + 11, tRow);
  await settle(s);
  assert('selection for Command+C test', s.renderer.hasSelection === true);

  reset();
  s.mockInput.pressKey('c', { super: true });
  await settle(s, 2);

  assert('Command+C: copyPayload is non-empty', copyPayload !== null && copyPayload.length > 0,
    `"${copyPayload}"`);
  assert('Command+C: no interrupt', interruptFired === false);

  // ── Path 6: Command+C forced fallback ───────────────────────────────────
  console.log('\n--- Path 6: Command+C forced fallback → copy cached text ---');
  s.renderer.clearSelection();
  await settle(s);
  await s.mockMouse.drag(tCol, tRow, tCol + 11, tRow);
  await settle(s);

  const selForCmdFallback = s.renderer.getSelection();
  assert('selection for Cmd fallback', selForCmdFallback !== null);
  const expectedCmdCache = cachedText;

  // Monkey-patch again — save this selection's own original getter
  const origGetTextCmd = selForCmdFallback!.getSelectedText.bind(selForCmdFallback);
  (selForCmdFallback as any).getSelectedText = () => '';

  reset();
  s.mockInput.pressKey('c', { super: true });
  await settle(s, 2);

  assert('Cmd FALLBACK: copyPayload matches cache', copyPayload === expectedCmdCache,
    `payload="${copyPayload}", expected="${expectedCmdCache}"`);
  assert('Cmd FALLBACK: no interrupt', interruptFired === false);

  // Restore
  (selForCmdFallback as any).getSelectedText = origGetTextCmd;

  // ── Path 7: clear → new selection doesn't reuse old cache ───────────────
  console.log('\n--- Path 7: clear + new selection → stale cache not reused ---');
  const oldSelObj = cachedSelObj;
  s.renderer.clearSelection();
  await settle(s);

  await s.mockMouse.drag(tCol, tRow, tCol + 5, tRow);
  await settle(s);

  if (s.renderer.hasSelection) {
    const newSelObj = s.renderer.getSelection();
    if (cachedSelObj !== oldSelObj) {
      assert('new drag updated cachedSelObj', true);
      assert('new cachedSelObj matches current selection', cachedSelObj === newSelObj);
    } else {
      assert('old cache object ≠ current selection (identity blocks stale use)', oldSelObj !== newSelObj);
    }
  }

  // ── Path 8: no selection + Ctrl+C → interrupt ───────────────────────────
  console.log('\n--- Path 8: no selection + Ctrl+C → interrupt ---');
  s.renderer.clearSelection();
  await settle(s);
  assert('selection cleared', s.renderer.hasSelection === false);

  reset();
  s.mockInput.pressCtrlC();
  await settle(s, 2);
  assert('interrupt fired', interruptFired === true);
  assert('no copy payload', copyPayload === null);

  // ── Path 9: no selection + Command+C → no-op ───────────────────────────
  console.log('\n--- Path 9: no selection + Command+C → no-op ---');
  s.renderer.clearSelection();
  await settle(s);
  reset();

  s.mockInput.pressKey('c', { super: true });
  await settle(s, 2);
  assert('Command+C: no interrupt', interruptFired === false);
  assert('Command+C: no copy', copyPayload === null);

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  s.renderer.destroy();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('Regression crashed:', err); process.exit(1); });
