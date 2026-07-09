import { redactSecrets, redactValue } from '../redact.js';

describe('redactSecrets (string pattern layer)', () => {
  it('redacts a GitHub personal access token', () => {
    const input = 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
    expect(redactSecrets(input)).toBe('token: «redacted»');
  });

  it('redacts each of the gh[pousr]_ token prefixes', () => {
    for (const prefix of ['ghp', 'gho', 'ghu', 'ghs', 'ghr']) {
      const token = `${prefix}_${'a'.repeat(36)}`;
      expect(redactSecrets(`see ${token} here`)).toBe('see «redacted» here');
    }
  });

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactSecrets(`Authorization payload ${jwt} end`)).toBe('Authorization payload «redacted» end');
  });

  it('redacts an Azure Storage connection string AccountKey', () => {
    const input =
      'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=abcd1234==/verylongbase64keymaterial+more;EndpointSuffix=core.windows.net';
    const out = redactSecrets(input);
    expect(out).toContain('AccountKey=«redacted»');
    expect(out).not.toContain('abcd1234==/verylongbase64keymaterial+more');
  });

  it('redacts a bearer authorization header', () => {
    const input = 'Authorization: Bearer sk-abcDEF1234567890.ghiJKL';
    expect(redactSecrets(input)).toBe('Authorization: Bearer «redacted»');
  });

  it('redacts a password key-value pair in quoted JSON style', () => {
    const input = '{"password": "hunter2-super-secret-value"}';
    expect(redactSecrets(input)).toBe('{"password"«redacted»}');
  });

  it('redacts password with = instead of :', () => {
    const input = 'password="hunter2-super-secret-value"';
    expect(redactSecrets(input)).toBe('password«redacted»');
  });

  it('redacts a generic 40+ char token-like value under a sensitive key name', () => {
    const value = 'A'.repeat(40);
    expect(redactSecrets(`token=${value}`)).toBe('token=«redacted»');
  });

  it('leaves ordinary text and short values untouched', () => {
    const input = 'the quick brown fox jumps over the lazy dog';
    expect(redactSecrets(input)).toBe(input);
  });

  it('does not throw on empty string', () => {
    expect(redactSecrets('')).toBe('');
  });
});

describe('redactValue (field-aware object layer)', () => {
  it('redacts a string value whose key matches /token|secret|key|password/i', () => {
    const result = redactValue({ token: 'a'.repeat(50), description: 'fine' }) as Record<string, unknown>;
    expect(result.token).toBe('«redacted»');
    expect(result.description).toBe('fine');
  });

  it('does NOT redact a generic 40+ char value under a non-sensitive key like "description"', () => {
    const longValue = 'x'.repeat(45);
    const result = redactValue({ description: longValue }) as Record<string, unknown>;
    expect(result.description).toBe(longValue);
  });

  it('redacts nested sensitive keys at any depth', () => {
    const result = redactValue({
      outer: { inner: { apiKey: 'b'.repeat(41) } },
    }) as Record<string, unknown>;
    const outer = result.outer as Record<string, unknown>;
    const inner = outer.inner as Record<string, unknown>;
    expect(inner.apiKey).toBe('«redacted»');
  });

  it('redacts sensitive keys inside arrays of objects', () => {
    const result = redactValue({
      items: [{ secret: 'c'.repeat(42) }, { name: 'ok' }],
    }) as Record<string, unknown>;
    const items = result.items as Array<Record<string, unknown>>;
    expect(items[0].secret).toBe('«redacted»');
    expect(items[1].name).toBe('ok');
  });

  it('does not mutate the input object', () => {
    const input = { token: 'd'.repeat(50) };
    const inputCopy = { ...input };
    redactValue(input);
    expect(input).toEqual(inputCopy);
  });

  it('passes through non-string, non-object values unchanged (numbers, booleans, null)', () => {
    const result = redactValue({ count: 5, active: true, missing: null }) as Record<string, unknown>;
    expect(result).toEqual({ count: 5, active: true, missing: null });
  });

  it('handles undefined input without throwing', () => {
    expect(redactValue(undefined)).toBeUndefined();
  });

  it('handles a bare string input (not an object) via key-name-less pattern scan only', () => {
    const value = `ghp_${'z'.repeat(36)}`;
    expect(redactValue(value)).toBe('«redacted»');
  });

  it('handles a bare number/boolean input unchanged', () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
  });

  it('does not throw on a circular object and still redacts sensitive fields', () => {
    const circular: Record<string, unknown> = { token: 'e'.repeat(45) };
    circular.self = circular;
    expect(() => redactValue(circular)).not.toThrow();
    const result = redactValue(circular) as Record<string, unknown>;
    expect(result.token).toBe('«redacted»');
  });

  it('applies pattern-scan redaction to the serialized remainder after key-based redaction', () => {
    // A github token embedded in a non-sensitively-named field must still be caught
    // by the second (pattern) layer even though the key name ("message") is not sensitive.
    const token = `ghp_${'q'.repeat(36)}`;
    const result = redactValue({ message: `deploy failed: ${token}` }) as Record<string, unknown>;
    expect(result.message).toBe('deploy failed: «redacted»');
  });
});
