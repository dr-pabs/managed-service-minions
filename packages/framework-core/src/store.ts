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
  listSessions(): Session[];
  createMinionRun(run: MinionRun): void;
  updateMinionRun(id: string, patch: Partial<MinionRun>): void;
  listMinionRunsBySession(sessionId: string): MinionRun[];
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
