import type {
  AuditEntry,
  MinionRun,
  PendingApproval,
  Session,
  SessionStore,
} from 'framework-core';

/**
 * A minimal in-memory `SessionStore` for orchestrator unit tests. Not the
 * `mcp-toolshed` implementation (that's what the e2e test uses via the real
 * package) -- this is a small hand-rolled fake so `runner.test.ts` can
 * assert on `MinionRun` rows without depending on `mcp-toolshed` at all.
 */
export function createInMemoryTestStore(): SessionStore {
  const sessions = new Map<string, Session>();
  const archive: Session[] = [];
  const minionRuns = new Map<string, MinionRun>();
  const approvals = new Map<string, PendingApproval>();
  const auditEntries: AuditEntry[] = [];
  const cache = new Map<string, unknown>();

  return {
    createSession(session) {
      sessions.set(session.id, session);
    },
    getSession(id) {
      return sessions.get(id);
    },
    updateSession(id, patch) {
      const existing = sessions.get(id);
      if (existing) sessions.set(id, { ...existing, ...patch });
    },
    listSessions() {
      return Array.from(sessions.values());
    },
    expireSessions(now) {
      for (const [id, session] of sessions.entries()) {
        if (now - session.updatedAt > 0) {
          archive.push(session);
          sessions.delete(id);
        }
      }
    },
    listSessionArchive() {
      return archive;
    },
    createMinionRun(run) {
      minionRuns.set(run.id, run);
    },
    updateMinionRun(id, patch) {
      const existing = minionRuns.get(id);
      if (existing) minionRuns.set(id, { ...existing, ...patch });
    },
    listMinionRunsBySession(sessionId) {
      return Array.from(minionRuns.values()).filter((r) => r.sessionId === sessionId);
    },
    listMinionRunsByCorrelationRoot(root) {
      return Array.from(minionRuns.values()).filter((r) => r.correlationId.startsWith(root));
    },
    createApproval(approval) {
      approvals.set(approval.id, approval);
    },
    getApproval(id) {
      return approvals.get(id);
    },
    getApprovalByRequestHash(requestHash) {
      return Array.from(approvals.values())
        .filter((a) => a.requestHash === requestHash)
        .sort((a, b) => b.requestedAt - a.requestedAt)[0];
    },
    resolveApproval(id, decision, approver) {
      const existing = approvals.get(id);
      if (existing) {
        approvals.set(id, {
          ...existing,
          decision,
          decidedAt: Date.now(),
          approverKind: approver?.kind,
          approverId: approver?.id,
        });
      }
    },
    markApprovalConsumed(id, consumedAt) {
      const existing = approvals.get(id);
      if (existing) approvals.set(id, { ...existing, consumedAt });
    },
    listPendingApprovals() {
      return Array.from(approvals.values()).filter((a) => !a.decision);
    },
    createAuditEntry(entry) {
      auditEntries.push(entry);
    },
    listAuditEntries(filters) {
      let result = auditEntries;
      if (filters?.correlationId) {
        result = result.filter((e) => e.correlationId === filters.correlationId);
      }
      return result;
    },
    getCachedToolCall(key) {
      return cache.get(key);
    },
    setCachedToolCall(key, value) {
      cache.set(key, value);
    },
  };
}
