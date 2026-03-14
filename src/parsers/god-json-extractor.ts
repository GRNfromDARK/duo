/**
 * God JSON extractor: extracts the last ```json ... ``` block from God CLI output
 * and validates it against a Zod schema.
 * Source: AR-002, OQ-002, OQ-003
 */

import { z, type ZodError } from 'zod';

export type ExtractResult<T> =
  | { success: true; data: T; sourceOutput?: string }
  | { success: false; error: string };

/**
 * Extract the last JSON code block from CLI text output and validate with Zod schema.
 *
 * BUG-23 fix: tries multiple extraction strategies in order:
 * 1. Code-fenced JSON block (case-insensitive: ```json, ```JSON, ```Json)
 * 2. Bare JSON object (first { to last } in text)
 *
 * Returns null only if no JSON can be found at all.
 * Returns ExtractResult with structured error if JSON parse or schema validation fails.
 */
export function extractGodJson<T>(
  output: string,
  schema: z.ZodSchema<T>,
): ExtractResult<T> | null {
  // Strategy 1: code-fenced JSON block (case-insensitive)
  const jsonBlock = extractLastJsonBlock(output);
  if (jsonBlock !== null) {
    return parseAndValidate(jsonBlock, schema);
  }

  // Strategy 2: bare JSON object (BUG-23 fix)
  const bareJson = extractBareJsonObject(output);
  if (bareJson !== null) {
    return parseAndValidate(bareJson, schema);
  }

  return null;
}

/**
 * Extract the last ```json ... ``` code block from text.
 * BUG-23 fix: case-insensitive matching for the json tag.
 * Returns null if no JSON block found.
 */
function extractLastJsonBlock(text: string): string | null {
  // Match ```json ... ``` blocks (case-insensitive for "json" tag)
  const pattern = /```json\s*\n([\s\S]*?)```/gi;
  let lastMatch: string | null = null;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    lastMatch = match[1].trim();
  }

  return lastMatch;
}

/**
 * BUG-23 fix: Extract a bare JSON object from text.
 * Finds the first '{' and the matching last '}' to extract a JSON object.
 * Returns null if no valid JSON object boundary found.
 */
function extractBareJsonObject(text: string): string | null {
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  return text.slice(firstBrace, lastBrace + 1).trim();
}

/**
 * Parse JSON string and validate against Zod schema.
 */
function parseAndValidate<T>(
  jsonString: string,
  schema: z.ZodSchema<T>,
): ExtractResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    return {
      success: false,
      error: `JSON parse error: ${(e as Error).message}`,
    };
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return { success: true, data: result.data };
  }

  return {
    success: false,
    error: formatZodError(result.error),
  };
}

/**
 * Extract with retry: if first extraction fails (JSON parse or schema validation),
 * call retryFn with error hint, then try once more.
 *
 * BUG-23 fix: never returns null — always returns ExtractResult with error details
 * so callers can log the specific failure reason and raw output.
 */
export async function extractWithRetry<T>(
  output: string,
  schema: z.ZodSchema<T>,
  retryFn: (errorHint: string) => Promise<string>,
): Promise<ExtractResult<T>> {
  const firstResult = extractGodJson(output, schema);

  // No JSON found at all → return error with details (BUG-23: was returning null)
  if (firstResult === null) {
    return {
      success: false,
      error: `No JSON found in output (no code-fenced block, no bare JSON object). Output length: ${output.length} chars`,
    };
  }

  // First attempt succeeded
  if (firstResult.success) {
    return { ...firstResult, sourceOutput: output };
  }

  // First attempt found JSON but validation failed → retry once with error hint
  const retryOutput = await retryFn(firstResult.error);
  const retryResult = extractGodJson(retryOutput, schema);

  // Retry produced no JSON
  if (retryResult === null) {
    return {
      success: false,
      error: `Retry also failed: no JSON found in retry output. Original error: ${firstResult.error}`,
    };
  }

  // Retry found JSON but validation still failed
  if (!retryResult.success) {
    return {
      success: false,
      error: `Retry validation failed: ${retryResult.error}. Original error: ${firstResult.error}`,
    };
  }

  return { ...retryResult, sourceOutput: retryOutput };
}

/**
 * Format Zod validation error into a human-readable string with paths.
 */
function formatZodError(error: ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
  return `Schema validation failed: ${issues.join('; ')}`;
}
