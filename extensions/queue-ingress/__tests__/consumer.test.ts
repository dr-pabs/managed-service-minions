import { describe, expect, it, jest } from '@jest/globals';
import { consumeQueue } from '../src/consumer.js';

function completed(text = 'ok') {
  return { status: 'completed' as const, result: { text }, shortCircuited: false };
}

function makeQueue() {
  return {
    receive: jest.fn(),
    complete: jest.fn(),
    abandon: jest.fn(),
    deadLetter: jest.fn(),
    close: jest.fn(),
  };
}

describe('consumeQueue (Milestone 15)', () => {
  it('returns 0 immediately when the signal is already aborted', async () => {
    const queue = makeQueue();
    const processor = { process: jest.fn() };
    const controller = new AbortController();
    controller.abort();
    const count = await consumeQueue({ queue, processor, signal: controller.signal });
    expect(count).toBe(0);
    expect(queue.receive).not.toHaveBeenCalled();
    expect(processor.process).not.toHaveBeenCalled();
  });

  it('processes each received message until the signal aborts', async () => {
    const queue = makeQueue();
    const m1 = { messageId: 'm1', body: { a: 1 }, deliveryCount: 1 };
    queue.receive.mockResolvedValueOnce(m1);
    const controller = new AbortController();
    const processor = {
      process: jest.fn(async () => {
        controller.abort();
        return completed();
      }),
    };
    const onResult = jest.fn();
    const count = await consumeQueue({ queue, processor, signal: controller.signal, onResult });
    expect(count).toBe(1);
    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(processor.process).toHaveBeenCalledWith(m1);
    expect(onResult).toHaveBeenCalledWith(completed());
    expect(queue.receive).toHaveBeenCalledTimes(1);
  });

  it('keeps polling when the queue is empty, then processes a later message', async () => {
    const queue = makeQueue();
    const m1 = { messageId: 'm1', body: { a: 1 }, deliveryCount: 1 };
    queue.receive.mockResolvedValueOnce(undefined).mockResolvedValueOnce(m1);
    const controller = new AbortController();
    const processor = {
      process: jest.fn(async () => {
        controller.abort();
        return completed('later');
      }),
    };
    const count = await consumeQueue({ queue, processor, signal: controller.signal, pollIntervalMs: 0 });
    expect(queue.receive).toHaveBeenCalledTimes(2);
    expect(processor.process).toHaveBeenCalledWith(m1);
    expect(count).toBe(1);
  });
});
