locals {
  base_name = "${var.name_prefix}-${var.environment}"
  common_tags = merge(
    {
      environment = var.environment
      managed_by  = "terraform"
      project     = "minions-agent-framework"
    },
    var.tags
  )
}

module "resource_group" {
  source = "./modules/resource_group"

  name     = "rg-${local.base_name}"
  location = var.location
  tags     = local.common_tags
}

module "observability" {
  source = "./modules/observability"

  name                = "la-${local.base_name}"
  resource_group_name = module.resource_group.name
  location            = var.location
  tags                = local.common_tags
}

module "networking" {
  source = "./modules/networking"

  name                = "vnet-${local.base_name}"
  resource_group_name = module.resource_group.name
  location            = var.location
  tags                = local.common_tags
}

module "managed_identity" {
  source = "./modules/managed_identity"

  resource_group_name = module.resource_group.name
  location            = var.location
  tags                = local.common_tags
  names = {
    orchestrator  = "mi-orch-${local.base_name}"
    slack_bot     = "mi-slack-${local.base_name}"
    teams_bot     = "mi-teams-${local.base_name}"
    dashboard     = "mi-dash-${local.base_name}"
    toolshed      = "mi-toolshed-${local.base_name}"
    queue_ingress = "mi-queue-ingress-${local.base_name}"
  }
}

module "keyvault" {
  source = "./modules/keyvault"

  name                = "kv-${local.base_name}"
  resource_group_name = module.resource_group.name
  location            = var.location
  tags                = local.common_tags

  role_assignments = [
    {
      principal_id         = module.managed_identity.orchestrator_principal_id
      role_definition_name = "Key Vault Secrets User"
    },
    {
      principal_id         = module.managed_identity.slack_bot_principal_id
      role_definition_name = "Key Vault Secrets User"
    },
    {
      principal_id         = module.managed_identity.teams_bot_principal_id
      role_definition_name = "Key Vault Secrets User"
    },
    {
      principal_id         = module.managed_identity.dashboard_principal_id
      role_definition_name = "Key Vault Secrets User"
    },
    {
      principal_id         = module.managed_identity.toolshed_principal_id
      role_definition_name = "Key Vault Secrets User"
    }
  ]
}

module "storage" {
  source = "./modules/storage"

  name_prefix         = var.name_prefix
  environment         = var.environment
  resource_group_name = module.resource_group.name
  location            = var.location
  tags                = local.common_tags

  role_assignments = [
    {
      principal_id         = module.managed_identity.orchestrator_principal_id
      role_definition_name = "Storage Table Data Contributor"
    },
    {
      principal_id         = module.managed_identity.orchestrator_principal_id
      role_definition_name = "Storage Blob Data Contributor"
    },
    {
      principal_id         = module.managed_identity.toolshed_principal_id
      role_definition_name = "Storage Table Data Contributor"
    },
    {
      principal_id         = module.managed_identity.dashboard_principal_id
      role_definition_name = "Storage Table Data Contributor"
    },
    {
      principal_id         = module.managed_identity.slack_bot_principal_id
      role_definition_name = "Storage Table Data Contributor"
    },
    {
      principal_id         = module.managed_identity.teams_bot_principal_id
      role_definition_name = "Storage Table Data Contributor"
    }
  ]
}

module "service_bus" {
  source = "./modules/service_bus"

  name                = "sb-${local.base_name}"
  resource_group_name = module.resource_group.name
  location            = var.location
  tags                = local.common_tags

  role_assignments = [
    {
      principal_id         = module.managed_identity.orchestrator_principal_id
      role_definition_name = "Azure Service Bus Data Sender"
    },
    {
      principal_id         = module.managed_identity.orchestrator_principal_id
      role_definition_name = "Azure Service Bus Data Receiver"
    },
    {
      principal_id         = module.managed_identity.queue_ingress_principal_id
      role_definition_name = "Azure Service Bus Data Sender"
    },
    {
      principal_id         = module.managed_identity.queue_ingress_principal_id
      role_definition_name = "Azure Service Bus Data Receiver"
    }
  ]
}

module "container_registry" {
  source = "./modules/container_registry"

  name_prefix         = var.name_prefix
  environment         = var.environment
  resource_group_name = module.resource_group.name
  location            = var.location
  tags                = local.common_tags
}

module "ai_foundry" {
  source = "./modules/ai_foundry"

  hub_name            = "foundry-${local.base_name}"
  project_name        = "foundry-project-${local.base_name}"
  resource_group_name = module.resource_group.name
  location            = var.location
  tags                = local.common_tags

  model_deployments = var.ai_model_deployments

  role_assignments = [
    {
      principal_id         = module.managed_identity.orchestrator_principal_id
      role_definition_name = "Cognitive Services OpenAI User"
    },
    {
      principal_id         = module.managed_identity.toolshed_principal_id
      role_definition_name = "Cognitive Services OpenAI User"
    },
    {
      principal_id         = module.managed_identity.dashboard_principal_id
      role_definition_name = "Cognitive Services OpenAI User"
    }
  ]
}

