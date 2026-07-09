# ADR-018: Observability dashboard design

| Key | Value |
|---|---|
| **Status** | Accepted (Tier 2 implemented 2026-07-09 — see status note below) |
| **Date** | 2026-06-05 |
| **Deciders** | Goose Agent Framework team |
| **Replaces** | — |
| **Superseded by** | — |

---

## Context

The framework generates significant telemetry:
- **Sessions** — who asked what, from which platform, when
- **Minion runs** — status, duration, turns used, tokens consumed
- **Tool calls** — every MCP invocation with latency, parameters, and result
- **Failures** — timeouts, blocked calls, retry exhaustion
- **Cost** — token usage by minion, model, session, and time period
- **Rate limits** — per-server throttle events

Operators need visibility into all of this for debugging, capacity planning, and compliance. Options:

1. **Azure Managed Grafana** — managed dashboard service with native Azure Monitor data source.
2. **Custom Goose extension (`agent-dashboard`)** — full-custom web UI built as a Goose app.
3. **Azure Monitor Workbooks** — built-in Azure portal dashboards with KQL.
4. **Third-party observability** — Datadog, New Relic, etc.

## Decision

**Use a two-tier approach:**

| Tier | What | Who for | Build effort |
|---|---|---|---|
| **Tier 1: Azure Managed Grafana** | Curated dashboards for minion health, tool call metrics, cost, and alerts | Platform operators, SREs | Low — pre-built visualizations on Log Analytics data |
| **Tier 2: Custom `agent-dashboard` Goose extension** | Session replay, correlation tree viewer, live minion status, governance config | Framework users, developers | Medium — built in Phase 4 |

Tier 1 is the **operational observability backbone**. Tier 2 is the **user-facing introspection tool**. Both read from the same data sources (Log Analytics + Table Storage).

**Azure Monitor Workbooks are used for ad-hoc KQL exploration and alert authoring.** They complement, not replace, Grafana.

## Rationale

### Why Two Tiers?

- **Grafana** is zero-code, purpose-built for metrics and dashboards. It handles alerting, annotation, and team sharing natively. Operators already know it.
- **The custom dashboard** provides Goose-specific views that a generic metrics tool can't: correlation tree visualization, session replay (reconstruct the full conversation), governance config editor, and one-click retry of failed sessions.

### Why Azure Managed Grafana (not self-hosted)?

- No server to manage. Azure AD single sign-on.
- Native Log Analytics and Azure Monitor data sources — zero configuration.
- $0/month for the essential plan (up to 2 dashboards, 5 users — sufficient for the ops team).
- Standard plan at ~$9/user/month for larger teams.

### Dashboard Definitions (Tier 1 — Grafana)

#### Dashboard 1: Overview

| Panel | Type | KQL / Metric |
|---|---|---|
| Active sessions (gauge) | Stat | `AppTraces \| where timestamp > ago(1h) \| where Properties.event == "session_started" \| summarize count()` |
| Minion runs (24h, stacked bar) | Time series | `AppTraces \| where Properties.event == "minion_completed" \| summarize count() by bin(timestamp, 1h), Properties.minion_type` |
| Success rate (24h) | Stat | `AppTraces \| where Properties.event == "tool_call" \| summarize success = countif(Properties.success == true), total = count()` |
| Avg tool call latency (24h) | Time series | `AppTraces \| where Properties.event == "tool_call" \| summarize avg(Properties.latency_ms) by bin(timestamp, 10m)` |
| Queue depth (real-time) | Stat | Azure Service Bus metric: `Active Messages` |
| Tool call failures (24h, by server) | Bar chart | `AppTraces \| where Properties.success == false \| summarize count() by Properties.mcp_server` |

#### Dashboard 2: Minion Health

| Panel | Type | KQL |
|---|---|---|
| Runs by minion type (24h) | Pie | `summarize count() by Properties.minion_type` |
| Timeout rate (24h) | Stat per minion | `where Properties.status == "timed_out" \| summarize count()` |
| Retry distribution | Heatmap | `summarize count() by Properties.minion_type, Properties.attempt` |
| Avg turns per minion type | Bar gauge | `summarize avg(Properties.turns_used) by Properties.minion_type` |
| Tokens consumed (24h, by minion) | Time series | `summarize sum(Properties.tokens_used) by bin(timestamp, 1h), Properties.minion_type` |

