output "environment_id" {
  description = "Container Apps Environment ID."
  value       = azurerm_container_app_environment.main.id
}

output "log_analytics_workspace_id" {
  description = "Log Analytics workspace ID referenced by the environment."
  value       = azurerm_container_app_environment.main.log_analytics_workspace_id
}

output "dashboard_ingress_external_enabled" {
  description = "Whether the dashboard container app exposes external ingress."
  value       = azurerm_container_app.dashboard.ingress[0].external_enabled
}

output "dashboard_liveness_path" {
  description = "Liveness probe path for the dashboard container app."
  value       = azurerm_container_app.dashboard.template[0].container[0].liveness_probe[0].path
}

output "toolshed_name" {
  description = "Name of the toolshed container app."
  value       = azurerm_container_app.toolshed.name
}

output "sqlite_storage_name" {
  description = "Container Apps environment storage name for the SQLite File Share."
  value       = azurerm_container_app_environment_storage.sqlite.name
}
