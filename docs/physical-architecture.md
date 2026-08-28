# Physical Architecture Design

> **Date:** 2026-06-06  
> **Status:** Draft  
> **Complements:** [logical-architecture.md](./logical-architecture.md), [azure-architecture.md](./azure-architecture.md)

---

## Table of Contents

1. [Design Principles](#design-principles)
2. [Compute Sizing](#compute-sizing)
3. [Networking Design](#networking-design)
4. [Storage Layout](#storage-layout)
5. [Messaging Throughput](#messaging-throughput)
6. [Identity & Access](#identity--access)
7. [High Availability](#high-availability)
8. [Disaster Recovery](#disaster-recovery)
9. [Scaling Model](#scaling-model)
10. [Cost Model](#cost-model)

---

## Design Principles

| Principle | Constraint |
|---|---|
| **Serverless-first** | No VMs, no Kubernetes clusters. Container Apps + managed services. |
| **Scale-to-zero** | Zero cost when idle. Warm replica kept during business hours (08:00–18:00 local). |
| **Private network** | All service-to-service traffic over VNet. No public IPs except Slack/Teams ingress. |
| **Single region, zone-redundant** | One Azure region, services spread across availability zones. No multi-region in initial scope. |
| **Right-size, not over-provision** | Start small. Scale with usage data. No pre-provisioned capacity beyond AI Foundry PTU (optional). |
| **Immutable infrastructure** | All resources defined in Terraform. Deployed via GitHub Actions. No ClickOps. |

---

## Compute Sizing

### Container Apps Environment

| Resource | SKU | vCPU | Memory | Replicas (min–max) |
|---|---|---|---|---|
| **Orchestrator** (`ca-orchestrator`) | Consumption-only | 1.0 | 2 GB | 1–5 |
| **Queue-Ingress** (`ca-queue-ingress`) | Consumption-only | 1.0 | 2 GB | 1–5 (KEDA on work-queue depth, ADR-027) |
| **Toolshed** (`ca-toolshed`) | Consumption-only | 0.5 | 1 GB | 1–5 (shared governance state, ADR-026) |
| **Dashboard** (`ca-dashboard`) | Consumption-only | 0.5 | 1 GB | 1 (pinned, ADR-026) |
| **Slack Bot** (`ca-slackbot`) | Consumption-only | 0.5 | 1 GB | 1 (always warm, pinned) |
| **Teams Bot** (`ca-teamsbot`) | Consumption-only | 0.5 | 1 GB | 1 (always warm, pinned) |
| **MCP Sidecars** (filesystem, git, shell) | Consumption-only | 0.25 | 0.5 GB | 1 per orchestrator replica |

**Scaling triggers:**

| Component | Scaler | Metric | Threshold |
|---|---|---|---|
| Queue-ingress | KEDA Service Bus (queue mode) | Work-queue (`minion-tasks`) depth | +1 replica per depth threshold (`messageCount` metadata), 1–5 replicas (ADR-027: the scale target moved here from the orchestrator) |
| Orchestrator | None — plain `min_replicas = 1` / `max_replicas = 5` | N/A | No KEDA rule since the queue consumer moved to queue-ingress |
| Bots | N/A — pinned single replica | N/A | `max_replicas = 1` always; no scaler configured (ADR-026) |
| MCP Sidecars | Colocated | Same as orchestrator | Inherits orchestrator scaling |

> **Correction (2026-07-09, Milestone 18 hygiene sweep; updated 2026-08-28 for ADR-026):** this table previously read "Bots | KEDA HTTP | Requests > 10/min | +1 replica (rarely needed)," implying the Slack/Teams bots autoscale on HTTP request volume. That never matched `infra/terraform/modules/container_apps/main.tf`, which pins both bots to `min_replicas = 1` / `max_replicas = 1` with no KEDA HTTP scale rule defined for them — and per `adrs/adr-026-shared-governance-state.md`, this is intentional, not an oversight: the bots share the toolshed's mounted SQLite file and the still single-writer pending-approval path (session/thread bookkeeping) and are not part of the orchestrator's tested KEDA/Service-Bus scaling story. The toolshed itself now scales (its rate limiter and circuit breaker moved to a shared `GovernanceState` Azure Table, ADR-026); the bots remain pinned because they hold no such state of their own and inherit the SQLite single-writer concern. See ADR-026 for the trigger condition that would justify revisiting the bots' pinning.

**Why consumption-only (not Dedicated):**

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryTextColor': '#1a1a1a'}}}%%
flowchart LR
    subgraph "Scaling Triggers (queue-ingress only, ADR-027)"
        q_depth["Service Bus\nWork-Queue Depth"]
        q_empty["Queue Depth = 0\nfor 15 min"]
        off_hours["Outside\nBusiness Hours"]
    end
    
    subgraph "KEDA Scaler"
        keda["KEDA\n(Kubernetes Event-Driven\nAutoscaling)"]
    end
    
    subgraph "Container Apps"
        qi["Queue-Ingress\n1 ⇄ 5 replicas (KEDA)"]
        orch["Orchestrator\n1 ⇄ 5 replicas (no scaler)"]
        toolshed["Toolshed\n1 ⇄ 5 replicas (ADR-026)"]
        bots["Bots, dashboard\nmax_replicas = 1, no scaler (ADR-026)"]
    end
    
    q_depth -->|"scale out"| keda
    q_empty -->|"scale in"| keda
    off_hours -->|"scale to zero"| keda
    keda --> qi
    
    style q_depth fill:#fadbd8,stroke:#e6a8a0,color:#1a1a1a
    style q_empty fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
    style keda fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style bots fill:#eeeeee,stroke:#999999,color:#1a1a1a
```
- Dedicated plan minimum: ~$150/month for always-warm workers
- Consumption plan: pay per-second for active containers, scale-to-zero
- Orchestrator CPU bound only during intent classification and response synthesis — seconds per session
- Minions run as delegates within the orchestrator process, not separate containers
- Estimated active compute: ~2–4 hours/day at moderate usage → ~$15–30/month

**Container image:**

```
gooseframework.azurecr.io/orchestrator:latest
├── Base: Goose runtime (Node.js or Python)
├── Extensions:
│   ├── orchestrator/
│   ├── mcp-toolshed/
│   └── chatrecall/
├── Prompts: /prompts/*.md
├── Config: /config/governance.yaml
└── SQLite: /data/goose-sessions.db
```

---

## Networking Design

### VNet Layout

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryTextColor': '#1a1a1a', 'lineColor': '#555' }}}%%
graph TB
    subgraph "VNet: goose-framework-vnet (10.0.0.0/16)"
        direction TB
        
        subgraph "snet-container-apps (10.0.1.0/24)"
            orch1["Orchestrator<br/>10.0.1.10"]
            orch2["Orchestrator<br/>10.0.1.11"]
            slack["Slack Bot<br/>10.0.1.20"]
            teams["Teams Bot<br/>10.0.1.21"]
        end
        
        subgraph "snet-private-endpoints (10.0.2.0/24)"
            pe_sb["PE: Service Bus<br/>10.0.2.4"]
            pe_st["PE: Storage<br/>10.0.2.5"]
            pe_kv["PE: Key Vault<br/>10.0.2.6"]
            pe_foundry["PE: AI Foundry<br/>10.0.2.7"]
            pe_acr["PE: ACR<br/>10.0.2.8"]
        end
        
        subgraph "snet-bastion (10.0.3.0/24)"
            bastion["Azure Bastion<br/>(disabled by default)"]
        end
    end
    
    orch1 -->|"AMQP:5671"| pe_sb
    orch2 -->|"AMQP:5671"| pe_sb
    orch1 -->|"HTTPS:443"| pe_st
    orch2 -->|"HTTPS:443"| pe_st
    orch1 -.->|"MI"| pe_kv
    orch2 -.->|"MI"| pe_kv
    orch1 -->|"HTTPS:443"| pe_foundry
    orch2 -->|"HTTPS:443"| pe_foundry
    
    style orch1 fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style orch2 fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style slack fill:#fcf3cf,stroke:#d4ac0d,color:#1a1a1a
    style teams fill:#fcf3cf,stroke:#d4ac0d,color:#1a1a1a
    style pe_sb fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
    style pe_st fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
    style pe_kv fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
    style pe_foundry fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
```

Three subnets in a single VNet. The container-apps subnet hosts all compute — orchestrator replicas and bot containers. The private-endpoints subnet hosts the 5-6 private endpoints that keep all Azure service traffic off the public internet. The bastion subnet exists for emergency access but is disabled by default.

All service-to-service traffic flows through private endpoints, resolving to private IPs via auto-created private DNS zones.

### DNS & Service Discovery

| Concern | Solution |
|---|---|
| Service Bus namespace DNS | `sb-goose-framework.servicebus.windows.net` → private endpoint → private IP |
| Storage account DNS | `stgooseframework.table.core.windows.net` → private endpoint → private IP |
| AI Foundry endpoint | `foundry-goose-framework.openai.azure.com` → private endpoint → private IP |
| Container-to-container | Container Apps environment-internal DNS (service name resolution) |
| Bot ingress | Public FQDN via Container Apps managed certificate: `teams-bot.<env>.azurecontainerapps.io` |

### Network Security Groups (NSGs)

| Subnet | Inbound | Outbound |
|---|---|---|
| **container-apps** | From: Internet (HTTPS:443) — only to bot containers | To: private-endpoints (HTTPS:443, AMQP:5671), Internet (MCP servers:443) |
| **private-endpoints** | From: container-apps (443, 5671) | To: Azure services (via PE) |
| **bastion** | From: Azure Bastion (443) | To: container-apps (22) — disabled by default |

### Firewall / WAF

Not needed in initial scope. Container Apps provides DDoS protection at the platform level. Bot endpoints are authenticated (Slack signing secret, Teams Bot Framework auth). No sensitive data is exposed on public endpoints.

---

## Storage Layout

### Storage Account: `stgooseframework`

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryTextColor': '#1a1a1a', 'lineColor': '#555'}}}%%
graph TB
    subgraph "Storage Account: stgooseframework"
        table["Table: ToolCallLog\nPK: correlation_id\nTTL: 90 days"]
        minion_blob["Container: minion-outputs\nPath: sessions/{corr_id}/{minion_id}/\nTier: Cool → Archive 90d"]
        backup_blob["Container: sqlite-backups\nPath: orchestrator/{replica}/\nRetention: 7 daily"]
    end
    
    subgraph "Compute"
        orch["Orchestrator\nContainer"]
    end
    
    subgraph "Local Ephemeral"
        sqlite["SQLite\n/data/goose-sessions.db\n10-50 MB"]
    end
    
    orch -->|"write tool calls"| table
    orch -->|"write large outputs"| minion_blob
    orch -->|"WAL backup / 15 min"| backup_blob
    orch -->|"read/write"| sqlite
    backup_blob -.->|"restore on startup"| sqlite
    
    style table fill:#fcf3cf,stroke:#d4ac0d,color:#1a1a1a
    style minion_blob fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
    style backup_blob fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
    style sqlite fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style orch fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
```

Three stores, three purposes. Table Storage for the append-only immutable tool call log. Blob Storage for large artifacts (full minion outputs, diffs) and SQLite backups. SQLite for hot session state — local to the orchestrator container, backed up every 15 minutes, restored on container start.

```
Storage Account: stgooseframework
├── Table: ToolCallLog
│   ├── Partition Key: {correlation_id}
│   ├── Row Key: {timestamp_ticks}_{minion_type}_{tool_name}
│   ├── TTL: 90 days (auto-delete)
│   └── Redundancy: LRS (zone-redundant for production)
│
├── Blob Container: minion-outputs
│   ├── Path: sessions/{correlation_id}/{minion_id}/output.json
│   ├── Tier: Cool (auto-transition to Archive after 90 days)
│   ├── Immutability: Legal hold on tool call data (optional, for compliance)
│   └── Redundancy: LRS (zone-redundant for production)
│
├── Blob Container: sqlite-backups
│   ├── Path: orchestrator/{replica_id}/sessions-{timestamp}.sqlite-wal
│   ├── Retention: 7 daily backups
│   └── Tier: Cool
│
└── Blob Container: prompts
    ├── Path: prompts/{minion_type}/{version}.md
    └── Optional: source of truth is Git; Blob is deployment cache
```

### SQLite (ephemeral, per orchestrator replica)

```
Location: /data/goose-sessions.db (within container)
Size: ~10–50 MB typical, grows with active sessions
Backup: WAL checkpoint every 15 minutes → Blob (sqlite-backups container)
Recovery: On container start, check Blob for latest backup. Restore if present.
```

### Capacity Planning

| Resource | 10 sessions/day | 100 sessions/day | 1,000 sessions/day |
|---|---|---|---|
| Table Storage (tool calls) | ~1 MB/month | ~10 MB/month | ~100 MB/month |
| Blob Storage (outputs) | ~50 MB/month | ~500 MB/month | ~5 GB/month |
| SQLite | <10 MB | <50 MB | <200 MB (rotate with backup) |
| Log Analytics ingestion | ~100 MB/month | ~1 GB/month | ~10 GB/month |

All well within free/cheapest tier limits.

---

## Messaging Throughput

### Service Bus: `sb-goose-framework`

| Resource | SKU | Throughput |
|---|---|---|
| Namespace | Standard | Up to 1,000 msg/sec |
| Queue: `minion-tasks` | — | Single work-item queue (ADR-027; not a topic + per-minion-type subscriptions), max delivery count: 3 |

> **Correction (2026-08-28, ADR-027):** an earlier revision described a `minion-tasks` **topic** with one subscription per minion type. The as-built topology (`infra/terraform/modules/service_bus/main.tf`, forge-ops Milestone 15) is a single Service Bus **queue** consumed by the queue-ingress; `item_type` is a field of the `WorkItem` envelope, not a broker routing property.

**Message size:** ~2–10 KB typical (instructions + context object). Blob reference for large context payloads (>200 KB).

**Dead-letter:** Max delivery count = 3 → DLQ, with reason codes (`MALFORMED_ENVELOPE` / `POISON_MESSAGE` / `BUDGET_EXCEEDED`) set by the queue-ingress. Operator triage per `docs/runbooks/stream-operations.md`.

**Idempotency:** Consumer-side, not Service Bus duplicate detection (ADR-027): the queue-ingress records completed outcomes against each item's `idempotency_key` in an idempotency store, so a redelivery or producer duplicate short-circuits to the recorded outcome instead of re-running.

---

## Identity & Access

### Managed Identities

| Resource | Identity Type | Purpose |
|---|---|---|
| Orchestrator Container App | User-assigned managed identity | Authenticate to: Service Bus, Table Storage, Blob Storage, Key Vault, AI Foundry |
| Slack Bot Container App | User-assigned managed identity | Authenticate to: Key Vault (for Slack signing secret) |
| Teams Bot Container App | User-assigned managed identity | Authenticate to: Key Vault (for Teams bot credentials) |
| GitHub Actions (CI/CD) | Federated credential (OIDC) | Authenticate to Azure for deployments |

### Key Vault: `kv-goose-framework`

```
Secret: github-pat            → GitHub MCP authentication
Secret: ado-pat               → Azure DevOps MCP authentication
Secret: servicenow-password   → ServiceNow MCP authentication
Secret: jira-api-token        → Jira MCP authentication
Secret: slack-signing-secret  → Slack bot verification
Secret: teams-bot-password    → Teams bot authentication
```

**No LLM API keys** — AI Foundry uses managed identity.

### RBAC Roles

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryTextColor': '#1a1a1a', 'lineColor': '#555'}}}%%
graph LR
    subgraph "Managed Identities"
        mi_orch["mi-orch-goosefw\nOrchestrator"]
        mi_slack["mi-slack-goosefw\nSlack Bot"]
        mi_teams["mi-teams-goosefw\nTeams Bot"]
        gh_oidc["GitHub OIDC\nCI/CD"]
    end
    
    subgraph "Azure Resources"
        sb["Service Bus\nData Sender + Receiver"]
        st["Storage Account\nTable & Blob Contributor"]
        kv["Key Vault\nSecrets User"]
        foundry["AI Foundry\nOpenAI User"]
        acr["Container Registry\nAcrPush"]
        ca["Container Apps\nContributor"]
    end
    
    mi_orch --> sb
    mi_orch --> st
    mi_orch --> kv
    mi_orch --> foundry
    mi_slack --> kv
    mi_teams --> kv
    gh_oidc --> acr
    gh_oidc --> ca
    
    style mi_orch fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style mi_slack fill:#fcf3cf,stroke:#d4ac0d,color:#1a1a1a
    style mi_teams fill:#fcf3cf,stroke:#d4ac0d,color:#1a1a1a
    style gh_oidc fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
    style sb fill:#fcf3cf,stroke:#d4ac0d,color:#1a1a1a
    style st fill:#fcf3cf,stroke:#d4ac0d,color:#1a1a1a
    style kv fill:#fadbd8,stroke:#e6a8a0,color:#1a1a1a
    style foundry fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
```

**Four identities, least privilege.** The Orchestrator has broadest access (Service Bus, Storage, Key Vault, AI Foundry). Bots only read their own secrets from Key Vault. CI/CD (GitHub OIDC) can push containers and update apps but never reads secrets or production data. Key Vault (red) is the only credential store — no secrets in container env vars or config files.

| Identity | Scope | Role |
|---|---|---|
| Orchestrator MI | Service Bus | Azure Service Bus Data Sender, Data Receiver |
| Orchestrator MI | Storage Account | Storage Table Data Contributor |
| Orchestrator MI | Storage Account | Storage Blob Data Contributor |
| Orchestrator MI | AI Foundry | Cognitive Services OpenAI User |
| Orchestrator MI | Key Vault | Key Vault Secrets User (for MCP creds) |
| GitHub OIDC | Container Registry | AcrPush |
| GitHub OIDC | Container Apps | Contributor (for deployments) |

---

## High Availability

### Availability Zone Redundancy

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryTextColor': '#1a1a1a', 'lineColor': '#555'}}}%%
graph TB
    subgraph "Azure Region: UK South"
        subgraph "Zone 1"
            orch_z1["Orchestrator\nReplica 1"]
            sb_z1["Service Bus\n(MS-managed)"]
            st_z1["Storage ZRS\nReplica 1"]
        end
        
        subgraph "Zone 2"
            orch_z2["Orchestrator\nReplica 2"]
            sb_z2["Service Bus\n(MS-managed)"]
            st_z2["Storage ZRS\nReplica 2"]
        end
        
        subgraph "Zone 3"
            orch_z3["Orchestrator\nReplica 3"]
            sb_z3["Service Bus\n(MS-managed)"]
            st_z3["Storage ZRS\nReplica 3"]
        end
    end
    
    orch_z1 <-->|"AMQP"| sb_z1
    orch_z2 <-->|"AMQP"| sb_z2
    orch_z3 <-->|"AMQP"| sb_z3
    
    orch_z1 -->|"write"| st_z1
    orch_z2 -->|"write"| st_z2
    orch_z3 -->|"write"| st_z3
    
    style orch_z1 fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style orch_z2 fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style orch_z3 fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style sb_z1 fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
    style st_z1 fill:#fcf3cf,stroke:#d4ac0d,color:#1a1a1a
```

**Zone-redundant where it matters.** Container Apps automatically distributes replicas across zones when ≥3 are running. Service Bus Standard tier provides Microsoft-managed paired-region redundancy. Storage uses ZRS in production (3 synchronous copies across zones). If Zone 1 fails, replicas in Zones 2 and 3 continue processing with no data loss.

| Resource | Zone Redundancy | Notes |
|---|---|---|
| Container Apps | Automatic (when ≥3 replicas) | Replicas spread across zones |
| Service Bus (Standard) | Automatic (paired regions) | Microsoft-managed |
| Table Storage | LRS (zone-redundant for production) | ZRS recommended for production |
| Blob Storage | LRS (zone-redundant for production) | ZRS recommended for production |
| Key Vault | Automatic (within region) | Microsoft-managed |
| AI Foundry | Deployment-specific | Deploy to multiple zones for HA |
| Log Analytics | Automatic | Microsoft-managed |

### Single Points of Failure

| Component | SPOF? | Mitigation |
|---|---|---|
| Orchestrator | No (multi-replica) | `min_replicas = 1` / `max_replicas = 5`; the KEDA queue-depth scaler now lives on the queue-ingress (ADR-027) |
| Queue-Ingress | No (multi-replica) | KEDA scales 1–5 on work-queue depth |
| Service Bus | No (Microsoft-managed, 99.9% SLA Standard) | Acceptable |
| Table Storage | No (Microsoft-managed, 99.9% SLA) | Acceptable |
| AI Foundry | Yes (single deployment) | Deploy to 2+ zones; fallback deployment in same region |
| Container Registry | No (Microsoft-managed, geo-replicated optional) | Geo-replication for production |
| SQLite (per replica) | Yes (local storage) | 15-min WAL backup to Blob; restore on restart |

### Recovery Time Objectives

| Scenario | RTO | RPO |
|---|---|---|
| Single orchestrator replica crash | <30 seconds (new replica spawns, loads SQLite from Blob) | <15 minutes (last WAL backup) |
| All orchestrator replicas crash | <2 minutes (KEDA respawns) | <15 minutes |
| Zone failure | <5 minutes (replicas shift to surviving zones) | <15 minutes |
| Region failure | Not in scope for initial design | Multi-region is a future enhancement |

---

## Scaling Model

### Horizontal Scaling

> **Correction (2026-07-09, Milestone 18 hygiene sweep; updated 2026-08-28 for ADR-026):** the diagram below previously showed a symmetric KEDA HTTP scaler for the bots (mirroring the orchestrator's Service Bus scaler, "Requests > 10/min → +1 replica"). That capability does not exist in Terraform and was never built — see `adrs/adr-025-single-replica-governance-state.md`. The queue-ingress (KEDA on work-queue depth, ADR-027), the orchestrator (plain 1–5 replica bounds, no scaler), and, since Milestone 18 (ADR-026), the toolshed scale horizontally today; the Slack/Teams bots and the dashboard remain pinned to `max_replicas = 1` in `infra/terraform/modules/container_apps/main.tf` because their governance-adjacent state (session bookkeeping, the mounted SQLite file) is still process-local. The toolshed's rate-limiter buckets and circuit breakers moved to a shared `GovernanceState` Azure Table (ADR-026), so those are no longer a single-replica constraint for it.

```
                     KEDA Scaler
                         │
                         ▼
              Service Bus work queue
              (queue-ingress ONLY, ADR-027)
                         │
                         ▼
              Queue depth over threshold
              → +1 queue-ingress replica
              (1 ⇄ 5)
                         │
                         ▼
              Queue depth = 0
              for 15 min →
              scale to 1
              (or 0 off-hours)

    Orchestrator: no scaler,
    min 1 / max 5 replicas.
    Bots, dashboard: no scaler.
    max_replicas = 1 always (ADR-026).
    Toolshed: no scaler, 1 ⇄ 5 replicas —
    shared governance state (ADR-026).
```

### Vertical Scaling

Container Apps consumption plan auto-sizes vCPU/memory within configured limits:

| Component | vCPU Max | Memory Max | Rationale |
|---|---|---|---|
| Orchestrator | 2.0 | 4 GB | Intent classification + DAG can be CPU-heavy |
| Bots | 1.0 | 2 GB | Lightweight adapters |
| MCP Sidecars | 1.0 | 1 GB | Git operations, shell commands |

### Throughput Ceiling (estimated)

| Bottleneck | Limit | Sessions/min it supports |
|---|---|---|
| LLM API rate (AI Foundry, GPT-4o-mini) | ~500 requests/min (PTU or paygo) | ~200 (assuming 2.5 LLM calls/session) |
| Service Bus | 1,000 msg/sec | Far exceeds all other limits |
| Table Storage | 20,000 transactions/sec | Far exceeds all other limits |
| Orchestrator CPU | ~10 intent classifications/sec/replica | ~100 sessions/min with 5 replicas |
| **System bottleneck** | **LLM API rate** | **~30–50 complex sessions/min** |

Bottleneck is the LLM API, not compute or storage.

---

## Cost Model

### Monthly Cost Estimate (Moderate Usage)

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryTextColor': '#1a1a1a'}}}%%
pie title Monthly Cost Breakdown — ~$180/month
    "AI Foundry (LLMs)" : 58
    "Private Endpoints" : 50
    "Container Apps" : 42
    "Service Bus" : 10
    "Log Analytics" : 7
    "Storage + KV + ACR" : 13
```

**LLM inference dominates at scale.** AI Foundry (token consumption) is 32% at moderate usage, rising to ~67% at heavy usage. Private endpoints are a fixed cost ($50/month for 6 endpoints). Container Apps costs are usage-based and stay flat because the orchestrator is event-driven, not always-on.

Assumptions: 50 sessions/day, 150 minion runs/day, ~3,000 tool calls/day, business hours only.

| Resource | SKU | Est. Monthly Cost |
|---|---|---|
| Container Apps (orchestrator) | Consumption, ~4 active hrs/day | $12 |
| Container Apps (bots) | Consumption, always warm × 2 | $30 |
| Container Apps (sidecars) | Consumption, colocated with orch | $0 (included) |
| Service Bus | Standard | $10 |
| Table Storage | ~3 GB + 90K ops | $2 |
| Blob Storage | ~15 GB Cool | $3 |
| Key Vault | Standard (secrets only) | $3 |
| AI Foundry — GPT-4o-mini (fast) | ~500K tokens/day, paygo | $8 |
| AI Foundry — GPT-4.1 (reasoning) | ~200K tokens/day, paygo | $30 |
| AI Foundry — Claude Sonnet (review) | ~100K tokens/day, paygo | $20 |
| Log Analytics | ~3 GB ingested/day | $7 |
| Managed Grafana | Essential (free tier) | $0 |
| Container Registry | Basic | $5 |
| VNet + Private Endpoints | 6 endpoints | $50 |
| **Total (moderate)** | | **~$180/month** |

### Monthly Cost Estimate (Light Usage — Dev/Staging)

| Resource | Adjustment | Est. Cost |
|---|---|---|
| Container Apps | Scale-to-zero, <1 hr active/day | $5 |
| AI Foundry | Minimal tokens | $15 |
| Log Analytics | Minimal ingestion | $2 |
| Private Endpoints | Reduce to 3 (SB, Storage, KV only) | $25 |
| **Total (light)** | | **~$80/month** |

### Monthly Cost Estimate (Heavy Usage — Production, 500 sessions/day)

| Resource | Adjustment | Est. Cost |
|---|---|---|
| Container Apps | Always warm, 3 replicas | $60 |
| AI Foundry | PTU for reasoning tier | $800 |
| Log Analytics | 30 GB ingested/day | $70 |
| Private Endpoints | Full set | $50 |
| **Total (heavy)** | | **~$1,200/month** |

### Cost Optimization Levers

| Lever | Saving |
|---|---|
| Scale-to-zero outside business hours | ~$20–40/month |
| Use `fast` tier for classification (not `reasoning`) | ~$200/month at scale |
| Prompt caching (repeated system prompts) | ~15–20% token reduction (when supported by model) |
| Session-level tool call caching | ~10% token reduction |
| Log Analytics data cap | Cap at 5 GB/day: ~$12/month saved |
| Archive blobs after 30 days instead of 90 | ~$5/month |

---

## Infrastructure as Code

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryTextColor': '#1a1a1a', 'lineColor': '#555'}}}%%
graph TB
    main["main.tf\n(root module)"]
    
    subgraph "modules/"
        net["networking\nVNet, subnets, NSGs"]
        ca["container_apps\nEnvironment, apps, revisions"]
        sb["service_bus\nNamespace, work queue (ADR-027)"]
        st["storage\nAccount, tables, containers"]
        kv["keyvault\nVault, RBAC"]
        ai["ai_foundry\nHub, project, deployments"]
        mon["observability\nLog Analytics"]
        id["managed_identity\nUser-assigned identities"]
        grafana["grafana\nManaged Grafana"]
        acr["container_registry\nACR"]
    end
    
    main --> net
    main --> ca
    main --> sb
    main --> st
    main --> kv
    main --> ai
    main --> mon
    main --> id
    main --> grafana
    main --> acr
    
    ca --> net
    ca --> id
    ca --> mon
    sb --> id
    st --> id
    kv --> id
    ai --> id
    
    style main fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style net fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
    style ca fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
    style id fill:#fadbd8,stroke:#e6a8a0,color:#1a1a1a
```

**11 Terraform modules, one root module.** `main.tf` orchestrates the deployment by calling child modules and passing dependencies. Modules that require networking (Container Apps) depend on `networking` for VNet + subnet IDs. `managed_identity` is a dependency for Container Apps, Key Vault, Storage, Service Bus, and AI Foundry role assignments.

All infrastructure is version-controlled in the same Git repo as the application code. GitHub Actions runs `terraform fmt -check`, `terraform init -backend=false`, `terraform validate`, and `terraform test` inside `infra/terraform`. Deployments use `terraform plan` and `terraform apply` with environment-specific variable files (`environments/dev/terraform.tfvars`, etc.).

### Terraform Workflow Summary

| Command | Purpose | Location |
|---|---|---|
| `terraform fmt -recursive` | Format all `.tf` and `.tfvars` files | `infra/terraform` |
| `terraform init -backend=false` | Initialize providers without remote state | `infra/terraform` |
| `terraform validate` | Validate configuration | `infra/terraform` |
| `terraform test` | Run mock-based integration tests | `infra/terraform` |
| `terraform plan` | Preview changes | `infra/terraform` or `environments/dev` |
| `terraform apply` | Apply changes | `infra/terraform` or `environments/dev` |

Helper scripts are also exposed through `infra/package.json`: `pnpm --filter infra fmt`, `pnpm --filter infra validate`, `pnpm --filter infra test`, `pnpm --filter infra plan`, `pnpm --filter infra apply`.


