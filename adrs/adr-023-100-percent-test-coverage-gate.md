# ADR-023: 100% Test Coverage Gate for Runnable Code

> **Status:** Accepted  
> **Date:** 2026-06-14  
> **Author:** Kimi Code CLI  
> **Supersedes / Amends:** `../docs/testing-strategy.md`, `../docs/delivery-specification.md`, `AGENTS.md`

## Context

The Goose Agent Framework is a multi-agent system that orchestrates engineering operations across chat platforms, source control, and ticket systems. Mistakes in the orchestrator, toolshed, or chat adapters can have outsized impact: a missed allowlist check could let a minion delete infrastructure, a circuit-breaker bug could silently block all ticket lookups, or a malformed error response could leave a destructive action unreviewed.

We already have a layered testing strategy (`../docs/testing-strategy.md`) and a human-in-the-loop governance model. However, as the codebase grows from documentation into runnable TypeScript packages and MCP extensions, we need a clear, non-negotiable signal that every line of runnable code is exercised by automated tests before it reaches production.

## Decision

We will enforce **100% line, branch, function, and statement coverage** for all runnable TypeScript code in `packages/` and `extensions/`.

### Scope

| In Scope | Out of Scope |
|---|---|
| `packages/framework-core/src/**/*.ts` | Markdown/JSON plugin content (`agents/`, `skills/`, `commands/`, `rules/`) |
| `extensions/mcp-toolshed/src/**/*.ts` | Generated or vendored third-party code |
| `extensions/slack-bot/src/**/*.ts` | Platform-specific shims with documented exemption |
| `extensions/teams-bot/src/**/*.ts` | `infra/` Bicep templates |
| `extensions/agent-dashboard/src/**/*.ts` | `test/` harness scaffolding (covered by its own policy) |

### Enforcement

1. Each package's `jest.config.js` sets `coverageThreshold: { global: { branches: 100, functions: 100, lines: 100, statements: 100 } }`.
2. `pnpm test --coverage` runs in CI and fails if any package drops below 100%.
3. Exemptions are allowed only for generated code, third-party vendored code, or platform-specific shims. Each exemption must be explicitly excluded in the package's Jest config and include a written rationale in the PR.
4. New code cannot be merged unless it maintains or improves the 100% coverage level.

## Consequences

### Positive

- Every path through the toolshed (allowlists, rate limits, circuit breakers, audit logging) is exercised.
- Regressions in error handling and edge cases are caught immediately.
- Refactors of shared core code are safer because tests must cover all branches.
- Sets a clear cultural expectation: untested code is not shipped.

### Negative

- Initial development will be slower as tests are written alongside code.
- Developers may be tempted to write low-value tests just to hit coverage. We mitigate this by requiring meaningful assertions and by reviewing tests in PRs.
- Exemption requests add process overhead. We mitigate by keeping the exemption criteria narrow.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| 80% coverage threshold | Leaves critical error paths untested in security-sensitive code. |
| Coverage only for critical packages | Creates ambiguity about what is "critical" and weakens the gate over time. |
| No coverage gate, rely on integration tests alone | Integration tests are slower and may not exercise every failure branch. |

## Related Decisions

- ADR-005: Tool allowlisting per minion
- ADR-007: Human-in-the-loop for destructive operations
- `../docs/testing-strategy.md`
- `../docs/delivery-specification.md` §9

---

## Amendment (2026-07-09): lower `branches`/`lines` thresholds to 95%; CI gate made honest

**Author:** platform-engineer (Milestone 18, Minions remediation ExecPlan, hygiene sweep)

**Status of this amendment:** Accepted. This section is appended, not a rewrite — the original Decision, Context, and Consequences above remain the historical record of what was decided on 2026-06-14 and why.

### What changed

