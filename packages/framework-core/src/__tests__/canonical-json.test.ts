import { canonicalJson } from '../canonical-json.js';

describe('canonicalJson (Milestone 4, H3/F1 — deterministic serialization for the approval requestHash contract)', () => {
  it('sorts object keys so differently-ordered-but-equal objects serialize identically', () => {
    const a = canonicalJson({ b: 2, a: 1 });
    const b = canonicalJson({ a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2}');
  });

  it('sorts keys recursively in nested objects', () => {
    const a = canonicalJson({ outer: { z: 1, a: 2 }, first: true });
    const b = canonicalJson({ first: true, outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('preserves array element order — arrays are not reordered', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it('serializes arrays of objects with each object key-sorted', () => {
    const value = [
      { b: 1, a: 2 },
      { d: 3, c: 4 },
    ];
    expect(canonicalJson(value)).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });

  it('serializes primitives the same way JSON.stringify would', () => {
    expect(canonicalJson('hello')).toBe('"hello"');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(null)).toBe('null');
  });

  it('serializes undefined as the literal string "undefined" (matches JSON.stringify(undefined))', () => {
    expect(canonicalJson(undefined)).toBe('undefined');
  });

  it('omits object properties whose value is undefined, matching JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('serializes undefined array elements as null, matching JSON.stringify', () => {
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('falls back to String() for values JSON.stringify cannot represent (e.g. a function)', () => {
    const fn = function namedFn() {
      return 1;
    };
    expect(canonicalJson(fn)).toBe(JSON.stringify(String(fn)));
  });

  it('produces byte-identical output for the same object regardless of construction order (the actual resume-contract property)', () => {
    const first = { pr: 1, reason: 'looks good', tags: ['a', 'b'] };
    const second: typeof first = {} as typeof first;
    second.tags = ['a', 'b'];
    second.reason = 'looks good';
    second.pr = 1;
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });
});
