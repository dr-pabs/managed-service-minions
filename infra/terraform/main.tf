locals {
  base_name = "${var.name_prefix}-${var.environment}"
  common_tags = merge(
    {
      environment = var.environment
      managed_by  = "terraform"
      project     = "goose-agent-framework"
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
    orchestrator = "mi-orch-${local.base_name}"
    slack_bot    = "mi-slack-${local.base_name}"
    teams_bot    = "mi-teams-${local.base_name}"
    dashboard    = "mi-dash-${local.base_name}"
    toolshed     = "mi-toolshed-${local.base_name}"
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
    name             = "ca-orchestrator-${var.environment}"
    identity_id      = module.managed_identity.orchestrator_id
    image            = "${module.container_registry.login_server}/orchestrator:latest"
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
  }

  toolshed = {
    name        = "ca-toolshed-${var.environment}"
    identity_id = module.managed_identity.toolshed_id
    image       = "${module.container_registry.login_server}/mcp-toolshed:latest"
  }

  log_analytics_workspace_id = module.observability.workspace_id

  env_vars = {
    KEY_VAULT_NAME      = module.keyvault.name
    AI_FOUNDRY_ENDPOINT = module.ai_foundry.project_endpoint
    GOOSE_SERVE_URL     = var.goose_serve_url
  }

  secrets = {
    SERVICE_BUS_CONNECTION_STRING = module.service_bus.primary_connection_string
    STORAGE_CONNECTION_STRING     = module.storage.primary_connection_string
    SLACK_BOT_TOKEN               = var.slack_bot_token
    SLACK_SIGNING_SECRET          = var.slack_signing_secret
    MICROSOFT_APP_ID              = var.microsoft_app_id
    MICROSOFT_APP_PASSWORD        = var.microsoft_app_password
    GITHUB_TOKEN                  = var.github_token
    AZURE_DEVOPS_PAT              = var.azure_devops_pat
    SERVICENOW_API_KEY            = var.servicenow_api_key
    JIRA_API_TOKEN                = var.jira_api_token
  }
}

module "grafana" {
  source = "./modules/grafana"

  count = var.enable_grafana ? 1 : 0

  name                = "graf-${local.base_name}"
  resource_group_name = module.resource_group.name
  location            = var.location
  tags                = local.common_tags
}
