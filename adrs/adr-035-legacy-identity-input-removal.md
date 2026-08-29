# ADR-035: Remove the Legacy Self-Reported Identity Input Fields

## Status

Accepted

## Date

2026-08-29

## Context

`MinionIdentityInput` carried three legacy fields — `legacyMinionType`,
`legacyTeamId`, `legacySessionId` — honored only on the unsigned dev path
(`TOOLSHED_ALLOW_UNSIGNED=1` with no `minionToken`). They survived the M13
rename to the native `identity/v1` claim set and the M21 removal of the
verify-both name-mapping shim as the last remaining way for a caller to
*self-report* an identity: exactly the trust posture `identity/v1` closed
("identity is asserted cryptographically, never self-reported"). Keeping
them meant an audit surface where `minionType`/`teamId` could be
attacker-chosen strings on the dev path, and a standing temptation to
re-widen the trusted fields.

## Decision

The fields are deleted from the type. The unsigned dev path resolves every
caller to one fixed principal — `dev-unsigned` on team `dev` — so local
development needs no token without anyone self-reporting anything: rate
limits, cache keys, approval session ids, and audit rows all key on that
principal, and a stray `legacy*` property smuggled into the JSON buys
nothing. `server.ts` logs a one-time warning when the hatch is enabled,
naming the shared principal. A compile-level pin in
`src/__tests__/legacy-identity-removal.test.ts` (`@ts-expect-error` on a
reference to the removed field) keeps the removal from silently regressing.

## Consequences

- Typed callers cannot compile a reference to self-reported identity; the
  MCP JSON surface ignores extra properties (verified by test).
- Dev environments that relied on `minion_type`/`team_id` params for
  allowlist selection must now allowlist the `dev-unsigned` principal (or,
  better, mint real tokens — the framework does this natively since M13).
- The C2-class concern (caller-chosen team/agent on any path) is closed at
  the type level, not merely by runtime ignores.
