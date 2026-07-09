# ADR-024: Red Build Policy — The "Ralph Wiggum" Loop

> **Status:** Accepted  
> **Date:** 2026-06-14  
> **Author:** Kimi Code CLI  
> **Relates to:** ADR-023, `../docs/testing-strategy.md`, `docs/execplan/execution-plan.md`, `.github/workflows/ci.yml`

## Context

The framework's quality gates — unit tests, integration tests, lint, type checks, and 100% coverage — are only effective if they are respected. A culture that tolerates failing CI checks, temporary threshold reductions, or "merge anyway" overrides will quickly erode the safety guarantees the framework is built on.

We need a simple, visible, and non-bypassable policy for failing builds.

## Decision

We adopt a **red build policy** we call the **"Ralph Wiggum" loop**.

> "I'm in danger." — Ralph Wiggum

A red build means the codebase is in danger. The loop continues — notifications, fixes, re-runs, QA review — until the build is green and the fix is approved.

### Policy Rules

1. **CI red = merge blocked.** Any failing required check in a PR prevents merge.
2. **Fix the root cause.** The author must fix the underlying issue. Disabling tests, lowering thresholds, or skipping checks without a written exemption is prohibited.
3. **Re-run the full pipeline.** After a fix, the entire CI workflow must pass, not just the previously failed job.
4. **QA/maintainer approval required.** A maintainer or designated QA reviewer must approve the fix. Self-approval after a red build is insufficient.
5. **Failures are broadcast.** The CI workflow posts failure notifications to the team Slack channel with branch, commit SHA, failing job, and correlation context.

### Enforcement in GitHub

- Required status checks protect `main`.
- `.github/workflows/ci.yml` runs build, lint, tests, and coverage gates.
- A commented-out Slack notification step is included for teams that configure `SLACK_WEBHOOK_URL`.

## Consequences

### Positive

- Creates a strong cultural signal: quality gates are real.
- Prevents broken code from reaching `main`.
- Encourages small, incremental changes that are easier to keep green.
- Makes failures visible to the whole team, not just the author.

### Negative

- Can feel heavy-handed for trivial fixes. We mitigate by keeping the policy simple and the feedback fast.
- Requires branch protection and maintainer discipline. We mitigate by documenting the policy in ADRs, AGENTS.md, and CI comments.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Allow merge with one failing check | Erodes the value of the failing gate over time. |
| Only require tests, not lint/type-check | Type and style errors can hide real bugs. |
| Silent failures / no notifications | Authors forget to follow up; failures linger. |

## References

- `../docs/testing-strategy.md` §Red Build Policy
- `AGENTS.md` §Build, test, and validation guidance
- `docs/execplan/execution-plan.md` §Validation and Acceptance

---

## Amendment note (2026-07-09): coverage thresholds referenced above

The Context above lists "100% coverage" among the quality gates. As of the ADR-023 amendment of 2026-07-09, the enforced thresholds are 95% branches/lines and 100% functions/statements; see ADR-023's amendment section for the rationale. That amendment is the "written exemption" Policy Rule 2 requires — the red build policy itself is unchanged, and whatever thresholds ADR-023 currently defines are the ones this policy enforces.
