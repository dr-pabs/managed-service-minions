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
  description = "List of AI Foundry model deployments."
  type = list(object({
    name       = string
    model_name = string
    version    = string
    sku        = string
    capacity   = number
  }))
  default = []
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
