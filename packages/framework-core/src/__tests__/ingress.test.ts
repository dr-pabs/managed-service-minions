import { describe, expect, it, jest } from '@jest/globals';
import { handleIngressMessage, resolveSessionTtlHours, DEFAULT_SESSION_TTL_HOURS } from '../ingress.js';
import type { Session, SessionStore } from '../store.js';

describe('resolveSessionTtlHours', () => {
  const originalTtl = process.env.SESSION_TTL_HOURS;

  afterEach(() => {
    if (originalTtl === undefined) delete process.env.SESSION_TTL_HOURS;
    else process.env.SESSION_TTL_HOURS = originalTtl;
  });

  it('defaults to 72 when unset', () => {
    delete process.env.SESSION_TTL_HOURS;
    expect(resolveSessionTtlHours()).toBe(DEFAULT_SESSION_TTL_HOURS);
  });

  it('uses a valid positive override', () => {
    process.env.SESSION_TTL_HOURS = '24';
    expect(resolveSessionTtlHours()).toBe(24);
  });

  it('falls back to the default for a non-numeric override', () => {
    process.env.SESSION_TTL_HOURS = 'not-a-number';
    expect(resolveSessionTtlHours()).toBe(DEFAULT_SESSION_TTL_HOURS);
  });

  it('falls back to the default for a zero or negative override', () => {
    process.env.SESSION_TTL_HOURS = '0';
    expect(resolveSessionTtlHours()).toBe(DEFAULT_SESSION_TTL_HOURS);
    process.env.SESSION_TTL_HOURS = '-5';
    expect(resolveSessionTtlHours()).toBe(DEFAULT_SESSION_TTL_HOURS);
  });
});

