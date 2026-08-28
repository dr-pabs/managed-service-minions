output "orchestrator_id" {
  description = "Orchestrator managed identity ID."
  value       = azurerm_user_assigned_identity.main["orchestrator"].id
}

output "orchestrator_principal_id" {
  description = "Orchestrator managed identity principal ID."
  value       = azurerm_user_assigned_identity.main["orchestrator"].principal_id
}

output "slack_bot_id" {
  description = "Slack bot managed identity ID."
  value       = azurerm_user_assigned_identity.main["slack_bot"].id
}

output "slack_bot_principal_id" {
  description = "Slack bot managed identity principal ID."
  value       = azurerm_user_assigned_identity.main["slack_bot"].principal_id
}

output "teams_bot_id" {
  description = "Teams bot managed identity ID."
  value       = azurerm_user_assigned_identity.main["teams_bot"].id
}

output "teams_bot_principal_id" {
  description = "Teams bot managed identity principal ID."
  value       = azurerm_user_assigned_identity.main["teams_bot"].principal_id
}

output "dashboard_id" {
  description = "Dashboard managed identity ID."
  value       = azurerm_user_assigned_identity.main["dashboard"].id
}

output "dashboard_principal_id" {
  description = "Dashboard managed identity principal ID."
  value       = azurerm_user_assigned_identity.main["dashboard"].principal_id
}

output "toolshed_id" {
  description = "Toolshed managed identity ID."
  value       = azurerm_user_assigned_identity.main["toolshed"].id
}

output "toolshed_principal_id" {
  description = "Toolshed managed identity principal ID."
  value       = azurerm_user_assigned_identity.main["toolshed"].principal_id
}

output "queue_ingress_id" {
  description = "Queue-ingress managed identity ID."
  value       = azurerm_user_assigned_identity.main["queue_ingress"].id
}

output "queue_ingress_principal_id" {
  description = "Queue-ingress managed identity principal ID."
  value       = azurerm_user_assigned_identity.main["queue_ingress"].principal_id
}