module "container_apps" {
  source = "./modules/container_apps"

  resource_group_name = module.resource_group.name
  location            = var.location
  tags                = local.common_tags

  environment_name = "cae-${local.base_name}"
  subnet_id        = module.networking.container_apps_subnet_id

  orchestrator = {
    name         = "ca-orchestrator-${var.environment}"
    identity_id  = module.managed_identity.orchestrator_id
    image        = "${module.container_registry.login_server}/orchestrator:latest"
    min_replicas = 1
    max_replicas = 5
  }

  queue_ingress = {
    name             = "ca-queue-ingress-${var.environment}"
    identity_id      = module.managed_identity.queue_ingress_id
    image            = "${module.container_registry.login_server}/queue-ingress:latest"
    min_replicas     = 1
    max_replicas     = 5
    service_bus_rule = module.service_bus.scale_rule
  }

  slack_bot = {
    name        = "ca-slackbot-${var.environment}"
    identity_id = module.managed_identity.slack_bot_id
    image       = "${module.container_registry.login_server}/slack-bot:latest"
  }

  teams_bot = {
    name        = "ca-teamsbot-${var.environment}"
    identity_id = module.managed_identity.teams_bot_id
    image       = "${module.container_registry.login_server}/teams-bot:latest"
  }

  dashboard = {
    name        = "ca-dashboard-${var.environment}"
    identity_id = module.managed_identity.dashboard_id
    image       = "${module.container_registry.login_server}/agent-dashboard:latest"
    port        = 3001
    # Milestone 14 (review finding M7): set both to enable Azure Container
    # Apps' Entra ID "easy auth" as this app's production front door — see
    # modules/container_apps/main.tf's azapi_resource.dashboard_easy_auth.
    # Left null here (module default) until an Entra app registration and
    # its client secret (provisioned into Key Vault, referenced as a
    # Container App secret) exist for this environment; DASHBOARD_AUTH_TOKEN
    # is the dashboard's own fallback either way.
    entra_client_id = null
    entra_tenant_id = null
  }

  toolshed = {
    name        = "ca-toolshed-${var.environment}"
    identity_id = module.managed_identity.toolshed_id
    image       = "${module.container_registry.login_server}/mcp-toolshed:latest"
    # Milestone 18 (ADR-026): the toolshed now scales past one replica — its
    # rate-limit buckets and circuit breaker state live in the shared
    # `GovernanceState` Azure Table, so multiple replicas enforce one view of
    # them. Pending-approval CRUD remains single-writer on SQLite (see ADR-026).
    min_replicas = 1
    max_replicas = 5
  }

  log_analytics_workspace_id = module.observability.workspace_id

  sqlite_storage_account_name = module.storage.account_name
  sqlite_share_name           = module.storage.sqlite_share_name
  sqlite_storage_access_key   = module.storage.primary_access_key

  env_vars = merge(
    {
      KEY_VAULT_NAME      = module.keyvault.name
      AI_FOUNDRY_ENDPOINT = module.ai_foundry.project_endpoint
      GOOSE_SERVE_URL     = var.goose_serve_url
      SQLITE_PATH         = "/data/sessions.sqlite"
    },
    var.model_provider_endpoints
  )

  secrets = merge(
    {
      SERVICE_BUS_CONNECTION_STRING = module.service_bus.primary_connection_string
      STORAGE_CONNECTION_STRING     = module.storage.primary_connection_string
      # Milestone 18 (ADR-026): the toolshed reads this to persist rate-limit
      # buckets and circuit breaker state to the shared `GovernanceState`
      # table (default table name matches modules/storage/main.tf). Injected as
      # a Container App secret/env var on every app; only the toolshed reads it.
      TOOLSHED_GOVERNANCE_STATE_CONNECTION_STRING = module.storage.primary_connection_string
      SLACK_BOT_TOKEN                             = var.slack_bot_token
      SLACK_SIGNING_SECRET                        = var.slack_signing_secret
      MICROSOFT_APP_ID                            = var.microsoft_app_id
      MICROSOFT_APP_PASSWORD                      = var.microsoft_app_password
      GITHUB_TOKEN                                = var.github_token
      AZURE_DEVOPS_PAT                            = var.azure_devops_pat
      SERVICENOW_API_KEY                          = var.servicenow_api_key
      JIRA_API_TOKEN                              = var.jira_api_token
    },
    var.model_provider_keys
  )
}

module "grafana" {
  source = "./modules/grafana"

  count = var.enable_grafana ? 1 : 0

  name                = "graf-${local.base_name}"
  resource_group_name = module.resource_group.name
  location            = var.location
  tags                = local.common_tags
}

# ── Private Endpoints & DNS Zones ────────────────────────────────────────────
# Each Azure PaaS service gets a private endpoint in the dedicated subnet so
# Container Apps can reach them over private IPs, with no public exposure.

