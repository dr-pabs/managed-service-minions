# Production Handoff Runbook

> **Scope:** Pre-launch checklist, sign-off, and post-launch support model for Minions Agent Framework v1.  
> **Audience:** Engineering lead, platform operator, security reviewer, and product owner.

---

## Pre-launch checklist

### Security & governance

| # | Item | Evidence | Owner | Date | Status |
|---|---|---|---|---|---|
| 1 | Allowlists reviewed and aligned with real MCP tool names | `rules/allowlists.yaml` matches `extensions/mcp-*/src/server.ts` tool names | | | ☐ |
| 2 | Destructive-action governance configured | `rules/governance.yaml` lists destructive tools and required approvals | | | ☐ |
| 3 | Secrets stored in Key Vault; no secrets in repo or container env | `infra/terraform/modules/key_vault` + `.github/workflows/ci.yml` uses OIDC | | | ☐ |
| 4 | Human approval gate tested for destructive actions | `extensions/mcp-toolshed/src/__tests__/toolshed.test.ts` approval tests pass | | | ☐ |
| 5 | Security review completed | `docs/runbooks/security-review.md` signed off | | | ☐ |

### Infrastructure & quotas

| # | Item | Evidence | Owner | Date | Status |
|---|---|---|---|---|---|
| 6 | Azure quotas sufficient (Container Apps, Service Bus, AI Foundry tokens) | Quota request tickets linked | | | ☐ |
| 7 | Terraform applied to production; `terraform test` passes | `infra/terraform/tests/main.tftest.hcl` | | | ☐ |
| 8 | Container images pushed to ACR and smoke-tested | `.github/workflows/container-build.yml` | | | ☐ |
| 9 | Log Analytics workspace and Grafana dashboards provisioned | `infra/terraform/modules/observability` | | | ☐ |
| 10 | SQLite backups scheduled and tested | `docs/runbooks/disaster-recovery.md` restore steps | | | ☐ |

### Observability & alerting

| # | Item | Evidence | Owner | Date | Status |
|---|---|---|---|---|---|
| 11 | Alerts configured for: orchestrator crash, DLQ depth > 10, tool-call failure rate > 5%, pending approvals > 30 min | Alert rules in observability module | | | ☐ |
| 12 | Dashboard accessible and healthy | `extensions/agent-dashboard` `/health` returns 200 | | | ☐ |
| 13 | Runbooks linked in incident response tooling | This directory (`docs/runbooks/`) referenced | | | ☐ |

### Bots & ingress

| # | Item | Evidence | Owner | Date | Status |
|---|---|---|---|---|---|
| 14 | Slack app installed and signing secret/App token configured | Slack app config page + Key Vault | | | ☐ |
| 15 | Teams bot registered and MicrosoftAppPassword in Key Vault | Azure Bot resource + Key Vault | | | ☐ |
| 16 | Bot endpoints reachable from Slack/Teams | Test `@minions hello` in each channel | | | ☐ |

---

## Sign-off

| Role | Name | Signature | Date |
|---|---|---|---|
| Engineering Lead | | | |
| Security Reviewer | | | |
| Platform Operator | | | |
| Product Owner | | | |

---

## Post-launch support model

- **L1 support:** Slack/Teams channel `#minions-support` — triage user questions and bot connectivity.
- **L2 support:** Platform on-call — handles scaling, stuck approvals, DLQ replay.
- **L3 support:** Engineering team — code bugs, prompt tuning, governance changes.
- **Escalation:** Page on-call if orchestrator is scaled to zero for > 5 minutes or tool-call failure rate > 10%.
- **Stream operations:** DLQ triage by reason code (`MALFORMED_ENVELOPE` / `POISON_MESSAGE` / `BUDGET_EXCEEDED`), sampling-QA breaker resets, daily-budget queue pauses, and escalation-bridge reconciliation are covered in [`stream-operations.md`](./stream-operations.md).

---

## Post-launch validation (first 24 hours)

- [ ] At least 10 successful sessions processed
- [ ] No Sev-1 or Sev-2 alerts
- [ ] Average tool-call latency within thresholds (p95 < 5s for simple queries)
- [ ] All destructive actions triggered an approval request
- [ ] SQLite backup succeeded at least once
