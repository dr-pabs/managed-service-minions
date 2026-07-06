variable "hub_name" {
  description = "Name of the AI Foundry Hub."
  type        = string
}

variable "project_name" {
  description = "Name of the AI Foundry Project."
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

variable "storage_account_id" {
  description = "Optional storage account ID for the hub."
  type        = string
  default     = ""
}

variable "key_vault_id" {
  description = "Optional Key Vault ID for the hub."
  type        = string
  default     = ""
}

variable "model_deployments" {
  description = "List of model deployments. Set format = \"OpenAI\" for Azure OpenAI Service models; format = \"Azure\" for AI Foundry catalog models (e.g. Claude, Deepseek, Qwen)."
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

variable "role_assignments" {
  description = "RBAC role assignments for the AI Foundry project."
  type = list(object({
    principal_id         = string
    role_definition_name = string
  }))
  default = []
}

variable "tags" {
  description = "Resource tags."
  type        = map(string)
  default     = {}
}