resource "azurerm_private_dns_zone" "keyvault" {
  name                = "privatelink.vaultcore.azure.net"
  resource_group_name = module.resource_group.name
  tags                = local.common_tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "keyvault" {
  name                  = "kv-vnet-link-${local.base_name}"
  resource_group_name   = module.resource_group.name
  private_dns_zone_name = azurerm_private_dns_zone.keyvault.name
  virtual_network_id    = module.networking.vnet_id
  tags                  = local.common_tags
}

resource "azurerm_private_endpoint" "keyvault" {
  name                = "pe-kv-${local.base_name}"
  location            = var.location
  resource_group_name = module.resource_group.name
  subnet_id           = module.networking.private_endpoint_subnet_id
  tags                = local.common_tags

  private_service_connection {
    name                           = "keyvault-connection"
    private_connection_resource_id = module.keyvault.id
    subresource_names              = ["vault"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "keyvault-dns-zone-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.keyvault.id]
  }
}

resource "azurerm_private_dns_zone" "storage_blob" {
  name                = "privatelink.blob.core.windows.net"
  resource_group_name = module.resource_group.name
  tags                = local.common_tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "storage_blob" {
  name                  = "stblob-vnet-link-${local.base_name}"
  resource_group_name   = module.resource_group.name
  private_dns_zone_name = azurerm_private_dns_zone.storage_blob.name
  virtual_network_id    = module.networking.vnet_id
  tags                  = local.common_tags
}

resource "azurerm_private_endpoint" "storage_blob" {
  name                = "pe-st-blob-${local.base_name}"
  location            = var.location
  resource_group_name = module.resource_group.name
  subnet_id           = module.networking.private_endpoint_subnet_id
  tags                = local.common_tags

  private_service_connection {
    name                           = "storage-blob-connection"
    private_connection_resource_id = module.storage.account_id
    subresource_names              = ["blob"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "storage-blob-dns-zone-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.storage_blob.id]
  }
}

resource "azurerm_private_dns_zone" "storage_table" {
  name                = "privatelink.table.core.windows.net"
  resource_group_name = module.resource_group.name
  tags                = local.common_tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "storage_table" {
  name                  = "sttable-vnet-link-${local.base_name}"
  resource_group_name   = module.resource_group.name
  private_dns_zone_name = azurerm_private_dns_zone.storage_table.name
  virtual_network_id    = module.networking.vnet_id
  tags                  = local.common_tags
}

resource "azurerm_private_endpoint" "storage_table" {
  name                = "pe-st-table-${local.base_name}"
  location            = var.location
  resource_group_name = module.resource_group.name
  subnet_id           = module.networking.private_endpoint_subnet_id
  tags                = local.common_tags

  private_service_connection {
    name                           = "storage-table-connection"
    private_connection_resource_id = module.storage.account_id
    subresource_names              = ["table"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "storage-table-dns-zone-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.storage_table.id]
  }
}

resource "azurerm_private_dns_zone" "storage_file" {
  name                = "privatelink.file.core.windows.net"
  resource_group_name = module.resource_group.name
  tags                = local.common_tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "storage_file" {
  name                  = "stfile-vnet-link-${local.base_name}"
  resource_group_name   = module.resource_group.name
  private_dns_zone_name = azurerm_private_dns_zone.storage_file.name
  virtual_network_id    = module.networking.vnet_id
  tags                  = local.common_tags
}

resource "azurerm_private_endpoint" "storage_file" {
  name                = "pe-st-file-${local.base_name}"
  location            = var.location
  resource_group_name = module.resource_group.name
  subnet_id           = module.networking.private_endpoint_subnet_id
  tags                = local.common_tags

  private_service_connection {
    name                           = "storage-file-connection"
    private_connection_resource_id = module.storage.account_id
    subresource_names              = ["file"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "storage-file-dns-zone-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.storage_file.id]
  }
}

resource "azurerm_private_dns_zone" "service_bus" {
  name                = "privatelink.servicebus.windows.net"
  resource_group_name = module.resource_group.name
  tags                = local.common_tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "service_bus" {
  name                  = "sb-vnet-link-${local.base_name}"
  resource_group_name   = module.resource_group.name
  private_dns_zone_name = azurerm_private_dns_zone.service_bus.name
  virtual_network_id    = module.networking.vnet_id
  tags                  = local.common_tags
}

resource "azurerm_private_endpoint" "service_bus" {
  name                = "pe-sb-${local.base_name}"
  location            = var.location
  resource_group_name = module.resource_group.name
  subnet_id           = module.networking.private_endpoint_subnet_id
  tags                = local.common_tags

  private_service_connection {
    name                           = "servicebus-connection"
    private_connection_resource_id = module.service_bus.namespace_id
    subresource_names              = ["namespace"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "servicebus-dns-zone-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.service_bus.id]
  }
}
