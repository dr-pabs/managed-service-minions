# Thermo-Nuclear Review — `feat/gap-10-code-writer-test-writer`

**Branch:** `feat/gap-10-code-writer-test-writer` → `main`
**Reviewed:** 2026-06-30
**Scope:** 9 files, 284 insertions, 1 deletion
**Passes:** Security & Correctness · Code Quality

---

## Verdict

The implementation is clean, well-structured, and consistent with established patterns in the codebase. No critical bugs or breaking changes. **One high-priority design finding** (path-scope/intent mismatch for `test_writer`), one medium (unconstrained shell access), and several low/informational findings. No approval blockers on the dashboard code or schemas; the agent config files warrant a decision on the design tradeoff.

---

## Security & Correctness

### HIGH — `test_writer` path scope grants full `/repo` write access, but the agent is only supposed to write to test directories

**Files:** [`rules/allowlists.yaml:110–118`](rules/allowlists.yaml), [`agents/test-writer.md:36`](agents/test-writer.md)

`allowlists.yaml` gives `test_writer` the same filesystem write scope as `code_writer`:

```yaml
test_writer:
  mode: allowlist
  paths:
    - /repo
  deny:
    - .git/
    - node_modules/
    - secrets/
    - .env*
```

The agent prompt says:

> I **never** modify files outside test directories — no changes to `src/`, `lib/`, `app/`, production config, or Terraform.

That constraint is **prompt-only**. Nothing in the rules config enforces it. A model hallucination, prompt injection through test fixture content, or adversarial task description could cause `test_writer` to overwrite `src/` files. The defense-in-depth principle says enforcement should not rely on the model obeying instructions.

**Recommended fix:** Restrict the `test_writer` path_scope to known test directories:

```yaml
test_writer:
  mode: allowlist
  paths:
    - /repo/test
    - /repo/__tests__
    - /repo/e2e
    - /repo/integration
    - /repo/spec
  deny:
    - .git/
    - node_modules/
    - secrets/
    - .env*
```

If the project has non-standard test directories, enumerate them. The principle is: grant only the write surface actually needed. `code_writer` legitimately needs full `/repo` write access; `test_writer` does not.

---

### MEDIUM — `shell.execute` has no command-level restriction for either new agent

**Files:** [`rules/allowlists.yaml:52–54`](rules/allowlists.yaml), [`rules/allowlists.yaml:60–62`](rules/allowlists.yaml)

Both `code_writer` and `test_writer` allowlists grant:

```yaml
shell:
  - execute
```

The only restriction on *which* commands can be run is in the agent prompts ("Do not run `shell.execute` with commands that push, deploy, or modify infrastructure"). There is no command-pattern allowlist at the rules layer. Prompt injection via a crafted ticket/PR description could cause the agent to run arbitrary shell commands within the `/repo` sandbox — e.g., `git push --force`, `curl <url> | sh`, or `rm -rf`.

This is **medium** (not high) because:
- The agents run in an isolated `/repo` environment, not on shared infrastructure.
- Running tests inherently requires shell access; there is no zero-risk alternative.
- The path_scopes provide some filesystem-level protection.

**Recommended:** If the shell MCP server supports a command-pattern allowlist, add one restricting to test runner invocations (e.g. `npm test`, `pnpm test`, `cargo test`). If not, document this as an accepted risk in the ADR or agent descriptions so future reviewers understand the boundary.

---

### LOW — `agentTypes` array is captured by reference, not by value

**File:** [`extensions/agent-dashboard/src/dashboard.ts:296`](extensions/agent-dashboard/src/dashboard.ts)

```typescript
handler: async (_req, res) => {
  jsonResponse(res, 200, { agentTypes });  // closure over the original array
},
```

If the caller mutates the `agentTypes` array after passing it to `startDashboardServer`, the `/api/config` endpoint silently reflects those mutations. In current usage this is benign (a constant literal is passed), but it is a latent correctness hazard. Defensive copy at construction time eliminates the risk:

```typescript
agentTypes: string[] = []
// …
const frozenAgentTypes = Object.freeze([...agentTypes]);
// use frozenAgentTypes in the closure
```

---

### LOW — `/api/config` exposes internal agent configuration

**File:** [`extensions/agent-dashboard/src/dashboard.ts:293–298`](extensions/agent-dashboard/src/dashboard.ts)

The endpoint returns the list of configured agent types to any client that can reach the dashboard. The dashboard is presumably internal/operator-facing (no auth visible in the diff), so this is low risk. Worth confirming the dashboard does not surface to untrusted networks before the agent list grows sensitive.

---

### INFORMATIONAL — No breaking changes

