import { createRequire } from 'node:module';

/**
 * Stream sampling QA loop (ExecPlan Milestone 19). After an item auto-commits
 * through the Milestone 14 effect gateway (approval class `auto`, no human in
 * the loop), a configurable percentage of those commits are routed *post hoc*
 * to a human reviewer through the existing approval surfaces. The reviewer
 * records `agreed` (the auto-commit was correct) or `disagreed` (it was wrong);
 * a disagreement rate crossing a configured threshold trips a per-type circuit
 * breaker that turns auto-commit OFF for that type, forcing every subsequent
 * item of that type through pre-commit human approval until the breaker is
 * reset.
 *
 * The "type" here is the effect gateway's `effect_type` — the Stream recipe
 * (`recipes/item-pipelines.yaml`) binds each `item_type` to exactly one commit
 * `effect_type`, so the two names refer to the same grouping at the commit
 * boundary the QA loop actually governs.
 *
 * This module is a self-contained controller plus a durable store, mirroring
 * the `effect-store.ts` dual-backend pattern (in-memory for local dev/tests, a
 * SQLite-backed store injectable for durability) so the disagreement tally and
 * breaker state survive a replica restart.
 */

/** A reviewer's verdict on one post-hoc review. `agreed` = auto-commit was right. */
export type ReviewDecision = 'agreed' | 'disagreed';

/** Per-type sampling/breaker policy. */
export interface SamplingQaPolicy {
  /** Percentage (0–100) of auto-committed items routed to post-hoc review. */
  reviewPercent: number;
  /** Disagreement rate (0–1) that trips auto-commit off for the type. */
  disagreementThreshold: number;
  /** Recent-verdict window the rate is computed over (>= 1). */
  windowSize: number;
}

/** One recorded post-hoc review outcome. */
export interface PostHocReviewVerdict {
  effectType: string;
  correlationId: string;
  draftRef: string;
  decision: ReviewDecision;
  reviewedAt: number;
}

/** The per-type view the dashboard surfaces (disagreement rate + breaker state). */
export interface SamplingQaStat {
  effectType: string;
  reviewed: number;
  disagreed: number;
  disagreementRate: number;
  tripped: boolean;
}

/** Durable home of verdicts and the per-type trip state. */
export interface SamplingQaStore {
  recordVerdict(verdict: PostHocReviewVerdict): void;
  listVerdicts(effectType?: string): PostHocReviewVerdict[];
  setTripped(effectType: string, tripped: boolean): void;
  isTripped(effectType: string): boolean;
  /** Clears both the verdict history and the trip state for one type (the "reset" action). */
  reset(effectType: string): void;
  trippedTypes(): string[];
}

function cloneVerdict(verdict: PostHocReviewVerdict): PostHocReviewVerdict {
  return { ...verdict };
}

/** In-memory store for local dev and tests (the QA loop needs no cloud dependency). */
export function createMemorySamplingQaStore(): SamplingQaStore {
  const verdicts: PostHocReviewVerdict[] = [];
  const tripped = new Set<string>();

  return {
    recordVerdict(verdict) {
      verdicts.push(cloneVerdict(verdict));
    },
    listVerdicts(effectType) {
      return verdicts
        .filter((verdict) => effectType === undefined || verdict.effectType === effectType)
        .map(cloneVerdict);
    },
    setTripped(effectType, isTripped) {
      if (isTripped) {
        tripped.add(effectType);
      } else {
        tripped.delete(effectType);
      }
    },
    isTripped(effectType) {
      return tripped.has(effectType);
    },
    reset(effectType) {
      for (let i = verdicts.length - 1; i >= 0; i--) {
        if (verdicts[i].effectType === effectType) {
          verdicts.splice(i, 1);
        }
      }
      tripped.delete(effectType);
    },
    trippedTypes() {
      return Array.from(tripped).sort();
    },
  };
}

const require = createRequire(import.meta.url);

interface BetterSqlite3Database {
  exec(sql: string): void;
  prepare(sql: string): BetterSqlite3Statement;
  close(): void;
}

interface BetterSqlite3Statement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

function loadBetterSqlite3(): new (path: string) => BetterSqlite3Database {
  const mod = require('better-sqlite3');
  return mod.default ?? mod;
}

/**
 * SQLite-backed QA store. Mirrors `effect-store.ts`: the same injectable
 * `DatabaseCtor` for SQL-logic tests without the native binding, and the same
 * fail-hard-in-production (unless `TOOLSHED_ALLOW_MEMORY_STORE=1`) fallback so
 * the disagreement tally is never silently discarded.
 */
