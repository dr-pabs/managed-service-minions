import { describe, expect, it, jest } from '@jest/globals';
import { mintMinionToken } from 'framework-core';
import { createMemoryStore, type PendingApproval } from '../store.js';
import {
  EffectCredentials,
  EffectGateway,
  effectTypesFromRecord,
  MapVerificationResolver,
  RecordingConnector,
  COMMIT_EFFECT,
  REVIEW_COMMIT,
  SERVER_ALIAS,
  type EffectCaller,
  type EffectTypePolicy,
} from '../effect-gateway.js';
import {
  SamplingQa,
  createMemorySamplingQaStore,
  createSqliteSamplingQaStore,
  makeSamplingQaPolicy,
  samplingQaPoliciesFromRecord,
  type PostHocReviewVerdict,
  type SamplingQaPolicy,
  type SamplingQaStore,
} from '../sampling-qa.js';

const SECRET = 'test-signing-secret';
const RUN_ID = 'run_1';
const CORR = 'corr_20260828';

function verdict(overrides: Partial<PostHocReviewVerdict> = {}): PostHocReviewVerdict {
  return {
    effectType: 'crm.case_note.append',
    correlationId: CORR,
    draftRef: 'draft://d1',
    decision: 'agreed',
    reviewedAt: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// policy construction and parsing
// ---------------------------------------------------------------------------

describe('makeSamplingQaPolicy', () => {
  it('accepts a valid triple', () => {
    expect(makeSamplingQaPolicy('t', 10, 0.2, 50)).toEqual({ reviewPercent: 10, disagreementThreshold: 0.2, windowSize: 50 });
  });

  it('accepts the boundary values', () => {
    expect(makeSamplingQaPolicy('t', 0, 0, 1)).toEqual({ reviewPercent: 0, disagreementThreshold: 0, windowSize: 1 });
    expect(makeSamplingQaPolicy('t', 100, 1, 1)).toEqual({ reviewPercent: 100, disagreementThreshold: 1, windowSize: 1 });
  });

  it('rejects an out-of-range or malformed review_percent', () => {
    expect(() => makeSamplingQaPolicy('t', -1, 0.5, 2)).toThrow(/review_percent must be between 0 and 100/);
    expect(() => makeSamplingQaPolicy('t', 101, 0.5, 2)).toThrow(/review_percent must be between 0 and 100/);
    expect(() => makeSamplingQaPolicy('t', '10' as unknown as number, 0.5, 2)).toThrow(/review_percent must be between 0 and 100/);
    expect(() => makeSamplingQaPolicy('t', NaN, 0.5, 2)).toThrow(/review_percent must be between 0 and 100/);
    expect(() => makeSamplingQaPolicy('t', Infinity, 0.5, 2)).toThrow(/review_percent must be between 0 and 100/);
  });

  it('rejects an out-of-range or malformed disagreement_threshold', () => {
    expect(() => makeSamplingQaPolicy('t', 10, -0.1, 2)).toThrow(/disagreement_threshold must be between 0 and 1/);
    expect(() => makeSamplingQaPolicy('t', 10, 1.1, 2)).toThrow(/disagreement_threshold must be between 0 and 1/);
    expect(() => makeSamplingQaPolicy('t', 10, 'x' as unknown as number, 2)).toThrow(/disagreement_threshold must be between 0 and 1/);
    expect(() => makeSamplingQaPolicy('t', 10, NaN, 2)).toThrow(/disagreement_threshold must be between 0 and 1/);
  });

  it('rejects a malformed window_size', () => {
    expect(() => makeSamplingQaPolicy('t', 10, 0.5, 0)).toThrow(/window_size must be an integer >= 1/);
    expect(() => makeSamplingQaPolicy('t', 10, 0.5, -1)).toThrow(/window_size must be an integer >= 1/);
    expect(() => makeSamplingQaPolicy('t', 10, 0.5, 1.5)).toThrow(/window_size must be an integer >= 1/);
    expect(() => makeSamplingQaPolicy('t', 10, 0.5, '2' as unknown as number)).toThrow(/window_size must be an integer >= 1/);
  });
});

describe('samplingQaPoliciesFromRecord', () => {
  it('parses a mapping, coercing numeric strings', () => {
    const policies = samplingQaPoliciesFromRecord({
      'crm.case_note.append': { review_percent: '10', disagreement_threshold: '0.2', window_size: '50' },
      'payment.refund': { review_percent: 100, disagreement_threshold: 0.5, window_size: 20 },
    });
    expect(policies.get('crm.case_note.append')).toEqual({ reviewPercent: 10, disagreementThreshold: 0.2, windowSize: 50 });
    expect(policies.get('payment.refund')).toEqual({ reviewPercent: 100, disagreementThreshold: 0.5, windowSize: 20 });
  });

  it('rejects a non-mapping', () => {
    expect(() => samplingQaPoliciesFromRecord('nope')).toThrow(/sampling_qa must be a mapping/);
    expect(() => samplingQaPoliciesFromRecord(null)).toThrow(/sampling_qa must be a mapping/);
    expect(() => samplingQaPoliciesFromRecord(['a'])).toThrow(/sampling_qa must be a mapping/);
  });

  it('rejects a non-mapping entry', () => {
    expect(() => samplingQaPoliciesFromRecord({ t: 'nope' })).toThrow(/sampling_qa\.t must be a mapping/);
    expect(() => samplingQaPoliciesFromRecord({ t: null })).toThrow(/sampling_qa\.t must be a mapping/);
  });

  it('rejects unknown keys', () => {
    expect(() =>
      samplingQaPoliciesFromRecord({ t: { review_percent: 10, disagreement_threshold: 0.2, window_size: 2, extra: 1 } })
    ).toThrow(/sampling_qa\.t: unknown keys extra/);
  });

  it('rejects a missing key', () => {
    expect(() => samplingQaPoliciesFromRecord({ t: { review_percent: 10, disagreement_threshold: 0.2 } })).toThrow(
      /sampling_qa\.t: missing window_size/
    );
    expect(() => samplingQaPoliciesFromRecord({ t: { review_percent: 10 } })).toThrow(/missing disagreement_threshold/);
  });

  it('propagates a validation error for an out-of-range value', () => {
    expect(() => samplingQaPoliciesFromRecord({ t: { review_percent: 500, disagreement_threshold: 0.2, window_size: 2 } })).toThrow(
      /review_percent must be between 0 and 100/
    );
  });
});

// ---------------------------------------------------------------------------
// memory store
// ---------------------------------------------------------------------------

describe('createMemorySamplingQaStore', () => {
  it('records and lists verdicts, optionally filtered by type', () => {
    const store = createMemorySamplingQaStore();
    store.recordVerdict(verdict({ effectType: 'a', decision: 'agreed' }));
    store.recordVerdict(verdict({ effectType: 'b', decision: 'disagreed' }));
    store.recordVerdict(verdict({ effectType: 'a', decision: 'disagreed', reviewedAt: 2 }));

    expect(store.listVerdicts().map((v) => v.effectType)).toEqual(['a', 'b', 'a']);
    expect(store.listVerdicts('a').map((v) => v.decision)).toEqual(['agreed', 'disagreed']);
    expect(store.listVerdicts('missing')).toEqual([]);
  });

  it('tracks the tripped set', () => {
    const store = createMemorySamplingQaStore();
    expect(store.isTripped('a')).toBe(false);
    store.setTripped('a', true);
    store.setTripped('b', true);
    expect(store.isTripped('a')).toBe(true);
    expect(store.trippedTypes()).toEqual(['a', 'b']);
    store.setTripped('a', false);
    expect(store.isTripped('a')).toBe(false);
    expect(store.trippedTypes()).toEqual(['b']);
  });

  it('reset clears both the verdict history and the trip state for one type', () => {
    const store = createMemorySamplingQaStore();
    store.recordVerdict(verdict({ effectType: 'a' }));
    store.recordVerdict(verdict({ effectType: 'b' }));
    store.setTripped('a', true);
    store.setTripped('b', true);
    store.reset('a');
    expect(store.listVerdicts('a')).toEqual([]);
    expect(store.listVerdicts('b')).toHaveLength(1);
    expect(store.isTripped('a')).toBe(false);
    expect(store.isTripped('b')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SQLite store
// ---------------------------------------------------------------------------

type Statement = {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

/** A hand-rolled in-memory SQLite stand-in that implements the sampling-QA schema semantics. */
class FakeSamplingQaDb {
  verdicts: Array<Record<string, unknown>> = [];
  tripped = new Set<string>();
  exec = jest.fn();
  close = jest.fn();

  prepare(sql: string): Statement {
    const empty: Statement = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] };
    // Deletes are matched first: `DELETE FROM sampling_qa_verdicts WHERE ...`
    // also contains the substring `FROM sampling_qa_verdicts WHERE ...`, so it
    // must be caught before the SELECT branches below.
    if (sql.includes('DELETE FROM sampling_qa_verdicts')) {
      return {
        ...empty,
        run: (...params: unknown[]) => {
          this.verdicts = this.verdicts.filter((v) => v.effect_type !== String(params[0]));
          return { changes: 1 };
        },
      };
    }
    if (sql.includes('DELETE FROM sampling_qa_tripped')) {
      return {
        ...empty,
        run: (...params: unknown[]) => {
          this.tripped.delete(String(params[0]));
          return { changes: 1 };
        },
      };
    }
    if (sql.includes('INSERT INTO sampling_qa_verdicts')) {
      return {
        ...empty,
        run: (...params: unknown[]) => {
          this.verdicts.push({
            seq: this.verdicts.length + 1,
            effect_type: params[0],
            correlation_id: params[1],
            draft_ref: params[2],
            decision: params[3],
            reviewed_at: params[4],
          });
          return { changes: 1 };
        },
      };
    }
    if (sql.includes('INSERT OR REPLACE INTO sampling_qa_tripped')) {
      return {
        ...empty,
        run: (...params: unknown[]) => {
          this.tripped.add(String(params[0]));
          return { changes: 1 };
        },
      };
    }
    if (sql.includes('FROM sampling_qa_verdicts WHERE effect_type')) {
      return {
        ...empty,
        all: (...params: unknown[]) => this.verdicts.filter((v) => v.effect_type === params[0]),
      };
    }
    if (sql.includes('FROM sampling_qa_verdicts')) {
      return { ...empty, all: () => [...this.verdicts] };
    }
    if (sql.includes('SELECT 1 FROM sampling_qa_tripped')) {
      return {
        ...empty,
        get: (...params: unknown[]) => (this.tripped.has(String(params[0])) ? { 1: 1 } : undefined),
      };
    }
    if (sql.includes('SELECT effect_type FROM sampling_qa_tripped')) {
      return { ...empty, all: () => Array.from(this.tripped).sort().map((t) => ({ effect_type: t })) };
    }
    return empty;
  }
}

describe('createSqliteSamplingQaStore', () => {
  function makeStore(db = new FakeSamplingQaDb()): { store: SamplingQaStore; db: FakeSamplingQaDb } {
    const ctor = jest.fn().mockReturnValue(db) as unknown as new (path: string) => FakeSamplingQaDb;
    return { store: createSqliteSamplingQaStore(':memory:', ctor), db };
  }

  it('round-trips verdicts, trip state, and reset through SQL', () => {
    const { store } = makeStore();
    store.recordVerdict(verdict({ effectType: 'a', decision: 'agreed', reviewedAt: 1 }));
    store.recordVerdict(verdict({ effectType: 'b', decision: 'disagreed', reviewedAt: 2 }));
    store.setTripped('a', true);

    expect(store.listVerdicts().map((v) => v.effectType)).toEqual(['a', 'b']);
    expect(store.listVerdicts('a')).toMatchObject([{ effectType: 'a', decision: 'agreed', reviewedAt: 1 }]);
    expect(store.listVerdicts('b')[0]).toMatchObject({ decision: 'disagreed', correlationId: CORR, draftRef: 'draft://d1' });
    expect(store.isTripped('a')).toBe(true);
    expect(store.isTripped('b')).toBe(false);
    expect(store.trippedTypes()).toEqual(['a']);

    // The explicit un-trip path (setTripped false) is distinct from reset.
    store.setTripped('a', false);
    expect(store.isTripped('a')).toBe(false);
    expect(store.trippedTypes()).toEqual([]);

    store.setTripped('a', true);
    store.reset('a');
    expect(store.listVerdicts('a')).toEqual([]);
    expect(store.listVerdicts('b')).toHaveLength(1);
    expect(store.isTripped('a')).toBe(false);
  });

  it('falls back to memory (with a warning) when the constructor throws outside production', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const throwing = jest.fn().mockImplementation(() => {
        throw new Error('native bindings missing');
      }) as unknown as new (path: string) => FakeSamplingQaDb;
      const store = createSqliteSamplingQaStore(':memory:', throwing);
      store.recordVerdict(verdict({ effectType: 'a' }));
      expect(store.listVerdicts('a')).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('refuses to fall back in production without the escape hatch', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAllow = process.env.TOOLSHED_ALLOW_MEMORY_STORE;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.TOOLSHED_ALLOW_MEMORY_STORE;
      const throwing = (() => {
        throw new Error('boom');
      }) as unknown as new (path: string) => FakeSamplingQaDb;
      expect(() => createSqliteSamplingQaStore(':memory:', throwing)).toThrow(/SQLite unavailable/);
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalAllow === undefined) delete process.env.TOOLSHED_ALLOW_MEMORY_STORE;
      else process.env.TOOLSHED_ALLOW_MEMORY_STORE = originalAllow;
    }
  });

  it('falls back in production when the escape hatch is set', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAllow = process.env.TOOLSHED_ALLOW_MEMORY_STORE;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      process.env.NODE_ENV = 'production';
      process.env.TOOLSHED_ALLOW_MEMORY_STORE = '1';
      const throwing = (() => {
        throw new Error('boom');
      }) as unknown as new (path: string) => FakeSamplingQaDb;
      const store = createSqliteSamplingQaStore(':memory:', throwing);
      expect(store.listVerdicts()).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalAllow === undefined) delete process.env.TOOLSHED_ALLOW_MEMORY_STORE;
      else process.env.TOOLSHED_ALLOW_MEMORY_STORE = originalAllow;
    }
  });

  it('loads the native module (or falls back to a working store) when no constructor is injected', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const store = createSqliteSamplingQaStore(':memory:');
      store.recordVerdict(verdict({ effectType: 'native' }));
      expect(store.listVerdicts('native')).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// controller
// ---------------------------------------------------------------------------

function policies(entries: Record<string, SamplingQaPolicy>): Map<string, SamplingQaPolicy> {
  return new Map(Object.entries(entries));
}

describe('SamplingQa', () => {
  it('shouldReview samples only a configured type, honouring the percentage boundary', () => {
    const qa = new SamplingQa(
      policies({ crm: { reviewPercent: 50, disagreementThreshold: 0.5, windowSize: 10 } }),
      createMemorySamplingQaStore(),
      () => 0.5
    );
    // random()*100 === 50, and the comparison is strict (<), so exactly 50% does NOT sample.
    expect(qa.shouldReview('crm')).toBe(false);
    expect(qa.shouldReview('unknown')).toBe(false);
  });

  it('shouldReview samples at 100% and never at 0%', () => {
    const always = new SamplingQa(
      policies({ crm: { reviewPercent: 100, disagreementThreshold: 0.5, windowSize: 10 } }),
      createMemorySamplingQaStore(),
      () => 0
    );
    expect(always.shouldReview('crm')).toBe(true);
    const never = new SamplingQa(
      policies({ crm: { reviewPercent: 0, disagreementThreshold: 0.5, windowSize: 10 } }),
      createMemorySamplingQaStore(),
      () => 0
    );
    expect(never.shouldReview('crm')).toBe(false);
  });

  it('computes the disagreement rate over the configured window only', () => {
    const store = createMemorySamplingQaStore();
    const qa = new SamplingQa(policies({ crm: { reviewPercent: 100, disagreementThreshold: 0.5, windowSize: 2 } }), store);
    store.recordVerdict(verdict({ effectType: 'crm', decision: 'agreed', reviewedAt: 1 }));
    store.recordVerdict(verdict({ effectType: 'crm', decision: 'disagreed', reviewedAt: 2 }));
    // window covers only the two most recent verdicts -> 1 disagreed / 2 = 0.5
    store.recordVerdict(verdict({ effectType: 'crm', decision: 'agreed', reviewedAt: 3 }));
    expect(qa.disagreementRate('crm')).toBe(0.5);
  });

  it('recordVerdict trips the breaker once the rate crosses the threshold', () => {
    const store = createMemorySamplingQaStore();
    const qa = new SamplingQa(policies({ crm: { reviewPercent: 100, disagreementThreshold: 0.5, windowSize: 2 } }), store);
    const first = qa.recordVerdict(verdict({ effectType: 'crm', decision: 'disagreed' }));
    expect(first.disagreementRate).toBe(1);
    expect(first.tripped).toBe(true);
    expect(qa.isTripped('crm')).toBe(true);
  });

  it('recordVerdict does not trip while the rate stays below the threshold', () => {
    const store = createMemorySamplingQaStore();
    const qa = new SamplingQa(policies({ crm: { reviewPercent: 100, disagreementThreshold: 0.5, windowSize: 2 } }), store);
    const first = qa.recordVerdict(verdict({ effectType: 'crm', decision: 'agreed' }));
    expect(first.disagreementRate).toBe(0);
    expect(first.tripped).toBe(false);
    expect(qa.isTripped('crm')).toBe(false);
  });

  it('a type with no policy records verdicts but never trips', () => {
    const store = createMemorySamplingQaStore();
    const qa = new SamplingQa(new Map(), store);
    const stat = qa.recordVerdict(verdict({ effectType: 'unmanaged', decision: 'disagreed' }));
    // No policy means no review window, so the stat has nothing to aggregate over;
    // the verdict is still persisted and the breaker is never tripped.
    expect(stat.reviewed).toBe(0);
    expect(stat.disagreementRate).toBe(0);
    expect(stat.tripped).toBe(false);
    expect(store.listVerdicts('unmanaged')).toHaveLength(1);
    expect(qa.isTripped('unmanaged')).toBe(false);
  });

  it('reset clears the history and the trip for one type', () => {
    const store = createMemorySamplingQaStore();
    const qa = new SamplingQa(policies({ crm: { reviewPercent: 100, disagreementThreshold: 0.5, windowSize: 2 } }), store);
    qa.recordVerdict(verdict({ effectType: 'crm', decision: 'disagreed' }));
    expect(qa.isTripped('crm')).toBe(true);
    qa.reset('crm');
    expect(qa.isTripped('crm')).toBe(false);
    expect(qa.stat('crm')).toMatchObject({ reviewed: 0, disagreed: 0, disagreementRate: 0, tripped: false });
  });

  it('stats() includes every type with a policy, verdict, or trip, sorted', () => {
    const store = createMemorySamplingQaStore();
    const qa = new SamplingQa(policies({ b: { reviewPercent: 10, disagreementThreshold: 0.5, windowSize: 2 } }), store);
    store.recordVerdict(verdict({ effectType: 'a', decision: 'agreed' }));
    store.setTripped('c', true);
    expect(qa.stats().map((s) => s.effectType)).toEqual(['a', 'b', 'c']);
    expect(qa.stats()[1]).toMatchObject({ effectType: 'b', reviewed: 0, disagreementRate: 0, tripped: false });
  });
});

// ---------------------------------------------------------------------------
// EffectGateway integration
// ---------------------------------------------------------------------------

function effectTypes(): Map<string, EffectTypePolicy> {
  return effectTypesFromRecord({
    'crm.case_note.append': { reversibility: 'reversible', approval_class: 'auto' },
    'payment.refund': { reversibility: 'compensatable', approval_class: 'sampled' },
    'comms.email.send': { reversibility: 'irreversible', approval_class: 'always_human' },
  });
}

function mintToken(agentId: string, scopeId: string = RUN_ID, correlationId: string = CORR): string {
  return mintMinionToken({ agent_id: agentId, scope_id: scopeId, correlation_id: correlationId }, SECRET);
}

function committer(): EffectCaller {
  return { agentId: 'committer', identityToken: mintToken('committer'), scopeId: RUN_ID, correlationId: CORR };
}

function crmDraftParams(): Record<string, unknown> {
  return {
    effect_type: 'crm.case_note.append',
    target_system: 'crm',
    payload: { case_id: '5001', note: 'refund issued' },
    evidence: ['verify://ok'],
    reversibility: 'reversible',
    idempotency_key: 'fx_run_1_casenote',
  };
}

interface QaWorld {
  gateway: EffectGateway;
  connectors: Map<string, RecordingConnector>;
  approvalStore: ReturnType<typeof createMemoryStore>;
  qa: SamplingQa;
  qaStore: SamplingQaStore;
}

function makeQaWorld(overrides: { policies?: Map<string, SamplingQaPolicy>; qaStore?: SamplingQaStore } = {}): QaWorld {
  const clock = { value: 1_000_000 };
  const now = () => clock.value;
  const connectors = new Map<string, RecordingConnector>([['crm', new RecordingConnector('crm')]]);
  const approvalStore = createMemoryStore(now);
  const resolver = new MapVerificationResolver({ 'verify://ok': { ref: 'verify://ok', verifier: 'pytest', passed: true, failing: [] } });
  const qaStore = overrides.qaStore ?? createMemorySamplingQaStore();
  const qa = new SamplingQa(overrides.policies ?? new Map(), qaStore, () => 0);
  const gateway = new EffectGateway({
    effectTypes: effectTypes(),
    connectors,
    credentials: new EffectCredentials({ crm: 'CRM_KEY' }),
    approvalStore,
    signingSecret: SECRET,
    evidenceResolver: resolver,
    qa,
    now,
  });
  return { gateway, connectors, approvalStore, qa, qaStore };
}

async function draftAndCommit(w: QaWorld): Promise<{ result: Awaited<ReturnType<EffectGateway['commitEffect']>> }> {
  const draft = await w.gateway.draftEffect(crmDraftParams(), committer());
  const result = await w.gateway.commitEffect({ draft_ref: draft.draftRef! }, committer());
  return { result };
}

describe('EffectGateway sampling-QA loop', () => {
  it('routes a sampled auto-commit to post-hoc review without blocking the commit', async () => {
    const w = makeQaWorld({
      policies: policies({ 'crm.case_note.append': { reviewPercent: 100, disagreementThreshold: 0.5, windowSize: 2 } }),
    });
    const { result } = await draftAndCommit(w);
    expect(result.committed).toBe(true);
    expect(w.connectors.get('crm')!.executions).toHaveLength(1);

    const review = w.approvalStore.listPendingApprovals().find((a) => a.toolName === REVIEW_COMMIT);
    expect(review).toBeDefined();
    expect(review!.serverAlias).toBe(SERVER_ALIAS);
    expect(JSON.parse(review!.paramsJson)).toMatchObject({ effect_type: 'crm.case_note.append' });
  });

  it('does not create a post-hoc review when the type is not sampled', async () => {
    const w = makeQaWorld(); // empty policy map -> shouldReview false
    const { result } = await draftAndCommit(w);
    expect(result.committed).toBe(true);
    expect(w.approvalStore.listPendingApprovals().some((a) => a.toolName === REVIEW_COMMIT)).toBe(false);
  });

  it('a tripped breaker forces pre-commit approval instead of auto-commit', async () => {
    const w = makeQaWorld({
      policies: policies({ 'crm.case_note.append': { reviewPercent: 100, disagreementThreshold: 0.5, windowSize: 2 } }),
    });
    w.qaStore.setTripped('crm.case_note.append', true);

    const { result } = await draftAndCommit(w);
    expect(result.committed).toBe(false);
    expect(result.approvalPending).toBe(true);
    expect(result.approvalId).toBeDefined();
    expect(w.connectors.get('crm')!.executions).toHaveLength(0);

    // The forced approval is a pre-commit commit_effect approval, not a post-hoc review.
    const approval = w.approvalStore.getApproval(result.approvalId!);
    expect(approval!.toolName).toBe(COMMIT_EFFECT);
  });

  it('recordReviewVerdict records agreement and leaves the breaker untripped', async () => {
    const w = makeQaWorld({
      policies: policies({ 'crm.case_note.append': { reviewPercent: 100, disagreementThreshold: 0.5, windowSize: 2 } }),
    });
    await draftAndCommit(w);
    const review = w.approvalStore.listPendingApprovals().find((a) => a.toolName === REVIEW_COMMIT)!;

    const stat = w.gateway.recordReviewVerdict(review.id, 'agreed');
    expect(stat).toMatchObject({ effectType: 'crm.case_note.append', reviewed: 1, disagreed: 0, disagreementRate: 0, tripped: false });
    expect(w.qa.isTripped('crm.case_note.append')).toBe(false);
  });

  it('recordReviewVerdict records disagreement and trips the breaker at the threshold', async () => {
    const w = makeQaWorld({
      policies: policies({ 'crm.case_note.append': { reviewPercent: 100, disagreementThreshold: 0.5, windowSize: 2 } }),
    });
    await draftAndCommit(w);
    const review = w.approvalStore.listPendingApprovals().find((a) => a.toolName === REVIEW_COMMIT)!;

    const stat = w.gateway.recordReviewVerdict(review.id, 'disagreed');
    expect(stat).toMatchObject({ effectType: 'crm.case_note.append', reviewed: 1, disagreed: 1, disagreementRate: 1, tripped: true });
    expect(w.qa.isTripped('crm.case_note.append')).toBe(true);
  });

  it('recordReviewVerdict returns undefined for a non-review approval or a missing QA loop', async () => {
    const w = makeQaWorld({
      policies: policies({ 'crm.case_note.append': { reviewPercent: 100, disagreementThreshold: 0.5, windowSize: 2 } }),
    });
    // Trip the breaker so the commit creates a pre-commit commit_effect approval,
    // which is NOT a post-hoc review and so cannot record a verdict.
    w.qaStore.setTripped('crm.case_note.append', true);
    const { result } = await draftAndCommit(w);
    expect(result.approvalPending).toBe(true);
    expect(w.gateway.recordReviewVerdict(result.approvalId!, 'agreed')).toBeUndefined();

    // An unknown approval id (or a gateway with no QA loop) also yields undefined.
    expect(w.gateway.recordReviewVerdict('no-such-approval', 'disagreed')).toBeUndefined();

    const noQa = new EffectGateway({
      effectTypes: effectTypes(),
      connectors: new Map(),
      signingSecret: SECRET,
    });
    expect(noQa.recordReviewVerdict('whatever', 'agreed')).toBeUndefined();
  });

  it('a missing approval store makes post-hoc review a silent no-op and recordReviewVerdict a no-op', async () => {
    const qaStore = createMemorySamplingQaStore();
    const qa = new SamplingQa(
      policies({ 'crm.case_note.append': { reviewPercent: 100, disagreementThreshold: 0.5, windowSize: 2 } }),
      qaStore,
      () => 0
    );
    const gateway = new EffectGateway({
      effectTypes: effectTypes(),
      connectors: new Map([['crm', new RecordingConnector('crm')]]),
      credentials: new EffectCredentials({ crm: 'CRM_KEY' }),
      signingSecret: SECRET,
      evidenceResolver: new MapVerificationResolver({ 'verify://ok': { ref: 'verify://ok', verifier: 'pytest', passed: true, failing: [] } }),
      qa,
    });

    const draft = await gateway.draftEffect(crmDraftParams(), committer());
    const result = await gateway.commitEffect({ draft_ref: draft.draftRef! }, committer());
    // The commit still succeeds (routing is best-effort), but no review is created.
    expect(result.committed).toBe(true);
    expect(gateway.recordReviewVerdict('x', 'agreed')).toBeUndefined();
  });

  it('a tripped breaker with no approval store refuses the commit with the breaker message', async () => {
    const qaStore = createMemorySamplingQaStore();
    qaStore.setTripped('crm.case_note.append', true);
    const qa = new SamplingQa(
      policies({ 'crm.case_note.append': { reviewPercent: 100, disagreementThreshold: 0.5, windowSize: 2 } }),
      qaStore,
      () => 0
    );
    const gateway = new EffectGateway({
      effectTypes: effectTypes(),
      connectors: new Map([['crm', new RecordingConnector('crm')]]),
      credentials: new EffectCredentials({ crm: 'CRM_KEY' }),
      signingSecret: SECRET,
      evidenceResolver: new MapVerificationResolver({ 'verify://ok': { ref: 'verify://ok', verifier: 'pytest', passed: true, failing: [] } }),
      qa,
    });

    const draft = await gateway.draftEffect(crmDraftParams(), committer());
    const result = await gateway.commitEffect({ draft_ref: draft.draftRef! }, committer());
    expect(result.committed).toBe(false);
    expect(result.refused).toContain('has auto-commit disabled by the sampling-QA circuit breaker');
  });

  it('recordReviewVerdict returns undefined when the review approval carries no effect_type', async () => {
    const w = makeQaWorld({
      policies: policies({ 'crm.case_note.append': { reviewPercent: 100, disagreementThreshold: 0.5, windowSize: 2 } }),
    });
    const id = `appr_review_${Math.floor(Math.random() * 1e6)}`;
    const approval: PendingApproval = {
      id,
      sessionId: RUN_ID,
      teamId: RUN_ID,
      correlationId: CORR,
      serverAlias: SERVER_ALIAS,
      toolName: REVIEW_COMMIT,
      paramsJson: JSON.stringify({ draft_ref: 'draft://d1' }),
      requestedAt: 1_000_000,
      timeoutAt: 2_000_000,
      requestHash: 'hash',
    };
    w.approvalStore.createApproval(approval);
    expect(w.gateway.recordReviewVerdict(id, 'disagreed')).toBeUndefined();
  });

  it('recordReviewVerdict returns undefined for malformed review params', async () => {
    const w = makeQaWorld({
      policies: policies({ 'crm.case_note.append': { reviewPercent: 100, disagreementThreshold: 0.5, windowSize: 2 } }),
    });
    const id = `appr_review_${Math.floor(Math.random() * 1e6)}`;
    w.approvalStore.createApproval({
      id,
      sessionId: RUN_ID,
      teamId: RUN_ID,
      correlationId: CORR,
      serverAlias: SERVER_ALIAS,
      toolName: REVIEW_COMMIT,
      paramsJson: 'not-json{{{',
      requestedAt: 1_000_000,
      timeoutAt: 2_000_000,
      requestHash: 'hash',
    });
    expect(w.gateway.recordReviewVerdict(id, 'agreed')).toBeUndefined();
  });
});
