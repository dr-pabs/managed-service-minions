mock_provider "azurerm" {
  override_resource {
    target = module.managed_identity.azurerm_user_assigned_identity.main["orchestrator"]
    values = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mi-orch-goosetest-test"
      principal_id = "00000000-0000-0000-0000-000000000011"
    }
  }

  override_resource {
    target = module.managed_identity.azurerm_user_assigned_identity.main["slack_bot"]
    values = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mi-slack-goosetest-test"
      principal_id = "00000000-0000-0000-0000-000000000012"
    }
  }

  override_resource {
    target = module.managed_identity.azurerm_user_assigned_identity.main["teams_bot"]
    values = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mi-teams-goosetest-test"
      principal_id = "00000000-0000-0000-0000-000000000013"
    }
  }

  override_resource {
    target = module.managed_identity.azurerm_user_assigned_identity.main["dashboard"]
    values = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mi-dash-goosetest-test"
      principal_id = "00000000-0000-0000-0000-000000000014"
    }
  }

  override_resource {
    target = module.managed_identity.azurerm_user_assigned_identity.main["toolshed"]
    values = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mi-toolshed-goosetest-test"
      principal_id = "00000000-0000-0000-0000-000000000015"
    }
  }

  override_resource {
    target = module.managed_identity.azurerm_user_assigned_identity.main["queue_ingress"]
    values = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mi-queue-ingress-goosetest-test"
      principal_id = "00000000-0000-0000-0000-000000000016"
    }
  }

  override_data {
    target = module.keyvault.data.azurerm_client_config.current
    values = {
      tenant_id = "00000000-0000-0000-0000-000000000000"
    }
  }

  override_data {
    target = module.ai_foundry.data.azurerm_resource_group.main
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test"
    }
  }

  override_resource {
    target = module.observability.azurerm_log_analytics_workspace.main
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.OperationalInsights/workspaces/la-goosetest-test"
    }
  }

  override_resource {
    target = module.networking.azurerm_subnet.container_apps
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.Network/virtualNetworks/vnet-goosetest-test/subnets/snet-ca-vnet-goosetest-test"
    }
  }

  override_resource {
    target = module.networking.azurerm_network_security_group.container_apps
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.Network/networkSecurityGroups/nsg-ca-vnet-goosetest-test"
    }
  }

  override_resource {
    target = module.networking.azurerm_virtual_network.main
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.Network/virtualNetworks/vnet-goosetest-test"
    }
  }

  override_resource {
    target = module.networking.azurerm_subnet.private_endpoints
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.Network/virtualNetworks/vnet-goosetest-test/subnets/snet-pe-vnet-goosetest-test"
    }
  }

  override_resource {
    target = module.keyvault.azurerm_key_vault.main
    values = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.KeyVault/vaults/kv-goosetest-test"
      name = "kv-goosetest-test"
    }
  }

  override_resource {
    target = module.storage.azurerm_storage_account.main
    values = {
      id                 = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.Storage/storageAccounts/stgoosetesttestabc123"
      name               = "stgoosetesttestabc123"
      primary_access_key = "bW9ja2FjY2Vzc2tleWZvcnRlc3Rpbmcx"
    }
  }

  override_resource {
    target = module.storage.azurerm_storage_share.sqlite_data
    values = {
      name = "sqlite-data"
    }
  }

  override_resource {
    target = module.container_apps.azurerm_container_app_environment_storage.sqlite
    values = {
      name = "sqlite-data"
    }
  }

  override_resource {
    target = module.service_bus.azurerm_servicebus_namespace.main
    values = {
      id                                = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.ServiceBus/namespaces/sb-goosetest-test"
      name                              = "sb-goosetest-test"
      endpoint                          = "sb://sb-goosetest-test.servicebus.windows.net/"
      default_primary_connection_string = "Endpoint=sb://sb-goosetest-test.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=test"
    }
  }

  override_resource {
    target = module.service_bus.azurerm_servicebus_queue.work_items
    values = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.ServiceBus/namespaces/sb-goosetest-test/queues/minion-tasks"
      name = "minion-tasks"
    }
  }

  override_resource {
    target = module.container_registry.azurerm_container_registry.main
    values = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.ContainerRegistry/registries/acrgoosetesttestxyz789"
      name         = "acrgoosetesttestxyz789"
      login_server = "acrgoosetesttestxyz789.azurecr.io"
    }
  }

  override_resource {
    target = module.container_apps.azurerm_container_app_environment.main
    values = {
      id                         = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.App/managedEnvironments/cae-goosetest-test"
      log_analytics_workspace_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.OperationalInsights/workspaces/la-goosetest-test"
    }
  }

  override_resource {
    target = azurerm_private_dns_zone.keyvault
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.Network/privateDnsZones/privatelink.vaultcore.azure.net"
    }
  }

  override_resource {
    target = azurerm_private_dns_zone.storage_blob
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net"
    }
  }

  override_resource {
    target = azurerm_private_dns_zone.storage_table
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.Network/privateDnsZones/privatelink.table.core.windows.net"
    }
  }

  override_resource {
    target = azurerm_private_dns_zone.storage_file
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.Network/privateDnsZones/privatelink.file.core.windows.net"
    }
  }

  override_resource {
    target = azurerm_private_dns_zone.service_bus
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.Network/privateDnsZones/privatelink.servicebus.windows.net"
    }
  }
}

