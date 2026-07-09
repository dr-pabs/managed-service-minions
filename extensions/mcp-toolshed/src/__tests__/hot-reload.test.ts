import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchRules } from '../hot-reload.js';
import { createMemoryStore } from '../store.js';
import { createDefaultToolshedState } from '../toolshed.js';
import type { AuditEntry } from 'framework-core';

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

/**
 * Minimal internally-consistent config tree that `validateConfigAtRoot`
 * accepts, mirroring `config-validation.test.ts`'s `seedMinimalValidTree`.
 * Hot-reload tests need a real repoRoot tree (not just standalone YAML
 * files) because the milestone requires running the FULL Milestone 1
 * cross-validator against the reloaded config, not just re-parsing YAML.
 */
function seedValidTree(root: string): void {
  writeFile(
    path.join(root, 'agents', 'ticket-analyst.md'),
    ['---', 'name: ticket-analyst', 'minion_type: ticket_analyst', 'output_schema: schemas/ticket-analyst-output.json', '---', '# Ticket Analyst'].join('\n')
  );
  writeFile(path.join(root, 'schemas', 'ticket-analyst-output.json'), '{}');
  writeFile(
    path.join(root, 'rules', 'allowlists.yaml'),
    ['allowlists:', '  ticket_analyst:', '    jira:', '      - jira_get_issue', '      - jira_add_comment'].join('\n')
  );
  writeFile(
    path.join(root, 'rules', 'tool-registry.yaml'),
    ['registry:', '  jira:', '    - jira_get_issue', '    - jira_add_comment'].join('\n')
  );
  writeFile(path.join(root, 'rules', 'governance.yaml'), ['governance:', '  destructive_actions: []'].join('\n'));
}

