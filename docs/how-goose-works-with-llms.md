# How Goose Works with LLMs

> **Date:** 2026-06-06  
> **Purpose:** Clarify how Goose calls LLMs, how the agent harness works, and how Azure AI Foundry fits in.

---

## Table of Contents

1. [The Goose Agent Loop](#the-goose-agent-loop)
2. [How Goose Calls an LLM](#how-goose-calls-an-llm)
3. [Provider Abstraction](#provider-abstraction)
4. [Goose's Own Harness vs. Native LLM Harness](#gooses-own-harness-vs-native-llm-harness)
5. [How Tool Calling Works](#how-tool-calling-works)
6. [Azure AI Foundry Integration](#azure-ai-foundry-integration)
7. [Multi-Model Routing in the Framework](#multi-model-routing-in-the-framework)
8. [Token Consumption & Cost Management](#token-consumption--cost-management)
9. [GitHub Copilot — Can Goose Use It?](#github-copilot--can-goose-use-it)
10. [What Goose Does NOT Do](#what-goose-does-not-do)

---

## The Goose Agent Loop

Goose implements its **own agent harness** — it does not delegate agentic behavior to the LLM. The LLM is treated as a reasoning engine. Goose controls the loop.

```
┌───────────────────────────────────────────────────────────┐
│                    GOOSE AGENT LOOP                         │
│                                                             │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐          │
│   │  THINK   │────▶│   ACT    │────▶│ OBSERVE  │──┐       │
│   │          │     │          │     │          │  │       │
│   │ LLM call │     │ Execute  │     │ Collect  │  │       │
│   │ returns  │     │ tool(s)  │     │ result(s)│  │       │
│   │ text or  │     │          │     │          │  │       │
│   │ tool call│     │          │     │          │  │       │
│   └──────────┘     └──────────┘     └──────────┘  │       │
│         ▲                                          │       │
│         └──────────────────────────────────────────┘       │
│                    (repeat until task complete)             │
│                                                             │
│   Terminating conditions:                                   │
│   • LLM returns final answer (no tool call)                 │
│   • max_turns exceeded                                      │
│   • Context window full                                     │
│   • User interrupts                                         │
└───────────────────────────────────────────────────────────┘
```

**Goose, not the LLM, decides:**
- When to stop the loop (max_turns, context limits)
- Which tools are available (extension allowlists)
- How results are formatted and fed back
- When to spawn a delegate (sub-agent)

---

## How Goose Calls an LLM

Goose calls LLMs **via API, not via CLI**. There is no subprocess, no shell invocation, no CLI wrapper.

```
┌────────────────────┐         HTTPS + JSON          ┌────────────────────┐
│                    │ ─────────────────────────────▶ │                    │
│   Goose Runtime    │                                │   LLM API          │
│   (Container)      │                                │   Endpoint         │
│                    │ ◀───────────────────────────── │                    │
└────────────────────┘         Streaming JSON         └────────────────────┘
```

### The API call payload

Goose sends a standard chat-completions-style request:

```json
{
  "model": "<resolved from model tier config>",
  "messages": [
    { "role": "system", "content": "<minion system prompt>" },
    { "role": "user",   "content": "<user message or orchestrator instruction>" },
    { "role": "assistant", "content": null, "tool_calls": [{ "id": "...", ... }] },
    { "role": "tool",   "content": "<tool result JSON>", "tool_call_id": "..." }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "github.get_pr_diff",
        "description": "Get the diff for a pull request",
        "parameters": { "type": "object", "properties": { "pr_number": { "type": "integer" } } }
      }
    }
  ],
  "stream": true,
  "temperature": 0.3
}
```

The LLM returns one of two things:
1. **A text response** — the task is done. Goose presents this to the user or collects it as a delegate output.
2. **A tool call** — Goose parses the function name and arguments, executes the tool via the extension system, appends the result as a `tool` role message, and loops back to THINK.

### Streaming

Goose uses streaming responses (`stream: true`). It receives tokens incrementally. For tool calls, it accumulates the JSON until the function name and arguments are complete, then executes. This means the user (or the orchestrator, for minions) sees partial text responses as they're generated.

---

## Provider Abstraction

Goose has a **provider abstraction** that decouples the LLM API from the agent loop. Providers handle authentication, request formatting, response parsing, and provider-specific quirks.

```
┌──────────────────────────────────────────────────────────┐
│                    GOOSE PROVIDER LAYER                    │
│                                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ OpenAI   │  │ Anthropic│  │ Azure    │  │ Custom   │ │
│  │ Provider │  │ Provider │  │ OpenAI   │  │ Provider │ │
│  │          │  │          │  │ Provider │  │          │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
│       │              │              │              │       │
│       ▼              ▼              ▼              ▼       │
│  api.openai    api.anthropic   {resource}     Any OpenAI-  │
│  .com/v1       .com/v1        .openai.azure   compatible  │
│                                .com            endpoint    │
└──────────────────────────────────────────────────────────┘
```

**For our framework, we use the Azure OpenAI provider**, pointed at an Azure AI Foundry endpoint. This provider:

- Authenticates using **managed identity** (no API key in code) via Azure AD token acquisition
- Formats requests to the Azure OpenAI API schema
- Handles Azure-specific features: content filtering responses, provisioned throughput headers
- Routes to the correct model deployment within the Foundry project

### Tier-based provider configuration

The actual configuration file is `rules/models.yaml`. This is the **only file** that changes when models are upgraded, retired, or switched between providers. No code changes are required.

```yaml
# rules/models.yaml — operator fills in deployment and provider for each tier.
# Specific model names and versions are never committed to the codebase.
# See the file header for full field documentation.
tiers:
  fast:
    deployment: ""      # e.g. the deployment name in Azure AI Foundry, or a model slug
    provider: ""        # e.g. azure  anthropic  openai  ollama  deepseek  zhipu
    max_tokens_per_call: 4096

  reasoning:
    deployment: ""
    provider: ""
    max_tokens_per_call: 16384

  code_review:
    deployment: ""
    provider: ""
    max_tokens_per_call: 32768

  code_generation:
    deployment: ""
    provider: ""
    max_tokens_per_call: 16384

  security:
    deployment: ""
    provider: ""
    max_tokens_per_call: 32768
```

The `provider` field maps to the API client Goose uses: `azure` for Azure AI Foundry (authenticates via managed identity, no API key in code), or any external provider name whose API key is supplied in `model_provider_keys` in Terraform. The `deployment` is whatever that provider's API accepts as the model identifier — an Azure deployment name, an Anthropic model ID, an Ollama tag, etc.

**This design intentionally keeps model names out of the repository.** Providers release new model versions frequently; version strings embedded in code become stale within weeks. Operators choose current models at deploy time.

---

## Goose's Own Harness vs. Native LLM Harness

This is a critical architectural distinction. Some LLMs have their own built-in agentic capabilities — Claude has "tool use", OpenAI has "function calling", and some models have "computer use". Goose **does not delegate agentic control to the LLM**.

### What Goose does

| Function | Who does it |
|---|---|
| **Decide to call a tool** | The LLM (in its response) |
| **Decide which tool to call** | The LLM (in its response) |
| **Decide tool arguments** | The LLM (in its response) |
| **Execute the tool** | **Goose** (extension system) |
| **Enforce tool allowlists** | **Goose** (mcp-toolshed extension) |
| **Rate-limit tool calls** | **Goose** (mcp-toolshed extension) |
| **Log every tool call** | **Goose** (mcp-toolshed extension) |
| **Control the loop (when to stop)** | **Goose** (max_turns, context limits) |
| **Spawn sub-agents** | **Goose** (delegate) |
| **Manage context windows** | **Goose** (session management) |
| **Persist state** | **Goose** (SQLite) |

### Why Goose doesn't use the LLM's native harness

If Goose delegated agentic control to Claude's native tool-use loop, we would lose:

- **Tool allowlisting per minion** — Claude would have access to whatever tools the system prompt describes. No hardware enforcement.
- **Audit logging** — Claude's internal tool calls are opaque. We couldn't log parameters, latency, or results.
- **Rate limiting** — Claude doesn't know about our GitHub API rate limits.
- **Correlation IDs** — No way to inject our hierarchical ID scheme.
- **Minion isolation** — Claude's native harness doesn't understand Goose's delegate sandboxing.
- **Provider portability** — Each LLM's native harness works differently. Goose abstracts this.

**The LLM is a reasoning engine. Goose is the agent.** This is a deliberate separation of concerns.

```
┌─────────────────────────────────────────────────────────┐
│                                                          │
│   LLM RESPONSIBILITY:      GOOSE RESPONSIBILITY:         │
│                                                          │
│   "What should I do?"      "Is the LLM allowed to        │
│   "Which tool?"             do that?"                    │
│   "What arguments?"        "Execute the tool safely"     │
│   "What does the result    "Log everything"              │
│    mean?"                  "Enforce limits"              │
│                            "Manage context"              │
│                            "Orchestrate minions"         │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## How Tool Calling Works

### Step-by-step for a single turn

```
Turn N: Minion (Code Reviewer) needs to review PR #342

1. GOOSE: Sends HTTP POST to LLM API
   {
     "model": "<resolved from model tier config>",
     "messages": [
       { "role": "system", "content": "You are a code reviewer..." },
       { "role": "user",   "content": "Review PR #342 in org/repo" }
     ],
     "tools": [
       { "function": { "name": "github.get_pr_diff", ... } },
       { "function": { "name": "github.create_pr_review", ... } }
     ]
   }

2. LLM: Returns tool call (via API response, streaming)
   {
     "choices": [{
       "delta": {
         "tool_calls": [{
           "id": "call_abc123",
           "function": {
             "name": "github.get_pr_diff",
             "arguments": "{\"pr_number\": 342, \"repo\": \"org/repo\"}"
           }
         }]
       }
     }]
   }

3. GOOSE: Intercepts the tool call via the mcp-toolshed extension
   ┌─────────────────────────────────────────┐
   │ MCP Toolshed:                            │
   │  ✅ Allowlist check: github.get_pr_diff  │
   │     IS in code-reviewer allowlist        │
   │  ✅ Rate limiter: 49/50 this minute      │
   │  📝 Pre-call log: Table Storage           │
   │     corr_a1b2c3.1.gh-001, params: {...}  │
   │  ── Execute ──▶ GitHub MCP Server         │
   │  ◀── Result ──  { diff: "...", files:..} │
   │  📝 Post-call log: 600ms, success        │
   └─────────────────────────────────────────┘

4. GOOSE: Appends result to messages array
   {
     "role": "tool",
     "tool_call_id": "call_abc123",
     "content": "{ \"diff\": \"...\", \"files_changed\": [...] }"
   }

5. GOOSE: Loops back to step 1 (Turn N+1)
   Now the LLM sees the diff and can decide to call
   github.create_pr_review or return a final analysis.
```

### The mcp-toolshed is the mandatory intermediary

```
Minion (Goose delegate) ──tool_call──▶ mcp-toolshed ──▶ MCP Server
                                         │
                                         ├── Allowlist check
                                         ├── Rate limit check
                                         ├── Pre-call log
                                         ├── Post-call log
                                         └── Write to Table Storage
                                              + stdout → Log Analytics
```

The minion **cannot bypass the toolshed**. The delegate's tool access is restricted to the toolshed extension only. The toolshed multiplexes to the correct MCP server. This is enforced at the Goose extension level — the minion literally does not have the GitHub MCP extension loaded; it only has `mcp-toolshed`.

---

## Azure AI Foundry Integration

### Architecture

```
┌──────────────────────┐
│  Goose Container     │
│                      │
│  Provider:           │        Managed Identity (Azure AD token)
│  azure_openai        │ ───────────────────────────────────────────┐
│                      │                                             │
│  Endpoint:           │                                             ▼
│  foundry-project     │        ┌──────────────────────────────────────┐
│  .openai.azure.com   │        │  Azure AI Foundry                    │
│                      │        │                                      │
└──────────────────────┘        │  ┌────────────────────────────────┐ │
                                │  │  AI Hub / Project              │ │
                                │  │                                │ │
                                │  │  Deployments:                  │ │
                                │  │  • fast (classification)        │ │
                                │  │  • reasoning (orchestration)   │ │
                                │  │  • code_review (analysis)     │ │
                                │  │  • code_generation (authoring)│ │
                                │  │  • security (auditing)        │ │
                                │  │                                │ │
                                │  │  Content Safety:               │ │
                                │  │  • Prompt injection filter     │ │
                                │  │  • Harmful content filter      │ │
                                │  │  • Jailbreak detection         │ │
                                │  │                                │ │
                                │  │  Monitoring:                   │ │
                                │  │  • Token usage per deployment  │ │
                                │  │  • Latency percentiles         │ │
                                │  │  • Error rates                 │ │
                                │  └────────────────────────────────┘ │
                                └──────────────────────────────────────┘
```

### How it connects

1. Goose container starts with a **managed identity** (Azure AD workload identity)
2. The Azure OpenAI provider acquires an **Azure AD token** for the Foundry endpoint
3. All API calls include the token in the `Authorization: Bearer <token>` header
4. **No API key is ever stored** — not in code, not in env vars, not in Key Vault for the LLM itself
5. Key Vault only stores MCP server credentials (GitHub PAT, ServiceNow password, etc.)

### Content safety

Azure AI Foundry applies content safety **before** the request reaches the model and **after** the model generates a response. This is a platform-level feature — Goose doesn't implement content filtering. If a user's Slack message contains a prompt injection attempt, Foundry blocks it before the LLM sees it. If an LLM generates harmful content, Foundry filters the response before Goose receives it.

---

## Multi-Model Routing in the Framework

The framework does **not hardcode specific model names**. Models evolve — GPT-4 variants are retiring, Claude Sonnet is at 4.8 and moving. Instead, the framework defines **model tiers** — capability profiles mapped to task types. The actual model deployment behind each tier is configuration, not code.

### Model Tiers (Configurable)

```yaml
# models.yaml — version-controlled, deployed with the framework
model_tiers:
  fast:
    description: "Low-latency, low-cost tasks — classification, summarization, simple lookups"
    capabilities: [text_generation, tool_calling]
    max_tokens_per_call: 4096
    preferred_family: "small"           # e.g., GPT-4o-mini, Claude Haiku, Llama-3-8B

  reasoning:
    description: "Complex reasoning — task decomposition, DAG construction, code exploration"
    capabilities: [text_generation, tool_calling, chain_of_thought]
    max_tokens_per_call: 16384
    preferred_family: "large"           # e.g., GPT-4.1, Claude Sonnet 4.8, Llama-3-70B

  code_review:
    description: "Deep code analysis — nuance, security patterns, performance"
    capabilities: [text_generation, tool_calling, long_context]
    max_tokens_per_call: 32768
    preferred_family: "large"           # e.g., Claude Sonnet 4.8, GPT-4.1

  code_generation:
    description: "Code authoring — implement fixes, write tests, generate commit messages"
    capabilities: [text_generation, tool_calling, code_completion]
    max_tokens_per_call: 16384
    preferred_family: "large"           # e.g., GPT-4.1, Claude Sonnet 4.8

  security:
    description: "Vulnerability scanning — OWASP detection, CVE analysis, dependency audit"
    capabilities: [text_generation, tool_calling, long_context]
    max_tokens_per_call: 32768
    preferred_family: "large"           # e.g., Claude Sonnet 4.8
```

### Tier-to-Task Mapping

```
┌──────────────────────────────────────────────────────────────┐
│                   MODEL TIER ROUTING                           │
│                                                                │
│  Task                        Tier            Rationale        │
│  ──────────────────────────  ──────────────  ───────────────  │
│  Intent classification       fast            Low latency,     │
│  (orchestrator)                              simple output    │
│                                                                │
│  Task decomposition          reasoning       Complex DAG,     │
│  (orchestrator DAG)                          dependencies     │
│                                                                │
│  Code exploration            reasoning       Symbol tracing,  │
│  (Code Explorer minion)                      call graphs      │
│                                                                │
│  Code review                 code_review     Deep analysis,   │
│  (Code Reviewer minion)                      nuance, security │
│                                                                │
│  PR creation                 code_generation Code authoring,  │
│  (PR Crafter minion)                         commit messages  │
│                                                                │
│  Ticket analysis             fast            Cross-reference, │
│  (Ticket Analyst minion)                     summarization    │
│                                                                │
│  Security audit              security        OWASP detection, │
│  (Security Auditor)                          CVE analysis     │
│                                                                │
│  Response synthesis          fast            Merge outputs,   │
│  (orchestrator)                              format response  │
└──────────────────────────────────────────────────────────────┘
```

### How Routing Works at Runtime

The orchestrator selects the tier when it spawns a minion. The provider layer resolves the tier to an actual Azure AI Foundry deployment:

```yaml
# orchestrator extension manifest (fragment)
minions:
  code-reviewer:
    model_tier: code_review
    system_prompt_path: ./prompts/code-reviewer.md
    ...

  ticket-analyst:
    model_tier: fast
    system_prompt_path: ./prompts/ticket-analyst.md
    ...
```

The tier configuration in `rules/models.yaml` maps each tier to a deployment and provider. At runtime, the orchestrator reads these fields and routes each minion to the correct API client:

```yaml
# rules/models.yaml — operator sets deployment and provider at deploy time.
# No model names are committed in the codebase.
tiers:
  fast:
    deployment: ""      # fill in: Azure deployment name, model slug, or Ollama tag
    provider: ""        # fill in: azure | anthropic | openai | ollama | deepseek | zhipu | ...
    max_tokens_per_call: 4096

  reasoning:
    deployment: ""
    provider: ""
    max_tokens_per_call: 16384

  code_review:
    deployment: ""
    provider: ""
    max_tokens_per_call: 32768

  code_generation:
    deployment: ""
    provider: ""
    max_tokens_per_call: 16384

  security:
    deployment: ""
    provider: ""
    max_tokens_per_call: 32768
```

**Model changes are a config deployment, not a code change.** When a model is retired or a new version ships, only `rules/models.yaml` changes — no prompt changes, no code changes, no container rebuild required. For Azure AI Foundry deployments, also update `ai_model_deployments` in `infra/terraform/environments/<env>/terraform.tfvars`.

---

## Token Consumption & Cost Management

### The Problem

A multi-minion pipeline can consume significant tokens:
- Orchestrator classification: ~500 tokens
- Task decomposition: ~2,000 tokens
- Code Explorer (searching a large repo): ~15,000 tokens
- Code Reviewer (analyzing a 500-line diff): ~20,000 tokens
- PR Crafter (implementing + testing): ~30,000 tokens
- Response synthesis: ~1,000 tokens

**A complex pipeline can consume 50,000–100,000 tokens.** Without controls, costs and latency grow unpredictably.

### Strategy 1: Tier-Based Token Budgets

Each minion has a token budget, enforced by the orchestrator:

```yaml
minions:
  code-explorer:
    model_tier: reasoning
    max_tokens_per_run: 25000      # hard cap per minion invocation
    max_context_tokens: 50000      # max context window allowed

  code-reviewer:
    model_tier: code_review
    max_tokens_per_run: 40000
    max_context_tokens: 100000

  ticket-analyst:
    model_tier: fast
    max_tokens_per_run: 10000
    max_context_tokens: 30000
```

The orchestrator tracks cumulative token usage from the delegate's metadata. If a minion approaches its budget, the orchestrator signals it to wrap up (truncate context, return partial results, escalate).

### Strategy 2: Progressive Disclosure

Minions don't get the entire codebase dumped into their context window. The orchestrator controls what each minion sees:

```
Instead of: "Here is the entire repo. Find the auth bug."
            → 50,000 tokens of context, 30,000 tokens of reasoning

We do:      "Search for files matching 'auth' AND 'login'."
            → 500 tokens of context, then targeted reads
            → 5,000 tokens total
```

This is enforced by the **Code Explorer minion's** system prompt, which instructs it to search first, then read targeted files, then reason — never "read everything."

### Strategy 3: Response Caching

Identical tool calls within a session skip the LLM and return cached results:

```
Session: corr_a1b2c3
├── Minion 1 (Ticket Analyst): servicenow.query_incidents("INC00421")
│   → Result cached with key: sn:query_incidents:INC00421
│
├── Minion 3 (PR Crafter): servicenow.query_incidents("INC00421")
│   → Cache hit. Returns cached result. 0 LLM tokens consumed.
```

Cache is session-scoped (lives in the orchestrator's SQLite) and TTL'd (default: session lifetime). Cross-session caching is not implemented due to staleness risk.

### Strategy 4: Model Tier Selection by Task Complexity

The orchestrator's intent classifier also estimates task complexity and picks the cheapest tier that can handle it:

| Complexity | Example | Tier Selected |
|---|---|---|
| **Trivial** | "What repo is this?" | `fast` |
| **Simple** | "What's the status of AB#1234?" | `fast` |
| **Moderate** | "Review PR #342" | `code_review` |
| **Complex** | "Fix INC00421 and create a PR" | `reasoning` → `code_generation` → `code_review` |

### Strategy 5: Cost Tracking & Alerts

Every minion run records tokens consumed. The observability layer tracks costs:

```kql
// Daily cost by tier (Grafana panel)
AppTraces
| where timestamp > ago(7d)
| where Properties.event == "minion_completed"
| extend tier = Properties.model_tier
| extend tokens = Properties.tokens_used
| extend cost = case(
    tier == "fast", tokens * 0.00000015,          // $0.15/1M tokens
    tier == "reasoning", tokens * 0.0000025,       // $2.50/1M
    tier == "code_review", tokens * 0.000003,      // $3.00/1M (Claude)
    tier == "code_generation", tokens * 0.0000025,
    tier == "security", tokens * 0.000003,
    0)
| summarize total_cost = sum(cost) by bin(timestamp, 1d), tier
```

An alert fires if daily cost exceeds a configured threshold ($50 default).

---

## GitHub Copilot — Can Goose Use It?

### Short answer

Goose does **not** have a native GitHub Copilot provider. Even if one were built, Copilot is not suitable for the agentic tasks our framework performs.

### Why Copilot doesn't fit

| Aspect | Copilot | What our framework needs |
|---|---|---|
| **Primary function** | Inline code completion in an IDE | Agentic reasoning across multiple tools |
| **API surface** | Code completion (fill-in-the-middle), limited chat | Full chat-completions with tool calling |
| **Context model** | Current file + few adjacent files | Entire codebase search, cross-file analysis, diff review |
| **Tool calling** | No native tool-use capability | The LLM must decide *which* tool to call, with *what* arguments |
| **Reasoning depth** | Next-token prediction for code | Multi-step reasoning: search → analyze → decide → implement → review |
| **Self-critique** | None | Code review requires the LLM to critique its own or others' work |

### What Copilot *could* be used for (in theory)

If GitHub exposes a chat-completions-compatible API with tool-calling support, a custom Goose provider *could* be written. But even then, Copilot's models are optimized for code completion, not the deep reasoning required for:

- **Task decomposition** — understanding dependencies between tickets, code, and PRs
- **Code review** — detecting OWASP vulnerabilities, performance anti-patterns, architectural issues
- **Cross-system reasoning** — correlating a ServiceNow incident with an Azure DevOps work item and a GitHub PR

### What we use instead

**Azure AI Foundry's model catalog** provides models purpose-built for each task. The configurable tier system means we can swap in whatever model family is best — GPT variants for generation, Claude variants for analysis, and lightweight models for classification — without changing the framework code.

---

## What Goose Does NOT Do

To avoid confusion, here's what Goose explicitly does **not** do with LLMs:

| Goose does NOT... | What actually happens |
|---|---|
| **Call LLMs via CLI** | All calls are HTTPS API calls. No subprocess, no `claude` or `gpt` CLI tools. |
| **Use the LLM's native agent harness** | Goose has its own agent loop. The LLM's built-in tool-use capability is used only for the tool *selection* step, not for execution, logging, or safety. |
| **Store API keys in code** | All authentication is via managed identity (Azure AD) or Key Vault. No static secrets. |
| **Let minions choose their model** | The orchestrator assigns the model. Minions are unaware of which model they're using. |
| **Allow direct LLM access from minions** | Minions call the toolshed, which calls MCP servers. The LLM endpoint is only called by the Goose provider layer, not by tools. |
| **Train or fine-tune models** | The framework uses pre-trained models as-is. No training data leaves the inference endpoint. |
| **Share context across minions without orchestration** | Each minion has an isolated context window. Cross-minion knowledge transfer goes through the orchestrator (via `chatrecall` or explicit context passing). |

---

## Summary

```
                    ┌─────────────────────┐
                    │    User / Cron      │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │  Slack/Teams Bot    │
                    │  (Goose extension)  │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   Orchestrator      │
                    │   (Goose extension) │
                    │                     │
                    │  Classify intent    │
                    │  Build DAG          │
                    │  Spawn minions      │
                    └──────────┬──────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
                    ▼                     ▼
          ┌──────────────┐      ┌──────────────┐
          │  Minion A     │      │  Minion B     │
          │  (delegate)   │      │  (delegate)   │
          │               │      │               │
          │  ┌─────────┐  │      │  ┌─────────┐  │
          │  │ Provider │  │      │  │ Provider │  │
          │  │ Layer    │  │      │  │ Layer    │  │
          │  └────┬─────┘  │      │  └────┬─────┘  │
          │       │        │      │       │        │
          │  HTTPS│ JSON   │      │  HTTPS│ JSON   │
          │       │        │      │       │        │
          └───────┼────────┘      └───────┼────────┘
                  │                       │
                  ▼                       ▼
          ┌─────────────────────────────────────┐
          │        Azure AI Foundry              │
          │                                      │
          │  fast  │  reasoning │ code_review │ code_gen │ security │
          │                                      │
          │  Content Safety  │  Monitoring       │
          └─────────────────────────────────────┘

          Minions call tools through:
          
          Minion → mcp-toolshed → MCP Server
                      │
                      ├── Allowlist check
                      ├── Rate limit
                      └── Log (Table Storage + Log Analytics)
```

**The key insight:** Goose is an agent harness that *wraps* LLMs. The LLM provides reasoning. Goose provides execution, safety, audit, and orchestration. The LLM is called via standard HTTPS APIs (not CLI), through a provider abstraction that handles authentication, streaming, and response parsing.