#### Dashboard 3: Cost & Capacity

| Panel | Type | Data |
|---|---|---|
| Token usage (daily, by model) | Time series | AI Foundry metrics |
| Estimated cost (daily, by model) | Time series | Token count × model pricing rate |
| Rate limit hits (24h, by server) | Bar chart | `AppTraces \| where Properties.status == "throttled" \| summarize count() by Properties.mcp_server` |
| Container replica count | Time series | Azure Container Apps metric |
| Service Bus DLQ depth | Stat | Service Bus metric: `Count of dead-lettered messages` |

#### Dashboard 4: Security

| Panel | Type | KQL |
|---|---|---|
| Blocked tool calls (24h) | Table | `where Properties.status == "blocked_by_allowlist" \| project timestamp, Properties.minion_type, Properties.tool_name` |
| Pending approvals | Table | SQLite query exposed via a custom log |
| Failed auth attempts | Stat | MCP server logs |
| Content safety triggers | Stat | AI Foundry content safety metrics |

### Alert Rules (Azure Monitor)

| Alert | Condition | Severity | Channel |
|---|---|---|---|
| Minion timeout rate > 10% (15 min) | `countif(status == "timed_out") / count() > 0.1` | Sev-2 | Teams |
| DLQ has messages | `DLQ count > 0` | Sev-2 | Teams |
| Tool call failure rate > 20% (15 min) | `countif(success == false) / count() > 0.2` | Sev-1 | Teams + SMS |
| Rate limit hits (5 min rolling) | `countif(status == "throttled") > 10` | Sev-3 | Teams |
| No sessions in 4 hours (business hours) | `countif(event == "session_started") == 0` | Sev-3 | Teams (info) |
| Pending approval older than 1 hour | `approval age > 1h` | Sev-3 | Teams |
| Container restarts > 3 in 30 min | Container Apps metric | Sev-2 | Teams |

### Tier 2: Custom `agent-dashboard` Extension

A Goose extension providing:

| View | Description |
|---|---|
| **Session explorer** | Search sessions by user, channel, intent, date. Click to expand full correlation tree. |
| **Correlation tree** | Visual DAG of a session: root → minions → tool calls. Color-coded by status (green=success, red=failure, yellow=timeout). Click a node for full details. |
| **Live minion status** | Real-time view of active minions with progress indicators. Cancel long-running minions. |
| **Tool call inspector** | Search/filter tool calls by server, minion, status, time range. View parameters and result summary. |
| **Governance config** | View and edit `governance.yaml` with validation. Changes proposed as PRs to the framework repo. |
| **Prompt viewer** | View the current system prompt for each minion type. See the version history (from Git). |

## Consequences

### Positive
- Two-tier observability: ops-grade for SREs (Grafana), introspective for users (custom dashboard)
- Zero-ops Grafana (Azure Managed)
- Shared data sources — no duplication
- Alerts for critical conditions

### Negative / Mitigations
- **Grafana essential plan is limited to 2 dashboards** — Mitigation: Standard plan at ~$9/user/month if more are needed. Or use Azure Monitor Workbooks as a free alternative for secondary dashboards.
- **Custom dashboard is Phase 4 effort** — Mitigation: Grafana covers operational needs from Day 1. The custom dashboard is a UX/developer-experience improvement, not a launch dependency.
- **Log Analytics cost grows with volume** — Mitigation: Tool call logs in Log Analytics are sampled/aggregated for dashboard queries. Raw detail lives in Table Storage (cheaper). Set data caps.

---

## Status note (2026-07-09): Tier 2 custom dashboard implemented

The Tier 2 custom `agent-dashboard` described above was delivered by the 2026-07-08 remediation ExecPlan (Milestone 14, `extensions/agent-dashboard`): bearer-token auth (with the `?token=` query fallback scoped to `/api/events` for browser `EventSource`), SSE live updates, a pending-approvals panel with approve/deny proxying through the governed toolshed, audit search, and a token-cost view. Entra ID easy-auth for production is documented in Terraform. Status accordingly moves Proposed → Accepted. The Tier 1 Grafana dashboards and alert rules remain as designed here and are provisioned via `infra/terraform`.
