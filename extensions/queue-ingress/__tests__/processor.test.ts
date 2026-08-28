import { describe, expect, it, jest } from '@jest/globals';
import {
  DEAD_LETTER_MALFORMED_ENVELOPE,
  DEAD_LETTER_POISON_MESSAGE,
  toRunnerRequest,
  WorkItemProcessor,
} from '../src/processor.js';

const validItem = {
  item_type: 'ticket',
  payload: { title: 'Fix login' },
  idempotency_key: 'key-1',
  correlation_id: 'corr-1',
};

function makeDeps() {
  return {
    runner: { run: jest.fn() },
    queue: {
      receive: jest.fn(),
      complete: jest.fn(),
      abandon: jest.fn(),
      deadLetter: jest.fn(),
      close: jest.fn(),
    },
    outcomes: {
      get: jest.fn(),
      set: jest.fn(),
    },
  };
}

function message(body: unknown, deliveryCount = 1) {
  return { messageId: 'm1', body, deliveryCount };
}

describe('toRunnerRequest (Milestone 15)', () => {
  it('maps a string payload to text verbatim and carries the envelope identity', () => {
    const req = toRunnerRequest({ ...validItem, payload: 'raw message' });
    expect(req).toEqual({
      platform: 'webhook',
      teamId: 'ticket',
      userId: 'queue',
      text: 'raw message',
      threadId: 'key-1',
      sessionId: 'key-1',
      correlationRoot: 'corr-1',
    });
  });

  it('JSON-serializes a non-string payload and preserves idempotency/correlation ids', () => {
    const req = toRunnerRequest(validItem);
    expect(req.text).toBe(JSON.stringify({ title: 'Fix login' }));
    expect(req.sessionId).toBe('key-1');
    expect(req.correlationRoot).toBe('corr-1');
  });
});

describe('WorkItemProcessor (Milestone 15)', () => {
  it('dead-letters a malformed envelope with MALFORMED_ENVELOPE and never runs the runner', async () => {
    const deps = makeDeps();
    const p = new WorkItemProcessor(deps);
    const result = await p.process(message(null));
    expect(result).toEqual({ status: 'dead_lettered', reason: DEAD_LETTER_MALFORMED_ENVELOPE });
    expect(deps.queue.deadLetter).toHaveBeenCalledWith(message(null), DEAD_LETTER_MALFORMED_ENVELOPE);
    expect(deps.runner.run).not.toHaveBeenCalled();
    expect(deps.outcomes.set).not.toHaveBeenCalled();
  });

  it('short-circuits a completed idempotency key to the recorded outcome (at-most-once)', async () => {
    const deps = makeDeps();
    const recorded = { status: 'completed' as const, result: { text: 'already done' }, completedAt: 5 };
    deps.outcomes.get.mockReturnValue(recorded);
    const p = new WorkItemProcessor(deps);
    const result = await p.process(message(validItem));
    expect(result).toEqual({ status: 'completed', result: recorded.result, shortCircuited: true });
    expect(deps.queue.complete).toHaveBeenCalledWith(message(validItem));
    expect(deps.runner.run).not.toHaveBeenCalled();
    expect(deps.outcomes.set).not.toHaveBeenCalled();
  });

  it('dead-letters a poisoned item at the default maxDeliveryCount of 3', async () => {
    const deps = makeDeps();
    const p = new WorkItemProcessor(deps);
    const result = await p.process(message(validItem, 3));
    expect(result).toEqual({ status: 'dead_lettered', reason: DEAD_LETTER_POISON_MESSAGE });
    expect(deps.queue.deadLetter).toHaveBeenCalledWith(message(validItem, 3), DEAD_LETTER_POISON_MESSAGE);
    expect(deps.runner.run).not.toHaveBeenCalled();
  });

  it('honours a custom maxDeliveryCount', async () => {
    const deps = makeDeps();
    const p = new WorkItemProcessor({ ...deps, maxDeliveryCount: 2 });
    await p.process(message(validItem, 1)); // below threshold -> runs
    expect(deps.runner.run).toHaveBeenCalledTimes(1);
    deps.runner.run.mockReset();
    await p.process(message(validItem, 2)); // at threshold -> poison
    expect(deps.runner.run).not.toHaveBeenCalled();
    expect(deps.queue.deadLetter).toHaveBeenCalledWith(message(validItem, 2), DEAD_LETTER_POISON_MESSAGE);
  });

  it('runs the runner, records the outcome before completing, and completes', async () => {
    const deps = makeDeps();
    deps.runner.run.mockResolvedValue({ text: 'done' });
    const p = new WorkItemProcessor(deps);
    const result = await p.process(message(validItem));
    expect(result).toEqual({ status: 'completed', result: { text: 'done' }, shortCircuited: false });
    expect(deps.runner.run).toHaveBeenCalledWith(toRunnerRequest(validItem));
    expect(deps.outcomes.set).toHaveBeenCalledWith('key-1', {
      status: 'completed',
      result: { text: 'done' },
      completedAt: expect.any(Number),
    });
    expect(deps.queue.complete).toHaveBeenCalledWith(message(validItem));
    // at-most-once: the outcome is committed BEFORE the message is settled.
    expect(deps.outcomes.set.mock.invocationCallOrder[0]).toBeLessThan(
      deps.queue.complete.mock.invocationCallOrder[0]
    );
  });

  it('abandons when the runner throws an Error', async () => {
    const deps = makeDeps();
    deps.runner.run.mockRejectedValue(new Error('boom'));
    const p = new WorkItemProcessor(deps);
    const result = await p.process(message(validItem));
    expect(result).toEqual({ status: 'abandoned', reason: 'boom' });
    expect(deps.queue.abandon).toHaveBeenCalledWith(message(validItem));
    expect(deps.outcomes.set).not.toHaveBeenCalled();
    expect(deps.queue.complete).not.toHaveBeenCalled();
  });

  it('abandons when the runner throws a non-Error value', async () => {
    const deps = makeDeps();
    deps.runner.run.mockRejectedValue('plain string failure');
    const p = new WorkItemProcessor(deps);
    const result = await p.process(message(validItem));
    expect(result).toEqual({ status: 'abandoned', reason: 'plain string failure' });
    expect(deps.queue.abandon).toHaveBeenCalledWith(message(validItem));
  });
});
