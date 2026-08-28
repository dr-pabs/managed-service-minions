import type { QueueMessage, WorkItemQueue } from './queue.js';

/**
 * Structural subset of `@azure/service-bus`'s `ServiceBusReceivedMessage` we
 * actually read. Kept as an interface — not an import of the SDK — so this
 * module (and the whole package) type-checks and tests without
 * `@azure/service-bus` installed. Only `ServiceBusWorkItemQueue.connect`
 * touches the SDK, and it does so via a variable-specifier dynamic import
 * (see below) so even importing this file never loads the package.
 */
export interface ServiceBusReceivedMessageLike {
  messageId: string;
  body: unknown;
  deliveryCount: number;
}

/**
 * Structural subset of `@azure/service-bus`'s `ServiceBusReceiver` (peek-lock
 * mode). The SDK requires the *same* receiver instance that received a
 * message to settle it, so the queue below caches one receiver and passes the
 * original opaque message handle back on complete/abandon/deadLetter.
 */
export interface ServiceBusReceiverLike {
  receiveMessages(maxMessageCount: number): Promise<ServiceBusReceivedMessageLike[]>;
  completeMessage(message: unknown): Promise<void>;
  abandonMessage(message: unknown): Promise<void>;
  deadLetterMessage(message: unknown, options?: { deadLetterReason?: string }): Promise<void>;
  close(): Promise<void>;
}

/** Structural subset of `@azure/service-bus`'s `ServiceBusClient`. */
export interface ServiceBusClientLike {
  createReceiver(queueName: string): ServiceBusReceiverLike;
  close(): Promise<void>;
}

/** The package id resolved via dynamic import — never statically imported. */
const SERVICE_BUS_MODULE_ID = '@azure/service-bus';

/**
 * Azure Service Bus `WorkItemQueue` (Milestone 15). Peek-lock semantics, one
 * receiver cached per queue so complete/abandon/deadLetter settle the exact
 * message the receiver handed out. `connect` is the single point that loads
 * `@azure/service-bus` — a variable-specifier dynamic import the bundler/TS
 * cannot resolve statically, so the dependency stays "isolated behind the
 * queue interface" and tests run without it (per forge-ops.execplan.md
 * Milestone 15).
 */
export class ServiceBusWorkItemQueue implements WorkItemQueue {
  private receiverInstance: ServiceBusReceiverLike | undefined;
  private readonly handles = new Map<string, unknown>();

  private constructor(
    private readonly client: ServiceBusClientLike,
    private readonly queueName: string
  ) {}

  /** Loads the SDK lazily and opens a client; returns a ready queue. */
  static async connect(connectionString: string, queueName: string): Promise<ServiceBusWorkItemQueue> {
    const sdk = (await import(SERVICE_BUS_MODULE_ID)) as {
      ServiceBusClient: new (connectionString: string) => ServiceBusClientLike;
    };
    const client = new sdk.ServiceBusClient(connectionString);
    return new ServiceBusWorkItemQueue(client, queueName);
  }

  private receiver(): ServiceBusReceiverLike {
    if (!this.receiverInstance) {
      this.receiverInstance = this.client.createReceiver(this.queueName);
    }
    return this.receiverInstance;
  }

  async receive(): Promise<QueueMessage | undefined> {
    const messages = await this.receiver().receiveMessages(1);
    const raw = messages[0];
    if (!raw) {
      return undefined;
    }
    this.handles.set(raw.messageId, raw);
    return {
      messageId: raw.messageId,
      body: raw.body,
      deliveryCount: raw.deliveryCount,
    };
  }

  async complete(message: QueueMessage): Promise<void> {
    const raw = this.handles.get(message.messageId);
    if (!raw) {
      return;
    }
    await this.receiver().completeMessage(raw);
    this.handles.delete(message.messageId);
  }

  async abandon(message: QueueMessage): Promise<void> {
    const raw = this.handles.get(message.messageId);
    if (!raw) {
      return;
    }
    await this.receiver().abandonMessage(raw);
    this.handles.delete(message.messageId);
  }

  async deadLetter(message: QueueMessage, reason: string): Promise<void> {
    const raw = this.handles.get(message.messageId);
    if (!raw) {
      return;
    }
    await this.receiver().deadLetterMessage(raw, { deadLetterReason: reason });
    this.handles.delete(message.messageId);
  }

  async close(): Promise<void> {
    if (this.receiverInstance) {
      await this.receiverInstance.close();
      this.receiverInstance = undefined;
    }
    await this.client.close();
  }
}
