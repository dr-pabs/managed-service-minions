variable "name_prefix" {
  description = "Prefix used when generating resource names."
  type        = string
  default     = "goose"
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod)."
  type        = string
}

variable "location" {
  description = "Azure region for resources."
  type        = string
  default     = "westus2"
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default     = {}
}

variable "enable_grafana" {
  description = "Whether to deploy Azure Managed Grafana."
  type        = bool
  default     = true
}

variable "ai_model_deployments" {
  description = "Azure AI Foundry model deployments. Only needed for models served through Azure AI Foundry. Set format = \"OpenAI\" for Azure OpenAI Service models; format = \"Azure\" for models from the AI Foundry catalog (Claude, Deepseek, Qwen, etc.)."
  type = list(object({
    name       = string
    model_name = string
    version    = string
    sku        = string
    capacity   = number
    format     = optional(string, "OpenAI")
  }))
  default = []
}

# ── Model provider keys ───────────────────────────────────────────────────────
# API keys for external model providers (non-Azure). Use the provider's native
# env var name as the key so agents pick them up without any extra mapping.
# Example:
#   model_provider_keys = {
#     ANTHROPIC_API_KEY = "sk-ant-..."
#     DEEPSEEK_API_KEY  = "sk-..."
#     ZHIPU_API_KEY     = "..."
#   }
variable "model_provider_keys" {
  description = "Map of env-var name to API key for non-Azure model providers. Keys are injected verbatim as container secrets."
  type        = map(string)
  sensitive   = true
  default     = {}
}

# ── Model provider endpoints ──────────────────────────────────────────────────
# Base URL overrides for providers not at their standard URL (local inference
# servers, private deployments, compatible proxies). Use the provider's native
# env var name as the key.
# Example:
#   model_provider_endpoints = {
#     OLLAMA_HOST         = "http://my-ollama:11434"
#     OPENAI_BASE_URL     = "http://my-vllm:8000/v1"
#   }
variable "model_provider_endpoints" {
  description = "Map of env-var name to base URL for non-standard provider endpoints. Keys are injected verbatim as container env vars."
  type        = map(string)
  default     = {}
}

# ── Chat platform credentials ─────────────────────────────────────────────────

variable "slack_bot_token" {
  description = "Slack bot OAuth token (xoxb-…). Required by the Slack bot container."
  type        = string
  sensitive   = true
  default     = ""
}

variable "slack_signing_secret" {
  description = "Slack app signing secret for request verification."
  type        = string
  sensitive   = true
  default     = ""
}

variable "microsoft_app_id" {
  description = "Azure AD application (client) ID for the Teams bot."
  type        = string
  sensitive   = true
  default     = ""
}

variable "microsoft_app_password" {
  description = "Azure AD client secret for the Teams bot."
  type        = string
  sensitive   = true
  default     = ""
}

# ── External integration tokens ───────────────────────────────────────────────

variable "github_token" {
  description = "GitHub personal access token or GitHub App token for mcp-github."
  type        = string
  sensitive   = true
  default     = ""
}

variable "azure_devops_pat" {
  description = "Azure DevOps personal access token for mcp-azure-devops."
  type        = string
  sensitive   = true
  default     = ""
}

variable "servicenow_api_key" {
  description = "ServiceNow API key for mcp-servicenow."
  type        = string
  sensitive   = true
  default     = ""
}

variable "jira_api_token" {
  description = "Jira API token for mcp-jira."
  type        = string
  sensitive   = true
  default     = ""
}

# ── Orchestrator ──────────────────────────────────────────────────────────────

variable "goose_serve_url" {
  description = "Internal URL of the orchestrator's goose serve endpoint. Used by chat bots."
  type        = string
  default     = "http://ca-orchestrator-dev:3284"
}