export function createSqliteSamplingQaStore(
  path: string,
  DatabaseCtor?: new (path: string) => BetterSqlite3Database
): SamplingQaStore {
  try {
    const Database = DatabaseCtor ?? loadBetterSqlite3();
    const db = new Database(path);
    initializeSamplingQaSchema(db);
    return createSqliteSamplingQaDStore(db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isProduction = process.env.NODE_ENV === 'production';
    const allowMemoryStore = process.env.TOOLSHED_ALLOW_MEMORY_STORE === '1';
    if (isProduction && !allowMemoryStore) {
      throw new Error(
        `[sampling-qa] SQLite unavailable (${message}) in production (NODE_ENV=production) — refusing to silently fall back to a memory store that would discard the sampling-QA trail. Set TOOLSHED_ALLOW_MEMORY_STORE=1 to explicitly accept memory-only durability.`
      );
    }
    console.warn(`[sampling-qa] SQLite unavailable (${message}), falling back to memory store`);
    return createMemorySamplingQaStore();
  }
}

function initializeSamplingQaSchema(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sampling_qa_verdicts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      effect_type TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      draft_ref TEXT NOT NULL,
      decision TEXT NOT NULL,
      reviewed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sampling_qa_effect_type ON sampling_qa_verdicts (effect_type);

    CREATE TABLE IF NOT EXISTS sampling_qa_tripped (
      effect_type TEXT PRIMARY KEY
    );
  `);
}

function createSqliteSamplingQaDStore(db: BetterSqlite3Database): SamplingQaStore {
  const insertVerdict = db.prepare(
    `INSERT INTO sampling_qa_verdicts (effect_type, correlation_id, draft_ref, decision, reviewed_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  const selectByType = db.prepare(
    'SELECT * FROM sampling_qa_verdicts WHERE effect_type = ? ORDER BY reviewed_at, seq'
  );
  const selectAll = db.prepare('SELECT * FROM sampling_qa_verdicts ORDER BY reviewed_at, seq');
  const insertTripped = db.prepare('INSERT OR REPLACE INTO sampling_qa_tripped (effect_type) VALUES (?)');
  const deleteTripped = db.prepare('DELETE FROM sampling_qa_tripped WHERE effect_type = ?');
  const selectTripped = db.prepare('SELECT 1 FROM sampling_qa_tripped WHERE effect_type = ?');
  const selectAllTripped = db.prepare('SELECT effect_type FROM sampling_qa_tripped ORDER BY effect_type');
  const deleteVerdicts = db.prepare('DELETE FROM sampling_qa_verdicts WHERE effect_type = ?');

  return {
    recordVerdict(verdict) {
      insertVerdict.run(
        verdict.effectType,
        verdict.correlationId,
        verdict.draftRef,
        verdict.decision,
        verdict.reviewedAt
      );
    },
    listVerdicts(effectType) {
      const rows = (
        effectType === undefined ? selectAll.all() : selectByType.all(effectType)
      ) as Record<string, unknown>[];
      return rows.map(rowToVerdict);
    },
    setTripped(effectType, isTripped) {
      if (isTripped) {
        insertTripped.run(effectType);
      } else {
        deleteTripped.run(effectType);
      }
    },
    isTripped(effectType) {
      return selectTripped.get(effectType) !== undefined;
    },
    reset(effectType) {
      deleteVerdicts.run(effectType);
      deleteTripped.run(effectType);
    },
    trippedTypes() {
      return (selectAllTripped.all() as Record<string, unknown>[]).map((row) => String(row.effect_type));
    },
  };
}

function rowToVerdict(row: Record<string, unknown>): PostHocReviewVerdict {
  return {
    effectType: String(row.effect_type),
    correlationId: String(row.correlation_id),
    draftRef: String(row.draft_ref),
    decision: row.decision === 'disagreed' ? 'disagreed' : 'agreed',
    reviewedAt: Number(row.reviewed_at),
  };
}

// ---------------------------------------------------------------------------
// Policy construction and validation
// ---------------------------------------------------------------------------

/** Validates one policy triple, rejecting out-of-range or malformed values. */
export function makeSamplingQaPolicy(
  effectType: string,
  reviewPercent: number,
  disagreementThreshold: number,
  windowSize: number
): SamplingQaPolicy {
  if (typeof reviewPercent !== 'number' || !Number.isFinite(reviewPercent) || reviewPercent < 0 || reviewPercent > 100) {
    throw new Error(`sampling QA '${effectType}': review_percent must be between 0 and 100, got ${reviewPercent}`);
  }
  if (
    typeof disagreementThreshold !== 'number' ||
    !Number.isFinite(disagreementThreshold) ||
    disagreementThreshold < 0 ||
    disagreementThreshold > 1
  ) {
    throw new Error(
      `sampling QA '${effectType}': disagreement_threshold must be between 0 and 1, got ${disagreementThreshold}`
    );
  }
  if (!Number.isInteger(windowSize) || windowSize < 1) {
    throw new Error(`sampling QA '${effectType}': window_size must be an integer >= 1, got ${windowSize}`);
  }
  return { reviewPercent, disagreementThreshold, windowSize };
}

/**
 * Parses a `sampling_qa:` mapping (one entry per type) into policies, rejecting
 * malformed entries — the config-driven counterpart of `effectTypesFromRecord`.
 * Each entry requires `review_percent`, `disagreement_threshold`, and
 * `window_size`.
 */
export function samplingQaPoliciesFromRecord(data: unknown): Map<string, SamplingQaPolicy> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('sampling_qa must be a mapping');
  }
  const policies = new Map<string, SamplingQaPolicy>();
  for (const [effectType, raw] of Object.entries(data as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`sampling_qa.${effectType} must be a mapping`);
    }
    const entry = raw as Record<string, unknown>;
    const unknown = Object.keys(entry).filter(
      (key) => key !== 'review_percent' && key !== 'disagreement_threshold' && key !== 'window_size'
    );
    if (unknown.length > 0) {
      throw new Error(
        `sampling_qa.${effectType}: unknown keys ${unknown.sort().join(', ')} (expected review_percent, disagreement_threshold, window_size)`
      );
    }
    for (const key of ['review_percent', 'disagreement_threshold', 'window_size'] as const) {
      if (!(key in entry)) {
        throw new Error(`sampling_qa.${effectType}: missing ${key}`);
      }
    }
    policies.set(
      effectType,
      makeSamplingQaPolicy(
        effectType,
        Number(entry.review_percent),
        Number(entry.disagreement_threshold),
        Number(entry.window_size)
      )
    );
  }
  return policies;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * The sampling QA loop's decision logic, kept separate from the durable store
 * so the rate/threshold arithmetic is deterministic and directly testable. The
 * gateway owns the `SamplingQa` instance and consults it at commit time.
 */