mock_provider "azapi" {
  override_resource {
    target = module.ai_foundry.azapi_resource.hub
    values = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.MachineLearningServices/workspaces/foundry-goosetest-test"
      name = "foundry-goosetest-test"
    }
  }

  override_resource {
    target = module.ai_foundry.azapi_resource.project
    values = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-goosetest-test/providers/Microsoft.MachineLearningServices/workspaces/foundry-project-goosetest-test"
      name = "foundry-project-goosetest-test"
    }
  }
}

mock_provider "random" {
  override_resource {
    target = module.storage.random_string.storage_suffix
    values = {
      result = "abc123"
    }
  }

  override_resource {
    target = module.container_registry.random_string.acr_suffix
    values = {
      result = "xyz789"
    }
  }
}

variables {
  environment = "test"
  location    = "westus2"
  name_prefix = "goosetest"
}

run "plan_is_valid" {
  command = plan
}

run "resource_group_name_is_correct" {
  command = plan

  assert {
    condition     = module.resource_group.name == "rg-goosetest-test"
    error_message = "Resource group name should match the expected pattern."
  }
}

run "storage_account_name_is_valid" {
  command = apply

  assert {
    condition     = length("st${var.name_prefix}${var.environment}abc123") >= 3 && length("st${var.name_prefix}${var.environment}abc123") <= 24 && can(regex("^[a-z0-9]+$", "st${var.name_prefix}${var.environment}abc123"))
    error_message = "Storage account name must be lowercase alphanumeric and between 3 and 24 characters."
  }
}

run "service_bus_namespace_name_is_valid" {
  command = apply

  assert {
    condition     = can(regex("^[a-zA-Z0-9][a-zA-Z0-9-]{4,48}[a-zA-Z0-9]$", module.service_bus.namespace_name))
    error_message = "Service Bus namespace name should be a valid Azure resource name."
  }
}

run "container_app_environment_uses_log_analytics" {
  command = apply

  assert {
    condition     = can(regex("log_analytics_workspace_id\\s*=\\s*module\\.observability\\.workspace_id", file("${path.root}/main.tf")))
    error_message = "Container Apps Environment must reference the Log Analytics workspace."
  }
}

run "key_vault_has_soft_delete_and_rbac" {
  command = plan

  assert {
    condition     = module.keyvault.soft_delete_enabled == true
    error_message = "Key Vault must have soft delete enabled."
  }
}

run "dashboard_app_has_ingress_and_health_probe" {
  command = plan

  assert {
    condition     = module.container_apps.dashboard_ingress_external_enabled == true
    error_message = "Dashboard container app must expose external ingress."
  }

  assert {
    condition     = module.container_apps.dashboard_liveness_path == "/health"
    error_message = "Dashboard container app must have a /health liveness probe."
  }
}

run "toolshed_app_is_deployed" {
  command = plan

  assert {
    condition     = module.container_apps.toolshed_name == "ca-toolshed-test"
    error_message = "Toolshed container app should be deployed with the expected name."
  }
}

run "private_endpoints_secure_all_services" {
  command = plan

  assert {
    condition     = azurerm_private_endpoint.keyvault.name == "pe-kv-goosetest-test"
    error_message = "Key Vault private endpoint must be created with the expected name."
  }

  assert {
    condition     = azurerm_private_dns_zone.keyvault.name == "privatelink.vaultcore.azure.net"
    error_message = "Key Vault private DNS zone must use the correct Azure zone name."
  }

  assert {
    condition     = azurerm_private_endpoint.storage_blob.name == "pe-st-blob-goosetest-test"
    error_message = "Storage blob private endpoint must be created."
  }

  assert {
    condition     = azurerm_private_endpoint.storage_table.name == "pe-st-table-goosetest-test"
    error_message = "Storage table private endpoint must be created."
  }

  assert {
    condition     = azurerm_private_endpoint.storage_file.name == "pe-st-file-goosetest-test"
    error_message = "Storage file private endpoint must be created for the SQLite File Share."
  }

  assert {
    condition     = azurerm_private_endpoint.service_bus.name == "pe-sb-goosetest-test"
    error_message = "Service Bus private endpoint must be created."
  }

  assert {
    condition     = azurerm_private_dns_zone.service_bus.name == "privatelink.servicebus.windows.net"
    error_message = "Service Bus private DNS zone must use the correct Azure zone name."
  }
}

run "sqlite_volume_is_mounted_in_all_apps" {
  command = plan

  assert {
    condition     = module.container_apps.sqlite_storage_name == "sqlite-data"
    error_message = "Container Apps environment storage must be configured for the sqlite-data file share."
  }

  assert {
    condition     = can(regex("SQLITE_PATH", file("${path.root}/main.tf")))
    error_message = "SQLITE_PATH must be set in the container apps env_vars."
  }
}