describe('handleIngressMessage', () => {
  const makeStore = (): SessionStore => {
    const sessions = new Map<string, Session>();
    const archive: Session[] = [];
    return {
      createSession: jest.fn((session: Session) => {
        sessions.set(session.id, session);
      }),
      getSession: jest.fn((id: string) => sessions.get(id)),
      updateSession: jest.fn((id: string, patch: Partial<Session>) => {
        const existing = sessions.get(id);
        if (existing) {
          sessions.set(id, { ...existing, ...patch });
        }
      }),
      listSessions: jest.fn(() => Array.from(sessions.values())),
      createMinionRun: jest.fn(),
      updateMinionRun: jest.fn(),
      listMinionRunsBySession: jest.fn(),
      listMinionRunsByCorrelationRoot: jest.fn(),
      createApproval: jest.fn(),
      getApproval: jest.fn().mockReturnValue(undefined),
      getApprovalByRequestHash: jest.fn().mockReturnValue(undefined),
      resolveApproval: jest.fn(),
      markApprovalConsumed: jest.fn(),
      listPendingApprovals: jest.fn(),
      createAuditEntry: jest.fn(),
      listAuditEntries: jest.fn().mockReturnValue([]),
      getCachedToolCall: jest.fn(),
      setCachedToolCall: jest.fn(),
      expireSessions: jest.fn((expireNow: number) => {
        // Real implementations archive (remove-from-live-view) any session
        // idle past the caller's TTL window; this fake mirrors that
        // observable effect (removal from `getSession`/`listSessions`, plus
        // insertion into the archive) without a real archive table.
        for (const [id, session] of sessions) {
          if (expireNow - session.updatedAt > DEFAULT_SESSION_TTL_HOURS * 60 * 60 * 1000) {
            archive.push(session);
            sessions.delete(id);
          }
        }
      }),
      listSessionArchive: jest.fn(() => archive.slice()),
    };
  };

  it('creates a new session when no thread id exists', async () => {
    const store = makeStore();
    const runner = { run: jest.fn().mockResolvedValue({ text: 'ok' }) };

    await handleIngressMessage(
      { platform: 'slack', teamId: 't1', userId: 'u1', text: 'hello' },
      store,
      runner
    );

    expect(store.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        teamId: 't1',
        platform: 'slack',
        userId: 'u1',
        correlationRoot: expect.stringMatching(/^corr_/),
      })
    );
  });

  it('reuses an existing session when thread id matches', async () => {
    const store = makeStore();
    const runner = { run: jest.fn().mockResolvedValue({ text: 'ok' }) };

    // First message creates the session for this (teamId, platform, threadId).
    await handleIngressMessage(
      { platform: 'slack', teamId: 't1', userId: 'u1', text: 'hello', threadId: 'thread-1' },
      store,
      runner
    );
    const firstSessionId = (store.createSession as jest.Mock).mock.calls[0][0].id as string;

    // Second message on the SAME thread must find and reuse the same session.
    await handleIngressMessage(
      { platform: 'slack', teamId: 't1', userId: 'u1', text: 'again', threadId: 'thread-1' },
      store,
      runner
    );

    expect(store.createSession).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: firstSessionId })
    );
  });

  it('keys sessions by (teamId, platform, threadId) — a different team on the same threadId gets its own session', async () => {
    const store = makeStore();
    const runner = { run: jest.fn().mockResolvedValue({ text: 'ok' }) };

    await handleIngressMessage(
      { platform: 'slack', teamId: 't1', userId: 'u1', text: 'hello', threadId: 'thread-1' },
      store,
      runner
    );
    await handleIngressMessage(
      { platform: 'slack', teamId: 't2', userId: 'u2', text: 'hello', threadId: 'thread-1' },
      store,
      runner
    );

    expect(store.createSession).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = (store.createSession as jest.Mock).mock.calls;
    expect(firstCall[0].id).not.toBe(secondCall[0].id);
  });

  it('M3 regression: two non-threaded channel messages produce two DISTINCT sessions', async () => {
    const store = makeStore();
    const runner = { run: jest.fn().mockResolvedValue({ text: 'ok' }) };

    // Simulates two separate, non-threaded messages in the same channel: each
    // carries its OWN message timestamp as threadId (per the slack-bot fix),
    // never the shared channel id. Before this milestone, a bug elsewhere in
    // the stack collapsed all such messages into one shared, never-ending
    // session; this test pins the ingress side of that contract: distinct
    // threadIds must never be coalesced into the same session.
    await handleIngressMessage(
      { platform: 'slack', teamId: 't1', userId: 'u1', text: 'first message', threadId: 'ts-1' },
      store,
      runner
    );
    await handleIngressMessage(
      { platform: 'slack', teamId: 't1', userId: 'u1', text: 'second message', threadId: 'ts-2' },
      store,
      runner
    );

    expect(store.createSession).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = (store.createSession as jest.Mock).mock.calls;
    expect(firstCall[0].id).not.toBe(secondCall[0].id);
    expect(store.listSessions()).toHaveLength(2);
  });

  it('touches updatedAt on every message, including a reused session', async () => {
    const store = makeStore();
    const runner = { run: jest.fn().mockResolvedValue({ text: 'ok' }) };
    let clock = 1000;
    const now = () => clock;

    await handleIngressMessage(
      { platform: 'slack', teamId: 't1', userId: 'u1', text: 'hello', threadId: 'thread-1' },
      store,
      runner,
      { now }
    );
    const created = store.getSession(
      ((store.createSession as jest.Mock).mock.calls[0][0] as Session).id
    )!;
    expect(created.updatedAt).toBe(1000);

    clock = 5000;
    await handleIngressMessage(
      { platform: 'slack', teamId: 't1', userId: 'u1', text: 'again', threadId: 'thread-1' },
      store,
      runner,
      { now }
    );

    expect(store.createSession).toHaveBeenCalledTimes(1);
    expect(store.updateSession).toHaveBeenCalledWith(
      created.id,
      expect.objectContaining({ updatedAt: 5000 })
    );
  });

  it('does not resume a session idle past SESSION_TTL_HOURS — creates a new one instead', async () => {
    const store = makeStore();
    const runner = { run: jest.fn().mockResolvedValue({ text: 'ok' }) };
    let clock = 0;
    const now = () => clock;

    await handleIngressMessage(
      { platform: 'slack', teamId: 't1', userId: 'u1', text: 'hello', threadId: 'thread-1' },
      store,
      runner,
      { now }
    );
    const firstCorrelationRoot = (store.createSession as jest.Mock).mock.calls[0][0]
      .correlationRoot as string;
    const expireSpy = store.expireSessions as jest.Mock;

    // Advance the clock past the default 72-hour TTL.
    clock = 73 * 60 * 60 * 1000;
    await handleIngressMessage(
      { platform: 'slack', teamId: 't1', userId: 'u1', text: 'still there?', threadId: 'thread-1' },
      store,
      runner,
      { now }
    );

    // The stale session is archived (not silently overwritten), then a
    // genuinely NEW session record is created — same deterministic id (it is
    // the only live session on this thread again), but a fresh
    // correlationRoot/createdAt, i.e. not a resumption of the old run.
    expect(expireSpy).toHaveBeenCalledWith(clock);
    expect(store.createSession).toHaveBeenCalledTimes(2);
    const secondCall = (store.createSession as jest.Mock).mock.calls[1][0] as Session;
    expect(secondCall.correlationRoot).not.toBe(firstCorrelationRoot);
    expect(secondCall.createdAt).toBe(clock);
    expect(runner.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ correlationRoot: secondCall.correlationRoot })
    );
  });

  it('resumes normally when the session is idle but still within the TTL', async () => {
    const store = makeStore();
    const runner = { run: jest.fn().mockResolvedValue({ text: 'ok' }) };
    let clock = 0;
    const now = () => clock;

    await handleIngressMessage(
      { platform: 'slack', teamId: 't1', userId: 'u1', text: 'hello', threadId: 'thread-1' },
      store,
      runner,
      { now }
    );
    const firstId = (store.createSession as jest.Mock).mock.calls[0][0].id as string;

    clock = 71 * 60 * 60 * 1000; // just under 72h
    await handleIngressMessage(
      { platform: 'slack', teamId: 't1', userId: 'u1', text: 'still there', threadId: 'thread-1' },
      store,
      runner,
      { now }
    );

    expect(store.createSession).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: firstId })
    );
  });

  it('returns the runner response', async () => {
    const store = makeStore();
    const runner = { run: jest.fn().mockResolvedValue({ text: 'done', blocks: [] }) };

    const result = await handleIngressMessage(
      { platform: 'teams', teamId: 't2', userId: 'u2', text: 'go' },
      store,
      runner
    );

    expect(result).toEqual({ text: 'done', blocks: [] });
  });
});