export class SamplingQa {
  constructor(
    private readonly policies: Map<string, SamplingQaPolicy>,
    private readonly store: SamplingQaStore,
    private readonly random: () => number = Math.random
  ) {}

  /**
   * Whether an auto-commit of `effectType` should also be routed to post-hoc
   * review. A type with no policy (or a 0% review rate) is never sampled.
   */
  shouldReview(effectType: string): boolean {
    const policy = this.policies.get(effectType);
    if (!policy) {
      return false;
    }
    return this.random() * 100 < policy.reviewPercent;
  }

  /** Whether the breaker is currently tripped for `effectType` (auto-commit OFF). */
  isTripped(effectType: string): boolean {
    return this.store.isTripped(effectType);
  }

  /** The disagreement rate over the type's most recent `windowSize` verdicts. */
  disagreementRate(effectType: string): number {
    return this.stat(effectType).disagreementRate;
  }

  /**
   * Records a reviewer verdict and, if the disagreement rate now crosses the
   * type's threshold, trips the breaker. Returns the updated per-type stat.
   */
  recordVerdict(verdict: PostHocReviewVerdict): SamplingQaStat {
    this.store.recordVerdict(verdict);
    const stat = this.stat(verdict.effectType);
    const policy = this.policies.get(verdict.effectType);
    if (policy && stat.reviewed > 0 && stat.disagreementRate >= policy.disagreementThreshold) {
      this.store.setTripped(verdict.effectType, true);
    }
    return this.stat(verdict.effectType);
  }

  /** Resets one type: clears its verdict history and its trip state. */
  reset(effectType: string): void {
    this.store.reset(effectType);
  }

  /** The disagreement rate + trip state for one type over its current window. */
  stat(effectType: string): SamplingQaStat {
    const policy = this.policies.get(effectType);
    const windowSize = policy?.windowSize ?? 0;
    const window = windowSize > 0 ? this.store.listVerdicts(effectType).slice(-windowSize) : [];
    const disagreed = window.filter((verdict) => verdict.decision === 'disagreed').length;
    return {
      effectType,
      reviewed: window.length,
      disagreed,
      disagreementRate: window.length === 0 ? 0 : disagreed / window.length,
      tripped: this.store.isTripped(effectType),
    };
  }

  /** Every type that has a policy, a recorded verdict, or a tripped breaker. */
  stats(): SamplingQaStat[] {
    const types = new Set<string>();
    for (const type of this.policies.keys()) {
      types.add(type);
    }
    for (const verdict of this.store.listVerdicts()) {
      types.add(verdict.effectType);
    }
    for (const type of this.store.trippedTypes()) {
      types.add(type);
    }
    return Array.from(types).sort().map((type) => this.stat(type));
  }
}
