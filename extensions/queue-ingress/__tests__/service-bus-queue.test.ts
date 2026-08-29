import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockReceiver = {
  receiveMessages: jest.fn(),
  completeMessage: jest.fn(),
  abandonMessage: jest.fn(),
  deadLetterMessage: jest.fn(),
  close: jest.fn(),
};
const mockClient = {
  createReceiver: jest.fn(),
  close: jest.fn(),
};
const ServiceBusClient = jest.fn();

jest.unstable_mockModule('@azure/service-bus', () => ({ ServiceBusClient }));

type ServiceBusWorkItemQueueCtor = typeof import('../src/service-bus-queue.js').ServiceBusWorkItemQueue;

let ServiceBusWorkItemQueue: ServiceBusWorkItemQueueCtor;

beforeAll(async () => {
  ({ ServiceBusWorkItemQueue } = await import('../src/service-bus-queue.js'));
});

beforeEach(() => {
  ServiceBusClient.mockReset().mockImplementation(() => mockClient);
  mockClient.createReceiver.mockReset().mockReturnValue(mockReceiver);
  mockClient.close.mockReset().mockResolvedValue(undefined);
  mockReceiver.receiveMessages.mockReset();
  mockReceiver.completeMessage.mockReset().mockResolvedValue(undefined);
  mockReceiver.abandonMessage.mockReset().mockResolvedValue(undefined);
  mockReceiver.deadLetterMessage.mockReset().mockResolvedValue(undefined);
  mockReceiver.close.mockReset().mockResolvedValue(undefined);
});

const rawMessage = { messageId: 'm1', body: { item_type: 'ticket' }, deliveryCount: 2 };

describe('ServiceBusWorkItemQueue (Milestone 15)', () => {
  it('connect() lazily imports the SDK and opens a client', async () => {
    const q = await ServiceBusWorkItemQueue.connect('Endpoint=sb://x', 'minion-tasks');
    expect(ServiceBusClient).toHaveBeenCalledWith('Endpoint=sb://x');
    expect(q).toBeInstanceOf(ServiceBusWorkItemQueue);
  });

  it('receive() returns a message and caches its raw handle', async () => {
    mockReceiver.receiveMessages.mockResolvedValue([rawMessage]);
    const q = await ServiceBusWorkItemQueue.connect('cs', 'queue-name');
    const msg = await q.receive();
    expect(mockClient.createReceiver).toHaveBeenCalledWith('queue-name');
    expect(mockReceiver.receiveMessages).toHaveBeenCalledWith(1);
    expect(msg).toEqual({ messageId: 'm1', body: { item_type: 'ticket' }, deliveryCount: 2 });
  });

  it('receive() returns undefined when the batch is empty', async () => {
    mockReceiver.receiveMessages.mockResolvedValue([]);
    const q = await ServiceBusWorkItemQueue.connect('cs', 'queue-name');
    await expect(q.receive()).resolves.toBeUndefined();
  });

  it('caches a single receiver across receives', async () => {
    mockReceiver.receiveMessages.mockResolvedValueOnce([rawMessage]).mockResolvedValueOnce([]);
    const q = await ServiceBusWorkItemQueue.connect('cs', 'queue-name');
    await q.receive();
    await q.receive();
    expect(mockClient.createReceiver).toHaveBeenCalledTimes(1);
  });

  it('complete() settles the original raw handle', async () => {
    mockReceiver.receiveMessages.mockResolvedValue([rawMessage]);
    const q = await ServiceBusWorkItemQueue.connect('cs', 'queue-name');
    const msg = (await q.receive())!;
    await q.complete(msg);
    expect(mockReceiver.completeMessage).toHaveBeenCalledWith(rawMessage);
  });

  it('abandon() returns the original raw handle', async () => {
    mockReceiver.receiveMessages.mockResolvedValue([rawMessage]);
    const q = await ServiceBusWorkItemQueue.connect('cs', 'queue-name');
    const msg = (await q.receive())!;
    await q.abandon(msg);
    expect(mockReceiver.abandonMessage).toHaveBeenCalledWith(rawMessage);
  });

  it('deadLetter() passes the reason code through', async () => {
    mockReceiver.receiveMessages.mockResolvedValue([rawMessage]);
    const q = await ServiceBusWorkItemQueue.connect('cs', 'queue-name');
    const msg = (await q.receive())!;
    await q.deadLetter(msg, 'POISON_MESSAGE');
    expect(mockReceiver.deadLetterMessage).toHaveBeenCalledWith(rawMessage, {
      deadLetterReason: 'POISON_MESSAGE',
    });
  });

  it('settling an unknown message is a no-op that never touches the SDK', async () => {
    const q = await ServiceBusWorkItemQueue.connect('cs', 'queue-name');
    const ghost = { messageId: 'nope', body: null, deliveryCount: 1 };
    await q.complete(ghost);
    await q.abandon(ghost);
    await q.deadLetter(ghost, 'X');
    expect(mockReceiver.completeMessage).not.toHaveBeenCalled();
    expect(mockReceiver.abandonMessage).not.toHaveBeenCalled();
    expect(mockReceiver.deadLetterMessage).not.toHaveBeenCalled();
  });

  it('close() closes the receiver and the client', async () => {
    mockReceiver.receiveMessages.mockResolvedValue([rawMessage]);
    const q = await ServiceBusWorkItemQueue.connect('cs', 'queue-name');
    await q.receive(); // forces the receiver to be created
    await q.close();
    expect(mockReceiver.close).toHaveBeenCalled();
    expect(mockClient.close).toHaveBeenCalled();
  });

  it('close() with no receiver still closes the client', async () => {
    const q = await ServiceBusWorkItemQueue.connect('cs', 'queue-name');
    await q.close();
    expect(mockReceiver.close).not.toHaveBeenCalled();
    expect(mockClient.close).toHaveBeenCalled();
  });
});
