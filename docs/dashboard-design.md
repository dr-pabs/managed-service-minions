# Dashboard Design — Agent Dashboard Extension (Phase 4)

> **Date:** 2026-06-06  
> **Status:** Draft  
> **Complements:** ADR-018 (Observability), `./logical-architecture.md` §15

---

## Overview

The custom `agent-dashboard` is a Goose extension (built via `apps__create_app`) providing Goose-specific views that Azure Managed Grafana cannot. It reads from Azure Table Storage and Log Analytics. It is a Phase 4 deliverable — Grafana covers operational needs from Day 1.

## Navigation Model

```
┌─────────────────────────────────────────────────────────────┐
│  Minions Agent Framework                       [Settings ⚙]  │
├─────────────────────────────────────────────────────────────┤
│  [Sessions] [Live] [Tool Calls] [Cost] [Prompts] [Config]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                    Active View Content                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Always visible header:** Correlation ID search bar. Paste any `corr_` ID and jump directly to that session's tree view.

---

## View 1: Session Explorer

### Purpose
Search and browse all orchestration sessions. Entry point for debugging and auditing.

### Wireframe

```
┌─────────────────────────────────────────────────────────────┐
│  Sessions                                                  │
│                                                             │
│  Filters:                                                   │
│  Channel: [All ▾]  User: [__________]  Intent: [All ▾]     │
│  Status:  ☑ Active  ☑ Completed  ☑ Failed                 │
│  Date:    [2026-06-01] → [2026-06-06]                      │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ corr_a1b2c3  │ teams    │ alice     │ ticket→fix→pr  │  │
│  │ 2026-06-06   │ #general │           │ ✅ completed   │  │
│  │ 08:42 UTC    │          │           │ 4 minions, 52s │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ corr_f7e8d9  │ slack    │ bob       │ ticket_lookup  │  │
│  │ 2026-06-06   │ #eng     │           │ ✅ completed   │  │
│  │ 09:15 UTC    │          │           │ 1 minion, 2s   │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ corr_k9m0n1  │ cron     │ —         │ daily_review   │  │
│  │ 2026-06-06   │          │           │ ✅ completed   │  │
│  │ 08:00 UTC    │          │           │ 6 minions, 3m  │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ corr_x1y2z3  │ teams    │ charlie   │ code_review    │  │
│  │ 2026-06-06   │ #backend │           │ ❌ failed      │  │
│  │ 10:30 UTC    │          │           │ 2 retries      │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  Showing 4 of 127 sessions            [Load More]           │
└─────────────────────────────────────────────────────────────┘
```

### Interaction
- Click any session row → navigates to **Correlation Tree** for that session.
- Failed sessions highlighted in red; click to see error details and retry options.
- Filter by channel, user, intent, status, or date range.

---

## View 2: Correlation Tree (Per-Session Drill-Down)

### Purpose
Visualize the full execution DAG for a single session. Every minion and every tool call, color-coded by status.

### Wireframe

```
┌─────────────────────────────────────────────────────────────┐
│  Session: corr_a1b2c3    ← Back to Sessions                │
│                                                             │
│  Channel: teams / #general          User: alice@org.com     │
│  Intent: ticket→fix→pr              Status: ✅ completed    │
│  Message: "@minions fix INC00421 and create a PR"            │
│  Duration: 52s                       Tokens: 47,230         │
│                                                             │
│  ┌─── Correlation Tree ──────────────────────────────────┐  │
│  │                                                        │  │
│  │                    ┌──────────────┐                    │  │
│  │                    │ Orchestrator │                    │  │
│  │                    │  corr_a1b2c3 │                    │  │
│  │                    └──────┬───────┘                    │  │
│  │           ┌───────────────┼───────────────┐           │  │
│  │           │               │               │           │  │
│  │           ▼               ▼               ▼           │  │
│  │   ┌────────────┐  ┌────────────┐  ┌────────────┐     │  │
│  │   │ 🟢 Ticket  │  │ 🟢 Code    │  │ 🟢 Related │     │  │
│  │   │ Analyst    │  │ Explorer   │  │ PRs        │     │  │
│  │   │ .1        │  │ .2         │  │ .3         │     │  │
│  │   └─────┬──────┘  └─────┬──────┘  └─────┬──────┘     │  │
│  │         │               │               │              │  │
│  │   ┌─────┴──────┐  ┌─────┴──────┐  ┌─────┴──────┐     │  │
│  │   │ado-001 ✓   │  │fs-001 ✓    │  │ado-004 ✓   │     │  │
│  │   │42ms        │  │5ms         │  │90ms        │     │  │
│  │   ├────────────┤  ├────────────┤  └────────────┘     │  │
│  │   │sn-002 ✓    │  │analyze-002 │                      │  │
│  │   │130ms       │  │1100ms ✓    │                      │  │
│  │   └────────────┘  └────────────┘                      │  │
│  │           │               │               │           │  │
│  │           └───────────────┼───────────────┘           │  │
│  │                           │                            │  │
│  │                           ▼                            │  │
│  │                   ┌────────────┐                       │  │
│  │                   │ 🟢 PR      │                       │  │
│  │                   │ Crafter    │                       │  │
│  │                   │ .4         │                       │  │
│  │                   └─────┬──────┘                       │  │
│  │                         │                              │  │
│  │                   ┌─────┴──────┐                       │  │
│  │                   │git-005 80ms│                       │  │
│  │                   ├────────────┤                       │  │
│  │                   │fs-006 12ms │                       │  │
│  │                   ├────────────┤                       │  │
│  │                   │sh-007 4.5s │                       │  │
│  │                   ├────────────┤                       │  │
│  │                   │git-008 150m│                       │  │
│  │                   ├────────────┤                       │  │
│  │                   │ado-009 600m│                       │  │
│  │                   └────────────┘                       │  │
│  │                         │                              │  │
│  │                         ▼                              │  │
│  │                   ┌────────────┐                       │  │
│  │                   │ 🟡 Code    │                       │  │
│  │                   │ Reviewer   │                       │  │
│  │                   │ .5         │                       │  │
│  │                   └─────┬──────┘                       │  │
│  │                         │                              │  │
│  │                   ┌─────┴──────┐                       │  │
│  │                   │ado-010     │                       │  │
│  │                   │2.3s ✓      │                       │  │
│  │                   └────────────┘                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  Legend: 🟢 Success  🟡 Warning  🔴 Error                  │
│                                                             │
│  [Retry Failed] [Export as JSON]                           │
└─────────────────────────────────────────────────────────────┘
```

### Interaction
- **Click any minion node** → right panel shows: system prompt used, full instructions, structured JSON output, token consumption.
- **Click any tool call node** → right panel shows: full parameters (from Table Storage), result summary (first 1KB), full result link (Blob), latency.
- **Hover** shows quick stats: turns used, tokens consumed, duration.
- **Retry Failed** re-enqueues the failed minion with the same correlation ID (incremented attempt counter).
- **Export as JSON** dumps the full trace for offline analysis.

---

## View 3: Live Minion Status

### Purpose
Real-time view of all currently running minions. Operator can monitor progress and cancel stuck minions.

### Wireframe

```
┌─────────────────────────────────────────────────────────────┐
│  Live Minions                         Auto-refresh [5s ▾]   │
│                                                             │
│  Active: 3    Queued: 2    Orchs: 2 replicas               │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 🟢 Code Reviewer  │ corr_k9m0n1.3  │ Turn 12/20      │  │
│  │ PR: org/repo#344  │ Running 45s    │ 18,200 tokens   │  │
│  │                   │                │ [████████░░] 60% │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ 🟢 Code Reviewer  │ corr_k9m0n1.5  │ Turn 8/20       │  │
│  │ PR: Platform!892  │ Running 30s    │ 9,400 tokens    │  │
│  │                   │                │ [████░░░░░░] 40% │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ 🟡 PR Crafter      │ corr_a1b2c3.4  │ Turn 18/30      │  │
│  │ Fix: auth timeout  │ Running 38s    │ 24,100 tokens   │  │
│  │                   │                │ [██████░░░░] 60% │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ ⏳ Ticket Analyst  │ corr_p4q5r6.1  │ Queued          │  │
│  │ INC00823           │ Waiting 12s    │ —               │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ ⏳ Security Audit  │ corr_p4q5r6.2  │ Queued          │  │
│  │ Dependency scan    │ Waiting 12s    │ —               │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  [Cancel Selected] [View Session]                           │
└─────────────────────────────────────────────────────────────┘
```

### Interaction
- Progress bar = `current_turn / max_turns`. Approaches 100% → may time out.
- **Cancel** terminates the delegate (via Goose's delegate cancellation, if supported) and marks the run as `cancelled`.
- **View Session** jumps to that minion's parent session in the Correlation Tree.

---

## View 4: Tool Call Inspector

### Purpose
Search, filter, and inspect all tool calls across all sessions. Audit and debugging.

### Wireframe

```
┌─────────────────────────────────────────────────────────────┐
│  Tool Calls                                                │
│                                                             │
│  Filters:                                                   │
│  Server: [All ▾]  Minion: [All ▾]  Status: [All ▾]        │
│  Tool: [__________]  Corr ID: [__________]                 │
│  Date: [2026-06-06 00:00] → [2026-06-06 23:59]            │
│  Latency > [1000] ms                                       │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Time     │ Corr ID          │ Server  │ Tool         │  │
│  │──────────┼──────────────────┼─────────┼──────────────│  │
│  │ 08:42:03 │ corr_a1b2c3.1... │ ado     │ get_work_ite │  │
│  │          │                  │         │ 42ms ✓       │  │
│  │ 08:42:04 │ corr_a1b2c3.1... │ sn      │ query_incid  │  │
│  │          │                  │         │ 130ms ✓      │  │
│  │ 08:42:03 │ corr_a1b2c3.2... │ fs      │ list_dir     │  │
│  │          │                  │         │ 5ms ✓        │  │
│  │ 08:42:07 │ corr_a1b2c3.2... │ analyze │ analyze      │  │
│  │          │                  │         │ 1100ms ✓     │  │
│  │ 08:44:11 │ corr_a1b2c3.4... │ shell   │ run_cmd      │  │
│  │          │                  │         │ 4.5s ✓       │  │
│  │ 09:15:22 │ corr_f7e8d9.1... │ ado     │ get_work_ite │  │
│  │          │                  │         │ 55ms ✓       │  │
│  │ 10:31:01 │ corr_x1y2z3.1... │ gh      │ get_pr_diff  │  │
│  │          │                  │         │ ❌ timeout    │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  Selected: corr_a1b2c3.2.analyze-002                        │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Parameters:                                            │  │
│  │ { "path": "src/auth/", "focus": "login",              │  │
│  │   "max_depth": 3 }                                    │  │
│  │                                                        │  │
│  │ Result (first 1KB):                                    │  │
│  │ { "files": ["src/auth/login.ts", ...],                │  │
│  │   "symbols": [{ "name": "authenticate", ...}],        │  │
│  │   ... }                                                │  │
│  │                                                        │  │
│  │ [View Full Result in Blob]                             │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## View 5: Prompt Viewer