1. Every package's `jest.config.js` `coverageThreshold.global` changed from `{ branches: 100, functions: 100, lines: 100, statements: 100 }` to `{ branches: 95, functions: 100, lines: 95, statements: 100 }`. `functions` and `statements` remain at 100%; only `branches` and `lines` were relaxed.
2. `.github/workflows/ci.yml`'s coverage step, previously named "Verify 100% coverage" and consisting only of `echo "Coverage gate enforced by Jest thresholds."` (a no-op that could never fail the build regardless of actual coverage), was replaced with a step whose `run:` is the actual `pnpm -r --filter "!infra" test` invocation — the same command that runs each package's `test` script, which itself invokes `jest --coverage`. The step now fails (non-zero exit, `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`) if any package's coverage drops below its configured threshold, because that is what running jest with a `coverageThreshold` actually does — there is no longer a separate, disconnected "verification" step that could pass regardless of the real numbers.
3. `test/jest.config.js` (the `test/` harness package, covering `src/prompt-quality/**/*.ts`) already declared a `coverageThreshold`, but `test/package.json`'s `test` script ran plain `jest` without `--coverage` — meaning that package's threshold was declared but never actually evaluated by `pnpm test`. Fixed to `jest --coverage`, so it now gates like every other package.
4. Deleted zero test files in this pass. Every `*.test.ts` file in the repository was inspected (see the ExecPlan's Milestone 18 Decision Log entry for the full list and method) and every one exercises real behavior — env-var validation, error formatting, exit-code handling, mocked bootstrap sequencing — not bare re-export assertions. The one place a pure re-export module exists (`packages/framework-core/src/index.ts`, `extensions/orchestrator/src/index.ts` — both `export * from './x.js'` barrels) has no dedicated test file at all, so there was no padding test to remove there either. The "padding-test problem" this amendment's title refers to is described below as the reason for the threshold change, not evidence that padding tests were found and deleted in this repo today.

### The padding-test problem

The original ADR's own "Negative" consequences section already named the risk: *"Developers may be tempted to write low-value tests just to hit coverage."* At 100% branches, this is not merely a temptation but frequently a structural necessity. A 100%-branches requirement demands a test for every conditional path, including defensive branches that guard against conditions the surrounding code has already made impossible by construction (a `try/catch` around a call that a library's documented behavior guarantees never throws — see the ExecPlan's Milestone 15 Decision Log entry on `verifyAdoBasicAuth`'s originally-unreachable base64-decode `catch`, which was ultimately deleted as dead code rather than tested, but only after being caught and reasoned through explicitly), or the final `else` of an exhaustive discriminated union already fully checked by the type system. Reaching literally 100% of branches across an entire codebase this size, indefinitely, as new conditional logic is added, creates sustained pressure to write a test whose only purpose is incrementing a denominator — the "low-value test" the original ADR already flagged as a risk to mitigate "by requiring meaningful assertions and reviewing tests in PRs," a process control that does not scale as well as a config number does.

95% branches/lines keeps the gate strict — a single untested new branch in a small file can still fail the build, and every package in this repository is at 100% today, so 95% is headroom, not a lowered bar being immediately exploited — while giving an author room to leave one genuinely-defensive, hard-to-provoke branch untested with a comment explaining why, rather than manufacturing a test whose assertion is `expect(true).toBe(true)` dressed up in enough setup to look meaningful. `functions` and `statements` stay at 100% because those are rarely the source of unreachable-branch pressure (a function either is or isn't called at all by some test; a statement either executes or the whole test suite around it is incomplete) — the padding-test problem specifically concentrates in `branches` (conditional paths) and, more mildly, `lines` (which branches partially double-count).

### Rejected alternatives (amendment-scoped)

| Alternative | Why rejected |
|---|---|
| Keep 100% and rely on documented per-line coverage-ignore comments (e.g. Istanbul's `/* istanbul ignore next */`) for genuinely unreachable branches | Considered, but this just relocates the same judgment call into scattered inline comments with no single place to review the accumulated list, and is easier to reach for reflexively than a package-wide threshold number is — the same "temptation" risk the original ADR named, just moved rather than reduced. A 95% budget is coarser but keeps the exception visible at the config level, matching this ADR's own existing "Exemptions... must be explicitly excluded... and include a written rationale" enforcement philosophy for `collectCoverageFrom` exclusions. |
| Lower `functions`/`statements` too, to a uniform 95% | Rejected — every package in the repo is at 100% on both today with no padding-test pressure observed on those two metrics specifically (see rationale above), so relaxing them would trade away a real, cheaply-maintained guarantee for no corresponding benefit. |
| Drop the coverage gate to a much lower number (e.g. 80%, the alternative the original ADR already rejected) | Still rejected for the same reason the original ADR gave: this is security-sensitive governance code (allowlists, rate limits, circuit breakers, audit logging) where untested error paths are exactly the failure mode this gate exists to catch. 95% is a targeted relief for the specific `branches`/`lines` padding-test pressure, not a general loosening. |

### Trigger for revisiting this amendment

If a future package's `branches` or `lines` coverage genuinely needs to drop below 95% to avoid padding tests, that is a signal the 95% figure itself needs re-examination (or that specific file needs a scoped `collectCoverageFrom` exclusion per the original ADR's exemption process) — not a signal to raise the threshold back to 100% without addressing the underlying pressure this amendment describes.
