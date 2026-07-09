export interface Session {
  id: string;
  teamId: string;
  platform: string;
  userId: string;
  correlationRoot: string;
  createdAt: number;
  updatedAt: number;
}

export interface MinionRun {
  id: string;
  sessionId: string;
  minionType: string;
  correlationId: string;
  status: string;
  resultJson?: string;
  tokensUsed?: number;
  createdAt: number;
  completedAt?: number;
}

export interface PendingApproval {
  id: string;
  /**
   * The verified minion token's sessionId (Milestone 6, M4 fix) — NOT the
   * team. Before M4 this field was mistakenly populated with `ctx.teamId`;
   * `teamId` below is now its own distinct field.
   */
  sessionId: string;
  /**
   * The team that owns this approval, derived from the verified token
   * (Milestone 6, M4). Added as its own field so `sessionId` above can hold
   * the actual session identity instead of being overloaded with the team.
   */
  teamId: string;
  correlationId: string;
  serverAlias: string;
  toolName: string;
  paramsJson: string;
  requestedAt: number;
  timeoutAt: number;
  decision?: 'approved' | 'denied';
  decidedAt?: number;
  /** Kind of operator-authenticated surface that resolved the approval (Milestone 4). */
  approverKind?: 'slack' | 'teams' | 'dashboard';
  /** Identity of the human approver within that surface (e.g. a Slack user ID). */
  approverId?: string;
  /**
   * `sha256(serverAlias + toolName + canonicalJSON(params) + correlationId)`
   * (Milestone 4, H3/F1) — identifies an identical resubmission of the same
   * destructive call so it can consume an already-`approved` record exactly
   * once instead of the toolshed blocking in-call for a human decision.
   */
  requestHash: string;
  /**
   * Set the moment an `approved` record is matched by `requestHash` and
   * executed. A consumed approval must never execute a second time; a
   * further identical resubmission creates a fresh approval instead
   * (Milestone 4's resume contract).
   */
  consumedAt?: number;
}

export interface AuditEntry {
  id: string;
  timestamp: number;
  correlationId: string;
  minionType: string;
  teamId: string;
  serverAlias: string;
  toolName: string;
  params: unknown;
  status: string;
  latencyMs: number;
  error?: string;
  retryAfterSeconds?: number;
  approvalId?: string;
}

export interface SessionStore {
  createSession(session: Session): void;
  getSession(id: string): Session | undefined;
  /** Patches an existing session (Milestone 9 — used to touch `updatedAt` on every message). */
  updateSession(id: string, patch: Partial<Session>): void;
  /**
   * Optionally scoped to one team (Milestone 9, ADR-022 multi-tenancy) so a
   * dashboard call cannot leak another tenant's sessions. Omitting `teamId`
   * preserves the pre-Milestone-9 "list everything" behavior for existing
   * callers/tests.
   */
  listSessions(teamId?: string): Session[];
  /**
   * Archives sessions idle past `SESSION_TTL_HOURS` as of `now` (Milestone 9,
   * M3 review / F14). Implementations move expired rows out of the live
   * `sessions` table into an archive (SQLite: `sessions_archive`; memory
   * store: a parallel archive Map) so `listSessions` never returns them again
   * but the record is not destroyed. Blob/transcript archival is explicitly
   * OUT of scope here — only the `Session` row itself is archived.
   */
  expireSessions(now: number): void;
  /** Rows moved out of the live `sessions` table by `expireSessions` (Milestone 9). Blob/transcript archival is out of scope — only the `Session` row itself is preserved here. */
  listSessionArchive(): Session[];
  createMinionRun(run: MinionRun): void;
  updateMinionRun(id: string, patch: Partial<MinionRun>): void;
  /**
   * Optionally scoped to one team (Milestone 9, ADR-022 multi-tenancy) — a
   * defense-in-depth check beyond the sessionId itself, so a caller who
   * guesses/enumerates another tenant's session id still gets nothing back.
   * Omitting `teamId` preserves pre-Milestone-9 behavior.
   */
  listMinionRunsBySession(sessionId: string, teamId?: string): MinionRun[];
  listMinionRunsByCorrelationRoot(root: string): MinionRun[];
  createApproval(approval: PendingApproval): void;
  getApproval(id: string): PendingApproval | undefined;
  /**
   * Looks up the most recent approval matching a `requestHash` (Milestone 4
   * resume contract). Used by the destructive-call gate to recognize an
   * identical resubmission — an approved-and-unconsumed match is executed
   * and marked consumed; a denied/expired/still-pending match short-circuits
   * with the corresponding status; no match creates a fresh approval.
   */
  getApprovalByRequestHash(requestHash: string): PendingApproval | undefined;
  resolveApproval(
    id: string,
    decision: 'approved' | 'denied',
    approver?: { kind: 'slack' | 'teams' | 'dashboard'; id: string }
  ): void;
  /** Marks an approved record as consumed so it can never execute twice. */
  markApprovalConsumed(id: string, consumedAt: number): void;
  listPendingApprovals(): PendingApproval[];
  createAuditEntry(entry: AuditEntry): void;
  listAuditEntries(filters?: { correlationId?: string; limit?: number; offset?: number }): AuditEntry[];
  getCachedToolCall(key: string): unknown | undefined;
  setCachedToolCall(key: string, value: unknown, ttlMs: number): void;
}
