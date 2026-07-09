# Azure Architecture Design

> **Date:** 2026-06-06  
> **Status:** Draft  
> **Complements:** [physical-architecture.md](./physical-architecture.md), [logical-architecture.md](./logical-architecture.md)

---

## Table of Contents

1. [Architecture Diagrams](#architecture-diagrams)
2. [Resource Inventory](#resource-inventory)
3. [Resource Sizing Rationale](#resource-sizing-rationale)
4. [Networking Deep Dive](#networking-deep-dive)
5. [Identity Deep Dive](#identity-deep-dive)
6. [AI Foundry Deployment Strategy](#ai-foundry-deployment-strategy)
7. [Security Baseline](#security-baseline)
8. [Environments](#environments)
9. [CI/CD Pipeline](#cicd-pipeline)
10. [Operational Runbooks](#operational-runbooks)
11. [Terraform Module Inventory](#terraform-module-inventory)
12. [Discoveries](#discoveries)

---

## Architecture Diagrams

### Azure Resource Map

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryTextColor': '#1a1a1a', 'lineColor': '#555' }}}%%
graph TB
    subgraph "Azure Subscription"
        direction TB
        
        subgraph "Resource Group: goose-framework-{env}"
            direction TB
            
            subgraph "Compute"
                ca_env["Container Apps Environment\n(Consumption plan)"]
                orch["Orchestrator App\n(1-5 replicas)"]
                slack_app["Slack Bot App\n(1 replica)"]
                teams_app["Teams Bot App\n(1 replica)"]
            end
            
            subgraph "Messaging"
                sb_ns["Service Bus Namespace\n(Standard tier)"]
                sb_topic["Topic: minion-tasks"]
                sb_subs["5 Subscriptions\n(1 per minion type)"]
            end
            
            subgraph "Storage"
                st_acct["Storage Account\n(LRS / ZRS)"]
                st_table["Table: ToolCallLog"]
                st_blob_out["Container: minion-outputs"]
                st_blob_backup["Container: sqlite-backups"]
            end
            
            subgraph "Security"
                kv["Key Vault\n(Standard)"]
                mi_orch["Orchestrator MI\n(User-assigned)"]
                mi_bots["Bot MIs\n(User-assigned)"]
            end
            
            subgraph "AI"
                foundry_hub["AI Hub"]
                foundry_proj["AI Project"]
                foundry_deploy["Model Deployments\n(5 tiers)"]
            end
            
            subgraph "Observability"
                la_ws["Log Analytics\nWorkspace"]
                grafana["Managed Grafana\n(Essential)"]
                alerts["Alert Rules\n(7 rules)"]
            end
            
            subgraph "Registry"
                acr["Container Registry\n(Basic)"]
            end
        end
    end
    
    ca_env --> orch
    ca_env --> slack_app
    ca_env --> teams_app
    
    orch -->|"AMQP:5671"| sb_ns
    orch -->|"HTTPS:443"| st_acct
    orch -->|"HTTPS:443"| foundry_proj
    orch -.->|"MI"| kv
    orch -.->|"MI"| mi_orch
    
    slack_app -.->|"MI"| kv
    teams_app -.->|"MI"| kv
    
    orch -->|"stdout"| la_ws
    la_ws --> grafana
    la_ws --> alerts
    
    acr -->|"image pull"| ca_env
    
    style orch fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style sb_ns fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
    style st_acct fill:#fcf3cf,stroke:#d4ac0d,color:#1a1a1a
    style foundry_proj fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
```

### Network Topology (Azure View)

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryTextColor': '#1a1a1a', 'lineColor': '#555' }}}%%
graph LR
    subgraph "Internet"
        slack["Slack API"]
        teams["Teams API"]
        github["GitHub MCP"]
        ado["Azure DevOps MCP"]
        sn["ServiceNow MCP"]
        jira["Jira MCP"]
    end
    
    subgraph "Azure: goose-framework-vnet (10.0.0.0/16)"
        subgraph "snet-container-apps (10.0.1.0/24)"
            orch["Orchestrator"]
            bots["Bot Containers"]
        end
        
        subgraph "snet-private-endpoints (10.0.2.0/24)"
            pe_sb["PE: Service Bus"]
            pe_st["PE: Storage"]
            pe_kv["PE: Key Vault"]
            pe_foundry["PE: AI Foundry"]
            pe_acr["PE: ACR"]
        end
    end
    
    subgraph "Azure Managed Services"
        sb["Service Bus"]
        st["Storage Account"]
        kv["Key Vault"]
        foundry["AI Foundry"]
        acr["Container Registry"]
        la["Log Analytics"]
    end
    
    slack -->|"HTTPS:443"| bots
    teams -->|"HTTPS:443"| bots
    
    orch -->|"AMQP:5671 → PE"| pe_sb
    orch -->|"HTTPS:443 → PE"| pe_st
    orch -.->|"MI token → PE"| pe_kv
    orch -->|"HTTPS:443 → PE"| pe_foundry
    
    orch -->|"HTTPS:443 (public)"| github
    orch -->|"HTTPS:443 (public)"| ado
    orch -->|"HTTPS:443 (public)"| sn
    orch -->|"HTTPS:443 (public)"| jira
    
    pe_sb --- sb
    pe_st --- st
    pe_kv --- kv
    pe_foundry --- foundry
    pe_acr --- acr
    
    orch -->|"stdout → AMA"| la
    
    style orch fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style bots fill:#fcf3cf,stroke:#d4ac0d,color:#1a1a1a
```

---

## Resource Inventory

### Naming Convention

```
Pattern: {type}-{app}-{env}-{region}

Examples:
  ca-goosefw-prod-uksouth        Container Apps Environment
  sb-goosefw-prod                Service Bus Namespace
  stgoosefwprod                  Storage Account (alphanumeric only)
  kv-goosefw-prod                Key Vault
  foundry-goosefw-prod           AI Foundry Hub
  acrgoosefw                     Container Registry (unique, alphanumeric)
```

### Full Inventory

| Resource | Name | SKU | Purpose |
|---|---|---|---|
| **Resource Group** | `rg-goosefw-{env}` | — | Logical container |
| **VNet** | `vnet-goosefw-{env}` | — | 10.0.0.0/16 |
| **Subnet: container-apps** | `snet-ca-goosefw-{env}` | — | 10.0.1.0/24, delegated to Microsoft.App |
| **Subnet: private-endpoints** | `snet-pe-goosefw-{env}` | — | 10.0.2.0/24 |
| **NSG: container-apps** | `nsg-ca-goosefw-{env}` | — | Inbound: 443 from Internet; Outbound: 443, 5671 |
| **NSG: private-endpoints** | `nsg-pe-goosefw-{env}` | — | Inbound: 443, 5671 from container-apps |
| **Container Apps Environment** | `cae-goosefw-{env}` | Consumption | Workload profiles: Consumption |
| **Container App: Orchestrator** | `ca-orchestrator-{env}` | — | 1 vCPU, 2 GB, 1–5 replicas |
| **Container App: Slack Bot** | `ca-slackbot-{env}` | — | 0.5 vCPU, 1 GB, 1 replica |
| **Container App: Teams Bot** | `ca-teamsbot-{env}` | — | 0.5 vCPU, 1 GB, 1 replica |
| **Service Bus Namespace** | `sb-goosefw-{env}` | Standard | Sessions, DLQ, duplicate detection |
| **Service Bus Topic** | `minion-tasks` | — | All minion tasks |
| **Service Bus Subscriptions** | `code-explorer`, `code-reviewer`, `pr-crafter`, `ticket-analyst`, `security-auditor` | — | Filtered by minion_type property |
| **Storage Account** | `stgoosefw{env}` | LRS / ZRS | Tables + Blobs |
| **Table** | `ToolCallLog` | — | Immutable tool call log |
| **Blob Container** | `minion-outputs` | Cool | Full minion output artifacts |
| **Blob Container** | `sqlite-backups` | Cool | Orchestrator SQLite WAL snapshots |
| **Key Vault** | `kv-goosefw-{env}` | Standard | MCP credentials, bot secrets |
| **AI Foundry Hub** | `foundry-goosefw-{env}` | — | Model catalog, content safety |
| **AI Foundry Project** | `foundry-goosefw-project` | — | Deployments, endpoints |
| **AI Foundry Deployments** | `fast`, `reasoning`, `code-review`, `code-gen`, `security` | Various | 5 model tiers |
| **Log Analytics Workspace** | `la-goosefw-{env}` | Pay-as-you-go | 31-day retention default |
| **Managed Grafana** | `graf-goosefw-{env}` | Essential | 2 dashboards, 5 users |
| **Container Registry** | `acrgoosefw` | Basic | Container images |
| **Managed Identity: Orchestrator** | `mi-orch-goosefw-{env}` | User-assigned | Azure service auth |
| **Managed Identity: Slack Bot** | `mi-slack-goosefw-{env}` | User-assigned | KV access |
| **Managed Identity: Teams Bot** | `mi-teams-goosefw-{env}` | User-assigned | KV access |

---

## Resource Sizing Rationale

### Why Consumption Plan (not Dedicated)

| Factor | Consumption | Dedicated |
|---|---|---|
| Minimum monthly cost | $0 (scale-to-zero) | ~$150 (1 worker, always on) |
| Cold start | 5–15 seconds | None |
| vCPU max | 4.0 | 32.0 |
| Session isolation | Per-request | Shared worker |
| Stateful workloads | Not supported | Supported |

**Our workload is event-driven and bursty.** Sessions arrive via Slack/Teams messages — sporadic, mostly during business hours. There is no steady stream of requests. Consumption plan's scale-to-zero saves $100+/month vs. Dedicated. Cold start latency is acceptable because:
- Bots are always warm (1 replica minimum)
- The orchestrator's first classification takes <1 second of LLM time; the 5–15s cold start is hidden behind the bot's "working..." acknowledgment

### Why Service Bus Standard (not Premium)

| Feature | Standard | Premium |
|---|---|---|
| Sessions | ✅ | ✅ |
| Dead-letter | ✅ | ✅ |
| Duplicate detection | ✅ | ✅ |
| Message size | 256 KB | 100 MB |
| Cost | $10/month | ~$700/month |
| Availability zones | Paired region | Within region |

Standard tier provides all messaging features the framework needs. Large context payloads (>256 KB) go via Blob Storage with a SAS URL in the Service Bus message — the Premium tier's 100 MB message size is unnecessary.

### Why LRS (not ZRS for dev)

| Environment | Storage Redundancy | Rationale |
|---|---|---|
| Dev | LRS | Cost optimization. Data loss is acceptable. |
| Staging | LRS | Cost optimization. |
| Production | ZRS | Zone redundancy. Survives a single zone failure. |

### Why AI Foundry PTU is Optional

Provisioned Throughput (PTU) guarantees capacity and predictable cost. Pay-as-you-go (PayGo) is cheaper at low volume but may throttle under load.

| Scenario | Recommendation |
|---|---|---|
| Dev/Staging | PayGo — minimal cost |
| Production, <200 sessions/day | PayGo — cheaper than PTU minimum |
| Production, >200 sessions/day | PTU for `reasoning` and `code_review` tiers |
| Production, spiky | PayGo + alert if throttling detected |

---

## Networking Deep Dive

### Private Endpoint DNS

Each private endpoint creates a private DNS zone for its service. Container Apps resolves these to private IPs within the VNet.

```
Private DNS Zones (auto-created):

privatelink.servicebus.windows.net
  └── sb-goosefw-prod → 10.0.2.4

privatelink.table.core.windows.net
  └── stgoosefwprod → 10.0.2.5

privatelink.blob.core.windows.net
  └── stgoosefwprod → 10.0.2.6

privatelink.vaultcore.azure.net
  └── kv-goosefw-prod → 10.0.2.7

privatelink.openai.azure.com
  └── foundry-goosefw-prod → 10.0.2.8

privatelink.azurecr.io
  └── acrgoosefw → 10.0.2.9
```

### Egress Paths

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryTextColor': '#1a1a1a', 'lineColor': '#555'}}}%%
flowchart LR
    orch["Orchestrator\nContainer"]
    
    subgraph "Private (via PE)"
        sb_pe["Service Bus\nAMQP:5671"]
        st_pe["Storage\nHTTPS:443"]
        kv_pe["Key Vault\nHTTPS:443"]
        foundry_pe["AI Foundry\nHTTPS:443"]
    end
    
    subgraph "Public Internet"
        gh["GitHub MCP\napi.github.com"]
        ado["Azure DevOps MCP\ndev.azure.com"]
        sn["ServiceNow MCP\n*.service-now.com"]
        jira["Jira MCP\n*.atlassian.net"]
        slack["Slack API\nslack.com"]
        teams["Teams API\nsmba.trafficmanager.net"]
    end
    
    orch -->|"Managed Identity"| sb_pe
    orch -->|"Managed Identity"| st_pe
    orch -.->|"Managed Identity"| kv_pe
    orch -->|"Managed Identity"| foundry_pe
    orch -->|"PAT from KV"| gh
    orch -->|"PAT from KV"| ado
    orch -->|"Basic Auth from KV"| sn
    orch -->|"API Token from KV"| jira
    orch -->|"Bot Token from KV"| slack
    orch -->|"Azure AD Token from MI"| teams
    
    style orch fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style sb_pe fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
    style st_pe fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
    style kv_pe fill:#fadbd8,stroke:#e6a8a0,color:#1a1a1a
    style foundry_pe fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
```

**Two egress paths, two auth models.** Azure services (left) use Managed Identity over private endpoints — no credentials in code. External MCP servers (right) use PATs or API tokens fetched from Key Vault at startup. Teams is the exception — it uses Azure AD token via managed identity, sharing auth with the Azure services.

| Destination | Path | Authentication |
|---|---|---|
| GitHub MCP (api.github.com) | Internet (public) | PAT from Key Vault |
| Azure DevOps MCP (dev.azure.com) | Internet (public) | PAT from Key Vault |
| ServiceNow MCP | Internet (public) | Basic auth from Key Vault |
| Jira MCP | Internet (public) | API token from Key Vault |
| Slack API | Internet (public) | Bot token from Key Vault |
| Teams API | Internet (public) | Azure AD token via MI |
| AI Foundry | Private endpoint | Managed Identity |
| Service Bus | Private endpoint | Managed Identity |
| Storage Account | Private endpoint | Managed Identity |
| Key Vault | Private endpoint | Managed Identity |

### Ingress Paths

| Source | Target | Authentication |
|---|---|---|
| Slack (slack.com) | ca-slackbot-*.azurecontainerapps.io | Slack signing secret |
| Teams (botframework.com) | ca-teamsbot-*.azurecontainerapps.io | Bot Framework auth |
| GitHub Actions (CI/CD) | Azure Resource Manager (public) | OIDC federation |
| Operator (dashboard) | ca-dashboard-*.azurecontainerapps.io | Azure AD (future) |

---

## Identity Deep Dive

### Managed Identity Hierarchy

```
User-Assigned Managed Identities
├── mi-orch-goosefw-{env}
│   ├── Role: Storage Table Data Contributor → stgoosefw{env}
│   ├── Role: Storage Blob Data Contributor → stgoosefw{env}
│   ├── Role: Azure Service Bus Data Sender → sb-goosefw-{env}
│   ├── Role: Azure Service Bus Data Receiver → sb-goosefw-{env}
│   ├── Role: Cognitive Services OpenAI User → foundry-goosefw-{env}
│   └── Role: Key Vault Secrets User → kv-goosefw-{env}
│
├── mi-slack-goosefw-{env}
│   └── Role: Key Vault Secrets User → kv-goosefw-{env}
│       (scope: secret/slack-signing-secret, secret/slack-bot-token)
│
└── mi-teams-goosefw-{env}
    └── Role: Key Vault Secrets User → kv-goosefw-{env}
        (scope: secret/teams-bot-password)
```

### Least Privilege Principle

| Identity | What it can access | What it CANNOT access |
|---|---|---|
| Orchestrator MI | SB: send/receive. Storage: read/write tables+blobs. Foundry: call models. KV: read secrets. | Delete resources. Modify RBAC. Access other Key Vaults. |
| Slack Bot MI | KV: read Slack secrets only | Everything else |
| Teams Bot MI | KV: read Teams secrets only | Everything else |
| GitHub OIDC | ACR: push/pull. Container Apps: update revisions. | Read secrets from KV. Access production data. |

### Key Vault RBAC (not Access Policies)

Key Vault uses **RBAC authorization** (not legacy Access Policies) for consistent Azure RBAC across all resources.

```hcl
# Terraform example
resource "azurerm_role_assignment" "kv_role" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.orchestrator.principal_id
}
```

---

## AI Foundry Deployment Strategy

### Hub and Project Model

```
AI Foundry Hub: foundry-goosefw-{env}
├── Content Safety: enabled (prompt injection, hate speech, violence, self-harm)
├── Network Isolation: private endpoint
│
└── AI Project: goosefw-orchestration
    │   (Model names are never hardcoded — operators configure current models
    │    via rules/models.yaml and terraform.tfvars at deploy time.)
    │
    ├── Deployment: fast  (operator-configured; Azure OpenAI or catalog model)
    │   ├── SKU: operator-configured (GlobalStandard PayGo or PTU)
    │   ├── Capacity: operator-configured TPM
    │   └── Content Filter: DefaultV2
    │
    ├── Deployment: reasoning  (operator-configured)
    │   ├── SKU: operator-configured
    │   ├── Capacity: operator-configured TPM
    │   └── Content Filter: DefaultV2
    │
    ├── Deployment: code-review  (operator-configured; catalog models supported)
    │   ├── SKU: operator-configured
    │   ├── Capacity: operator-configured TPM
    │   └── Content Filter: DefaultV2
    │
    ├── Deployment: code-gen  (operator-configured)
    │   ├── SKU: operator-configured
    │   ├── Capacity: operator-configured TPM
    │   └── Content Filter: DefaultV2
    │
    └── Deployment: security  (operator-configured; catalog models supported)
        ├── SKU: operator-configured
        ├── Capacity: operator-configured TPM
        └── Content Filter: DefaultV2
```

### Content Safety Configuration

| Filter | Severity Threshold | Action |
|---|---|---|
| Prompt injection (jailbreak) | Low | Block request, log event |
| Hate speech | Medium | Block request |
| Violence | Medium | Block request |
| Self-harm | Low | Block request |
| Sexual content | Medium | Block request |

Content safety is enabled at the AI Foundry level — no code in Goose handles content filtering.

### Model Upgrade Process

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryTextColor': '#1a1a1a', 'lineColor': '#555'}}}%%
flowchart LR
    available["New Model\nAvailable in\nFoundry Catalog"]
    deploy["Deploy as\n{name}-v2"]
    update_config["Update\nrules/models.yaml\n+ terraform.tfvars"]
    pr_review["PR Review\n+ Merge"]
    deploy_config["CI/CD Deploys\nConfig Only"]
    monitor["Monitor 24hr\nError Rate + Latency"]
    cleanup["Delete Old\n{name}-v1"]
    
    available --> deploy
    deploy --> update_config
    update_config --> pr_review
    pr_review --> deploy_config
    deploy_config --> monitor
    monitor -->|"no regression"| cleanup
    monitor -->|"regression ⚠️"| rollback["Rollback\nrevert models.yaml"]
    rollback --> pr_review
    
    style available fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
    style monitor fill:#fcf3cf,stroke:#d4ac0d,color:#1a1a1a
    style cleanup fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style rollback fill:#fadbd8,stroke:#e6a8a0,color:#1a1a1a
```

1. New model version available in AI Foundry catalog (or external provider)
2. Deploy new model to a new AI Foundry deployment (e.g., `fast-v2`) — only needed for Azure-hosted models
3. Update `rules/models.yaml` → set `deployment` for the tier to the new deployment name; update `infra/terraform/environments/<env>/terraform.tfvars` if using AI Foundry
4. Deploy config change via CI/CD (no container rebuild required)
5. Monitor error rate and latency for 24 hours
6. Delete old deployment if Azure-hosted (`fast-v1`)

**Model changes are a config deployment, not a code change.** No model names are hardcoded in the codebase — operators choose current models in `rules/models.yaml` and `terraform.tfvars` at deploy time.

---

## Security Baseline

### Azure Policy Assignments

| Policy | Scope | Effect |
|---|---|---|
| Key Vault secrets should have expiration dates | `rg-goosefw-*` | Audit (90-day expiry recommended) |
| Storage accounts should use private endpoints | `rg-goosefw-*` | Deny public access |
| Container Apps should use private endpoints | `rg-goosefw-*` | Audit (Managed TLS is public) |
| Service Bus should use private endpoints | `rg-goosefw-*` | Deny public access |
| AI Foundry should disable public network access | `rg-goosefw-*` | Deny public access |
| Subnets should have NSGs | All subnets | Deny |
| Managed Identities should be used | `rg-goosefw-*` | Audit |

### Defender for Cloud

Enable Defender for Cloud (free tier) on the subscription. Recommendations:
- Enable encryption-at-rest for all storage accounts ✅ (default)
- Enable soft delete for Key Vault ✅ (default, 90 days)
- Enable soft delete for Blob Storage ✅ (7 days minimum)
- Enable versioning for Blob Storage ✅

### Secret Rotation

| Secret | Rotation Cadence | Automation |
|---|---|---|
| GitHub PAT | 90 days | Manual (GitHub App token preferred — auto-rotating) |
| Azure DevOps PAT | 90 days | Manual |
| ServiceNow password | Per org policy | Manual |
| Jira API token | Per org policy | Manual |
| Slack signing secret | Never (Slack-managed) | — |
| Teams bot password | Per org policy | Manual |

---

## Environments

### Environment Strategy

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryTextColor': '#1a1a1a', 'lineColor': '#555'}}}%%
flowchart LR
    dev["🔧 Dev\nScale-to-zero\nSynthetic data"]
    staging["🧪 Staging\n1 warm replica\nAnonymized data"]
    prod["🚀 Production\nAutoscale\nLive data"]
    
    pr["Pull Request"] -->|"preview deploy"| dev
    dev -->|"integration tests"| staging
    staging -->|"approval gate"| prod
    
    staging -->|"canary: 10% traffic, 1hr"| prod
    prod -->|"rollback on alert"| staging
    
    style dev fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
    style staging fill:#fcf3cf,stroke:#d4ac0d,color:#1a1a1a
    style prod fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style pr fill:#fadbd8,stroke:#e6a8a0,color:#1a1a1a
```

| Environment | Purpose | Scaling | Data |
|---|---|---|---|
| **dev** | Active development, PR testing | Scale-to-zero when idle | Synthetic test data only |
| **staging** | Pre-production validation | 1 warm replica during test hours | Anonymized production data (optional) |
| **prod** | Production | Scale with demand | Live data |

### Per-Environment Configuration

| Setting | dev | staging | prod |
|---|---|---|---|
| Container Apps plan | Consumption | Consumption | Consumption |
| Service Bus tier | Standard | Standard | Standard |
| Storage redundancy | LRS | LRS | ZRS |
| AI Foundry SKU | PayGo | PayGo | PayGo (PTU optional) |
| Log Analytics retention | 30 days | 30 days | 90 days |
| Key Vault soft delete | 7 days | 7 days | 90 days |
| Grafana | Essential | Essential | Standard ($9/user if >5 users) |
| Private endpoints | 3 (SB, Storage, KV) | 5 (+ACR, Foundry) | 6 (all) |
| Scale-to-zero outside hours | Yes | Yes | No (1 replica minimum) |

---

## CI/CD Pipeline

### Pipeline Architecture

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryTextColor': '#1a1a1a', 'lineColor': '#555'}}}%%
flowchart TB
    pr_open["PR Opened"]
    lint["Lint\nTerraform, YAML, Markdown"]
    unit_test["Unit Tests\nper extension"]
    preview["Preview Deploy\n(dev env)"]
    
    merge["Merge to main"]
    build["Build Images\norchestrator, bots"]
    push["Push to ACR\nlatest + git-sha"]
    infra_plan["Terraform Plan"]
    infra_apply["Terraform Apply"]
    
    staging_canary["Staging Canary\n10% traffic, 15 min"]
    staging_full["Staging Full"]
    prod_canary["Production Canary\n10% traffic, 1 hr"]
    prod_full["Production Full"]
    
    pr_open --> lint
    lint --> unit_test
    unit_test --> preview
    
    merge --> build
    build --> push
    push --> infra_plan
    infra_plan --> infra_apply
    infra_apply --> staging_canary
    staging_canary --> staging_full
    staging_full -->|"manual approval"| prod_canary
    prod_canary --> prod_full
    
    style pr_open fill:#fadbd8,stroke:#e6a8a0,color:#1a1a1a
    style merge fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style prod_full fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style staging_canary fill:#fcf3cf,stroke:#d4ac0d,color:#1a1a1a
    style prod_canary fill:#fcf3cf,stroke:#d4ac0d,color:#1a1a1a
```

```
GitHub Repo: org/minions-agent-framework
│
├── PR opened
│   ├── Lint (Terraform, YAML, Markdown)
│   ├── Unit tests (per extension)
│   └── Preview deployment (dev environment)
│
├── Merge to main
│   ├── Build container images
│   │   ├── orchestrator
│   │   ├── slack-bot
│   │   └── teams-bot
│   ├── Push to ACR
│   │   ├── Tag: latest
│   │   └── Tag: git-sha
│   ├── Deploy infrastructure (Terraform)
│   │   ├── Plan
│   │   └── Apply
│   └── Deploy containers
│       ├── Staging: canary (10% traffic, 15 min)
│       ├── Staging: full rollout
│       ├── Prod: canary (10% traffic, 1 hour)
│       └── Prod: full rollout
│
└── Scheduled (weekly)
    ├── Security scan (container images)
    ├── Dependency update (automated PR)
    └── Cost report to Teams
```

### GitHub Actions Workflows

```
.github/workflows/
├── ci.yml                 # PR: typecheck, build, lint, unit tests, Terraform fmt/validate/test
├── terraform-plan.yml     # PR: Terraform plan for the target environment (OIDC)
├── terraform-apply.yml    # Merge to main: Terraform apply for the target environment (OIDC, env protection)
└── build.yml              # Build + push container images (future)
```

See [`docs/terraform-bootstrap.md`](./terraform-bootstrap.md) for OIDC setup and backend bootstrap instructions.

---

## Operational Runbooks

### Runbook 1: Deploy a Model Tier Update

1. Confirm new model is available in AI Foundry catalog
2. Create new deployment in AI Foundry (e.g., `reasoning-v2`)
3. Update `provider.yaml`: change `reasoning` tier deployment to `reasoning-v2`
4. PR → review → merge
5. CI/CD deploys config change (no container rebuild)
6. Monitor Grafana dashboard "Cost & Capacity" for 24 hours
7. If error rate < baseline, delete old deployment

### Runbook 2: Investigate a Failed Session

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryTextColor': '#1a1a1a', 'lineColor': '#555'}}}%%
flowchart TB
    report["User reports:\n'PR review never completed'"]
    search["Dashboard → Session Explorer\nSearch by user or time"]
    select["Click session →\nCorrelation Tree"]
    identify["Identify failed minion\n(🔴 red node)"]
    details["Click node →\nError: 'ServiceNow MCP timeout'"]
    grafana["Check Grafana →\nMinion Health dashboard"]
    transient{"Transient\nfailure?"}
    retry["Click 'Retry Failed'\nin dashboard"]
    escalate["Escalate to\nServiceNow team"]
    resolved["Session completes ✅"]
    
    report --> search
    search --> select
    select --> identify
    identify --> details
    details --> grafana
    grafana --> transient
    transient -->|"yes, retryable"| retry
    transient -->|"no, persistent issue"| escalate
    retry --> resolved
    escalate --> resolved
    
    style report fill:#fadbd8,stroke:#e6a8a0,color:#1a1a1a
    style identify fill:#fadbd8,stroke:#e6a8a0,color:#1a1a1a
    style resolved fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style grafana fill:#fcf3cf,stroke:#d4ac0d,color:#1a1a1a
```

1. User reports: "My PR review never completed"
2. Open dashboard → Session Explorer
3. Search by user or approximate time
4. Click session → Correlation Tree
5. Identify failed minion (red node)
6. Click failed minion → see error: "ServiceNow MCP timeout"
7. Check Grafana → Minion Health → ServiceNow latency spike
8. If transient: click "Retry Failed" in dashboard
9. If persistent: escalate to ServiceNow team; check MCP server health

### Runbook 3: Recover from Orchestrator Crash

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryTextColor': '#1a1a1a', 'lineColor': '#555'}}}%%
flowchart TB
    alert["⚠️ Grafana Alert:\n'Orchestrator replicas = 0'\nSev-1 → Teams + SMS"]
    check_logs["Check Container Apps logs\nLog Analytics KQL"]
    diagnose{"Diagnosis?"}
    oom["OOM Kill\nIncrease memory\nin Terraform"]
    startup["Startup Failure\nCheck ACR image\npull logs"]
    config["Config Error\nCheck provider.yaml\nsyntax"]
    respawn["KEDA auto-respawns\ncontainer"]
    restore["SQLite restored from\nlatest Blob backup\n(RPO < 15 min)"]
    replay["Queued Service Bus\nmessages re-delivered"]
    adjust["Adjust backup\nfrequency if RPO\ntoo high"]
    healthy["Orchestrator healthy ✅"]
    
    alert --> check_logs
    check_logs --> diagnose
    diagnose -->|"OOM"| oom
    diagnose -->|"startup"| startup
    diagnose -->|"config"| config
    oom --> respawn
    startup --> respawn
    config --> respawn
    respawn --> restore
    restore --> replay
    replay --> healthy
    healthy -.-> adjust
    
    style alert fill:#fadbd8,stroke:#e6a8a0,color:#1a1a1a
    style healthy fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style respawn fill:#d6eaf8,stroke:#7fb3d8,color:#1a1a1a
```

1. Grafana alert: "Orchestrator replicas = 0" (Sev-1)
2. Check Container Apps logs in Log Analytics
3. If OOM: check SQLite size; increase memory allocation in Terraform
4. If startup failure: check container image pull logs in ACR
5. KEDA automatically respawns the container
6. SQLite restored from latest Blob backup (<15 min RPO)
7. Queued Service Bus messages re-delivered to new replica
8. Review: adjust SQLite backup frequency if RPO is too high

### Runbook 4: Scale AI Foundry Capacity

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryTextColor': '#1a1a1a', 'lineColor': '#555'}}}%%
flowchart TB
    trigger["⚠️ Grafana Alert:\n'AI Foundry throttling > 5%'\nSev-2 → Teams"]
    dashboard["Check Cost & Capacity\ndashboard → throttling trend"]
    sustained{"Sustained > 2 hours?"}
    wait["Monitor 1 more hour\nMay be transient spike"]
    increase_paygo["Increase TPM\nin Foundry deployment\n(PayGo)"]
    increase_ptu["Provision additional\nPTU units"]
    terraform["Update Terraform module\n+ PR + deploy"]
    monitor_result["Monitor 1 hour"]
    still_throttling{"Still throttling?"}
    resolved["Throttling resolved ✅"]
    
    trigger --> dashboard
    dashboard --> sustained
    sustained -->|"no, transient"| wait
    wait --> sustained
    sustained -->|"yes"| increase_paygo
    increase_paygo --> terraform
    increase_ptu --> terraform
    terraform --> monitor_result
    monitor_result --> still_throttling
    still_throttling -->|"yes"| increase_paygo
    still_throttling -->|"no"| resolved
    
    style trigger fill:#fadbd8,stroke:#e6a8a0,color:#1a1a1a
    style resolved fill:#d5f5e3,stroke:#82c091,color:#1a1a1a
    style terraform fill:#fcf3cf,stroke:#d4ac0d,color:#1a1a1a
```

1. Grafana alert: "AI Foundry throttling rate > 5%" (Sev-2)
2. Check "Cost & Capacity" dashboard → throttling trend
3. If sustained >2 hours: increase TPM for affected tier
   - PayGo: increase capacity in AI Foundry deployment settings
   - PTU: provision additional PTU units
4. Update Terraform module → PR → deploy
5. Monitor for 1 hour; if throttling persists, repeat

---

## Terraform Module Inventory

Infrastructure is defined in `infra/terraform/` using Terraform 1.9+ with the `azurerm`, `azapi`, and `random` providers.

| Module | Path | Purpose |
|---|---|---|
| `resource_group` | `modules/resource_group/` | Resource group container |
| `networking` | `modules/networking/` | VNet `10.0.0.0/16`, Container Apps subnet, private endpoint subnet, NSG |
| `observability` | `modules/observability/` | Log Analytics workspace |
| `managed_identity` | `modules/managed_identity/` | User-assigned identities for orchestrator and bots |
| `keyvault` | `modules/keyvault/` | Key Vault with RBAC and role assignments |
| `storage` | `modules/storage/` | Storage account, `ToolCallLog` table, blob containers, role assignments |
| `service_bus` | `modules/service_bus/` | Standard namespace, `minion-tasks` topic, 5 subscriptions, role assignments |
| `container_registry` | `modules/container_registry/` | Basic ACR and role assignments |
| `container_apps` | `modules/container_apps/` | Container Apps Environment, orchestrator, slack bot, teams bot, KEDA scale rule |
| `ai_foundry` | `modules/ai_foundry/` | AI Hub and AI Project via `azapi`, model deployments |
| `grafana` | `modules/grafana/` | Managed Grafana Essential, role assignments |

Root module files:

- `main.tf` — wires all child modules together.
- `variables.tf` — `name_prefix`, `environment`, `location`, `tags`, `enable_grafana`, `ai_model_deployments`.
- `outputs.tf` — resource group name, storage account name, service bus endpoint, ACR login server, Key Vault URI, Container App Environment ID.
- `providers.tf` — Terraform >= 1.9, `azurerm` ~> 3.0, `azapi` ~> 1.0, `random` ~> 3.0.
- `backend.tf` — `backend "azurerm" {}` placeholder (credentials supplied at runtime).

Environment wrappers:

- `environments/dev/main.tf` — thin wrapper calling the root module.
- `environments/dev/terraform.tfvars` — dev defaults.

### State Backend

The root module declares `backend "azurerm" {}` with no credentials. CI/CD and operators supply the storage account, container, key, and subscription details via `-backend-config` or environment variables. State files and `.terraform/` are ignored by `.gitignore`; never commit them.

---

## Discoveries

- **AI Foundry Hub and Project require `azapi`.** The `azurerm` provider does not natively expose AI Foundry Hub/Project resources as of v3.x, so the `modules/ai_foundry` uses `azapi_resource` with `Microsoft.MachineLearningServices/workspaces` and `kind = "Hub"` / `"Project"`.
- **Container Apps Environment requires a Log Analytics workspace.** `azurerm_container_app_environment` needs `log_analytics_workspace_id`; observability is provisioned before compute.
- **Globally unique names need random suffixes.** Storage accounts and container registries must be globally unique and are generated with `random_string` plus the `name_prefix` and `environment` values.
- **Key Vault soft delete is always enabled in `azurerm` v3.** The `soft_delete_enabled` argument was removed in v3.x because soft delete is mandatory; the module exposes an output confirming soft delete is active and sets `soft_delete_retention_days` to 90 by default.
