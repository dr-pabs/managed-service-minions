import { jest } from '@jest/globals';
import { createMemoryStore, createSqliteStore, type PendingApproval, type AuditEntry } from '../store.js';

type Statement = {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

type DatabaseCtor = new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
};

function createStatement(overrides: Partial<Statement> = {}): Statement {
  return {
    run: jest.fn() as unknown as Statement['run'],
    get: jest.fn().mockReturnValue(undefined) as unknown as Statement['get'],
    // Defaults to [] (not undefined) because store.ts's PRAGMA table_info
    // migration guard calls `.some(...)` on every `all()` result, including
    // this shared default statement used for CREATE TABLE/PRAGMA calls in
    // most of these hand-mocked tests.
    all: jest.fn().mockReturnValue([]) as unknown as Statement['all'],
    ...overrides,
  };
}

describe('store', () => {
  describe('createMemoryStore', () => {
    it('stores and retrieves sessions', () => {
      const store = createMemoryStore();
      const session = {
        id: 's1',
        teamId: 'team-a',
        platform: 'slack',
        userId: 'u1',
        correlationRoot: 'corr_1',
        createdAt: 1,
        updatedAt: 1,
      };
      store.createSession(session);
      expect(store.getSession('s1')).toEqual(session);
      expect(store.getSession('missing')).toBeUndefined();
    });

    it('stores and updates minion runs', () => {
      const store = createMemoryStore();
      const run = {
        id: 'r1',
        sessionId: 's1',
        minionType: 'code-explorer',
        correlationId: 'corr_1',
        status: 'running',
        createdAt: 1,
      };
      store.createMinionRun(run);
      store.updateMinionRun('r1', { status: 'completed', completedAt: 2 });
      store.updateMinionRun('r1', { tokensUsed: 10 });
      store.updateMinionRun('missing', { status: 'completed' });
      expect(store.getSession('r1')).toBeUndefined();
    });

    it('stores, retrieves, and resolves approvals', () => {
      const store = createMemoryStore();
      const approval: PendingApproval = {
        id: 'a1',
        sessionId: 's1',
        correlationId: 'corr_1',
        serverAlias: 'github',
        toolName: 'merge_pull_request',
        paramsJson: '{}',
        requestedAt: 1,
        timeoutAt: 2,
        requestHash: 'hash_1',
      };
      store.createApproval(approval);
      expect(store.getApproval('a1')).toBe(approval);
      expect(store.getApproval('missing')).toBeUndefined();
      store.resolveApproval('a1', 'approved');
      expect(approval.decision).toBe('approved');
      expect(approval.decidedAt).toBeDefined();
      store.resolveApproval('missing', 'denied');
    });

    it('M4: teamId is its own field, distinct from sessionId, and round-trips through the memory store', () => {
      const store = createMemoryStore();
      const approval: PendingApproval = {
        id: 'a1-teamid',
        sessionId: 'sess-distinct',
        teamId: 'team-distinct',
        correlationId: 'corr_1',
        serverAlias: 'github',
        toolName: 'merge_pull_request',
        paramsJson: '{}',
        requestedAt: 1,
        timeoutAt: 2,
        requestHash: 'hash_teamid',
      };
      store.createApproval(approval);
      const retrieved = store.getApproval('a1-teamid');
      expect(retrieved?.sessionId).toBe('sess-distinct');
      expect(retrieved?.teamId).toBe('team-distinct');
    });

    it('records the operator identity that resolved an approval (Milestone 3)', () => {
      const store = createMemoryStore();
      const approval: PendingApproval = {
        id: 'a2',
        sessionId: 's1',
        correlationId: 'corr_1',
        serverAlias: 'github',
        toolName: 'merge_pull_request',
        paramsJson: '{}',
        requestedAt: 1,
        timeoutAt: 2,
        requestHash: 'hash_1',
      };
      store.createApproval(approval);
      store.resolveApproval('a2', 'approved', { kind: 'slack', id: 'U123' });
      expect(approval.approverKind).toBe('slack');
      expect(approval.approverId).toBe('U123');
    });

    it('getApprovalByRequestHash returns the most-recently-requested match (Milestone 4 resume contract)', () => {
      const store = createMemoryStore();
      store.createApproval({
        id: 'older',
        sessionId: 's1',
        correlationId: 'corr_1',
        serverAlias: 'github',
        toolName: 'merge_pull_request',
        paramsJson: '{}',
        requestedAt: 100,
        timeoutAt: 200,
        requestHash: 'shared_hash',
      });
      store.createApproval({
        id: 'newer',
        sessionId: 's1',
        correlationId: 'corr_1',
        serverAlias: 'github',
        toolName: 'merge_pull_request',
        paramsJson: '{}',
        requestedAt: 200,
        timeoutAt: 300,
        requestHash: 'shared_hash',
      });
      expect(store.getApprovalByRequestHash('shared_hash')?.id).toBe('newer');
      expect(store.getApprovalByRequestHash('no_such_hash')).toBeUndefined();
    });

    it('markApprovalConsumed sets consumedAt and is a no-op for a missing approval', () => {
      const store = createMemoryStore();
      const approval: PendingApproval = {
        id: 'a3',
        sessionId: 's1',
        correlationId: 'corr_1',
        serverAlias: 'github',
        toolName: 'merge_pull_request',
        paramsJson: '{}',
        requestedAt: 1,
        timeoutAt: 2,
        requestHash: 'hash_3',
      };
      store.createApproval(approval);
      store.markApprovalConsumed('a3', 999);
      expect(approval.consumedAt).toBe(999);
      store.markApprovalConsumed('missing', 999);
    });

    it('caches tool calls', () => {
      const store = createMemoryStore();
      store.setCachedToolCall('key', { value: 42 }, 60_000);
      expect(store.getCachedToolCall('key')).toEqual({ value: 42 });
      expect(store.getCachedToolCall('missing')).toBeUndefined();
    });

    it('expires a cached tool call past its TTL using the injected clock', () => {
      let now = 1000;
      const store = createMemoryStore(() => now);
      store.setCachedToolCall('key', { value: 42 }, 1000);
      expect(store.getCachedToolCall('key')).toEqual({ value: 42 });
      now += 1001;
      expect(store.getCachedToolCall('key')).toBeUndefined();
    });

    it('evicts the oldest entry once the 5,000-row cap is reached', () => {
      let now = 0;
      const store = createMemoryStore(() => now);
      for (let i = 0; i < 5000; i++) {
        now += 1;
        store.setCachedToolCall(`key-${i}`, i, 60_000_000);
      }
      expect(store.getCachedToolCall('key-0')).toBe(0);
      now += 1;
      store.setCachedToolCall('key-5000', 5000, 60_000_000);
      // The oldest entry (key-0) must have been evicted to make room.
      expect(store.getCachedToolCall('key-0')).toBeUndefined();
      expect(store.getCachedToolCall('key-5000')).toBe(5000);
    });

    it('does not evict when overwriting an existing key at the cap', () => {
      let now = 0;
      const store = createMemoryStore(() => now);
      for (let i = 0; i < 5000; i++) {
        now += 1;
        store.setCachedToolCall(`key-${i}`, i, 60_000_000);
      }
      now += 1;
      store.setCachedToolCall('key-0', 'updated', 60_000_000);
      expect(store.getCachedToolCall('key-0')).toBe('updated');
      expect(store.getCachedToolCall('key-1')).toBe(1);
    });

    it('stores and lists audit entries', () => {
      const store = createMemoryStore();
      const entry: AuditEntry = {
        id: 'e1',
        timestamp: 1,
        correlationId: 'corr_1',
        minionType: 'code-explorer',
        teamId: 'team-a',
        serverAlias: 'github',
        toolName: 'get_file_contents',
        params: { path: '/repo/readme.md' },
        status: 'success',
        latencyMs: 10,
      };
      store.createAuditEntry(entry);
      expect(store.listAuditEntries()).toHaveLength(1);
      expect(store.listAuditEntries({ correlationId: 'corr_1' })[0]).toMatchObject(entry);
      expect(store.listAuditEntries({ correlationId: 'other' })).toHaveLength(0);
      expect(store.listAuditEntries({ limit: 0 })).toHaveLength(0);
      expect(store.listAuditEntries({ offset: 1 })).toHaveLength(0);
    });

    it('sorts audit entries by descending timestamp', () => {
      const store = createMemoryStore();
      store.createAuditEntry({
        id: 'e1',
        timestamp: 1,
        correlationId: 'corr_1',
        minionType: 'code-explorer',
        teamId: 'team-a',
        serverAlias: 'github',
        toolName: 'get_file_contents',
        params: undefined,
        status: 'success',
        latencyMs: 10,
      });
      store.createAuditEntry({
        id: 'e2',
        timestamp: 3,
        correlationId: 'corr_1',
        minionType: 'code-explorer',
        teamId: 'team-a',
        serverAlias: 'github',
        toolName: 'get_file_contents',
        params: undefined,
        status: 'success',
        latencyMs: 10,
      });
      const entries = store.listAuditEntries();
      expect(entries[0].id).toBe('e2');
      expect(entries[1].id).toBe('e1');
    });
  });

  describe('createSqliteStore', () => {
    it('falls back to memory when the constructor throws', () => {
      const DatabaseCtor = jest.fn().mockImplementation(() => {
        throw new Error('native bindings missing');
      }) as unknown as DatabaseCtor;
      const store = createSqliteStore(':memory:', DatabaseCtor);
      store.createSession({
        id: 's1',
        teamId: 'team-a',
        platform: 'slack',
        userId: 'u1',
        correlationRoot: 'corr_1',
        createdAt: 1,
        updatedAt: 1,
      });
      expect(store.getSession('s1')).toMatchObject({ id: 's1' });
    });

    it('falls back when the constructor throws a non-error', () => {
      const DatabaseCtor = jest.fn().mockImplementation(() => {
        throw 'string failure';
      }) as unknown as DatabaseCtor;
      const store = createSqliteStore(':memory:', DatabaseCtor);
      expect(store.getSession('s1')).toBeUndefined();
    });

    describe('H6: fail-hard in production instead of silently degrading to memory', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalAllowMemory = process.env.TOOLSHED_ALLOW_MEMORY_STORE;

      afterEach(() => {
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
        if (originalAllowMemory === undefined) delete process.env.TOOLSHED_ALLOW_MEMORY_STORE;
        else process.env.TOOLSHED_ALLOW_MEMORY_STORE = originalAllowMemory;
      });

      it('still falls back with a warning outside production (dev branch unchanged)', () => {
        delete process.env.NODE_ENV;
        delete process.env.TOOLSHED_ALLOW_MEMORY_STORE;
        const DatabaseCtor = jest.fn().mockImplementation(() => {
          throw new Error('native bindings missing');
        }) as unknown as DatabaseCtor;
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        const store = createSqliteStore(':memory:', DatabaseCtor);
        store.createSession({
          id: 's1',
          teamId: 'team-a',
          platform: 'slack',
          userId: 'u1',
          correlationRoot: 'corr_1',
          createdAt: 1,
          updatedAt: 1,
        });
        expect(store.getSession('s1')).toMatchObject({ id: 's1' });
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it('THROWS instead of falling back in production without the escape hatch', () => {
        process.env.NODE_ENV = 'production';
        delete process.env.TOOLSHED_ALLOW_MEMORY_STORE;
        const DatabaseCtor = jest.fn().mockImplementation(() => {
          throw new Error('native bindings missing');
        }) as unknown as DatabaseCtor;

        expect(() => createSqliteStore(':memory:', DatabaseCtor)).toThrow(
          /SQLite unavailable.*production/i
        );
      });

      it('falls back with a warning in production when TOOLSHED_ALLOW_MEMORY_STORE=1', () => {
        process.env.NODE_ENV = 'production';
        process.env.TOOLSHED_ALLOW_MEMORY_STORE = '1';
        const DatabaseCtor = jest.fn().mockImplementation(() => {
          throw new Error('native bindings missing');
        }) as unknown as DatabaseCtor;
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        const store = createSqliteStore(':memory:', DatabaseCtor);
        store.createSession({
          id: 's1',
          teamId: 'team-a',
          platform: 'slack',
          userId: 'u1',
          correlationRoot: 'corr_1',
          createdAt: 1,
          updatedAt: 1,
        });
        expect(store.getSession('s1')).toMatchObject({ id: 's1' });
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
      });
    });

    it('uses SQLite when available', () => {
      const prepared = createStatement({
        get: jest.fn().mockImplementation(
          ((id: string) => {
            if (id === 'key') return { value: JSON.stringify({ value: 42 }), expires_at: Number.MAX_SAFE_INTEGER };
            return {
              id: 's1',
              team_id: 'team-a',
              platform: 'slack',
              user_id: 'u1',
              correlation_root: 'corr_1',
              created_at: 1,
              updated_at: 1,
            };
          }) as (...args: unknown[]) => unknown
        ) as unknown as Statement['get'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      store.createSession({
        id: 's1',
        teamId: 'team-a',
        platform: 'slack',
        userId: 'u1',
        correlationRoot: 'corr_1',
        createdAt: 1,
        updatedAt: 1,
      });
      store.createMinionRun({
        id: 'r1',
        sessionId: 's1',
        minionType: 'code-explorer',
        correlationId: 'corr_1',
        status: 'running',
        createdAt: 1,
      });
      store.updateMinionRun('r1', { status: 'completed', completedAt: 2 });
      store.updateMinionRun('r1', { tokensUsed: 10 });
      store.createApproval({
        id: 'a1',
        sessionId: 's1',
        correlationId: 'corr_1',
        serverAlias: 'github',
        toolName: 'merge_pull_request',
        paramsJson: '{}',
        requestedAt: 1,
        timeoutAt: 2,
        requestHash: 'hash_1',
      });
      store.resolveApproval('a1', 'approved', { kind: 'dashboard', id: 'operator_1' });
      store.setCachedToolCall('key', { value: 42 }, 60_000);
      expect(store.getCachedToolCall('key')).toEqual({ value: 42 });

      expect(db.exec).toHaveBeenCalled();
      expect(prepared.run).toHaveBeenCalled();

      const session = store.getSession('s1');
      expect(session).toMatchObject({ id: 's1', teamId: 'team-a' });
    });

    it('returns undefined for missing SQLite records', () => {
      const prepared = createStatement();
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      expect(store.getSession('missing')).toBeUndefined();
    });

    it('silently ignores updates for missing runs', () => {
      const prepared = createStatement();
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      store.updateMinionRun('missing', { status: 'completed' });
    });

    it('silently ignores resolve for missing approvals', () => {
      const prepared = createStatement();
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      store.resolveApproval('missing', 'denied');
    });

    it('resolves an approval in sqlite with no approver supplied', () => {
      const prepared = createStatement({
        get: jest.fn().mockReturnValue({ id: 'a1' }) as unknown as Statement['get'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      store.resolveApproval('a1', 'denied');
      expect(prepared.run).toHaveBeenCalledWith('denied', expect.any(Number), null, null, 'a1');
    });

    it('M4: passes teamId to the insert statement in its own column, and maps team_id back on read', () => {
      const prepared = createStatement();
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;
      const store = createSqliteStore(':memory:', DatabaseCtor);

      store.createApproval({
        id: 'a-teamid',
        sessionId: 'sess-distinct',
        teamId: 'team-distinct',
        correlationId: 'corr_1',
        serverAlias: 'github',
        toolName: 'merge_pull_request',
        paramsJson: '{}',
        requestedAt: 1,
        timeoutAt: 2,
        requestHash: 'hash_teamid',
      });
      expect(prepared.run).toHaveBeenCalledWith(
        'a-teamid',
        'sess-distinct',
        'team-distinct',
        'corr_1',
        'github',
        'merge_pull_request',
        '{}',
        1,
        2,
        null,
        null,
        null,
        null,
        'hash_teamid',
        null
      );

      (prepared.get as jest.Mock).mockReturnValue({
        id: 'a-teamid',
        session_id: 'sess-distinct',
        team_id: 'team-distinct',
        correlation_id: 'corr_1',
        server_alias: 'github',
        tool_name: 'merge_pull_request',
        params_json: '{}',
        requested_at: 1,
        timeout_at: 2,
      });
      const retrieved = store.getApproval('a-teamid');
      expect(retrieved?.sessionId).toBe('sess-distinct');
      expect(retrieved?.teamId).toBe('team-distinct');
    });

    it('retrieves an approval from sqlite', () => {
      const prepared = createStatement({
        get: jest.fn().mockReturnValue({
          id: 'a1',
          session_id: 's1',
          correlation_id: 'corr_1',
          server_alias: 'github',
          tool_name: 'merge_pull_request',
          params_json: '{}',
          requested_at: 1,
          timeout_at: 2,
          decision: 'approved',
          decided_at: 3,
          approver_kind: 'slack',
          approver_id: 'U123',
        }) as unknown as Statement['get'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      const approval = store.getApproval('a1');
      expect(approval).toMatchObject({
        id: 'a1',
        decision: 'approved',
        decidedAt: 3,
        approverKind: 'slack',
        approverId: 'U123',
      });
    });

    it('returns undefined for missing sqlite approvals', () => {
      const prepared = createStatement();
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      expect(store.getApproval('missing')).toBeUndefined();
    });

    it('retrieves an approval by requestHash from sqlite (Milestone 4 resume contract)', () => {
      const prepared = createStatement({
        get: jest.fn().mockReturnValue({
          id: 'a1',
          session_id: 's1',
          correlation_id: 'corr_1',
          server_alias: 'github',
          tool_name: 'merge_pull_request',
          params_json: '{}',
          requested_at: 1,
          timeout_at: 2,
          request_hash: 'hash_1',
        }) as unknown as Statement['get'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      const approval = store.getApprovalByRequestHash('hash_1');
      expect(approval).toMatchObject({ id: 'a1', requestHash: 'hash_1' });
    });

    it('maps a populated consumed_at column to consumedAt', () => {
      const prepared = createStatement({
        get: jest.fn().mockReturnValue({
          id: 'a1',
          session_id: 's1',
          correlation_id: 'corr_1',
          server_alias: 'github',
          tool_name: 'merge_pull_request',
          params_json: '{}',
          requested_at: 1,
          timeout_at: 2,
          request_hash: 'hash_1',
          consumed_at: 555,
        }) as unknown as Statement['get'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      expect(store.getApproval('a1')?.consumedAt).toBe(555);
    });

    it('returns undefined when no sqlite approval matches the requestHash', () => {
      const prepared = createStatement();
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      expect(store.getApprovalByRequestHash('missing_hash')).toBeUndefined();
    });

    it('marks an approval consumed in sqlite', () => {
      const prepared = createStatement();
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      store.markApprovalConsumed('a1', 12345);
      expect(prepared.run).toHaveBeenCalledWith(12345, 'a1');
    });

    it('maps null sqlite approval decision fields to undefined', () => {
      const prepared = createStatement({
        get: jest.fn().mockReturnValue({
          id: 'a1',
          session_id: 's1',
          correlation_id: 'corr_1',
          server_alias: 'github',
          tool_name: 'merge_pull_request',
          params_json: '{}',
          requested_at: 1,
          timeout_at: 2,
          decision: null,
          decided_at: null,
        }) as unknown as Statement['get'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      const approval = store.getApproval('a1');
      expect(approval).toMatchObject({ decision: undefined, decidedAt: undefined });
    });

    it('returns undefined when cache row is missing', () => {
      const prepared = createStatement();
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      expect(store.getCachedToolCall('missing')).toBeUndefined();
    });

    it('returns undefined when cached JSON is invalid', () => {
      const prepared = createStatement({
        get: jest.fn().mockReturnValue({ value: 'not-json' }) as unknown as Statement['get'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      expect(store.getCachedToolCall('key')).toBeUndefined();
    });

    describe('tool_call_cache real SQL semantics (fake in-memory engine)', () => {
      // A tiny fake SQL engine that understands only the handful of
      // statements store.ts issues against tool_call_cache and the
      // sessions/... tables it CREATEs at startup. This exercises the real
      // expiry/eviction/migration *logic* in store.ts (lazy delete, 5,000-row
      // cap, PRAGMA-guarded ALTER TABLE) without depending on the native
      // better-sqlite3 binding being compiled in every CI environment, same
      // spirit as the hand-rolled `createStatement` mocks used throughout
      // this file.
      interface CacheRow {
        key: string;
        value: string;
        expires_at: number;
        inserted_at: number;
      }

      function createFakeDatabaseCtor(preExistingColumns: string[] = ['key', 'value']) {
        const cacheTable = new Map<string, CacheRow>();
        const columns = [...preExistingColumns];

        const FakeDatabase = jest.fn().mockImplementation(() => ({
          exec: jest.fn((_sql: string) => {
            // CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN handling.
            if (/ALTER TABLE tool_call_cache ADD COLUMN (\w+)/.test(_sql)) {
              const match = /ADD COLUMN (\w+)/.exec(_sql);
              if (match && !columns.includes(match[1])) {
                columns.push(match[1]);
                for (const row of cacheTable.values()) {
                  (row as unknown as Record<string, unknown>)[match[1]] = 0;
                }
              }
            }
          }),
          prepare: jest.fn((sql: string) => ({
            run: jest.fn((...params: unknown[]) => {
              if (sql.startsWith('INSERT OR REPLACE INTO tool_call_cache')) {
                const [key, value, expires_at, inserted_at] = params as [string, string, number, number];
                cacheTable.set(key, { key, value, expires_at, inserted_at });
              } else if (sql.startsWith('DELETE FROM tool_call_cache')) {
                const [key] = params as [string];
                cacheTable.delete(key);
              }
              return { changes: 1 };
            }),
            get: jest.fn((...params: unknown[]) => {
              if (sql === 'PRAGMA table_info(tool_call_cache)') {
                return undefined;
              }
              if (sql.startsWith('SELECT value, expires_at FROM tool_call_cache')) {
                const [key] = params as [string];
                const row = cacheTable.get(key);
                return row ? { value: row.value, expires_at: row.expires_at } : undefined;
              }
              if (sql.startsWith('SELECT COUNT(*)')) {
                return { count: cacheTable.size };
              }
              if (sql.startsWith('SELECT key FROM tool_call_cache ORDER BY inserted_at ASC')) {
                let oldest: CacheRow | undefined;
                for (const row of cacheTable.values()) {
                  if (!oldest || row.inserted_at < oldest.inserted_at) oldest = row;
                }
                return oldest ? { key: oldest.key } : undefined;
              }
              return undefined;
            }),
            all: jest.fn((_sql: string) => {
              if (sql === 'PRAGMA table_info(tool_call_cache)') {
                return columns.map((name) => ({ name }));
              }
              return [];
            }),
          })),
          close: jest.fn(),
        }));
        return { FakeDatabase, cacheTable };
      }

      it('expires a cached tool call past its TTL using the injected clock (lazy delete on read)', () => {
        const { FakeDatabase } = createFakeDatabaseCtor(['key', 'value', 'expires_at', 'inserted_at']);
        let now = 1000;
        const store = createSqliteStore(':memory:', FakeDatabase as unknown as DatabaseCtor, () => now);
        store.setCachedToolCall('key', { value: 42 }, 1000);
        expect(store.getCachedToolCall('key')).toEqual({ value: 42 });
        now += 1001;
        expect(store.getCachedToolCall('key')).toBeUndefined();
      });

      it('evicts the oldest row once the 5,000-row cap is reached', () => {
        const { FakeDatabase, cacheTable } = createFakeDatabaseCtor(['key', 'value', 'expires_at', 'inserted_at']);
        let now = 0;
        const store = createSqliteStore(':memory:', FakeDatabase as unknown as DatabaseCtor, () => now);
        for (let i = 0; i < 5000; i++) {
          now += 1;
          store.setCachedToolCall(`key-${i}`, i, 60_000_000);
        }
        expect(cacheTable.size).toBe(5000);
        now += 1;
        store.setCachedToolCall('key-5000', 5000, 60_000_000);
        expect(cacheTable.size).toBe(5000);
        expect(store.getCachedToolCall('key-0')).toBeUndefined();
        expect(store.getCachedToolCall('key-5000')).toBe(5000);
      });

      it('runs the additive expires_at/inserted_at migration when the columns are missing on an existing table', () => {
        const { FakeDatabase } = createFakeDatabaseCtor(['key', 'value']);
        const store = createSqliteStore(':memory:', FakeDatabase as unknown as DatabaseCtor);
        // If the migration didn't run, setCachedToolCall's INSERT with
        // expires_at/inserted_at values would be operating against a schema
        // that (in a real DB) lacks those columns; here we assert the store
        // still works end-to-end post-migration.
        store.setCachedToolCall('key', { value: 1 }, 60_000);
        expect(store.getCachedToolCall('key')).toEqual({ value: 1 });
      });

      it('is a no-op migration when expires_at/inserted_at already exist (re-running against an existing dev DB is safe)', () => {
        const { FakeDatabase } = createFakeDatabaseCtor(['key', 'value', 'expires_at', 'inserted_at']);
        expect(() => createSqliteStore(':memory:', FakeDatabase as unknown as DatabaseCtor)).not.toThrow();
      });
    });

    describe('sessions real SQL semantics (fake in-memory engine)', () => {
      // Same spirit as the tool_call_cache fake engine above: a tiny fake SQL
      // engine understanding only the sessions/sessions_archive statements
      // store.ts issues, exercising the real expireSessions/updateSession/
      // teamId-scoping *logic* without a native better-sqlite3 dependency.
      interface SessionRow {
        id: string;
        team_id: string;
        platform: string;
        user_id: string;
        correlation_root: string;
        created_at: number;
        updated_at: number;
      }

      function createFakeSessionsDatabaseCtor() {
        const sessionsTable = new Map<string, SessionRow>();
        const archiveTable: Array<SessionRow & { archived_at: number }> = [];

        const FakeDatabase = jest.fn().mockImplementation(() => ({
          exec: jest.fn(),
          prepare: jest.fn((sql: string) => ({
            run: jest.fn((...params: unknown[]) => {
              if (sql.startsWith('INSERT INTO sessions (')) {
                const [id, team_id, platform, user_id, correlation_root, created_at, updated_at] =
                  params as [string, string, string, string, string, number, number];
                sessionsTable.set(id, { id, team_id, platform, user_id, correlation_root, created_at, updated_at });
              } else if (sql.startsWith('UPDATE sessions SET updated_at')) {
                const [updated_at, id] = params as [number, string];
                const row = sessionsTable.get(id);
                if (row) row.updated_at = updated_at;
              } else if (sql.startsWith('DELETE FROM sessions')) {
                const [id] = params as [string];
                sessionsTable.delete(id);
              } else if (sql.startsWith('INSERT INTO sessions_archive')) {
                const [id, team_id, platform, user_id, correlation_root, created_at, updated_at, archived_at] =
                  params as [string, string, string, string, string, number, number, number];
                archiveTable.push({ id, team_id, platform, user_id, correlation_root, created_at, updated_at, archived_at });
              }
              return { changes: 1 };
            }),
            get: jest.fn((...params: unknown[]) => {
              if (sql === 'PRAGMA table_info(tool_call_cache)') return undefined;
              if (sql === 'PRAGMA table_info(pending_approvals)') return undefined;
              if (sql === 'SELECT * FROM sessions WHERE id = ?') {
                const [id] = params as [string];
                return sessionsTable.get(id);
              }
              return undefined;
            }),
            all: jest.fn((...params: unknown[]) => {
              if (sql === 'PRAGMA table_info(tool_call_cache)') return [];
              if (sql === 'PRAGMA table_info(pending_approvals)') return [];
              if (sql === 'SELECT * FROM sessions') {
                return Array.from(sessionsTable.values());
              }
              if (sql === 'SELECT * FROM sessions WHERE team_id = ?') {
                const [teamId] = params as [string];
                return Array.from(sessionsTable.values()).filter((row) => row.team_id === teamId);
              }
              if (sql === 'SELECT * FROM sessions WHERE ? - updated_at > ?') {
                const [expireNow, ttlMs] = params as [number, number];
                return Array.from(sessionsTable.values()).filter(
                  (row) => expireNow - row.updated_at > ttlMs
                );
              }
              if (sql === 'SELECT * FROM sessions_archive') {
                return archiveTable.slice();
              }
              return [];
            }),
          })),
          close: jest.fn(),
        }));
        return { FakeDatabase, sessionsTable, archiveTable };
      }

      it('updateSession patches updated_at on the live row', () => {
        const { FakeDatabase } = createFakeSessionsDatabaseCtor();
        const store = createSqliteStore(':memory:', FakeDatabase as unknown as DatabaseCtor);
        store.createSession({
          id: 's1',
          teamId: 'team-a',
          platform: 'slack',
          userId: 'u1',
          correlationRoot: 'corr_1',
          createdAt: 1,
          updatedAt: 1,
        });

        store.updateSession('s1', { updatedAt: 42 });

        expect(store.getSession('s1')).toMatchObject({ updatedAt: 42 });
      });

      it('updateSession is a no-op for a missing session', () => {
        const { FakeDatabase } = createFakeSessionsDatabaseCtor();
        const store = createSqliteStore(':memory:', FakeDatabase as unknown as DatabaseCtor);
        expect(() => store.updateSession('missing', { updatedAt: 42 })).not.toThrow();
      });

      it('updateSession is a no-op when the patch omits updatedAt', () => {
        const { FakeDatabase } = createFakeSessionsDatabaseCtor();
        const store = createSqliteStore(':memory:', FakeDatabase as unknown as DatabaseCtor);
        store.createSession({
          id: 's1',
          teamId: 'team-a',
          platform: 'slack',
          userId: 'u1',
          correlationRoot: 'corr_1',
          createdAt: 1,
          updatedAt: 1,
        });

        store.updateSession('s1', {});

        expect(store.getSession('s1')).toMatchObject({ updatedAt: 1 });
      });

      it('scopes listSessions to one team (ADR-022 multi-tenancy)', () => {
        const { FakeDatabase } = createFakeSessionsDatabaseCtor();
        const store = createSqliteStore(':memory:', FakeDatabase as unknown as DatabaseCtor);
        store.createSession({
          id: 's1',
          teamId: 'team-a',
          platform: 'slack',
          userId: 'u1',
          correlationRoot: 'corr_1',
          createdAt: 1,
          updatedAt: 1,
        });
        store.createSession({
          id: 's2',
          teamId: 'team-b',
          platform: 'slack',
          userId: 'u2',
          correlationRoot: 'corr_2',
          createdAt: 1,
          updatedAt: 1,
        });

        expect(store.listSessions('team-a')).toEqual([expect.objectContaining({ id: 's1' })]);
        expect(store.listSessions()).toHaveLength(2);
      });

      it('expireSessions archives idle-past-TTL rows: gone from listSessions, present in the archive', () => {
        const { FakeDatabase } = createFakeSessionsDatabaseCtor();
        const store = createSqliteStore(':memory:', FakeDatabase as unknown as DatabaseCtor);
        store.createSession({
          id: 'stale',
          teamId: 'team-a',
          platform: 'slack',
          userId: 'u1',
          correlationRoot: 'corr_stale',
          createdAt: 0,
          updatedAt: 0,
        });

        const cutoffNow = 72 * 60 * 60 * 1000 + 1;
        store.expireSessions(cutoffNow);

        expect(store.getSession('stale')).toBeUndefined();
        expect(store.listSessions()).toHaveLength(0);
        expect(store.listSessionArchive()).toEqual([expect.objectContaining({ id: 'stale' })]);
      });

      it('does not archive a session still within the TTL', () => {
        const { FakeDatabase } = createFakeSessionsDatabaseCtor();
        const store = createSqliteStore(':memory:', FakeDatabase as unknown as DatabaseCtor);
        store.createSession({
          id: 's1',
          teamId: 'team-a',
          platform: 'slack',
          userId: 'u1',
          correlationRoot: 'corr_1',
          createdAt: 0,
          updatedAt: 0,
        });

        store.expireSessions(60 * 60 * 1000);

        expect(store.getSession('s1')).toBeDefined();
        expect(store.listSessionArchive()).toHaveLength(0);
      });
    });

    it('lists sessions', () => {
      const prepared = createStatement({
        all: jest.fn().mockReturnValue([
          {
            id: 's1',
            team_id: 'team-a',
            platform: 'slack',
            user_id: 'u1',
            correlation_root: 'corr_1',
            created_at: 1,
            updated_at: 1,
          },
        ]) as unknown as Statement['all'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      expect(store.listSessions()).toHaveLength(1);
    });

    it('lists minion runs by session', () => {
      const prepared = createStatement({
        all: jest.fn().mockReturnValue([
          {
            id: 'r1',
            session_id: 's1',
            minion_type: 'code-explorer',
            correlation_id: 'corr_1',
            status: 'completed',
            result_json: null,
            tokens_used: null,
            created_at: 1,
            completed_at: 2,
          },
        ]) as unknown as Statement['all'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      expect(store.listMinionRunsBySession('s1')).toHaveLength(1);
    });

    it('lists minion runs by correlation root', () => {
      const prepared = createStatement({
        all: jest.fn().mockReturnValue([
          {
            id: 'r1',
            session_id: 's1',
            minion_type: 'code-explorer',
            correlation_id: 'corr_1',
            status: 'completed',
            result_json: null,
            tokens_used: null,
            created_at: 1,
            completed_at: 2,
          },
        ]) as unknown as Statement['all'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      expect(store.listMinionRunsByCorrelationRoot('corr_1')).toHaveLength(1);
    });

    it('lists pending approvals', () => {
      const prepared = createStatement({
        all: jest.fn().mockReturnValue([
          {
            id: 'a1',
            session_id: 's1',
            correlation_id: 'corr_1',
            server_alias: 'github',
            tool_name: 'merge_pull_request',
            params_json: '{}',
            requested_at: 1,
            timeout_at: 2,
            decision: null,
            decided_at: null,
          },
        ]) as unknown as Statement['all'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      expect(store.listPendingApprovals()).toHaveLength(1);
    });

    it('creates and lists sqlite audit entries', () => {
      const prepared = createStatement();
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      store.createAuditEntry({
        id: 'e1',
        timestamp: 1,
        correlationId: 'corr_1',
        minionType: 'code-explorer',
        teamId: 'team-a',
        serverAlias: 'github',
        toolName: 'get_file_contents',
        params: { path: '/repo/readme.md' },
        status: 'success',
        latencyMs: 10,
        error: 'oops',
        retryAfterSeconds: 5,
        approvalId: 'appr_1',
      });
      store.createAuditEntry({
        id: 'e2',
        timestamp: 2,
        correlationId: 'corr_2',
        minionType: 'code-explorer',
        teamId: 'team-a',
        serverAlias: 'github',
        toolName: 'get_file_contents',
        params: undefined,
        status: 'success',
        latencyMs: 5,
      });
      expect(prepared.run).toHaveBeenCalled();
    });

    it('lists sqlite audit entries with correlation filter and pagination', () => {
      const prepared = createStatement({
        all: jest.fn().mockReturnValue([
          {
            id: 'e1',
            timestamp: 1,
            correlation_id: 'corr_1',
            minion_type: 'code-explorer',
            team_id: 'team-a',
            server_alias: 'github',
            tool_name: 'get_file_contents',
            params: '{"path":"/repo/readme.md"}',
            status: 'success',
            latency_ms: 10,
            error: 'boom',
            retry_after_seconds: 7,
            approval_id: 'appr_1',
          },
        ]) as unknown as Statement['all'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      const entries = store.listAuditEntries({ correlationId: 'corr_1', limit: 1, offset: 0 });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ id: 'e1', correlationId: 'corr_1' });
    });

    it('lists all sqlite audit entries when no correlation filter is provided', () => {
      const prepared = createStatement({
        all: jest.fn().mockReturnValue([]) as unknown as Statement['all'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      expect(store.listAuditEntries()).toHaveLength(0);
    });

    it('maps invalid sqlite audit params json to the raw string', () => {
      const prepared = createStatement({
        all: jest.fn().mockReturnValue([
          {
            id: 'e1',
            timestamp: 1,
            correlation_id: 'corr_1',
            minion_type: 'code-explorer',
            team_id: 'team-a',
            server_alias: 'github',
            tool_name: 'get_file_contents',
            params: 'not-json',
            status: 'success',
            latency_ms: 10,
            error: null,
            retry_after_seconds: null,
            approval_id: null,
          },
        ]) as unknown as Statement['all'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      const entries = store.listAuditEntries();
      expect(entries[0].params).toBe('not-json');
    });

    it('maps optional sqlite row fields', () => {
      const prepared = createStatement({
        all: jest.fn().mockReturnValue([
          {
            id: 'r1',
            session_id: 's1',
            minion_type: 'code-explorer',
            correlation_id: 'corr_1',
            status: 'completed',
            result_json: 'null',
            tokens_used: 42,
            created_at: 1,
            completed_at: 2,
          },
        ]) as unknown as Statement['all'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      const runs = store.listMinionRunsBySession('s1');
      expect(runs[0]).toMatchObject({
        resultJson: 'null',
        tokensUsed: 42,
        completedAt: 2,
      });
    });

    it('scopes listMinionRunsBySession to one team (ADR-022 multi-tenancy)', () => {
      const sessionRow = {
        id: 's1',
        team_id: 'team-a',
        platform: 'slack',
        user_id: 'u1',
        correlation_root: 'corr_1',
        created_at: 1,
        updated_at: 1,
      };
      const runRow = {
        id: 'r1',
        session_id: 's1',
        minion_type: 'code-explorer',
        correlation_id: 'corr_1',
        status: 'completed',
        result_json: null,
        tokens_used: null,
        created_at: 1,
        completed_at: null,
      };
      const db = {
        exec: jest.fn(),
        prepare: jest.fn((sql: string) => {
          if (sql === 'SELECT * FROM sessions WHERE id = ?') {
            return createStatement({ get: jest.fn().mockReturnValue(sessionRow) as unknown as Statement['get'] });
          }
          if (sql === 'SELECT * FROM minion_runs WHERE session_id = ?') {
            return createStatement({ all: jest.fn().mockReturnValue([runRow]) as unknown as Statement['all'] });
          }
          return createStatement();
        }),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      expect(store.listMinionRunsBySession('s1', 'team-b')).toHaveLength(0);
      expect(store.listMinionRunsBySession('s1', 'team-a')).toHaveLength(1);
      expect(store.listMinionRunsBySession('s1')).toHaveLength(1);
    });

    it('listMinionRunsBySession returns empty for an unknown session when teamId is given', () => {
      const db = {
        exec: jest.fn(),
        prepare: jest.fn((sql: string) => {
          if (sql === 'SELECT * FROM sessions WHERE id = ?') {
            return createStatement({ get: jest.fn().mockReturnValue(undefined) as unknown as Statement['get'] });
          }
          return createStatement();
        }),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      expect(store.listMinionRunsBySession('missing', 'team-a')).toHaveLength(0);
    });

    it('maps null optional fields to undefined', () => {
      const prepared = createStatement({
        all: jest.fn().mockReturnValue([
          {
            id: 'r1',
            session_id: 's1',
            minion_type: 'code-explorer',
            correlation_id: 'corr_1',
            status: 'completed',
            result_json: null,
            tokens_used: null,
            created_at: 1,
            completed_at: null,
          },
        ]) as unknown as Statement['all'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      const runs = store.listMinionRunsBySession('s1');
      expect(runs[0]).toMatchObject({
        resultJson: undefined,
        tokensUsed: undefined,
        completedAt: undefined,
      });
    });

    it('maps decided approval fields', () => {
      const prepared = createStatement({
        all: jest.fn().mockReturnValue([
          {
            id: 'a1',
            session_id: 's1',
            correlation_id: 'corr_1',
            server_alias: 'github',
            tool_name: 'merge_pull_request',
            params_json: '{}',
            requested_at: 1,
            timeout_at: 2,
            decision: 'approved',
            decided_at: 3,
          },
        ]) as unknown as Statement['all'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      const approvals = store.listPendingApprovals();
      expect(approvals[0]).toMatchObject({
        decision: 'approved',
        decidedAt: 3,
      });
    });

    it('maps null decision approval fields', () => {
      const prepared = createStatement({
        all: jest.fn().mockReturnValue([
          {
            id: 'a1',
            session_id: 's1',
            correlation_id: 'corr_1',
            server_alias: 'github',
            tool_name: 'merge_pull_request',
            params_json: '{}',
            requested_at: 1,
            timeout_at: 2,
            decision: null,
            decided_at: null,
          },
        ]) as unknown as Statement['all'],
      });
      const db = {
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue(prepared),
        close: jest.fn(),
      };
      const DatabaseCtor = jest.fn().mockReturnValue(db) as unknown as DatabaseCtor;

      const store = createSqliteStore(':memory:', DatabaseCtor);
      const approvals = store.listPendingApprovals();
      expect(approvals[0]).toMatchObject({
        decision: undefined,
        decidedAt: undefined,
      });
    });
  });

  describe('memory store list queries', () => {
    it('lists sessions', () => {
      const store = createMemoryStore();
      store.createSession({
        id: 's1',
        teamId: 'team-a',
        platform: 'slack',
        userId: 'u1',
        correlationRoot: 'corr_1',
        createdAt: 1,
        updatedAt: 1,
      });
      expect(store.listSessions()).toHaveLength(1);
    });

    it('scopes listSessions to one team (ADR-022 multi-tenancy)', () => {
      const store = createMemoryStore();
      store.createSession({
        id: 's1',
        teamId: 'team-a',
        platform: 'slack',
        userId: 'u1',
        correlationRoot: 'corr_1',
        createdAt: 1,
        updatedAt: 1,
      });
      store.createSession({
        id: 's2',
        teamId: 'team-b',
        platform: 'slack',
        userId: 'u2',
        correlationRoot: 'corr_2',
        createdAt: 1,
        updatedAt: 1,
      });

      expect(store.listSessions('team-a')).toEqual([expect.objectContaining({ id: 's1' })]);
      expect(store.listSessions('team-b')).toEqual([expect.objectContaining({ id: 's2' })]);
      expect(store.listSessions()).toHaveLength(2);
    });

    it('lists minion runs by session', () => {
      const store = createMemoryStore();
      store.createMinionRun({
        id: 'r1',
        sessionId: 's1',
        minionType: 'code-explorer',
        correlationId: 'corr_1',
        status: 'completed',
        createdAt: 1,
      });
      expect(store.listMinionRunsBySession('s1')).toHaveLength(1);
      expect(store.listMinionRunsBySession('other')).toHaveLength(0);
    });

    it('scopes listMinionRunsBySession to one team (ADR-022 multi-tenancy)', () => {
      const store = createMemoryStore();
      store.createSession({
        id: 's1',
        teamId: 'team-a',
        platform: 'slack',
        userId: 'u1',
        correlationRoot: 'corr_1',
        createdAt: 1,
        updatedAt: 1,
      });
      store.createMinionRun({
        id: 'r1',
        sessionId: 's1',
        minionType: 'code-explorer',
        correlationId: 'corr_1',
        status: 'completed',
        createdAt: 1,
      });

      // A caller in another tenant guessing/enumerating session id 's1' gets
      // nothing back, even though the run really exists.
      expect(store.listMinionRunsBySession('s1', 'team-b')).toHaveLength(0);
      expect(store.listMinionRunsBySession('s1', 'team-a')).toHaveLength(1);
      expect(store.listMinionRunsBySession('s1')).toHaveLength(1);
    });

    it('updateSession patches an existing session and is a no-op for a missing one', () => {
      const store = createMemoryStore();
      store.createSession({
        id: 's1',
        teamId: 'team-a',
        platform: 'slack',
        userId: 'u1',
        correlationRoot: 'corr_1',
        createdAt: 1,
        updatedAt: 1,
      });

      store.updateSession('s1', { updatedAt: 42 });
      expect(store.getSession('s1')).toMatchObject({ updatedAt: 42 });

      expect(() => store.updateSession('missing', { updatedAt: 99 })).not.toThrow();
      expect(store.getSession('missing')).toBeUndefined();
    });

    describe('expireSessions', () => {
      it('archives sessions idle past the TTL — gone from listSessions, present in the archive', () => {
        const store = createMemoryStore();
        store.createSession({
          id: 'stale',
          teamId: 'team-a',
          platform: 'slack',
          userId: 'u1',
          correlationRoot: 'corr_stale',
          createdAt: 0,
          updatedAt: 0,
        });
        store.createSession({
          id: 'fresh',
          teamId: 'team-a',
          platform: 'slack',
          userId: 'u1',
          correlationRoot: 'corr_fresh',
          createdAt: 0,
          updatedAt: 0,
        });
        // Touch the fresh one forward so only 'stale' is idle past 72h.
        store.updateSession('fresh', { updatedAt: 72 * 60 * 60 * 1000 });

        const cutoffNow = 72 * 60 * 60 * 1000 + 1;
        store.expireSessions(cutoffNow);

        expect(store.getSession('stale')).toBeUndefined();
        expect(store.listSessions()).toEqual([expect.objectContaining({ id: 'fresh' })]);
        expect(store.listSessionArchive()).toEqual([expect.objectContaining({ id: 'stale' })]);
      });

      it('does not archive a session still within the TTL', () => {
        const store = createMemoryStore();
        store.createSession({
          id: 's1',
          teamId: 'team-a',
          platform: 'slack',
          userId: 'u1',
          correlationRoot: 'corr_1',
          createdAt: 0,
          updatedAt: 0,
        });

        store.expireSessions(60 * 60 * 1000); // 1 hour later, well within 72h TTL

        expect(store.getSession('s1')).toBeDefined();
        expect(store.listSessionArchive()).toHaveLength(0);
      });

      it('honors a SESSION_TTL_HOURS override', () => {
        const originalTtl = process.env.SESSION_TTL_HOURS;
        process.env.SESSION_TTL_HOURS = '1';
        try {
          const store = createMemoryStore();
          store.createSession({
            id: 's1',
            teamId: 'team-a',
            platform: 'slack',
            userId: 'u1',
            correlationRoot: 'corr_1',
            createdAt: 0,
            updatedAt: 0,
          });

          store.expireSessions(2 * 60 * 60 * 1000); // 2 hours later, past a 1-hour TTL

          expect(store.getSession('s1')).toBeUndefined();
        } finally {
          if (originalTtl === undefined) delete process.env.SESSION_TTL_HOURS;
          else process.env.SESSION_TTL_HOURS = originalTtl;
        }
      });
    });

    it('lists minion runs by correlation root', () => {
      const store = createMemoryStore();
      store.createMinionRun({
        id: 'r1',
        sessionId: 's1',
        minionType: 'code-explorer',
        correlationId: 'corr_1',
        status: 'completed',
        createdAt: 1,
      });
      expect(store.listMinionRunsByCorrelationRoot('corr_1')).toHaveLength(1);
      expect(store.listMinionRunsByCorrelationRoot('corr_2')).toHaveLength(0);
    });

    it('lists only pending approvals', () => {
      const store = createMemoryStore();
      store.createApproval({
        id: 'a1',
        sessionId: 's1',
        correlationId: 'corr_1',
        serverAlias: 'github',
        toolName: 'merge_pull_request',
        paramsJson: '{}',
        requestedAt: 1,
        timeoutAt: 2,
        requestHash: 'hash_1',
      });
      store.resolveApproval('a1', 'approved');
      expect(store.listPendingApprovals()).toHaveLength(0);
    });
  });
});
