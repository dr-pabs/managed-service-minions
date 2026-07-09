import { describe, expect, it } from '@jest/globals';
import {
  estimateTokensFromChars,
  extractTokenUsage,
  TokenBudgetExceededError,
  enforceTokenBudget,
  createTrackedBudget,
} from '../token-accounting.js';

describe('estimateTokensFromChars', () => {
  it('estimates tokens as characters/4, rounded up', () => {
    expect(estimateTokensFromChars('a'.repeat(4))).toBe(1);
    expect(estimateTokensFromChars('a'.repeat(5))).toBe(2);
    expect(estimateTokensFromChars('')).toBe(0);
  });

  it('sums system prompt, user content, and response content', () => {
    // 8 + 8 + 8 = 24 chars total -> 6 tokens
    const total = estimateTokensFromChars('aaaaaaaa') + estimateTokensFromChars('bbbbbbbb') + estimateTokensFromChars('cccccccc');
    expect(total).toBe(6);
  });
});

describe('extractTokenUsage', () => {
  it('returns undefined when the Goose response carries no usage field (the M11 fixture shape: {role, content})', () => {
    // Milestone 11's recorded fixtures (test/fixtures/goose/*.json) only ever
    // carry {role, content} in their "response" object -- no usage/tokens
    // field of any kind. This is the discovery this milestone logs: Goose's
    // /reply contract, as verified against those fixtures, does NOT report
    // token usage, so callers must estimate.
    expect(extractTokenUsage({ role: 'assistant', content: 'hello' })).toBeUndefined();
  });

  it('reads a usage field when present (forward-compatible, in case a future Goose response DOES carry one)', () => {
    expect(
      extractTokenUsage({
        role: 'assistant',
        content: 'hello',
        usage: { total_tokens: 42 },
      })
    ).toBe(42);
  });

  it('ignores a malformed usage field', () => {
    expect(extractTokenUsage({ role: 'assistant', content: 'x', usage: { total_tokens: 'not-a-number' } })).toBeUndefined();
    expect(extractTokenUsage({ role: 'assistant', content: 'x', usage: null })).toBeUndefined();
  });

  it('returns undefined for a non-object response (e.g. null, a primitive)', () => {
    expect(extractTokenUsage(null)).toBeUndefined();
    expect(extractTokenUsage('not an object')).toBeUndefined();
    expect(extractTokenUsage(undefined)).toBeUndefined();
  });
});

describe('TokenBudgetExceededError', () => {
  it('is a typed Error carrying the minion/session/budget context for chat surfacing', () => {
    const err = new TokenBudgetExceededError({
      minionType: 'code_writer',
      sessionId: 'sess_1',
      correlationId: 'corr_1.0',
      budget: 50000,
      used: 51000,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TokenBudgetExceededError');
    expect(err.minionType).toBe('code_writer');
    expect(err.budget).toBe(50000);
    expect(err.used).toBe(51000);
    expect(err.message).toContain('code_writer');
    expect(err.message).toContain('50000');
  });
});

describe('createTrackedBudget / enforceTokenBudget', () => {
  it('does not throw when usage stays within budget', () => {
    const tracked = createTrackedBudget(1000);
    expect(() =>
      enforceTokenBudget(tracked, 500, {
        minionType: 'ticket_analyst',
        sessionId: 'sess_1',
        correlationId: 'corr_1.0',
        budget: 1000,
      })
    ).not.toThrow();
  });

  it('throws TokenBudgetExceededError with the accumulated total once usage reaches the budget', () => {
    const tracked = createTrackedBudget(1000);
    enforceTokenBudget(tracked, 900, {
      minionType: 'ticket_analyst',
      sessionId: 'sess_1',
      correlationId: 'corr_1.0',
      budget: 1000,
    });
    try {
      enforceTokenBudget(tracked, 200, {
        minionType: 'ticket_analyst',
        sessionId: 'sess_1',
        correlationId: 'corr_1.0',
        budget: 1000,
      });
      throw new Error('expected enforceTokenBudget to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TokenBudgetExceededError);
      expect((err as TokenBudgetExceededError).used).toBe(1100);
      expect((err as TokenBudgetExceededError).minionType).toBe('ticket_analyst');
    }
  });
});
