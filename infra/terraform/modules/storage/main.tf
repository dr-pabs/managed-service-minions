resource "random_string" "storage_suffix" {
  length  = 6
  special = false
  upper   = false
}

resource "azurerm_storage_account" "main" {
  name                     = "st${var.name_prefix}${var.environment}${random_string.storage_suffix.result}"
  resource_group_name      = var.resource_group_name
  location                 = var.location
  account_tier             = var.account_tier
  account_replication_type = var.account_replication_type
  min_tls_version          = "TLS1_2"

  tags = var.tags
}

resource "azurerm_storage_table" "tool_call_log" {
  name                 = "ToolCallLog"
  storage_account_name = azurerm_storage_account.main.name
}

# Milestone 18 (ADR-026): shared rate-limit buckets and circuit breaker state
# for the (now multi-replica) toolshed. The table name matches the default of
# the toolshed's TOOLSHED_GOVERNANCE_STATE_TABLE env var.
resource "azurerm_storage_table" "governance_state" {
  name                 = "GovernanceState"
  storage_account_name = azurerm_storage_account.main.name
}

resource "azurerm_storage_container" "minion_outputs" {
  name                  = "minion-outputs"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

resource "azurerm_storage_container" "sqlite_backups" {
  name                  = "sqlite-backups"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

resource "azurerm_storage_share" "sqlite_data" {
  name                 = "sqlite-data"
  storage_account_name = azurerm_storage_account.main.name
  quota                = var.sqlite_share_quota_gb
}

resource "azurerm_role_assignment" "main" {
  for_each = { for idx, ra in var.role_assignments : idx => ra }

  scope                = azurerm_storage_account.main.id
  role_definition_name = each.value.role_definition_name
  principal_id         = each.value.principal_id
}
