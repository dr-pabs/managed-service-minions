output "namespace_id" {
  description = "Service Bus namespace ID."
  value       = azurerm_servicebus_namespace.main.id
}

output "namespace_name" {
  description = "Service Bus namespace name."
  value       = azurerm_servicebus_namespace.main.name
}

output "endpoint" {
  description = "Service Bus namespace endpoint."
  value       = azurerm_servicebus_namespace.main.endpoint
  sensitive   = true
}

output "primary_connection_string" {
  description = "Service Bus primary connection string."
  value       = azurerm_servicebus_namespace.main.default_primary_connection_string
  sensitive   = true
}

output "queue_id" {
  description = "Service Bus work-item queue ID."
  value       = azurerm_servicebus_queue.work_items.id
}

output "scale_rule" {
  description = "KEDA scale rule configuration for the queue-ingress (Milestone 15)."
  value = {
    queue_name     = azurerm_servicebus_queue.work_items.name
    namespace_name = azurerm_servicebus_namespace.main.name
    message_count  = "3"
  }
}
