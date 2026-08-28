variable "environment_name" {
  description = "Name of the Container Apps Environment."
  type        = string
}

variable "resource_group_name" {
  description = "Name of the resource group."
  type        = string
}

variable "location" {
  description = "Azure region."
  type        = string
}

variable "subnet_id" {
  description = "Subnet ID for the Container Apps Environment."
  type        = string
}

variable "log_analytics_workspace_id" {
  description = "Log Analytics workspace ID for the environment."
  type        = string
}

variable "orchestrator" {
  description = "Configuration for the orchestrator container app (goose serve)."
  type = object({
    name         = string
    identity_id  = string
    image        = string
    min_replicas = number
    max_replicas = number
  })
}

variable "queue_ingress" {
  description = "Configuration for the queue-ingress container app (Milestone 15 of the forge-ops execplan, forge-contracts repo)."
  type = object({
    name             = string
    identity_id      = string
    image            = string
    min_replicas     = number
    max_replicas     = number
    service_bus_rule = map(string)
  })
}

variable "slack_bot" {
  description = "Configuration for the Slack bot container app."
  type = object({
    name        = string
    identity_id = string
    image       = string
  })
}

variable "teams_bot" {
  description = "Configuration for the Teams bot container app."
  type = object({
    name        = string
    identity_id = string
    image       = string
  })
}

variable "dashboard" {
  description = "Configuration for the agent dashboard container app."
  type = object({
    name        = string
    identity_id = string
    image       = string
    port        = optional(number, 3001)
    # Milestone 14 of the 2026-07 Minions remediation plan (review finding
    # M7; see the README roadmap table — not the forge-ops execplan's
    # milestone numbering): Entra ID app registration for the
    # Container Apps "easy auth" front door. Both null by default so the
    # dashboard deploys without platform auth (local-dev/CI plans) until an
    # operator supplies a real app registration; the app's own
    # DASHBOARD_AUTH_TOKEN check remains the fallback either way.
    entra_client_id = optional(string, null)
    entra_tenant_id = optional(string, null)
  })
}

variable "toolshed" {
  description = "Configuration for the MCP toolshed container app."
  type = object({
    name         = string
    identity_id  = string
    image        = string
    min_replicas = number
    max_replicas = number
  })
}

variable "sqlite_storage_account_name" {
  description = "Storage account name for the SQLite Azure File Share."
  type        = string
}

variable "sqlite_share_name" {
  description = "Azure File Share name for SQLite data."
  type        = string
}

variable "sqlite_storage_access_key" {
  description = "Storage account access key for SQLite File Share mount."
  type        = string
  sensitive   = true
}

variable "env_vars" {
  description = "Plain environment variables for container apps."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Sensitive environment variables stored as secrets."
  type        = map(string)
  sensitive   = true
  default     = {}
}

variable "tags" {
  description = "Resource tags."
  type        = map(string)
  default     = {}
}
