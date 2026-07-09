/**
 * Secret redaction (Milestone 8, M1/F10). Two layers, applied in order:
 *
 *   1. Field-aware (`redactValue`): walk a PARSED value (object/array/
 *      primitive). Any object property whose KEY matches
 *      `SENSITIVE_KEY_PATTERN` (`/token|secret|key|password/i`) has its
 *      string value replaced with the sentinel `«redacted»` outright,
 *      regardless of what it looks like — this catches secrets that don't
 *      happen to match any of the pattern-scan shapes below (e.g. a short
 *      password, an opaque internal key format).
 *   2. Pattern-scan (`redactSecrets`): a plain string scan applied to every
 *      remaining string leaf (after layer 1), for the concrete secret shapes
 *      named in the ExecPlan: GitHub tokens, JWTs, Azure connection-string
 *      AccountKeys, bearer headers, `password: "..."` pairs, and a generic
 *      40+ char token-like value — but the generic pattern ONLY fires when
 *      scanning a value whose key already looked sensitive (layer 1 already
 *      redacted those wholesale) or when the surrounding text itself names
 *      the key inline (e.g. `token=<40+ chars>` in a single string, as
 *      happens with error messages or serialized query strings). This is
 *      why the generic pattern is anchored to a `token|secret|key|password`
 *      prefix in the TEXT itself, not applied context-free — a context-free
 *      `[A-Za-z0-9_-]{40,}` would redact commit SHAs concatenated with other
 *      text, long file hashes, etc. (over-redaction), which the milestone
 *      explicitly asks us to avoid ("a generic 40-char value under a
 *      NON-sensitive key... is NOT redacted").
 *
 * `toolshed.ts` calls `redactValue` on `params` (a parsed JS value) and
 * `redactSecrets` on `result.error` (already a string) BEFORE `truncate()`,
 * so a 4KB truncation can never split a half-redacted secret in two.
 */

const REDACTED = '«redacted»';

const SENSITIVE_KEY_PATTERN = /token|secret|key|password/i;

// Order matters only in that each pattern is independent and non-overlapping
// in practice; all are applied in sequence over the same string.
const GH_TOKEN = /gh[pousr]_[A-Za-z0-9]{36,}/g;
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const AZURE_ACCOUNT_KEY = /AccountKey=[^;\s"]+/g;
const BEARER = /Bearer\s+[^\s"]+/gi;
const PASSWORD_KV_COLON = /"?password"?\s*:\s*"[^"]+"/gi;
const PASSWORD_KV_EQUALS = /"?password"?\s*=\s*"[^"]+"/gi;
// Generic long-secret-like value, but only when the text immediately before
// it names a sensitive key (token=/secret=/key=/password= or their quoted
// JSON forms), so a bare 40+ char string elsewhere (e.g. a description) is
// never touched by this layer either.
const GENERIC_NAMED_SECRET = /(token|secret|key|password)("?\s*[:=]\s*"?)([A-Za-z0-9_-]{40,})/gi;

/**
 * Pattern-scan layer: redacts known secret SHAPES anywhere in a plain
 * string. Never throws — always returns a string, even for an empty input.
 */
export function redactSecrets(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;

  let out = input;
  out = out.replace(GH_TOKEN, REDACTED);
  out = out.replace(JWT, REDACTED);
  out = out.replace(AZURE_ACCOUNT_KEY, `AccountKey=${REDACTED}`);
  out = out.replace(BEARER, `Bearer ${REDACTED}`);
  out = out.replace(PASSWORD_KV_COLON, `"password"${REDACTED}`);
  out = out.replace(PASSWORD_KV_EQUALS, `password${REDACTED}`);
  out = out.replace(GENERIC_NAMED_SECRET, (_match, key: string, sep: string) => `${key}${sep}${REDACTED}`);
  return out;
}

/**
 * Field-aware layer: walks a parsed value. String values under a
 * sensitive-looking key are redacted outright; every other string leaf
 * (object values under non-sensitive keys, array elements, and the string
 * case at the top level) still passes through the pattern-scan layer, so a
 * secret embedded inline in an unrelated field (e.g. a GitHub token pasted
 * into a free-text `message`) is still caught.
 *
 * Never throws: non-plain-object/array values (numbers, booleans, null,
 * undefined) pass through unchanged; circular references are handled via a
 * `seen` set that substitutes the sentinel `"[circular]"` on a repeat visit
 * rather than recursing forever.
 */
export function redactValue(input: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (input === null || input === undefined) return input;

  if (typeof input === 'string') return redactSecrets(input);
  if (typeof input !== 'object') return input;

  if (seen.has(input as object)) return '[circular]';
  seen.add(input as object);

  if (Array.isArray(input)) {
    return input.map((item) => redactValue(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key) && typeof value === 'string') {
      out[key] = REDACTED;
    } else {
      out[key] = redactValue(value, seen);
    }
  }
  return out;
}
