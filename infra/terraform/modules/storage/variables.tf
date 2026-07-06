variable "name_prefix" {
  description = "Prefix used when generating the storage account name."
  type        = string
}

variable "environment" {
  description = "Deployment environment."
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

variable "account_tier" {
  description = "Storage account tier."
  type        = string
  default     = "Standard"
}

variable "account_replication_type" {
  description = "Storage account replication type."
  type        = string
  default     = "LRS"
}

variable "role_assignments" {
  description = "RBAC role assignments for the storage account."
  type = list(object({
    principal_id         = string
    role_definition_name = string
  }))
  default = []
}

variable "sqlite_share_quota_gb" {
  description = "Quota in GB for the SQLite Azure File Share."
  type        = number
  default     = 5
}

variable "tags" {
  description = "Resource tags."
  type        = map(string)
  default     = {}
}