### Purpose
Inspect the system prompt for each minion type. See version history. Understand what the minion is told.

### Wireframe

```
┌─────────────────────────────────────────────────────────────┐
│  Prompts                                                   │
│                                                             │
│  Minion: [Code Reviewer ▾]  Version: [v2.3.1 ▾]           │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ # Code Reviewer System Prompt — v2.3.1                │  │
│  │                                                        │  │
│  │ You are a senior code reviewer. Analyze diffs          │  │
│  │ systematically: correctness, readability,              │  │
│  │ performance, security, test coverage.                  │  │
│  │                                                        │  │
│  │ Produce structured JSON output with severity           │  │
│  │ levels: blocker, major, minor, nit.                    │  │
│  │                                                        │  │
│  │ Be constructive and specific. Suggest concrete         │  │
│  │ fixes with code examples where appropriate.            │  │
│  │ ...                                                    │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  Version History:                                           │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ v2.3.1 │ 2026-06-04 │ Added: check for race conditions│  │
│  │ v2.3.0 │ 2026-05-28 │ Changed: output schema v3       │  │
│  │ v2.2.1 │ 2026-05-15 │ Fixed: false positive on SQL    │  │
│  │ v2.2.0 │ 2026-05-10 │ Added: OWASP Top 10 checklist   │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  Diff: v2.3.0 → v2.3.1                                     │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ + - **Race conditions**: Check for shared state        │  │
│  │     access without synchronization primitives          │  │
│  │     (mutex, channels, atomic operations).              │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  [Propose Change (opens PR)]                               │
└─────────────────────────────────────────────────────────────┘
```

