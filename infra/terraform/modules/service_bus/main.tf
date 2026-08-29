resource "azurerm_servicebus_namespace" "main" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = var.sku

  tags = var.tags
}

# Milestone 15 of the forge-ops execplan (forge-contracts repo): the work
# queue is now first-class. A single Service Bus queue
# (not a topic + subscriptions) is what the queue-ingress consumes; the KEDA
# scaler targets its depth directly. `max_delivery_count = 3` mirrors the
# queue-ingress processor's default poison threshold, so an item that fails
# three times dead-letters rather than looping forever.
resource "azurerm_servicebus_queue" "work_items" {
  name         = var.queue_name
  namespace_id = azurerm_servicebus_namespace.main.id

  max_delivery_count = 3
}

resource "azurerm_role_assignment" "main" {
  for_each = { for idx, ra in var.role_assignments : idx => ra }

  scope                = azurerm_servicebus_namespace.main.id
  role_definition_name = each.value.role_definition_name
  principal_id         = each.value.principal_id
}
