# ADR-019: Filesystem path scoping per minion

| Key | Value |
|---|---|
| **Status** | Accepted (implemented 2026-07-09 — see status note below) |
| **Date** | 2026-06-06 |
| **Deciders** | Goose Agent Framework team |
| **Replaces** | — |
| **Superseded by** | — |
| **Related** | ADR-005 (Tool allowlisting per minion) |

---

## Context

Minions explore codebases. A PR Crafter modifying the auth module should not read billing code. A Ticket Analyst investigating a payment incident should not browse HR configuration. The Filesystem MCP currently has global workspace boundaries — all minions that can read files can read all files within the workspace.

How do we scope a minion to only its relevant directories — without duplicating the workspace or creating per-minion filesystem sandboxes?

## Decision

**Extend the per-minion allowlist model (ADR-005) to include filesystem path scoping within the MCP Toolshed.**

Every minion's manifest gains an optional `path_scope`:

```yaml
minions:
  ticket-analyst:
    path_scope:
      mode: allowlist
      paths:
        - src/auth/           # Only sees auth module
        - docs/architecture/  # Can read architecture docs
        - config/             # Can read config
      # Denied: src/payments/, src/billing/, src/hr/, ...

  code-explorer:
    path_scope:
      mode: denylist
      paths:
        - .git/               # Never expose git internals
        - secrets/            # Never expose secrets
        - node_modules/       # Never traverse dependencies
      # All other paths allowed
```

### Modes

| Mode | Behavior |
|---|---|
| `allowlist` | Minion can only read files matching the listed paths. Everything else is denied. |
| `denylist` | Minion can read everything EXCEPT the listed paths. |
| `none` (default) | No path scoping. Minion inherits the global `workspace_boundaries`. |

### Enforcement

The `mcp-toolshed` extension intercepts every `read_file`, `list_directory`, and `search_files` call. Before passing the call to the Filesystem MCP server, it checks the path against the minion's `path_scope`. If denied, the call is blocked and logged as a security event — same as a tool allowlist violation.

### Combined with tool allowlists

A minion's effective access is the intersection of:
1. **Tool allowlist** — which tools it can call (`read_file` may be allowed)
2. **Path scope** — which paths it can access within those tools

```
Minion: Ticket Analyst
├── Tool allowlist: filesystem.read_file ✓
├── Path scope mode: allowlist
│   ├── src/auth/login.ts ✓
│   ├── src/payments/gateway.ts ✗ (blocked by path scope)
│   └── secret.env ✗ (blocked by path scope)
└── Result: reads only auth module files
```

## Rationale

- **Least privilege** — same principle as tool allowlisting, applied to the data layer. A minion investigating a login bug gains nothing from seeing billing code.
- **Accidental damage prevention** — a PR Crafter hallucinating a file path can't accidentally overwrite files outside its scope.
- **Compliance** — regulated codebases (PCI, HIPAA) can exclude sensitive modules from AI access entirely.
- **Performance** — scoped minions search less, iterate faster, and use fewer tokens.
- **Reuse of existing mechanism** — the toolshed already enforces allowlists. Path scoping is an additional check in the same codepath, not a new subsystem.

## Consequences

### Positive
- Defense-in-depth: tool + path restrictions
- Compliance-friendly (PCI zone excluded, auth zone included)
- Faster minion execution (less to search)

### Negative / Mitigations
- **Path scopes must be maintained** — Mitigation: Scopes are defined in the minion manifest alongside the tool allowlist. PR-reviewed, version-controlled.
- **Granularity trade-off** — Too narrow and minions can't follow cross-cutting concerns (e.g., a refactor touching 3 modules). Mitigation: The orchestrator can spawn multiple minions with different scopes for cross-cutting tasks.
- **Denylist mode has escape risk** — If a sensitive directory is added but not denylisted, it's exposed. Mitigation: Use `allowlist` mode for sensitive minions. Reserve `denylist` for broad explorers where the default posture is "see everything except these obvious exclusions."

---

## Status note (2026-07-09): implemented and hardened

Path scoping was implemented in the `mcp-toolshed` enforcement pipeline and hardened by the 2026-07-08 remediation ExecPlan (Milestone 5, security finding H1): `isPathAllowed` in `extensions/mcp-toolshed/src/config.ts` was rewritten around path normalization, workspace base-path boundary checks, per-minion allowlist scopes, and deny-glob patterns, with regression tests for traversal (`../`) and prefix-collision escapes. Path parameters are identified per tool via `governance.pathCheckedTools`. Symlink resolution is not performed at this layer (paths are checked lexically after normalization). Shell command governance (H2/F5) landed in the same milestone as the companion control. Status accordingly moves Proposed → Accepted.
