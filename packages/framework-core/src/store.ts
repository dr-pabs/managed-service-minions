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
  sessionId: string;
  correlationId: string;
  serverAlias: string;
  toolName: string;
  paramsJson: string;
  requestedAt: number;
  timeoutAt: number;
  decision?: 'approved' | 'denied';
  decidedAt?: number;
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
  resolveApproval(id: string, decision: 'approved' | 'denied'): void;
  listPendingApprovals(): PendingApproval[];
  createAuditEntry(entry: AuditEntry): void;
  listAuditEntries(filters?: { correlationId?: string; limit?: number; offset?: number }): AuditEntry[];
  getCachedToolCall(key: string): unknown | undefined;
  setCachedToolCall(key: string, value: unknown, ttlMs: number): void;
}
