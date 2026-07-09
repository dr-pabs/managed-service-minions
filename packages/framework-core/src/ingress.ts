import { randomUUID } from 'node:crypto';
import { createRootCorrelationId } from './correlation.js';
import { withSpan } from './telemetry.js';
import type { Session, SessionStore } from './store.js';

/**
 * A session idle longer than this is treated as expired: a new message on
 * the same thread starts a fresh session rather than resuming the stale one
 * (Milestone 9, M3 review / F14). Overridable via `SESSION_TTL_HOURS` for
 * ops tuning; falls back to 72 (3 days) if unset or not a positive number.
 */
export const DEFAULT_SESSION_TTL_HOURS = 72;

/**
 * Shared by `handleIngressMessage` and every `SessionStore.expireSessions`
 * implementation so the TTL used to decide "is this session too old to
 * resume" and the TTL used to decide "is this row old enough to archive" can
 * never drift apart.
 */
export function resolveSessionTtlHours(): number {
  const raw = process.env.SESSION_TTL_HOURS;
  if (!raw) return DEFAULT_SESSION_TTL_HOURS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TTL_HOURS;
}

/**
 * A chat-platform message that has been normalized to a common shape.
 */
export interface IngressRequest {
  platform: 'slack' | 'teams' | 'webhook';
  teamId: string;
  channelId?: string;
  userId: string;
  text: string;
  threadId?: string;
}

/**
 * The response the bot should send back to the user. Each platform adapter picks
 * the rendering that its channel understands.
 */
export interface IngressResponse {
  text: string;
  blocks?: unknown[];
  adaptiveCard?: unknown;
}

/**
 * Something that can turn a normalized request into a response. In production this
 * is the orchestrator/minion runtime; in tests it is a mock.
 */
export interface IngressRunner {
  run(request: IngressRequest & { sessionId: string; correlationRoot: string }): Promise<IngressResponse>;
}

export interface HandleIngressMessageOptions {
  /** Injectable clock, mirroring the `now: () => number` convention used by the SessionStore implementations. Defaults to `Date.now`. */
  now?: () => number;
  /** Overrides the TTL for this call; defaults to `SESSION_TTL_HOURS`/`DEFAULT_SESSION_TTL_HOURS`. */
  ttlHours?: number;
}

/**
 * Derives a stable session id from (teamId, platform, threadId) so a second
 * message on the same thread finds the same row (Milestone 9, M3 review).
 * A request with no threadId (e.g. a DM ack event with no message ts) always
 * gets a fresh, unshareable session id — same as the pre-Milestone-9
 * behavior for the no-threadId case.
 */
function deriveSessionId(request: IngressRequest): string {
  if (!request.threadId) {
    return randomUUID();
  }
  return `sess_${request.teamId}:${request.platform}:${request.threadId}`;
}

/**
 * Turn a normalized chat message into a stored session plus a runner response.
 *
 * Sessions are keyed by (teamId, platform, threadId) (Milestone 9, M3 review
 * fix): a second message on the same thread reuses the same session row, but
 * two different threads — including two non-threaded channel messages, which
 * now each carry their own message timestamp as `threadId` per the bot-side
 * fix — never collide into one session. `updatedAt` is touched on every
 * message, including a reused session. A session idle past
 * `SESSION_TTL_HOURS` (default 72) is treated as expired: it is archived via
 * `store.expireSessions` and a brand new session is created rather than
 * resumed.
 */
export async function handleIngressMessage(
  request: IngressRequest,
  store: SessionStore,
  runner: IngressRunner,
  options: HandleIngressMessageOptions = {}
): Promise<IngressResponse> {
  const now = options.now ?? Date.now;
  const ttlHours = options.ttlHours ?? resolveSessionTtlHours();
  const ttlMs = ttlHours * 60 * 60 * 1000;
  const currentTime = now();

  const sessionId = deriveSessionId(request);
  let session: Session | undefined = store.getSession(sessionId);

  if (session && currentTime - session.updatedAt > ttlMs) {
    // Idle past TTL: archive the stale row (removing it from `getSession`'s
    // view) and fall through to create a fresh session below rather than
    // resuming it. Archiving — not deleting — is what makes the deterministic
    // id below safe to reuse for the new session: the old row lives on in
    // `sessions_archive`, distinguishable by its own createdAt/updatedAt.
    store.expireSessions(currentTime);
    session = undefined;
  }

  if (!session) {
    session = {
      id: sessionId,
      teamId: request.teamId,
      platform: request.platform,
      userId: request.userId,
      correlationRoot: createRootCorrelationId(),
      createdAt: currentTime,
      updatedAt: currentTime,
    };
    store.createSession(session);
  } else {
    store.updateSession(sessionId, { updatedAt: currentTime });
  }

  // ingress.message span (Milestone 13, M9/F9) — the root of the nesting
  // chain (ingress -> orchestrator.run -> minion.run -> execute_tool ->
  // adapter.call). Wraps the runner call specifically (not session
  // lookup/creation above, which is fast bookkeeping, not a call worth its
  // own span) so any span the runner itself creates (the orchestrator
  // runner's `orchestrator.run`) nests under this one via real OTel context
  // propagation, not just chronological ordering.
  return withSpan(
    'ingress.message',
    { correlation_id: session.correlationRoot, session_id: sessionId, minion_type: 'ingress' },
    () =>
      runner.run({
        ...request,
        sessionId,
        correlationRoot: session!.correlationRoot,
      })
  );
}