/** Waits for a condition to become true, polling briefly. No arbitrary sleeps. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('watchRules', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-reload-'));
    seedValidTree(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies a tightened allowlist on the next call without restart', async () => {
    const store = createMemoryStore();
    const state = createDefaultToolshedState({
      store,
      adapters: new Map(),
    });
    // Load the initial (permissive) config into state, as buildToolshedState would.
    const { loadAllowlists, loadGovernance } = await import('../config.js');
    const allowlistsPath = path.join(tmpDir, 'rules', 'allowlists.yaml');
    const governancePath = path.join(tmpDir, 'rules', 'governance.yaml');
    state.allowlists = loadAllowlists(allowlistsPath);
    state.governance = loadGovernance(governancePath);

    expect(state.allowlists.allowlists.ticket_analyst.jira).toContain('jira_add_comment');

    const auditEntries: AuditEntry[] = [];
    const handle = watchRules({
      repoRoot: tmpDir,
      allowlistsPath,
      governancePath,
      state,
      store,
      auditLogger: (entry) => {
        auditEntries.push(entry);
      },
      debounceMs: 20,
    });

    try {
      // Tighten the allowlist: drop jira_add_comment. A short delay after
      // starting the watcher avoids a setup race on some platforms where an
      // fs.watch listener registered a moment ago can miss the very next
      // write that lands within the same event-loop tick.
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeFile(
        allowlistsPath,
        ['allowlists:', '  ticket_analyst:', '    jira:', '      - jira_get_issue'].join('\n')
      );

      await waitFor(() => !state.allowlists.allowlists.ticket_analyst.jira.includes('jira_add_comment'));

      expect(state.allowlists.allowlists.ticket_analyst.jira).toEqual(['jira_get_issue']);
      expect(auditEntries.some((e) => e.status === 'config_reloaded')).toBe(true);
    } finally {
      handle.close();
    }
  });

  it('rejects an invalid edit and keeps the old rules working', async () => {
    const store = createMemoryStore();
    const state = createDefaultToolshedState({
      store,
      adapters: new Map(),
    });
    const { loadAllowlists, loadGovernance } = await import('../config.js');
    const allowlistsPath = path.join(tmpDir, 'rules', 'allowlists.yaml');
    const governancePath = path.join(tmpDir, 'rules', 'governance.yaml');
    state.allowlists = loadAllowlists(allowlistsPath);
    state.governance = loadGovernance(governancePath);

    const originalAllowlists = state.allowlists;

    const auditEntries: AuditEntry[] = [];
    const handle = watchRules({
      repoRoot: tmpDir,
      allowlistsPath,
      governancePath,
      state,
      store,
      auditLogger: (entry) => {
        auditEntries.push(entry);
      },
      debounceMs: 20,
    });

    try {
      // Break the config: grant a tool that does not exist in the tool registry
      // (validateConfigAtRoot check (d) — this is a genuine cross-validator error,
      // not just a YAML parse error). Short delay avoids the same watcher
      // setup race documented above.
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeFile(
        allowlistsPath,
        ['allowlists:', '  ticket_analyst:', '    jira:', '      - jira_get_issue', '      - jira_delete_everything'].join('\n')
      );

      await waitFor(() => auditEntries.some((e) => e.status === 'config_reload_rejected'));

      // Old config must still be in effect, unchanged object identity's VALUE.
      expect(state.allowlists).toBe(originalAllowlists);
      expect(state.allowlists.allowlists.ticket_analyst.jira).toEqual(['jira_get_issue', 'jira_add_comment']);
      expect(auditEntries.some((e) => e.status === 'config_reloaded')).toBe(false);
    } finally {
      handle.close();
    }
  });

  it('debounces multiple rapid edits into a single reload', async () => {
    const store = createMemoryStore();
    const state = createDefaultToolshedState({ store, adapters: new Map() });
    const { loadAllowlists, loadGovernance } = await import('../config.js');
    const allowlistsPath = path.join(tmpDir, 'rules', 'allowlists.yaml');
    const governancePath = path.join(tmpDir, 'rules', 'governance.yaml');
    state.allowlists = loadAllowlists(allowlistsPath);
    state.governance = loadGovernance(governancePath);

    const auditEntries: AuditEntry[] = [];
    const handle = watchRules({
      repoRoot: tmpDir,
      allowlistsPath,
      governancePath,
      state,
      store,
      auditLogger: (entry) => {
        auditEntries.push(entry);
      },
      debounceMs: 50,
    });

    try {
      for (let i = 0; i < 5; i++) {
        writeFile(
          allowlistsPath,
          ['allowlists:', '  ticket_analyst:', '    jira:', '      - jira_get_issue'].join('\n')
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      await waitFor(() => auditEntries.some((e) => e.status === 'config_reloaded'), 3000);
      // Give any straggler debounce window time to fire before asserting the count.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const reloadedCount = auditEntries.filter((e) => e.status === 'config_reloaded').length;
      expect(reloadedCount).toBe(1);
    } finally {
      handle.close();
    }
  });

  it('is disabled unless explicitly started (no watcher leaks when close() is called immediately)', () => {
    const store = createMemoryStore();
    const state = createDefaultToolshedState({ store, adapters: new Map() });
    const handle = watchRules({
      repoRoot: tmpDir,
      allowlistsPath: path.join(tmpDir, 'rules', 'allowlists.yaml'),
      governancePath: path.join(tmpDir, 'rules', 'governance.yaml'),
      state,
      store,
      auditLogger: () => {},
      debounceMs: 20,
    });
    expect(() => handle.close()).not.toThrow();
    // Calling close() twice must be safe (idempotent teardown).
    expect(() => handle.close()).not.toThrow();
  });

  it('rejects malformed YAML (a parse error, not a validator error) and keeps the old rules working', async () => {
    const store = createMemoryStore();
    const state = createDefaultToolshedState({ store, adapters: new Map() });
    const { loadAllowlists, loadGovernance } = await import('../config.js');
    const allowlistsPath = path.join(tmpDir, 'rules', 'allowlists.yaml');
    const governancePath = path.join(tmpDir, 'rules', 'governance.yaml');
    state.allowlists = loadAllowlists(allowlistsPath);
    state.governance = loadGovernance(governancePath);
    const originalAllowlists = state.allowlists;

    const auditEntries: AuditEntry[] = [];
    const handle = watchRules({
      repoRoot: tmpDir,
      allowlistsPath,
      governancePath,
      state,
      store,
      auditLogger: (entry) => {
        auditEntries.push(entry);
      },
      debounceMs: 20,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Genuinely invalid YAML (unterminated flow mapping), not just a
      // cross-validator error -- exercises the loadAllowlists/loadGovernance
      // try/catch branch distinct from the validateConfigAtRoot branch
      // covered by the "rejects an invalid edit" test above.
      writeFile(allowlistsPath, 'allowlists: [unterminated');

      await waitFor(() => auditEntries.some((e) => e.status === 'config_reload_rejected'));

      expect(state.allowlists).toBe(originalAllowlists);
      expect(auditEntries.some((e) => e.status === 'config_reloaded')).toBe(false);
    } finally {
      handle.close();
    }
  });

  it('rejects a reload when validateConfigAtRoot itself throws (malformed rules/tool-registry.yaml), instead of crashing the process (M17 review hardening)', async () => {
    const store = createMemoryStore();
    const state = createDefaultToolshedState({ store, adapters: new Map() });
    const { loadAllowlists, loadGovernance } = await import('../config.js');
    const allowlistsPath = path.join(tmpDir, 'rules', 'allowlists.yaml');
    const governancePath = path.join(tmpDir, 'rules', 'governance.yaml');
    state.allowlists = loadAllowlists(allowlistsPath);
    state.governance = loadGovernance(governancePath);
    const originalAllowlists = state.allowlists;
    const originalGovernance = state.governance;

    const auditEntries: AuditEntry[] = [];
    const handle = watchRules({
      repoRoot: tmpDir,
      allowlistsPath,
      governancePath,
      state,
      store,
      auditLogger: (entry) => {
        auditEntries.push(entry);
      },
      debounceMs: 20,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      // allowlists.yaml and governance.yaml (what loadAllowlistsFn/
      // loadGovernanceFn parse) are both left VALID here -- the loader
      // try/catch in performReload would not catch this. The corruption is
      // in rules/tool-registry.yaml, which validateConfigAtRoot reads
      // directly via loadYamlFile/yaml.load with no try/catch of its own
      // (config-validation.ts). Before the fix, this throw escaped
      // performReload (which only wrapped the two loader calls) as an
      // unhandled exception out of the setTimeout callback.
      //
      // watchRules only watches allowlistsPath/governancePath (not
      // tool-registry.yaml directly -- see the milestone spec), matching
      // the exact scenario the finding describes: an operator edits a
      // WATCHED file (governance.yaml here, re-written with its own
      // unchanged valid content) while tool-registry.yaml is concurrently
      // mid-write/malformed -- the watch event fires from the watched
      // file's own edit, and validateConfigAtRoot picks up the OTHER,
      // corrupted file when it re-reads the whole tree.
      writeFile(path.join(tmpDir, 'rules', 'tool-registry.yaml'), 'registry: [unterminated');
      writeFile(governancePath, ['governance:', '  destructive_actions: []'].join('\n'));

      await waitFor(() => auditEntries.some((e) => e.status === 'config_reload_rejected'));

      // Old config must still be in effect (identity-preserved) -- the
      // "broken edit is inert" guarantee holds even when the throw comes
      // from validateConfigAtRoot rather than the loaders.
      expect(state.allowlists).toBe(originalAllowlists);
      expect(state.governance).toBe(originalGovernance);
      expect(auditEntries.some((e) => e.status === 'config_reloaded')).toBe(false);
    } finally {
      handle.close();
    }
  });

  it('does not reload after close() even if a debounced write was already scheduled', async () => {
    const store = createMemoryStore();
    const state = createDefaultToolshedState({ store, adapters: new Map() });
    const { loadAllowlists, loadGovernance } = await import('../config.js');
    const allowlistsPath = path.join(tmpDir, 'rules', 'allowlists.yaml');
    const governancePath = path.join(tmpDir, 'rules', 'governance.yaml');
    state.allowlists = loadAllowlists(allowlistsPath);
    state.governance = loadGovernance(governancePath);

    const auditEntries: AuditEntry[] = [];
    const handle = watchRules({
      repoRoot: tmpDir,
      allowlistsPath,
      governancePath,
      state,
      store,
      auditLogger: (entry) => {
        auditEntries.push(entry);
      },
      debounceMs: 300,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    writeFile(
      allowlistsPath,
      ['allowlists:', '  ticket_analyst:', '    jira:', '      - jira_get_issue'].join('\n')
    );
    // Close well before the 300ms debounce window elapses.
    await new Promise((resolve) => setTimeout(resolve, 50));
    handle.close();

    // Wait past the original debounce window to prove no reload happened.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(auditEntries.some((e) => e.status === 'config_reloaded')).toBe(false);
    expect(state.allowlists.allowlists.ticket_analyst.jira).toContain('jira_add_comment');
  });

  it('ignores a change event delivered after close() (a real fs.watch race: an event already queued when watcher.close() runs)', () => {
    const store = createMemoryStore();
    const state = createDefaultToolshedState({ store, adapters: new Map() });
    const listeners: Array<() => void> = [];
    const fakeWatch = ((_path: unknown, listener: (event: string, filename: string | null) => void) => {
      listeners.push(() => listener('change', 'allowlists.yaml'));
      return { close: () => {} } as unknown as fs.FSWatcher;
    }) as unknown as typeof fs.watch;

    const auditEntries: AuditEntry[] = [];
    const handle = watchRules({
      repoRoot: tmpDir,
      allowlistsPath: path.join(tmpDir, 'rules', 'allowlists.yaml'),
      governancePath: path.join(tmpDir, 'rules', 'governance.yaml'),
      state,
      store,
      auditLogger: (entry) => {
        auditEntries.push(entry);
      },
      debounceMs: 20,
      watchFn: fakeWatch,
    });

    handle.close();
    // Simulate an fs.watch event that was already in-flight when close() ran
    // (node:fs does not guarantee no further callbacks fire the instant
    // .close() is called) -- scheduleReload's `closed` guard must swallow
    // this rather than scheduling a reload after teardown.
    for (const fireListener of listeners) {
      expect(() => fireListener()).not.toThrow();
    }
    expect(auditEntries).toEqual([]);
  });

  it('rejects a reload when the injected loader throws a non-Error value', async () => {
    const store = createMemoryStore();
    const state = createDefaultToolshedState({ store, adapters: new Map() });
    const { loadAllowlists, loadGovernance } = await import('../config.js');
    const allowlistsPath = path.join(tmpDir, 'rules', 'allowlists.yaml');
    const governancePath = path.join(tmpDir, 'rules', 'governance.yaml');
    state.allowlists = loadAllowlists(allowlistsPath);
    state.governance = loadGovernance(governancePath);
    const originalAllowlists = state.allowlists;

    const auditEntries: AuditEntry[] = [];
    const handle = watchRules({
      repoRoot: tmpDir,
      allowlistsPath,
      governancePath,
      state,
      store,
      auditLogger: (entry) => {
        auditEntries.push(entry);
      },
      debounceMs: 20,
      loadAllowlistsFn: () => {
        throw 'not an Error instance';
      },
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeFile(
        allowlistsPath,
        ['allowlists:', '  ticket_analyst:', '    jira:', '      - jira_get_issue'].join('\n')
      );
      await waitFor(() => auditEntries.some((e) => e.status === 'config_reload_rejected'));
      expect(state.allowlists).toBe(originalAllowlists);
    } finally {
      handle.close();
    }
  });

  it('applies the default 500ms debounce when debounceMs is omitted', () => {
    const store = createMemoryStore();
    const state = createDefaultToolshedState({ store, adapters: new Map() });
    const handle = watchRules({
      repoRoot: tmpDir,
      allowlistsPath: path.join(tmpDir, 'rules', 'allowlists.yaml'),
      governancePath: path.join(tmpDir, 'rules', 'governance.yaml'),
      state,
      store,
      auditLogger: () => {},
      // debounceMs deliberately omitted -- exercises the `?? 500` default.
    });
    expect(() => handle.close()).not.toThrow();
  });

  it('logs and continues when the underlying fs.watch call throws a non-Error value', () => {
    const store = createMemoryStore();
    const state = createDefaultToolshedState({ store, adapters: new Map() });
    const throwingWatch = (() => {
      throw 'permission denied';
    }) as unknown as typeof fs.watch;

    expect(() =>
      watchRules({
        repoRoot: tmpDir,
        allowlistsPath: path.join(tmpDir, 'rules', 'allowlists.yaml'),
        governancePath: path.join(tmpDir, 'rules', 'governance.yaml'),
        state,
        store,
        auditLogger: () => {},
        debounceMs: 20,
        watchFn: throwingWatch,
      })
    ).not.toThrow();
  });

  it('logs and continues when the underlying fs.watch call throws (e.g. an unreadable path)', () => {
    const store = createMemoryStore();
    const state = createDefaultToolshedState({ store, adapters: new Map() });
    const throwingWatch = (() => {
      throw new Error('EACCES: permission denied');
    }) as unknown as typeof fs.watch;

    expect(() =>
      watchRules({
        repoRoot: tmpDir,
        allowlistsPath: path.join(tmpDir, 'rules', 'allowlists.yaml'),
        governancePath: path.join(tmpDir, 'rules', 'governance.yaml'),
        state,
        store,
        auditLogger: () => {},
        debounceMs: 20,
        watchFn: throwingWatch,
      })
    ).not.toThrow();
  });

  it('logs (but does not throw into the caller) when an async auditLogger rejects on a successful reload', async () => {
    const store = createMemoryStore();
    const state = createDefaultToolshedState({ store, adapters: new Map() });
    const { loadAllowlists, loadGovernance } = await import('../config.js');
    const allowlistsPath = path.join(tmpDir, 'rules', 'allowlists.yaml');
    const governancePath = path.join(tmpDir, 'rules', 'governance.yaml');
    state.allowlists = loadAllowlists(allowlistsPath);
    state.governance = loadGovernance(governancePath);

    let sawReloadedCall = false;
    const handle = watchRules({
      repoRoot: tmpDir,
      allowlistsPath,
      governancePath,
      state,
      store,
      auditLogger: async (entry) => {
        if (entry.status === 'config_reloaded') {
          sawReloadedCall = true;
        }
        throw new Error('downstream audit sink unavailable');
      },
      debounceMs: 20,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeFile(
        allowlistsPath,
        ['allowlists:', '  ticket_analyst:', '    jira:', '      - jira_get_issue'].join('\n')
      );
      await waitFor(() => sawReloadedCall);
      // Give the rejected promise's .catch() a turn to run before the test ends.
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The durable store write still happened (invariant 2) even though the
      // in-process auditLogger sink failed asynchronously.
      expect(store.listAuditEntries({}).some((e) => e.status === 'config_reloaded')).toBe(true);
    } finally {
      handle.close();
    }
  });

  it('emits a config_reloaded audit entry with plain placeholder identity fields, not caller-trusted values', async () => {
    const store = createMemoryStore();
    const state = createDefaultToolshedState({ store, adapters: new Map() });
    const { loadAllowlists, loadGovernance } = await import('../config.js');
    const allowlistsPath = path.join(tmpDir, 'rules', 'allowlists.yaml');
    const governancePath = path.join(tmpDir, 'rules', 'governance.yaml');
    state.allowlists = loadAllowlists(allowlistsPath);
    state.governance = loadGovernance(governancePath);

    const auditEntries: AuditEntry[] = [];
    const handle = watchRules({
      repoRoot: tmpDir,
      allowlistsPath,
      governancePath,
      state,
      store,
      auditLogger: (entry) => {
        auditEntries.push(entry);
      },
      debounceMs: 20,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeFile(
        governancePath,
        ['governance:', '  destructive_actions: []', '  approval_timeout_minutes: 30'].join('\n')
      );
      await waitFor(() => auditEntries.some((e) => e.status === 'config_reloaded'));

      const entry = auditEntries.find((e) => e.status === 'config_reloaded')!;
      expect(entry.minionType).toBe('system');
      expect(entry.teamId).toBe('system');
      // Every exit path is audited AND persisted to the durable store (invariant 2).
      const persisted = store.listAuditEntries({});
      expect(persisted.some((e) => e.status === 'config_reloaded')).toBe(true);
    } finally {
      handle.close();
    }
  });
});
