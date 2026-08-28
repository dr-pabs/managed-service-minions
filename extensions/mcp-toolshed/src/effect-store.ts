import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { MinionTokenPayload } from 'framework-core';

/**
 * Durable home of effect drafts and the decision records the gateway writes
 * when a draft is committed or discarded (ExecPlan Milestone 14, mirroring
 * Flow's `forge/tools/effect_store.py` + migrations 011/012). Every stored
 * draft serialises to the `effects/v1` `effect_draft` document and every
 * decided draft to an `effects/v1` `decision_record`.
 *
 * Two implementations behind one interface, exactly as `store.ts` does for the
 * session store: an in-memory emulation for local dev and tests, and a
 * SQLite-backed durable store (Azure Tables in cloud is a future backend — see
 * Milestone 18). Both take an injectable `now` clock so timeouts/expiry are
 * deterministic under test.
 */

/** Who decided a draft — a verified agent or an authenticated human. Mirrors `effects/v1` `actor`. */
export type EffectActor =
  | { kind: 'agent'; token_payload: MinionTokenPayload }
  | { kind: 'human'; approver_id: string };

/** The seven `effects/v1` `effect_draft` fields, serialised verbatim. */
export interface EffectDraftDocument {
  effect_type: string;
  target_system: string;
  payload: Record<string, unknown>;
  evidence: string[];
  reversibility: string;
  idempotency_key: string;
  expiry: number;
}

/** The `effects/v1` `decision_record` the gateway writes on commit/discard. */
export interface DecisionRecord {
  draft_ref: string;
  decision: 'commit' | 'discard';
  draft: EffectDraftDocument;
  actor: EffectActor;
  reason?: string;
}

export type EffectStatus = 'draft' | 'committed' | 'discarded';

/** Internal row: the draft plus its provenance and decision. */
export interface EffectDraftRecord {
  id: string;
  sessionId: string;
  correlationId: string;
  /** Agent id of the drafter, as verified from the identity token when present. */
  drafterAgentId: string;
  /** True only when the drafter presented a valid `identity/v1` token. */
  drafterVerified: boolean;
  effectType: string;
  targetSystem: string;
  payload: Record<string, unknown>;
  evidence: string[];
  reversibility: string;
  /** The effect type's governance approval class (`auto`/`sampled`/`always_human`) at draft time. */
  approvalClass: string;
  idempotencyKey: string;
  expiry: number;
  status: EffectStatus;
  createdAt: number;
  decidedAt?: number;
  decisionActor?: EffectActor;
  decisionReason?: string;
  outcome?: Record<string, unknown>;
}

/** The compare-and-set decision write: `true` iff this call is the one that decided the draft. */
export interface DecisionWrite {
  status: 'committed' | 'discarded';
  actor: EffectActor;
  reason?: string;
  outcome?: Record<string, unknown>;
  decidedAt: number;
}

export interface EffectDraftStore {
  saveDraft(record: EffectDraftRecord): void;
  getDraft(id: string): EffectDraftRecord | undefined;
  /** The draft owning an idempotency key — committed rows first, so a replay finds the recorded outcome. */
  findByIdempotencyKey(key: string): EffectDraftRecord | undefined;
  /**
   * Compare-and-set: decide a draft only if it is still `draft`. Returns `true`
   * when this call wrote the decision, `false` when the draft was already
   * decided (the caller then re-reads and returns the recorded outcome — the
   * durable second line of defence against a commit race).
   */
  recordDecision(id: string, decision: DecisionWrite): boolean;
  listDrafts(filter?: { sessionId?: string; status?: EffectStatus }): EffectDraftRecord[];
}

const DRAFT_REF_PREFIX = 'draft://';