---

## View 6: Governance Configuration

### Purpose
View and edit the governance rules. Changes are validated in-browser and proposed as PRs to the framework repo.

### Wireframe

```
┌─────────────────────────────────────────────────────────────┐
│  Governance Config                      Repo: main / v2.1   │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ require_approval_for:                                  │  │
│  │   - github.merge_pr          ✅                       │  │
│  │   - github.delete_branch     ✅                       │  │
│  │   - azure_devops.complete_pr ✅                       │  │
│  │   - azure_devops.delete_br   ✅                       │  │
│  │   - servicenow.close_incid   ✅                       │  │
│  │   - servicenow.update_incid  ☐  ← changed            │  │
│  │   - jira.transition_issue    ✅                       │  │
│  │                                                        │  │
│  │ blocked_tools:                                         │  │
│  │   - github.delete_repo       ✅                       │  │
│  │   - azure_devops.delete_repo ✅                       │  │
│  │   - azure_devops.delete_proj ✅                       │  │
│  │   - servicenow.delete_incid  ✅                       │  │
│  │   - shell.rm_rf              ✅                       │  │
│  │                                                        │  │
│  │ rate_limits:                                           │  │
│  │   github: 50/min             [____]                   │  │
│  │   azure_devops: 40/min       [____]                   │  │
│  │   servicenow: 20/min         [____]                   │  │
│  │                                                        │  │
│  │ workspace_boundaries:                                  │  │
│  │   filesystem:                                         │  │
│  │     - /data/repos/org-*       ✅                      │  │
│  │   github_repos:                                       │  │
│  │     - org/repo-*              ✅                      │  │
│  │   azure_devops_projects:                              │  │
│  │     - Platform                ✅                      │  │
│  │     - Mobile                  ✅                      │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  3 changes detected                          [Validate]     │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ ⚠️ servicenow.update_incident no longer requires      │  │
│  │    approval. This allows minions to modify incident    │  │
│  │    fields (severity, assignment, notes).               │  │
│  │    Approve this change?                 [Yes] [Cancel] │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  [Propose Changes as PR]                                   │
└─────────────────────────────────────────────────────────────┘
```

### Interaction
- All changes are validated in-browser against the governance schema.
- Destructive relaxations (removing an approval requirement) trigger a confirmation dialog.
- **Propose Changes as PR** creates a branch + PR in the framework repo with the diff. Human review and merge required before changes take effect (ADR-013).
- View only mode shows the currently deployed config.

---

## UX Principles

1. **Correlation ID is the universal key.** Every view can be reached from a correlation ID. "Paste a `corr_` ID and go."
2. **Color coding is consistent.** Green = success, yellow = warning/timeout, red = failure/blocked. Same palette as the correlation tree in all views.
3. **Progressive disclosure.** Session list → correlation tree → minion detail → tool call detail. Drill down; never show everything at once.
4. **Read-only by default.** The dashboard is an observability tool. Writes (retry, cancel, config change) require explicit action.
5. **Exportable.** Every view can export data as JSON for offline analysis or sharing.
