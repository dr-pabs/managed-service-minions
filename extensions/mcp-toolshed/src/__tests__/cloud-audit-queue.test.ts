import { jest } from '@jest/globals';
import { createRetryingAuditLogger } from '../cloud-audit.js';
import type { AuditEntry } from 'framework-core';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 'audit_1',
    timestamp: 1,
    correlationId: 'corr_1',
    minionType: 'code-explorer',
    teamId: 'team-a',
    serverAlias: 'github',
    toolName: 'get_file_contents',
    params: { path: '/repo/readme.md' },
    status: 'success',
    latencyMs: 10,
    ...overrides,
  };
}

/** Drains the microtask/macrotask queue enough times for pending promise chains to settle. */
async function flushAsync(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('createRetryingAuditLogger', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'toolshed-audit-dlq-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('delivers exactly once on first-attempt success', async () => {
    const deliver = jest.fn<(entry: AuditEntry) => Promise<void>>().mockResolvedValue(undefined);
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const logger = createRetryingAuditLogger({ deliver, sleep, dlqPath: path.join(tmpDir, 'dlq.jsonl') });

    logger(makeEntry());
    await flushAsync();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('a logger that fails twice then succeeds delivers exactly once (retry)', async () => {
    const deliver = jest
      .fn<(entry: AuditEntry) => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockRejectedValueOnce(new Error('transient 2'))
      .mockResolvedValueOnce(undefined);
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const logger = createRetryingAuditLogger({ deliver, sleep, dlqPath: path.join(tmpDir, 'dlq.jsonl') });

    logger(makeEntry());
    await flushAsync();

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(existsSync(path.join(tmpDir, 'dlq.jsonl'))).toBe(false);
  });

  it('backoff delay grows across attempts (injectable, no real timers)', async () => {
    const deliver = jest
      .fn<(entry: AuditEntry) => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockResolvedValueOnce(undefined);
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const logger = createRetryingAuditLogger({ deliver, sleep, dlqPath: path.join(tmpDir, 'dlq.jsonl') });

    logger(makeEntry());
    await flushAsync();

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBeGreaterThan(0);
  });

  it('a logger that always fails lands the entry in the DLQ file after exhausting attempts', async () => {
    const deliver = jest.fn<(entry: AuditEntry) => Promise<void>>().mockRejectedValue(new Error('down'));
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const dlqPath = path.join(tmpDir, 'dlq.jsonl');
    const logger = createRetryingAuditLogger({ deliver, sleep, dlqPath });

    logger(makeEntry({ id: 'audit_dlq' }));
    await flushAsync();

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(existsSync(dlqPath)).toBe(true);
    const lines = readFileSync(dlqPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as AuditEntry;
    expect(parsed.id).toBe('audit_dlq');
  });

  it('appends multiple DLQ entries as separate JSONL lines', async () => {
    const deliver = jest.fn<(entry: AuditEntry) => Promise<void>>().mockRejectedValue(new Error('down'));
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const dlqPath = path.join(tmpDir, 'dlq.jsonl');
    const logger = createRetryingAuditLogger({ deliver, sleep, dlqPath });

    logger(makeEntry({ id: 'audit_a' }));
    await flushAsync();
    logger(makeEntry({ id: 'audit_b' }));
    await flushAsync();

    const lines = readFileSync(dlqPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('a DLQ write failure is isolated and never throws or crashes the pipeline', async () => {
    const deliver = jest.fn<(entry: AuditEntry) => Promise<void>>().mockRejectedValue(new Error('down'));
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const appendDlq = jest.fn<(dlqPath: string, line: string) => Promise<void>>().mockRejectedValue(new Error('disk full'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const logger = createRetryingAuditLogger({
      deliver,
      sleep,
      dlqPath: path.join(tmpDir, 'unwritable.jsonl'),
      appendDlq,
    });

    expect(() => logger(makeEntry())).not.toThrow();
    await flushAsync();

    expect(appendDlq).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('a DLQ write failure that rejects with a non-Error is still logged and isolated', async () => {
    const deliver = jest.fn<(entry: AuditEntry) => Promise<void>>().mockRejectedValue(new Error('down'));
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const appendDlq = jest.fn<(dlqPath: string, line: string) => Promise<void>>().mockRejectedValue('disk full string' as any);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const logger = createRetryingAuditLogger({
      deliver,
      sleep,
      dlqPath: path.join(tmpDir, 'unwritable.jsonl'),
      appendDlq,
    });

    expect(() => logger(makeEntry())).not.toThrow();
    await flushAsync();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('disk full string'));
    errorSpy.mockRestore();
  });

  it('a deliver rejection with a non-Error value is still logged and lands in the DLQ', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deliver = jest.fn<(entry: AuditEntry) => Promise<void>>().mockRejectedValue('plain string rejection' as any);
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const dlqPath = path.join(tmpDir, 'dlq.jsonl');
    const logger = createRetryingAuditLogger({ deliver, sleep, dlqPath });

    logger(makeEntry({ id: 'audit_nonerror' }));
    await flushAsync();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('plain string rejection'));
    expect(existsSync(dlqPath)).toBe(true);
    errorSpy.mockRestore();
  });

  it('the default dlqPath falls back to TOOLSHED_AUDIT_DLQ_PATH, then ./audit-dlq.jsonl', () => {
    const deliver = jest.fn<(entry: AuditEntry) => Promise<void>>().mockResolvedValue(undefined);
    const prev = process.env.TOOLSHED_AUDIT_DLQ_PATH;
    delete process.env.TOOLSHED_AUDIT_DLQ_PATH;
    try {
      const logger = createRetryingAuditLogger({ deliver });
      expect(logger.dlqPath).toBe('./audit-dlq.jsonl');
    } finally {
      if (prev !== undefined) process.env.TOOLSHED_AUDIT_DLQ_PATH = prev;
    }
  });

  it('honors TOOLSHED_AUDIT_DLQ_PATH when set and dlqPath is not explicitly passed', () => {
    const deliver = jest.fn<(entry: AuditEntry) => Promise<void>>().mockResolvedValue(undefined);
    const prev = process.env.TOOLSHED_AUDIT_DLQ_PATH;
    process.env.TOOLSHED_AUDIT_DLQ_PATH = '/custom/dlq.jsonl';
    try {
      const logger = createRetryingAuditLogger({ deliver });
      expect(logger.dlqPath).toBe('/custom/dlq.jsonl');
    } finally {
      if (prev !== undefined) process.env.TOOLSHED_AUDIT_DLQ_PATH = prev;
      else delete process.env.TOOLSHED_AUDIT_DLQ_PATH;
    }
  });

  it('uses the real timer-based sleep by default (backoffMs kept at 1ms for test speed)', async () => {
    const deliver = jest
      .fn<(entry: AuditEntry) => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined);
    const logger = createRetryingAuditLogger({
      deliver,
      backoffMs: () => 1,
      dlqPath: path.join(tmpDir, 'dlq.jsonl'),
    });

    logger(makeEntry());
    // No injected sleep: give the real setTimeout(1ms) + microtasks time to run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('uses the real filesystem append by default when appendDlq is not injected', async () => {
    const deliver = jest.fn<(entry: AuditEntry) => Promise<void>>().mockRejectedValue(new Error('down'));
    const dlqPath = path.join(tmpDir, 'real-fs-dlq.jsonl');
    const logger = createRetryingAuditLogger({ deliver, backoffMs: () => 1, dlqPath });

    logger(makeEntry({ id: 'audit_real_fs' }));
    // No injected sleep or appendDlq: wait for real timers + real fs.appendFile.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(existsSync(dlqPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(dlqPath, 'utf8').trim()) as AuditEntry;
    expect(parsed.id).toBe('audit_real_fs');
  });

  it('bounds the queue at 1000 in-flight entries and drops the OLDEST pending entry on overflow (drop-oldest policy)', async () => {
    // Never resolve `deliver` so every submitted entry stays queued/in-flight
    // (attempt 1 pending) long enough to submit past the bound in one tick.
    let resolveDeliver: (() => void) | undefined;
    const deliver = jest.fn<(entry: AuditEntry) => Promise<void>>().mockImplementation(
      () =>
        new Promise((resolve) => {
          if (!resolveDeliver) resolveDeliver = resolve as () => void;
        })
    );
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logger = createRetryingAuditLogger({
      deliver,
      sleep,
      dlqPath: path.join(tmpDir, 'dlq.jsonl'),
      maxQueueSize: 3,
    });

    logger(makeEntry({ id: 'audit_0' }));
    logger(makeEntry({ id: 'audit_1' }));
    logger(makeEntry({ id: 'audit_2' }));
    // Fourth entry overflows the bound of 3; drop-oldest means audit_0 is evicted.
    logger(makeEntry({ id: 'audit_overflow' }));

    expect(warnSpy).toHaveBeenCalled();
    expect(logger.queueLength()).toBeLessThanOrEqual(3);
    warnSpy.mockRestore();
  });
});
