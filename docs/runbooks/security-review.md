# Security Review Runbook

> **Scope:** Preparation, checklist, and findings template for the Minions Agent Framework v1 security review.  
> **Audience:** Security reviewer and engineering lead.

---

## Context

The framework delegates user requests to sub-agents ("minions") that invoke tools through a governed MCP toolshed. Security controls are defined in ADR-005 (tool allowlisting per minion) and ADR-007 (human-in-the-loop for destructive operations).

---

## Review checklist

### Identity & secrets

- [ ] No secrets, tokens, or private endpoints are committed to the repository.
- [ ] Key Vault is the only secret store; containers use managed identity (`DefaultAzureCredential`).
- [ ] CI/CD uses OIDC federation to Azure, not long-lived service principals.
- [ ] Container images run as non-root user.

### Tool governance

- [ ] `rules/allowlists.yaml` is the source of truth for which tools each minion can call.
- [ ] Allowlist tests pass and block disallowed tools (`pnpm --filter mcp-toolshed test`).
- [ ] `rules/governance.yaml` flags destructive tools and requires human approval.
- [ ] Path scoping prevents minions from reading arbitrary filesystem paths outside `/repo`.

### Network & data

- [ ] Container Apps ingress is restricted to required sources (Slack/Teams IPs, internal VNet).
- [ ] Service Bus uses private endpoints or trusted-service filtering in production.
- [ ] SQLite data is backed up to Blob Storage with encryption at rest.
- [ ] Table Storage audit log has a TTL or retention policy aligned with compliance needs.

### Human oversight

- [ ] Destructive actions pause for approval before execution.
- [ ] Approval requests time out and deny by default.
- [ ] Denied/timeout actions are logged and surfaced in the dashboard.

### Supply chain

- [ ] Dependency audit job runs in CI (`pnpm audit` or equivalent).
- [ ] Container base image is pinned to a digest, not a floating tag.
- [ ] No unnecessary packages or dev tools in production images.

---

## Evidence collection

Attach the following artifacts to the review record:

1. Latest CI run showing 100% coverage and passing tests.
2. `terraform plan` output for the production environment.
3. Screenshot of Key Vault access policy (managed identity only).
4. Output of `pnpm audit --prod`.
5. Container image SBOM or `docker inspect` of the production image.
6. List of approved vs. blocked tools from the toolshed config.

---

## Findings template

| ID | Severity | Finding | Recommendation | Owner | Status |
|---|---|---|---|---|---|
| SEC-001 | Low/ Medium/ High/ Critical | | | | Open / Mitigated / Accepted |

---

## Sign-off

| Reviewer | Date | Outcome |
|---|---|---|
| | | Approved / Approved with findings / Blocked |

---

## References

- ADR-005: Tool allowlisting per minion
- ADR-007: Human-in-the-loop for destructive operations
- `rules/allowlists.yaml`
- `rules/governance.yaml`
