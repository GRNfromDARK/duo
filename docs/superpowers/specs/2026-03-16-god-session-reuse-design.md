# God Session Reuse Design

**Goal:** Enable God adapter to maintain conversation continuity across rounds via session reuse, giving God natural memory of all previous observations, decisions, and context — eliminating the current "amnesia" where God only sees the latest observation and last decision summary.

**Approach:** Kill-and-resume pattern (identical to Coder/Reviewer adapters). Each round kills the God process, next round spawns a new process with `--resume <session_id>` to restore full conversation context.

---

## 1. God Adapter Layer

### ClaudeCodeGodAdapter

- Add `lastSessionId: string | null` private field
- In `execute()`, parse stream-json `status` chunks to capture `metadata.session_id` (same logic as Coder adapter)
- `buildArgs()` behavior:
  - **First round** (no sessionId): `claude -p <prompt> --system-prompt <sp> --tools '' --output-format stream-json --verbose`
  - **Resume round** (has sessionId): `claude -p <prompt> --resume <sessionId> --output-format stream-json --verbose` (skip `--system-prompt` and `--tools`)
- Implement `hasActiveSession()` / `getLastSessionId()` / `restoreSessionId()` methods (SessionCapableAdapter duck typing)
- Error recovery: on resume failure, clear `lastSessionId` — next round falls back to fresh session with full system prompt
- **systemPrompt handling:** The adapter internally checks `this.lastSessionId` in `buildArgs()` and skips `--system-prompt` when resuming (same pattern as Coder adapter lines 96-99). The caller (`god-call.ts`) always passes `systemPrompt` in `GodExecOptions`; the adapter decides whether to use it based on its own session state.
- **`--tools ''` handling:** `--resume` restores the original session settings including tool restrictions, so `--tools ''` is NOT re-passed on resume (same as `--system-prompt`). The adapter skips both flags when `this.lastSessionId` is set.

### CodexGodAdapter

- Deferred to follow-up. The current Codex God adapter uses `--ephemeral` flag and embeds system prompt in the prompt body, which creates complications for resume (duplicate system prompt in session context, ephemeral flag prevents persistence). This spec implements session reuse for **ClaudeCodeGodAdapter only**.
- Codex God adapter continues to work in stateless mode via the `isSessionCapable()` fallback.

### Non-session-capable adapters

- `god-decision-service.ts` uses `isSessionCapable(adapter)` runtime check
- If adapter doesn't support sessions, falls back to current stateless mode (full prompt every round)
- Zero breaking changes for future adapters

---

## 2. Call Layer (god-call.ts / god-decision-service.ts)

### god-call.ts

- No interface changes needed. `GodCallOptions` continues to pass `systemPrompt` every call. The adapter internally decides whether to use it (see Section 1).

### god-decision-service.ts

`makeDecision()` flow:

