# ADR-002: Use MCP for all tool integrations

| Key | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-05 |
| **Deciders** | Goose Agent Framework team |
| **Replaces** | — |
| **Superseded by** | — |

---

## Context

Minions need access to external systems: GitHub, Azure DevOps, ServiceNow, Jira, Slack, Microsoft Teams, local filesystems, git, and shell commands. Each integration surface must be versioned, secured, and auditable.

Options considered:

1. **Model Context Protocol (MCP)** — standardized client-server protocol for tool exposure. Each integration runs as an MCP server; minions call them through a shared proxy.
2. **Custom Goose extensions per integration** — build a separate Goose extension for each external system.
3. **Direct REST API calls** — have minions call REST APIs directly via the shell tool.

## Decision

**Use MCP for all tool integrations.**

Build a single `mcp-toolshed` Goose extension that manages connections to all MCP servers. Every tool call from any minion flows through this extension for logging, allowlist enforcement, and rate limiting.

## Rationale

- **Standard protocol** — MCP has a growing ecosystem of pre-built servers (GitHub, filesystem, git, Slack). We get integrations "for free" rather than building from scratch.
- **Clean separation of concerns** — Tools are defined once in MCP servers and shared across all minions. Tool definitions are owned by the integration, not by individual minions.
- **Unified governance** — The `mcp-toolshed` extension is a single interception point for allowlisting, rate limiting, logging, and audit.
- **Swappable backends** — If a system changes (e.g., Jira Cloud → Jira Data Center), only its MCP server changes; minion prompts and tool names stay the same.
- **Transport flexibility** — MCP supports stdio (local tools: filesystem, git, shell), SSE (streaming events), and WebSocket. This covers all integration patterns we need. The `mcp-toolshed` adapter (`extensions/mcp-toolshed/src/adapter.ts`) supports both stdio (via `StdioClientTransport`) and SSE (via optional `url` field using `SSEClientTransport`) connection methods, enabling mock MCP servers to run as separate Docker containers for local development.

## Consequences

### Positive
- Growing ecosystem reduces build effort
- Single governance point for all tool access
- Clean abstraction: minions know tool names, not API endpoints

### Negative / Mitigations
- **MCP server health is critical** — Mitigation: `mcp-toolshed` includes health checks and circuit-breaking per server.
- **Some MCP servers must be custom-built** — Azure DevOps MCP, ServiceNow MCP, and Jira MCP don't exist yet. Mitigation: These are scoped as Phase 1-3 development tasks.
- **Transport diversity adds complexity** — stdio, SSE, and WebSocket each have different connection management requirements. Mitigation: The `mcp-toolshed` abstracts transport behind a uniform interface.