- `startDashboardServer` gains an optional `agentTypes: string[] = []` parameter — fully backward-compatible.
- All existing routes are unchanged.
- No environment variables renamed, no port remapping, no new required config.
- No feature-gate leaks found.

---

## Code Quality

### MEDIUM — `test_writer` path_scope is structurally identical to `code_writer` (and every other agent)

**File:** [`rules/allowlists.yaml:101–118`](rules/allowlists.yaml)

Six agents now have exactly the same `path_scopes` block copy-pasted. YAML anchors/aliases would eliminate this, and the remediation above (restricting `test_writer` to test dirs) would also differentiate the blocks meaningfully. If the framework allows a `default_path_scope` key with per-agent overrides, that would be worth adding as the agent count grows.

This is a maintenance smell today; it will become a correctness risk when someone updates one block but forgets to update the others.

---

### MEDIUM — Output schemas are permissive (`additionalProperties` not constrained)

**Files:** [`schemas/code-writer-output.json`](schemas/code-writer-output.json), [`schemas/test-writer-output.json`](schemas/test-writer-output.json)

Neither schema includes `"additionalProperties": false`. This means validators will accept any extra fields silently, making it easy for schema drift to go undetected. If the framework uses these schemas for strict validation of agent output, add the constraint:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "properties": { … },
  "required": [ … ]
}
```

If the framework only uses the schemas for documentation, this is informational.

---

### LOW — `output_schema` field in frontmatter has no verified runtime enforcement

**Files:** [`agents/code-writer.md:8`](agents/code-writer.md), [`agents/test-writer.md:8`](agents/test-writer.md)

The frontmatter declares:

```yaml
output_schema: schemas/code-writer-output.json
```

The diff shows no code that reads `output_schema` and validates agent responses against it. If the framework ignores this field, the schemas are aspirational documentation only. This is worth confirming — if validation is absent, the `tests_passed: false` path and missing-field cases are untested contract obligations.

---

### LOW — Agent `allowed_extensions` frontmatter vs. `allowlists.yaml` use different naming conventions

**Files:** [`agents/code-writer.md:9`](agents/code-writer.md), [`rules/allowlists.yaml:45`](rules/allowlists.yaml)

Frontmatter uses extension names (`developer`, `analyze`, `mcp-toolshed`); the allowlist uses server aliases (`github`, `azure_devops`, `shell`). These are different axes of the same config, but a reader arriving at either file cannot easily cross-reference the other without knowing the mapping. A comment in `allowlists.yaml` or a note in the agent prompt clarifying "shell = the `shell` server alias within mcp-toolshed" would reduce future confusion.

---

### INFORMATIONAL — Dashboard route is a clean, direct extension

The `/api/config` route (`dashboard.ts:292–298`) follows exactly the same pattern as every other route in the file. No new abstractions, no spaghetti. The handler is as minimal as it can be. No code-judo opportunities — this is already the simplest possible form.

---

### INFORMATIONAL — Both agent files are well-structured

`code-writer.md` and `test-writer.md` establish clear identities, explicit `## What I do` / `## What I don't do` sections, a concrete tool-run protocol with retry caps, and a token-budget hint. The separation of concerns (unit tests → code-writer; integration/acceptance/E2E → test-writer) is stated unambiguously and correctly reflected in both files. No structural or legibility concerns.

---

## Summary Table

| # | Severity | Area | Finding |
|---|----------|------|---------|
| 1 | **HIGH** | Security | `test_writer` path scope grants full `/repo` write; prompt-only enforcement of test-dir restriction |
| 2 | **MEDIUM** | Security | `shell.execute` unconstrained at rules layer; command restriction is prompt-only |
| 3 | **MEDIUM** | Quality | `path_scopes` YAML block copy-pasted across 6 agents; will diverge under maintenance |
| 4 | **MEDIUM** | Quality | Output schemas missing `additionalProperties: false` |
| 5 | **LOW** | Correctness | `agentTypes` array captured by reference, not defensively copied |
| 6 | **LOW** | Security | `/api/config` exposes agent list; confirm dashboard is not internet-reachable |
| 7 | **LOW** | Quality | `output_schema` frontmatter field has no verified runtime enforcement |
| 8 | **LOW** | Quality | `allowed_extensions` vs. `allowlists.yaml` use different naming axes with no cross-reference |
| 9 | INFO | — | No breaking changes; dashboard route is clean; agent files are well-structured |

---

## Approval Recommendation

**Conditional approval.** The dashboard code and schemas are ship-ready. The agent definitions are well-written. Before merging, decide on finding #1: either restrict the `test_writer` path_scope to test directories (the safer default) or document the accepted risk explicitly. Finding #2 (shell access) is architecturally inherent but should be noted in the relevant ADR or agent description.