/** Fresh opaque draft id, e.g. `draft_9d41c0ab12`. */
export function newDraftId(): string {
  return `draft_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

/** `draft://<id>` reference form. */
export function draftRef(id: string): string {
  return `${DRAFT_REF_PREFIX}${id}`;
}

/** Strip the `draft://` prefix; a bare id passes through unchanged. */
export function parseDraftRef(ref: string): string {
  return ref.startsWith(DRAFT_REF_PREFIX) ? ref.slice(DRAFT_REF_PREFIX.length) : ref;
}

/** The seven `effect_draft` fields, copied so callers cannot mutate the stored row. */
export function toDraftDocument(record: EffectDraftRecord): EffectDraftDocument {
  return {
    effect_type: record.effectType,
    target_system: record.targetSystem,
    payload: { ...record.payload },
    evidence: [...record.evidence],
    reversibility: record.reversibility,
    idempotency_key: record.idempotencyKey,
    expiry: record.expiry,
  };
}

/**
 * The `decision_record` for a decided draft, with the draft snapshot embedded
 * (so the schema can enforce the irreversible-never-agent invariant directly).
 * `reason` is included only when set; it is required on discard.
 */
export function toDecisionRecord(record: EffectDraftRecord): DecisionRecord {
  if (record.status !== 'committed' && record.status !== 'discarded') {
    throw new Error(`draft ${record.id} is not decided (status=${record.status})`);
  }
  if (!record.decisionActor) {
    throw new Error(`draft ${record.id} has no decision actor`);
  }
  const decision: DecisionRecord = {
    draft_ref: draftRef(record.id),
    decision: record.status === 'committed' ? 'commit' : 'discard',
    draft: toDraftDocument(record),
    actor: record.decisionActor,
  };
  if (record.decisionReason !== undefined) {
    decision.reason = record.decisionReason;
  }
  return decision;
}

/** The view logged to the audit trail: the draft document plus provenance and decision. */
export function toAuditView(record: EffectDraftRecord): Record<string, unknown> {
  const view: Record<string, unknown> = {
    draft_ref: draftRef(record.id),
    status: record.status,
    drafter_agent_id: record.drafterAgentId,
    drafter_verified: record.drafterVerified,
    ...toDraftDocument(record),
  };
  if (record.decidedAt !== undefined) view.decided_at = record.decidedAt;
  if (record.decisionActor !== undefined) view.actor = record.decisionActor;
  if (record.outcome !== undefined) view.outcome = record.outcome;
  return view;
}

function cloneRecord(record: EffectDraftRecord): EffectDraftRecord {
  return {
    ...record,
    payload: { ...record.payload },
    evidence: [...record.evidence],
    decisionActor: record.decisionActor,
    outcome: record.outcome === undefined ? undefined : { ...record.outcome },
  };
}

function committedFirst(a: EffectDraftRecord, b: EffectDraftRecord): number {
  const rank = (r: EffectDraftRecord): number => (r.status === 'committed' ? 0 : 1);
  const byStatus = rank(a) - rank(b);
  return byStatus !== 0 ? byStatus : a.createdAt - b.createdAt;
}

export function createMemoryEffectStore(_now: () => number = Date.now): EffectDraftStore {
  const drafts = new Map<string, EffectDraftRecord>();

  return {
    saveDraft(record: EffectDraftRecord): void {
      drafts.set(record.id, cloneRecord(record));
    },
    getDraft(id: string): EffectDraftRecord | undefined {
      const record = drafts.get(id);
      return record ? cloneRecord(record) : undefined;
    },
    findByIdempotencyKey(key: string): EffectDraftRecord | undefined {
      const matches = Array.from(drafts.values())
        .filter((record) => record.idempotencyKey === key)
        .sort(committedFirst);
      return matches.length > 0 ? cloneRecord(matches[0]) : undefined;
    },
    recordDecision(id: string, decision: DecisionWrite): boolean {
      const record = drafts.get(id);
      if (!record || record.status !== 'draft') {
        return false;
      }
      record.status = decision.status;
      record.decidedAt = decision.decidedAt;
      record.decisionActor = decision.actor;
      record.decisionReason = decision.reason;
      record.outcome = decision.outcome;
      return true;
    },
    listDrafts(filter?: { sessionId?: string; status?: EffectStatus }): EffectDraftRecord[] {
      return Array.from(drafts.values())
        .filter((record) => filter?.sessionId === undefined || record.sessionId === filter.sessionId)
        .filter((record) => filter?.status === undefined || record.status === filter.status)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(cloneRecord);
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
 * SQLite-backed durable draft store. `DatabaseCtor` is injectable so tests
 * exercise the SQL logic without the native `better-sqlite3` binding, exactly
 * as `store.ts`'s `createSqliteStore` does. On a load/open failure it falls
 * back to the memory store — but fails hard in production unless
 * `TOOLSHED_ALLOW_MEMORY_STORE=1`, so a durable draft trail is never silently
 * discarded (same convention as the session store's H6 guard).
 */
export function createSqliteEffectStore(
  path: string,
  DatabaseCtor?: new (path: string) => BetterSqlite3Database,
  now: () => number = Date.now
): EffectDraftStore {
  try {
    const Database = DatabaseCtor ?? loadBetterSqlite3();
    const db = new Database(path);
    initializeEffectSchema(db);
    return createSqliteEffectDraftStore(db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isProduction = process.env.NODE_ENV === 'production';
    const allowMemoryStore = process.env.TOOLSHED_ALLOW_MEMORY_STORE === '1';
    if (isProduction && !allowMemoryStore) {
      throw new Error(
        `[effect-store] SQLite unavailable (${message}) in production (NODE_ENV=production) — refusing to silently fall back to a memory store that would discard the effect-draft trail. Set TOOLSHED_ALLOW_MEMORY_STORE=1 to explicitly accept memory-only durability.`
      );
    }
    console.warn(`[effect-store] SQLite unavailable (${message}), falling back to memory store`);
    return createMemoryEffectStore(now);
  }
}

function initializeEffectSchema(db: BetterSqlite3Database): void {
  // Mirrors Flow's migration 011_effect_drafts.sql. IF NOT EXISTS keeps
  // re-initialisation against a dev database idempotent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS effect_drafts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      correlation_id TEXT NOT NULL DEFAULT '',
      drafter_agent_id TEXT NOT NULL DEFAULT '',
      drafter_verified INTEGER NOT NULL DEFAULT 0,
      effect_type TEXT NOT NULL,
      target_system TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      reversibility TEXT NOT NULL,
      approval_class TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT NOT NULL,
      expiry INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      decision_actor_json TEXT,
      decision_reason TEXT,
      outcome_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_effect_drafts_idempotency ON effect_drafts (idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_effect_drafts_status ON effect_drafts (status);
  `);
}

function createSqliteEffectDraftStore(db: BetterSqlite3Database): EffectDraftStore {
  const insertDraft = db.prepare(
    `INSERT INTO effect_drafts (
       id, session_id, correlation_id, drafter_agent_id, drafter_verified,
       effect_type, target_system, payload_json, evidence_json, reversibility,
       approval_class, idempotency_key, expiry, status, created_at, decided_at,
       decision_actor_json, decision_reason, outcome_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const selectDraft = db.prepare('SELECT * FROM effect_drafts WHERE id = ?');
  const selectByIdempotency = db.prepare(
    `SELECT * FROM effect_drafts WHERE idempotency_key = ?
     ORDER BY CASE status WHEN 'committed' THEN 0 ELSE 1 END, created_at
     LIMIT 1`
  );
  const decideDraft = db.prepare(
    `UPDATE effect_drafts
     SET status = ?, decided_at = ?, decision_actor_json = ?, decision_reason = ?, outcome_json = ?
     WHERE id = ? AND status = 'draft'`
  );
  const selectAll = db.prepare('SELECT * FROM effect_drafts ORDER BY created_at');
  const selectBySession = db.prepare('SELECT * FROM effect_drafts WHERE session_id = ? ORDER BY created_at');

  return {
    saveDraft(record: EffectDraftRecord): void {
      insertDraft.run(
        record.id,
        record.sessionId,
        record.correlationId,
        record.drafterAgentId,
        record.drafterVerified ? 1 : 0,
        record.effectType,
        record.targetSystem,
        JSON.stringify(record.payload),
        JSON.stringify(record.evidence),
        record.reversibility,
        record.approvalClass,
        record.idempotencyKey,
        record.expiry,
        record.status,
        record.createdAt,
        record.decidedAt ?? null,
        record.decisionActor === undefined ? null : JSON.stringify(record.decisionActor),
        record.decisionReason ?? null,
        record.outcome === undefined ? null : JSON.stringify(record.outcome)
      );
    },
    getDraft(id: string): EffectDraftRecord | undefined {
      const row = selectDraft.get(id) as Record<string, unknown> | undefined;
      return row ? rowToRecord(row) : undefined;
    },
    findByIdempotencyKey(key: string): EffectDraftRecord | undefined {
      const row = selectByIdempotency.get(key) as Record<string, unknown> | undefined;
      return row ? rowToRecord(row) : undefined;
    },
    recordDecision(id: string, decision: DecisionWrite): boolean {
      const result = decideDraft.run(
        decision.status,
        decision.decidedAt,
        JSON.stringify(decision.actor),
        decision.reason ?? null,
        decision.outcome === undefined ? null : JSON.stringify(decision.outcome),
        id
      );
      return result.changes > 0;
    },
    listDrafts(filter?: { sessionId?: string; status?: EffectStatus }): EffectDraftRecord[] {
      const rows = (
        filter?.sessionId === undefined ? selectAll.all() : selectBySession.all(filter.sessionId)
      ) as Record<string, unknown>[];
      const records = rows.map(rowToRecord);
      return filter?.status === undefined ? records : records.filter((r) => r.status === filter.status);
    },
  };
}

function rowToRecord(row: Record<string, unknown>): EffectDraftRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id ?? ''),
    correlationId: String(row.correlation_id ?? ''),
    drafterAgentId: String(row.drafter_agent_id ?? ''),
    drafterVerified: Number(row.drafter_verified) === 1,
    effectType: String(row.effect_type),
    targetSystem: String(row.target_system),
    payload: parseJsonObject(row.payload_json),
    evidence: parseJsonStringArray(row.evidence_json),
    reversibility: String(row.reversibility),
    approvalClass: String(row.approval_class ?? ''),
    idempotencyKey: String(row.idempotency_key),
    expiry: Number(row.expiry),
    status: String(row.status) as EffectStatus,
    createdAt: Number(row.created_at),
    decidedAt: row.decided_at == null ? undefined : Number(row.decided_at),
    decisionActor: row.decision_actor_json == null ? undefined : (JSON.parse(String(row.decision_actor_json)) as EffectActor),
    decisionReason: row.decision_reason == null ? undefined : String(row.decision_reason),
    outcome: row.outcome_json == null ? undefined : (JSON.parse(String(row.outcome_json)) as Record<string, unknown>),
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = JSON.parse(String(value));
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function parseJsonStringArray(value: unknown): string[] {
  const parsed = JSON.parse(String(value));
  return Array.isArray(parsed) ? (parsed as string[]) : [];
}
