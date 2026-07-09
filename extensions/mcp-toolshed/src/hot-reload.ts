import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AuditEntry, SessionStore } from 'framework-core';
import { loadAllowlists, loadGovernance } from './config.js';
import { validateConfigAtRoot } from './config-validation.js';
import { redactSecrets } from './redact.js';
import type { ToolshedState } from './toolshed.js';

/**
 * Rules hot-reload (Milestone 17, F16): tightening policy must not require a
 * process restart. `watchRules` watches `allowlistsPath`/`governancePath`
 * with `fs.watch`, debounces bursts of edits (a single `git checkout` or
 * editor save can fire several change events for one logical edit), reloads
 * BOTH files fresh from disk, and runs them through the Milestone 1
 * cross-validator (`validateConfigAtRoot`) against the full config tree
 * rooted at `repoRoot` before ever touching live state.
 *
 * Only a config that validates cleanly (zero errors) is swapped in, and the
 * swap is a single atomic object assignment per field
 * (`state.allowlists = …; state.governance = …`) — never a mutation of the
 * existing objects in place, so a concurrent `executeTool` call reading
 * `state.allowlists` mid-reload always sees either the fully-old or the
 * fully-new config, never a half-written one. An invalid edit is logged and
 * REJECTED: the old config keeps serving exactly as before, and the
 * rejection is itself an audited exit path (`config_reload_rejected`),
 * matching every other exit path in the toolshed's enforcement pipeline
 * (see the toolshed-governance-invariants skill, invariant 2).
 *
 * This is a defensive feature, not a convenience one: it lets an operator
 * tighten an allowlist or add a deny pattern in response to an in-progress
 * incident WITHOUT restarting the process (which would drop in-flight
 * approvals/sessions) — but it must never let a config edit *silently*
 * widen what a misbehaving minion can do. A broken edit is inert (rejected,
 * old rules keep enforcing) rather than fail-open.
 */

export interface WatchRulesOptions {
  /** Repo root containing agents/, rules/, schemas/ — passed to validateConfigAtRoot. */
  repoRoot: string;
  allowlistsPath: string;
  governancePath: string;
  /** The live toolshed state to swap `allowlists`/`governance` on. */
  state: ToolshedState;
  /** Durable audit sink — every reload attempt (accepted or rejected) is persisted here. */
  store: SessionStore;
  /** In-process audit sink mirroring `ToolshedState.auditLogger`'s contract. */
  auditLogger: (entry: AuditEntry) => void | Promise<void>;
  /** Debounce window in ms. Default 500 per the milestone spec; tests inject a small value. */
  debounceMs?: number;
  /** Injectable clock (matches the rest of the toolshed's clock-injection convention). Default Date.now. */
  now?: () => number;
  /** Injectable fs.watch, for tests that want to fake the filesystem layer entirely. Default node:fs's fs.watch. */
  watchFn?: typeof fs.watch;
  /** Injectable allowlist loader, for tests exercising the parse-failure path. Default `loadAllowlists` from config.ts. */
  loadAllowlistsFn?: typeof loadAllowlists;
  /** Injectable governance loader, for tests exercising the parse-failure path. Default `loadGovernance` from config.ts. */
  loadGovernanceFn?: typeof loadGovernance;
  /** Called after each reload attempt (accepted or rejected) — mainly a test hook. */
  onReload?: (result: { accepted: boolean; errors: string[] }) => void;
}

export interface WatchRulesHandle {
  /** Stops watching and clears any pending debounce timer. Idempotent. */
  close: () => void;
}

