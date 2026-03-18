/**
 * UI types for Duo's TUI layer.
 * Source: FR-014 (AC-048, AC-049, AC-050, AC-051)
 */

export type RoleName = 'claude-code' | 'codex' | 'gemini' | 'system' | 'user';

export interface RoleStyle {
  displayName: string;
  color: string;
  border: string;
}

const DEFAULT_ROLE_STYLE: RoleStyle = { displayName: 'Agent', color: 'gray', border: '│' };

export const ROLE_STYLES: Record<RoleName, RoleStyle> = {
  'claude-code': { displayName: 'Claude', color: 'blue', border: '┃' },
  codex:         { displayName: 'Codex',  color: 'green', border: '║' },
  gemini:        { displayName: 'Gemini', color: '#FFA500', border: '│' },
  system:        { displayName: 'System', color: 'yellow', border: '·' },
  user:          { displayName: 'You',    color: 'white', border: '>' },
};

/**
 * Safe lookup for role styles with fallback for unknown roles.
 */
export function getRoleStyle(role: string): RoleStyle {
  return ROLE_STYLES[role as RoleName] ?? DEFAULT_ROLE_STYLE;
}

export interface MessageMetadata {
  /** CLI command used to invoke the tool (verbose mode) */
  cliCommand?: string;
  /** Token count for this message (verbose mode) */
  tokenCount?: number;
  /** Whether this is a routing/internal event (hidden in minimal mode) */
  isRoutingEvent?: boolean;
}

export interface Message {
  id: string;
  role: RoleName;
  roleLabel?: string; // e.g. "Coder", "Reviewer"
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  metadata?: MessageMetadata;
}

export interface ScrollState {
  offset: number;
  viewportHeight: number;
  totalLines: number;
  autoFollow: boolean;
}