1. The `isSessionCapable()` check lives in App.tsx (where it's already defined). App.tsx passes a computed `isResuming: boolean` flag when calling `makeDecision()`. The service does not import or know about `SessionCapableAdapter` duck typing.
2. **First round** (`!isResuming`): current logic unchanged — full system prompt, full user prompt with Hand catalog, previous decisions, etc.
3. **Resume round** (`isResuming`): build a slim user prompt (see Section 3)

### extractWithRetry interaction

When the main God call produces malformed JSON and `extractWithRetry` fires the retry callback:

- The retry call inherits the session context (God sees its own malformed output + the FORMAT ERROR correction prompt). This is **desired behavior** — God has full context to understand what went wrong and produce corrected JSON.
- The retry prompt already includes the error hint (`[FORMAT ERROR] ...`). Combined with session context, God has everything it needs.
- If retry also fails → DegradationManager triggers fallback envelope → `lastSessionId` is cleared → next round starts fresh. This matches existing error recovery.

---

## 3. Prompt Slimming (resume rounds)

When God resumes a session, the following are already in conversation context and do NOT need repeating:

| Content | First round | Resume round |
|---------|-------------|-------------|
| System prompt | Via `--system-prompt` | In session (not repeated) |
| Hand catalog (11 actions, ~1500 chars) | In user prompt | **Skipped** |
| Previous decision summary | In user prompt | **Skipped** (God generated it) |
| Task Goal | In user prompt | **Skipped** (seen in round 1) |
| Available Adapters | In user prompt | **Skipped** |
| Phase Plan (full list) | In user prompt | **Skipped** |

**Resume round user prompt contains only:**

1. **Phase & Round** — current phase ID, round N of M, active role
2. **Observations** — current round's coder/reviewer output (the new information)
3. **Format reminder** (appended at end):
   ```
   Reminder: re-read your system prompt and follow all instructions. Output a single GodDecisionEnvelope JSON code block.
   ```

Estimated savings: ~50% prompt tokens per round (from ~5000-6000 to ~2000-3000 chars, dominated by observation length).

---

## 4. Session Persistence (`duo resume`)

- **Save:** After each `makeDecision()` return, App.tsx reads `adapter.getLastSessionId()` and includes it in state. Both `saveState` call sites in App.tsx must be updated — the transition effect save AND the `saveStateForExit` (Ctrl+C) save — to ensure session ID is not lost on any exit path.
- **Restore:** `buildRestoredSessionRuntime()` in `session-runner-state.ts` reads `godSessionId` from snapshot and includes it in the returned `RestoredSessionRuntime`. App.tsx then calls `adapter.restoreSessionId(id)`. First God call in the resumed session uses `--resume`.
- **Error recovery:** If resume fails (session expired, file corrupted), clear `lastSessionId` and start fresh session with full system prompt. Graceful degradation, task continues uninterrupted.

---

## 5. Files Changed

| File | Change |
|------|--------|
| `src/god/adapters/claude-code-god-adapter.ts` | Add `lastSessionId`, session capture from stream, resume args, 3 session methods |
| `src/god/god-decision-service.ts` | Accept `isResuming` flag in `makeDecision()`, build slim prompt for resume rounds, add format reminder |
| `src/ui/components/App.tsx` | Save/restore God sessionId at both saveState call sites; remove "intentionally stateless" bypass; call `restoreSessionId` on resume |
| `src/ui/session-runner-state.ts` | Add `godSessionId` to `RestoredSessionRuntime` interface and return value |

**Not changed:**
- `src/god/god-call.ts` — no interface changes; adapter handles resume internally
- `src/god/adapters/codex-god-adapter.ts` — deferred; continues stateless mode
- `src/types/god-adapter.ts` — SessionCapableAdapter uses duck typing from adapter.ts
- Workflow state machine — God decision flow unchanged
- `snapshot.json` schema — `godSessionId` field already exists

**Potentially changed (investigate during implementation):**
- `src/god/tri-party-session.ts` — currently hardcodes `god = null` with "intentionally stateless" comment. If used in the restore flow, needs updating. If bypassed by App.tsx direct restore, add a comment noting the new session-capable behavior.

---

## 6. Tests

**Existing tests that will break (must update):**
- `audit-bug-regressions.test.ts` line 647: `expect('godSessionId' in runtime).toBe(false)` → change to `true`
- `session-runner-state.test.ts` lines 332, 429: `expect('godSessionId' in runtime).toBe(false)` → change to `true`
- `tri-party-session.test.ts` lines 115, 133: "god remains stateless" → update or remove

**New tests to add:**
- ClaudeCodeGodAdapter: session ID capture, resume args generation, error recovery (clear session on failure)
- god-decision-service: slim prompt generation for resume rounds vs full prompt for first round
- App.tsx integration: God sessionId persisted to and restored from snapshot

---

## 7. Backward Compatibility

- Adapters without session support auto-fallback to stateless mode via `isSessionCapable()` check
- Existing snapshots with `godSessionId: null` work unchanged (adapter starts fresh)
- Codex God adapter continues working in stateless mode (deferred to follow-up)
