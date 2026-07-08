/**
 * Deterministic ("canonical") JSON serialization: object keys are sorted
 * recursively so that two structurally-equal values with keys inserted in a
 * different order serialize to byte-identical strings. Arrays are NOT
 * reordered — element order is semantically meaningful and must be
 * preserved.
 *
 * This exists for the toolshed's approval resume contract (Milestone 4,
 * H3/F1): `requestHash = sha256(serverAlias + toolName +
 * canonicalJSON(params) + correlationId)` must hash identically for an
 * identical resubmission regardless of incidental key ordering introduced
 * by JSON.stringify/parse round-trips, object literal construction order,
 * etc. — otherwise a legitimate resubmission could silently create a
 * second, unrelated approval instead of consuming the one a human already
 * approved.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === undefined) {
    // JSON.stringify(undefined) is the bare word `undefined`, not valid
    // JSON, but is a legal *return value* of JSON.stringify at the top
    // level. Match that behavior so canonicalJson(undefined) doesn't throw.
    return 'undefined';
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : serialize(item))).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  // Functions, symbols, bigint: JSON.stringify would drop/throw on these too;
  // fall back to String() so the function never throws.
  return JSON.stringify(String(value));
}
