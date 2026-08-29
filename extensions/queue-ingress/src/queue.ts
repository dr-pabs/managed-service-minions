/**
 * The work-queue abstraction (Milestone 15). Both the in-memory queue (local
 * dev / tests) and the Azure Service Bus consumer implement this one
 * interface, so the processor and consume loop are transport-agnostic and the
 * test suite runs without any cloud dependency — the same dual-backend shape
 * `mcp-toolshed`'s `store.ts` uses (`createMemoryStore` for tests, a real
 * backend reserved for cloud).
 */
export interface QueueMessage {
  /** Service Bus message id (the in-memory queue assigns `msg_<n>`). */
  messageId: string;
  /** The raw envelope body — a `WorkItem`, or garbage the processor must dead-letter. */
  body: unknown;
  /** How many times this message has been delivered; increments each redelivery. */
  deliveryCount: number;
}

export interface WorkItemQueue {
  /** Returns the next available message (peek-lock), or `undefined` when empty. */
  receive(): Promise<QueueMessage | undefined>;
  /** Settles a message after successful processing — removes it permanently. */
  complete(message: QueueMessage): Promise<void>;
  /** Returns a failed message to the queue for redelivery (`deliveryCount` +1). */
  abandon(message: QueueMessage): Promise<void>;
  /** Moves a message to the dead-letter queue with a reason code — never silently drops. */
  deadLetter(message: QueueMessage, reason: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * In-memory `WorkItemQueue` (Milestone 15). Emulates Service Bus peek-lock
 * semantics: `receive` locks a message and bumps its `deliveryCount`,
 * `complete`/`deadLetter` settle it, and `abandon` returns it to the tail of
 * the queue with the count intact so the processor can detect a poisoned item
 * (deliveryCount reaching `maxDeliveryCount`). Used for local dev and every
 * test; the real transport is `ServiceBusWorkItemQueue`.
 */
export class InMemoryWorkItemQueue implements WorkItemQueue {
  private available: QueueMessage[] = [];
  private inFlight = new Map<string, QueueMessage>();
  private dead: Array<{ body: unknown; reason: string }> = [];
  private sequence = 0;
  private closed = false;

  /** Producer/test convenience: enqueue a raw body (a `WorkItem` or garbage). */
  enqueue(body: unknown): string {
    this.sequence += 1;
    const messageId = `msg_${this.sequence}`;
    this.available.push({ messageId, body, deliveryCount: 0 });
    return messageId;
  }

  async receive(): Promise<QueueMessage | undefined> {
    if (this.closed) {
      return undefined;
    }
    const entry = this.available.shift();
    if (!entry) {
      return undefined;
    }
    const message: QueueMessage = {
      messageId: entry.messageId,
      body: entry.body,
      deliveryCount: entry.deliveryCount + 1,
    };
    this.inFlight.set(message.messageId, message);
    return message;
  }

  async complete(message: QueueMessage): Promise<void> {
    this.inFlight.delete(message.messageId);
  }

  async abandon(message: QueueMessage): Promise<void> {
    const entry = this.inFlight.get(message.messageId);
    if (!entry) {
      return;
    }
    this.inFlight.delete(message.messageId);
    this.available.push(entry);
  }

  async deadLetter(message: QueueMessage, reason: string): Promise<void> {
    const entry = this.inFlight.get(message.messageId);
    if (!entry) {
      return;
    }
    this.inFlight.delete(message.messageId);
    this.dead.push({ body: entry.body, reason });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.available = [];
    this.inFlight.clear();
  }

  /** Test/observation helper: the dead-lettered bodies and their reason codes. */
  deadLetters(): Array<{ body: unknown; reason: string }> {
    return [...this.dead];
  }

  /** Test/observation helper: messages currently locked (received but not yet settled). */
  inFlightCount(): number {
    return this.inFlight.size;
  }
}