function emitReloadAudit(
  store: SessionStore,
  auditLogger: (entry: AuditEntry) => void | Promise<void>,
  now: () => number,
  accepted: boolean,
  detail: string
): void {
  // Config reloads are not a per-tool-call event — there is no minion,
  // team, server alias, or tool name to attribute this to. Following the
  // same convention as `auditRejectedIdentity` in toolshed.ts (a
  // synthetic audit entry for a non-tool-call exit path), the identity
  // fields are plain, honest placeholders rather than anything
  // caller-supplied — there is no caller here at all, only the watcher
  // itself reacting to a filesystem event.
  const entry: AuditEntry = {
    id: `audit_${randomUUID()}`,
    timestamp: now(),
    correlationId: `config_reload_${randomUUID()}`,
    minionType: 'system',
    teamId: 'system',
    serverAlias: 'toolshed',
    toolName: 'watch_rules',
    params: undefined,
    status: accepted ? 'config_reloaded' : 'config_reload_rejected',
    latencyMs: 0,
    // detail is operator-facing free text (validator error messages, a
    // caught exception's message) and could in principle echo back
    // something sensitive from a malformed YAML value — redact before
    // persisting, same as every other audited error string in the
    // toolshed (invariant 2).
    error: accepted ? undefined : redactSecrets(detail),
  };
  store.createAuditEntry(entry);
  const maybePromise = auditLogger(entry);
  if (maybePromise && typeof (maybePromise as Promise<void>).then === 'function') {
    (maybePromise as Promise<void>).catch((err) => {
      console.error('[toolshed] hot-reload audit logger rejected:', err);
    });
  }
}

/**
 * Watches the two rules files and reloads+validates+swaps on change. Enable
 * in production behind `TOOLSHED_WATCH_RULES=1` (wired in `server.ts`); the
 * function itself has no env-var gating so it stays trivially unit-testable
 * and so a caller (e.g. a future admin CLI) can opt in explicitly.
 */
export function watchRules(options: WatchRulesOptions): WatchRulesHandle {
  const debounceMs = options.debounceMs ?? 500;
  const now = options.now ?? Date.now;
  const watchFn = options.watchFn ?? fs.watch;
  const loadAllowlistsFn = options.loadAllowlistsFn ?? loadAllowlists;
  const loadGovernanceFn = options.loadGovernanceFn ?? loadGovernance;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function performReload(): void {
    timer = undefined;
    let nextAllowlists;
    let nextGovernance;
    try {
      nextAllowlists = loadAllowlistsFn(options.allowlistsPath);
      nextGovernance = loadGovernanceFn(options.governancePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[toolshed] hot-reload: failed to parse rules files, keeping old config: ${message}`);
      emitReloadAudit(options.store, options.auditLogger, now, false, message);
      options.onReload?.({ accepted: false, errors: [message] });
      return;
    }

    const { errors } = validateConfigAtRoot(options.repoRoot);
    if (errors.length > 0) {
      console.error(
        `[toolshed] hot-reload: rejected invalid config (${errors.length} error(s)), keeping old config:\n${errors.join('\n')}`
      );
      emitReloadAudit(options.store, options.auditLogger, now, false, errors.join('; '));
      options.onReload?.({ accepted: false, errors });
      return;
    }

    // Atomic swap: a single object assignment per field. Any in-flight
    // executeTool call already holds a reference to the OLD allowlists/
    // governance object (destructured or not) and finishes against it
    // consistently; the NEXT call reads the new reference. Never mutate
    // state.allowlists/state.governance in place.
    options.state.allowlists = nextAllowlists;
    options.state.governance = nextGovernance;

    console.log('[toolshed] hot-reload: applied new rules configuration');
    emitReloadAudit(options.store, options.auditLogger, now, true, '');
    options.onReload?.({ accepted: true, errors: [] });
  }

  function scheduleReload(): void {
    if (closed) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(performReload, debounceMs);
  }

  const watchedPaths = new Set([options.allowlistsPath, options.governancePath]);
  const watchers: fs.FSWatcher[] = [];
  for (const watchedPath of watchedPaths) {
    try {
      const watcher = watchFn(watchedPath, () => {
        scheduleReload();
      });
      watchers.push(watcher);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[toolshed] hot-reload: could not watch ${watchedPath}: ${message}`);
    }
  }

  return {
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const watcher of watchers) {
        watcher.close();
      }
    },
  };
}
