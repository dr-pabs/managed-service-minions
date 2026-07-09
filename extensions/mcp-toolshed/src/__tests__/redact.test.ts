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

  it('redacts a password key-value pair in quoted JSON style (preserving the key prefix)', () => {
    const input = '{"password": "hunter2-super-secret-value"}';
    // The broadened M8-finding-1 pattern preserves the `"password": ` prefix
    // and redacts only the VALUE, which is more structurally faithful than the
    // original whole-`key:value` swallow while still removing the secret.
    expect(redactSecrets(input)).toBe('{"password": «redacted»}');
  });

  it('redacts password with = instead of : (preserving the key prefix)', () => {
    const input = 'password="hunter2-super-secret-value"';
    expect(redactSecrets(input)).toBe('password=«redacted»');
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

// M8 review finding 1: password redaction must not require double quotes.
// The pre-fix PASSWORD_KV_* patterns only matched a `"[^"]+"` value, so every
// unquoted / single-quoted / query-string form below slipped through — and
// since result.error runs through redactSecrets only, an unquoted
// `Password=...` in a downstream connection-string failure leaked into a
// stored audit error.
describe('redactSecrets — unquoted / single-quoted / query-string password forms (M8 review finding 1)', () => {
  it('redacts an unquoted &password=... query-string value (up to the & delimiter)', () => {
    const out = redactSecrets('db?user=x&password=hunter2secretvalue&z=1');
    expect(out).not.toContain('hunter2secretvalue');
    // Surrounding, non-secret query params survive.
    expect(out).toContain('user=x');
    expect(out).toContain('z=1');
  });

  it('redacts an unquoted Password=value in a connection string (up to the ; delimiter)', () => {
    const out = redactSecrets('Server=db;Password=hunter2;Trusted=false');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('Server=db');
    expect(out).toContain('Trusted=false');
  });

  it('redacts an unquoted Password: value (colon separator) up to whitespace', () => {
    const out = redactSecrets('Password: hunter2secret next');
    expect(out).not.toContain('hunter2secret');
    expect(out).toContain('next');
  });

  it('redacts a single-quoted password value', () => {
    const out = redactSecrets("password: 'hunter2secret'");
    expect(out).not.toContain('hunter2secret');
  });

  it('still redacts the original double-quoted JSON form', () => {
    const out = redactSecrets('{"password": "hunter2-super-secret-value"}');
    expect(out).not.toContain('hunter2-super-secret-value');
  });

  it('does NOT redact the word "password" in prose with no value attached', () => {
    const input = 'Please reset your password soon and choose a strong one.';
    expect(redactSecrets(input)).toBe(input);
  });
});

// M8 review finding 2: extend the pattern layer to common credential shapes,
// so they are caught even in a bare error string or under a non-sensitive
// params key.
describe('redactSecrets — additional credential shapes (M8 review finding 2)', () => {
  it('redacts a GitHub fine-grained PAT (github_pat_...)', () => {
    const pat = `github_pat_${'A'.repeat(22)}`;
    expect(redactSecrets(`creds ${pat} end`)).toBe('creds «redacted» end');
  });

  it('redacts a GitHub fine-grained PAT with underscores and digits in the body', () => {
    const pat = 'github_pat_11ABCDEF0_abcdefghijklmnopqrstuvwxyz012345';
    expect(redactSecrets(pat)).toBe('«redacted»');
  });

  it('redacts Slack tokens (xoxb-/xoxa-/xoxp-/xoxr-/xoxs-)', () => {
    for (const prefix of ['xoxb', 'xoxa', 'xoxp', 'xoxr', 'xoxs']) {
      const token = `${prefix}-1234567890-abcdefghijkl`;
      expect(redactSecrets(`slack ${token} here`)).toBe('slack «redacted» here');
    }
  });

  it('redacts an AWS access key id (AKIA...)', () => {
    const out = redactSecrets('aws key AKIAIOSFODNN7EXAMPLE in use');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('«redacted»');
  });

  it('redacts an entire PEM private key block', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIabc123linebreak\nmoresecretmaterial==\n-----END RSA PRIVATE KEY-----';
    const out = redactSecrets(`error: leaked ${pem} oops`);
    expect(out).not.toContain('MIIabc123linebreak');
    expect(out).not.toContain('moresecretmaterial');
    expect(out).toContain('«redacted»');
  });

  it('redacts a plain (non-RSA) PEM PRIVATE KEY block', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nbodybytes\n-----END PRIVATE KEY-----';
    expect(redactSecrets(pem)).toBe('«redacted»');
  });

  it('does NOT redact a benign string that merely contains "AKIA" as a substring of a word', () => {
    // AKIA must be followed by exactly 16 upper/digit chars to match; a short
    // or lowercase-continuing occurrence is left alone.
    const input = 'the AKIAshort token is not a key';
    expect(redactSecrets(input)).toBe(input);
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

  it('does NOT redact a 40+ char value under "description" even after the pattern-set was widened (M8 finding 2 regression)', () => {
    // Guard against a widened key/pattern set accidentally over-redacting a
    // long-but-innocuous value under a plainly non-sensitive key.
    const longValue = 'ThisIsAPerfectlyNormalFortyFivePlusCharDescription';
    const result = redactValue({ description: longValue, notes: 'x'.repeat(60) }) as Record<string, unknown>;
    expect(result.description).toBe(longValue);
    expect(result.notes).toBe('x'.repeat(60));
  });

  it('redacts string values under newly-covered sensitive key names (M8 review finding 2)', () => {
    // authorization / credential / credentials / connection(string) / passwd
    // genuinely needed adding; apikey already matched via the "key" substring.
    for (const key of ['authorization', 'credential', 'credentials', 'connectionString', 'passwd', 'apikey']) {
      const result = redactValue({ [key]: 'short-secret-value' }) as Record<string, unknown>;
      expect(result[key]).toBe('«redacted»');
    }
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
