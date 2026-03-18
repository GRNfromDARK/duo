/**
 * Minimal types retained for backward compatibility with saved sessions.
 * Old sessions may have a degradationState field — it is silently ignored.
 */

export type GodErrorKind = 'process_exit' | 'timeout' | 'parse_failure' | 'schema_validation';
