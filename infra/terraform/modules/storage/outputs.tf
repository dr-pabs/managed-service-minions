output "account_name" {
  description = "Storage account name."
  value       = azurerm_storage_account.main.name
}

output "account_id" {
  description = "Storage account ID."
  value       = azurerm_storage_account.main.id
}

output "primary_connection_string" {
  description = "Storage account primary connection string."
  value       = azurerm_storage_account.main.primary_connection_string
  sensitive   = true
}

output "sqlite_share_name" {
  description = "Name of the Azure File Share for SQLite data."
  value       = azurerm_storage_share.sqlite_data.name
}

output "primary_access_key" {
  description = "Storage account primary access key for File Share mount."
  value       = azurerm_storage_account.main.primary_access_key
  sensitive   = true
}
