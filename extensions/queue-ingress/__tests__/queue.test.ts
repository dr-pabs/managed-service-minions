import { describe, expect, it } from '@jest/globals';
import { InMemoryWorkItemQueue } from '../src/queue.js';

describe('InMemoryWorkItemQueue (Milestone 15)', () => {
  it('enqueues bodies and assigns sequential message ids', () => {
    const q = new InMemoryWorkItemQueue();
    expect(q.enqueue({ a: 1 })).toBe('msg_1');
    expect(q.enqueue({ a: 2 })).toBe('msg_2');
  });

  it('receive returns the next message with deliveryCount 1 and locks it in-flight', async () => {
    const q = new InMemoryWorkItemQueue();
    q.enqueue({ hello: 'world' });
    await expect(q.receive()).resolves.toEqual({
      messageId: 'msg_1',
      body: { hello: 'world' },
      deliveryCount: 1,
    });
    expect(q.inFlightCount()).toBe(1);
  });

  it('receive returns undefined when the queue is empty', async () => {
    const q = new InMemoryWorkItemQueue();
    await expect(q.receive()).resolves.toBeUndefined();
  });

  it('receive returns undefined after close', async () => {
    const q = new InMemoryWorkItemQueue();
    q.enqueue({ x: 1 });
    await q.close();
    await expect(q.receive()).resolves.toBeUndefined();
  });

  it('complete settles an in-flight message without dead-lettering it', async () => {
    const q = new InMemoryWorkItemQueue();
    q.enqueue({ x: 1 });
    const msg = (await q.receive())!;
    await q.complete(msg);
    expect(q.inFlightCount()).toBe(0);
    expect(q.deadLetters()).toEqual([]);
  });

  it('abandon returns the message to the queue and redelivery bumps the delivery count', async () => {
    const q = new InMemoryWorkItemQueue();
    q.enqueue({ x: 1 });
    const msg = (await q.receive())!;
    await q.abandon(msg);
    expect(q.inFlightCount()).toBe(0);
    await expect(q.receive()).resolves.toEqual({ messageId: 'msg_1', body: { x: 1 }, deliveryCount: 2 });
  });

  it('deadLetter records the body and reason code', async () => {
    const q = new InMemoryWorkItemQueue();
    q.enqueue({ bad: true });
    const msg = (await q.receive())!;
    await q.deadLetter(msg, 'POISON_MESSAGE');
    expect(q.deadLetters()).toEqual([{ body: { bad: true }, reason: 'POISON_MESSAGE' }]);
    expect(q.inFlightCount()).toBe(0);
  });

  it('complete/abandon/deadLetter on an unknown message are no-ops', async () => {
    const q = new InMemoryWorkItemQueue();
    const ghost = { messageId: 'nope', body: null, deliveryCount: 1 };
    await q.complete(ghost);
    await q.abandon(ghost);
    await q.deadLetter(ghost, 'X');
    expect(q.deadLetters()).toEqual([]);
    expect(q.inFlightCount()).toBe(0);
  });
});
