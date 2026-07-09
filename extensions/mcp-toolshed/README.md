# mcp-toolshed

The `mcp-toolshed` is a governed MCP server proxy. It registers external MCP
servers, enforces per-minion allowlists, applies rate limits and circuit
breakers, and audits every tool call.

## Registering the GitHub MCP server

The framework ships a dedicated GitHub MCP server in `extensions/mcp-github/`.
To make it available to Goose minions, build it and register it as an MCP
extension, then point the toolshed at it via the `TOOLSHED_ADAPTERS` environment
variable.

Build the server:

```bash
pnpm --filter @minions-agent-framework/mcp-github build
```

Add the server to your Goose config (`~/.config/goose/config.yaml`):

```yaml
extensions:
  mcp-github:
    cmd: node
    args: ["/path/to/repo/extensions/mcp-github/dist/index.js"]
    type: stdio
    enabled: true
```

The server requires a `GITHUB_TOKEN` environment variable. For GitHub Enterprise
Server, you can also set `GITHUB_API_URL`:

```bash
export GITHUB_TOKEN="ghp_..."
export GITHUB_API_URL="https://github.example.com/api/v3"
```

To route the server through the toolshed so that allowlists, rate limits, and
audit logging apply, register it as an adapter:

```bash
export TOOLSHED_ADAPTERS='[
  {
    "alias": "github",
    "command": "node",
    "args": ["/path/to/repo/extensions/mcp-github/dist/index.js"],
    "env": { "GITHUB_TOKEN": "ghp_..." }
  }
]'
node extensions/mcp-toolshed/dist/index.js
```

Tools exposed by `mcp-github` include:

- `github_list_pull_requests`
- `github_get_pull_request`
- `github_get_pull_request_diff`
- `github_create_pull_request`
- `github_merge_pull_request`

Each tool returns JSON with `success` and either `data` or `error`.

## Registering the Azure DevOps MCP server

The `extensions/mcp-azure-devops` MCP server can be registered with the toolshed
via the `TOOLSHED_ADAPTERS` environment variable:

```json
[
  {
    "alias": "azure_devops",
    "command": "node",
    "args": ["/path/to/repo/extensions/mcp-azure-devops/dist/index.js"],
    "env": {
      "AZURE_DEVOPS_ORG": "<your-organization>",
      "AZURE_DEVOPS_PROJECT": "<your-project>",
      "AZURE_DEVOPS_TOKEN": "<personal-access-token>"
    }
  }
]
```

After building the extension (`pnpm --filter @minions-agent-framework/mcp-azure-devops build`),
start the toolshed with `TOOLSHED_ADAPTERS` set to the JSON above. Minions can
then call Azure DevOps tools such as `ado_get_pull_request`, `ado_list_work_items`,
and `ado_update_work_item` through the toolshed.

## Registering the ServiceNow MCP server

The `extensions/mcp-servicenow` MCP server can be registered with the toolshed
via the `TOOLSHED_ADAPTERS` environment variable:

```json
[
  {
    "alias": "servicenow",
    "command": "node",
    "args": ["/path/to/repo/extensions/mcp-servicenow/dist/index.js"],
    "env": {
      "SERVICENOW_INSTANCE": "<your-instance>",
      "SERVICENOW_USERNAME": "<username>",
      "SERVICENOW_PASSWORD": "<password>"
    }
  }
]
```

After building the extension (`pnpm --filter @minions-agent-framework/mcp-servicenow build`),
start the toolshed with `TOOLSHED_ADAPTERS` set to the JSON above. Minions can
then call ServiceNow tools such as `servicenow_list_incidents`,
`servicenow_get_incident`, `servicenow_update_incident`, and
`servicenow_create_incident` through the toolshed.

## Registering the Jira MCP server

The `extensions/mcp-jira` MCP server can be registered with the toolshed via the
`TOOLSHED_ADAPTERS` environment variable:

```json
[
  {
    "alias": "jira",
    "command": "node",
    "args": ["/path/to/repo/extensions/mcp-jira/dist/index.js"],
    "env": {
      "JIRA_HOST": "<your-jira-host>",
      "JIRA_EMAIL": "<your-email>",
      "JIRA_API_TOKEN": "<your-api-token>"
    }
  }
]
```

After building the extension (`pnpm --filter @minions-agent-framework/mcp-jira build`),
start the toolshed with `TOOLSHED_ADAPTERS` set to the JSON above. Minions can
then call Jira tools such as `jira_list_issues`, `jira_get_issue`,
`jira_update_issue`, `jira_create_issue`, and `jira_add_comment` through the
toolshed.
