import { describe, expect, it } from '@jest/globals';
import { parseWorkItem } from '../src/work-item.js';

const valid = {
  item_type: 'ticket',
  payload: { title: 'Fix login' },
  idempotency_key: 'key-1',
  correlation_id: 'corr-1',
};

describe('parseWorkItem (Milestone 15)', () => {
  it('accepts a well-formed envelope', () => {
    expect(parseWorkItem(valid)).toEqual(valid);
  });

  it('accepts any payload type, including a string or an undefined value (field present)', () => {
    expect(parseWorkItem({ ...valid, payload: 'raw text' })).toEqual({ ...valid, payload: 'raw text' });
    expect(parseWorkItem({ ...valid, payload: undefined })).toEqual({ ...valid, payload: undefined });
  });

  it('rejects non-object bodies', () => {
    expect(parseWorkItem(null)).toBeUndefined();
    expect(parseWorkItem(undefined)).toBeUndefined();
    expect(parseWorkItem('a string')).toBeUndefined();
    expect(parseWorkItem(42)).toBeUndefined();
    expect(parseWorkItem(['an', 'array'])).toBeUndefined();
  });

  it('rejects a missing, empty, or non-string item_type', () => {
    expect(parseWorkItem({ payload: {}, idempotency_key: 'k', correlation_id: 'c' })).toBeUndefined();
    expect(parseWorkItem({ ...valid, item_type: '' })).toBeUndefined();
    expect(parseWorkItem({ ...valid, item_type: 7 })).toBeUndefined();
  });

  it('rejects a missing or empty idempotency_key', () => {
    expect(parseWorkItem({ item_type: 't', payload: {}, correlation_id: 'c' })).toBeUndefined();
    expect(parseWorkItem({ ...valid, idempotency_key: '' })).toBeUndefined();
  });

  it('rejects a missing or empty correlation_id', () => {
    expect(parseWorkItem({ item_type: 't', payload: {}, idempotency_key: 'k' })).toBeUndefined();
    expect(parseWorkItem({ ...valid, correlation_id: '' })).toBeUndefined();
  });

  it('rejects an envelope missing the payload field entirely', () => {
    expect(parseWorkItem({ item_type: 't', idempotency_key: 'k', correlation_id: 'c' })).toBeUndefined();
  });
});
