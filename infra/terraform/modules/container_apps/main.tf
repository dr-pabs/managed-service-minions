resource "azurerm_container_app_environment" "main" {
  name                       = var.environment_name
  resource_group_name        = var.resource_group_name
  location                   = var.location
  infrastructure_subnet_id   = var.subnet_id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  tags = var.tags
}

locals {
  secret_keys  = toset(keys(nonsensitive(var.secrets)))
  secret_names = { for key in local.secret_keys : key => replace(lower(key), "/[^a-z0-9-]/", "-") }
}

resource "azurerm_container_app_environment_storage" "sqlite" {
  name                         = "sqlite-data"
  container_app_environment_id = azurerm_container_app_environment.main.id
  account_name                 = var.sqlite_storage_account_name
  share_name                   = var.sqlite_share_name
  access_key                   = var.sqlite_storage_access_key
  access_mode                  = "ReadWrite"
}

resource "azurerm_container_app" "orchestrator" {
  name                         = var.orchestrator.name
  resource_group_name          = var.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [var.orchestrator.identity_id]
  }

  template {
    min_replicas = var.orchestrator.min_replicas
    max_replicas = var.orchestrator.max_replicas

    volume {
      name         = "sqlite-data"
      storage_type = "AzureFile"
      storage_name = azurerm_container_app_environment_storage.sqlite.name
    }

    container {
      name   = "orchestrator"
      image  = var.orchestrator.image
      cpu    = 1.0
      memory = "2Gi"

      dynamic "env" {
        for_each = var.env_vars
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secret_keys
        content {
          name        = env.value
          secret_name = local.secret_names[env.value]
        }
      }

      volume_mounts {
        name = "sqlite-data"
        path = "/data"
      }
    }
  }

  dynamic "secret" {
    for_each = local.secret_keys
    content {
      name  = local.secret_names[secret.value]
      value = var.secrets[secret.value]
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].container[0].image
    ]
  }
}

# Milestone 15: the queue-ingress is the Service Bus work-queue consumer. It
# runs the same orchestrator runner the chat/webhook ingresses use (in-process)
# and is the KEDA scaling target — scaled on the work queue's depth (queue-mode
# metadata), which replaced the topic+subscription scaler that previously lived
# on the orchestrator app.
resource "azurerm_container_app" "queue_ingress" {
  name                         = var.queue_ingress.name
  resource_group_name          = var.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [var.queue_ingress.identity_id]
  }

  template {
    min_replicas = var.queue_ingress.min_replicas
    max_replicas = var.queue_ingress.max_replicas

    volume {
      name         = "sqlite-data"
      storage_type = "AzureFile"
      storage_name = azurerm_container_app_environment_storage.sqlite.name
    }

    container {
      name   = "queue-ingress"
      image  = var.queue_ingress.image
      cpu    = 1.0
      memory = "2Gi"

      dynamic "env" {
        for_each = var.env_vars
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secret_keys
        content {
          name        = env.value
          secret_name = local.secret_names[env.value]
        }
      }

      volume_mounts {
        name = "sqlite-data"
        path = "/data"
      }
    }

    custom_scale_rule {
      name             = "service-bus-queue-scale"
      custom_rule_type = "azure-servicebus"

      metadata = {
        namespaceName = var.queue_ingress.service_bus_rule.namespace_name
        queueName     = var.queue_ingress.service_bus_rule.queue_name
        messageCount  = var.queue_ingress.service_bus_rule.message_count
      }

      authentication {
        secret_name       = local.secret_names["SERVICE_BUS_CONNECTION_STRING"]
        trigger_parameter = "connection"
      }
    }
  }

  dynamic "secret" {
    for_each = local.secret_keys
    content {
      name  = local.secret_names[secret.value]
      value = var.secrets[secret.value]
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].container[0].image
    ]
  }
}

resource "azurerm_container_app" "slack_bot" {
  name                         = var.slack_bot.name
  resource_group_name          = var.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [var.slack_bot.identity_id]
  }

  template {
    # Pinned to a single replica (ADR-025): the bot shares the same mounted
    # SQLite file as the toolshed/dashboard and posts through the toolshed's
    # process-local rate limiter/breaker; a second replica adds no
    # coordination-safe capacity today.
    min_replicas = 1
    max_replicas = 1

    volume {
      name         = "sqlite-data"
      storage_type = "AzureFile"
      storage_name = azurerm_container_app_environment_storage.sqlite.name
    }

    container {
      name   = "slack-bot"
      image  = var.slack_bot.image
      cpu    = 0.5
      memory = "1Gi"

      dynamic "env" {
        for_each = var.env_vars
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secret_keys
        content {
          name        = env.value
          secret_name = local.secret_names[env.value]
        }
      }

      volume_mounts {
        name = "sqlite-data"
        path = "/data"
      }
    }
  }

  dynamic "secret" {
    for_each = local.secret_keys
    content {
      name  = local.secret_names[secret.value]
      value = var.secrets[secret.value]
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].container[0].image
    ]
  }
}

resource "azurerm_container_app" "toolshed" {
  name                         = var.toolshed.name
  resource_group_name          = var.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [var.toolshed.identity_id]
  }

  template {
    # Pinned to a single replica (ADR-025): the rate limiter's token buckets,
    # circuit breakers, and pending-approval reads/writes are process-local
    # state with no cross-replica coordination. Running >1 replica here would
    # silently multiply effective rate limits, let each replica's breaker
    # trip independently of the others, and risk inconsistent approval reads
    # across the shared SQLite file. Revisit only per ADR-025's trigger
    # condition (sustained load beyond one replica's capacity, measured via
    # Milestone 13 metrics), and only after GovernanceStateStore gets a real
    # distributed implementation.
    min_replicas = 1
    max_replicas = 1

    volume {
      name         = "sqlite-data"
      storage_type = "AzureFile"
      storage_name = azurerm_container_app_environment_storage.sqlite.name
    }

    container {
      name   = "toolshed"
      image  = var.toolshed.image
      cpu    = 0.5
      memory = "1Gi"

      dynamic "env" {
        for_each = var.env_vars
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secret_keys
        content {
          name        = env.value
          secret_name = local.secret_names[env.value]
        }
      }

      volume_mounts {
        name = "sqlite-data"
        path = "/data"
      }

      liveness_probe {
        transport = "TCP"
        port      = 8080
      }
    }
  }

  dynamic "secret" {
    for_each = local.secret_keys
    content {
      name  = local.secret_names[secret.value]
      value = var.secrets[secret.value]
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].container[0].image
    ]
  }
}

resource "azurerm_container_app" "dashboard" {
  name                         = var.dashboard.name
  resource_group_name          = var.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [var.dashboard.identity_id]
  }

  ingress {
    external_enabled = true
    target_port      = var.dashboard.port
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    # Pinned to a single replica (ADR-025): the dashboard shares the same
    # mounted SQLite file as the toolshed and, from Milestone 14, proxies
    # operator approve/deny actions to the toolshed's operator endpoint — it
    # has no independent governance state of its own but inherits the same
    # "one writer's view is authoritative" assumption in the approval path.
    # It is a read/proxy layer with no rate-limiter or breaker state, so
    # unlike the toolshed there is no throughput reason to scale it out
    # today either.
    min_replicas = 1
    max_replicas = 1

    volume {
      name         = "sqlite-data"
      storage_type = "AzureFile"
      storage_name = azurerm_container_app_environment_storage.sqlite.name
    }

    container {
      name   = "dashboard"
      image  = var.dashboard.image
      cpu    = 0.5
      memory = "1Gi"

      dynamic "env" {
        for_each = var.env_vars
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secret_keys
        content {
          name        = env.value
          secret_name = local.secret_names[env.value]
        }
      }

      volume_mounts {
        name = "sqlite-data"
        path = "/data"
      }

      liveness_probe {
        transport        = "HTTP"
        port             = var.dashboard.port
        path             = "/health"
        interval_seconds = 30
      }

      readiness_probe {
        transport        = "HTTP"
        port             = var.dashboard.port
        path             = "/health"
        interval_seconds = 10
      }
    }
  }

  dynamic "secret" {
    for_each = local.secret_keys
    content {
      name  = local.secret_names[secret.value]
      value = var.secrets[secret.value]
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].container[0].image
    ]
  }
}

# Milestone 14 (review finding M7 "the dashboard has no auth", closed):
# production front door for the dashboard is Azure Container Apps' built-in
# Entra ID authentication ("easy auth"), NOT `DASHBOARD_AUTH_TOKEN` — that
# token is the local-dev fallback the app itself enforces
# (extensions/agent-dashboard/src/dashboard.ts, `isDashboardAuthorized`) when
# no platform-level auth is available. `azurerm` 3.x's `azurerm_container_app`
# resource has no native easy-auth block (that support landed in the ARM API
# as `Microsoft.App/containerApps/authConfigs`, a child resource this
# provider version doesn't model), so this is expressed via `azapi_resource`
# against the same underlying ARM API the AI Foundry module already uses.
# Requiring authentication rejects unauthenticated requests at the platform
# edge — the dashboard's own `DASHBOARD_AUTH_TOKEN` check becomes defense in
# depth once this is enabled, not the primary control.
resource "azapi_resource" "dashboard_easy_auth" {
  count = var.dashboard.entra_client_id != null ? 1 : 0

  type      = "Microsoft.App/containerApps/authConfigs@2023-05-01"
  name      = "current"
  parent_id = azurerm_container_app.dashboard.id

  body = {
    properties = {
      platform = {
        enabled = true
      }
      globalValidation = {
        # Any signed-in Entra ID user in the tenant is authenticated by the
        # platform; the dashboard's own operator-identity checks (approve/deny
        # proxy, Milestone 14) still gate WHAT an authenticated user can do.
        unauthenticatedClientAction = "RedirectToLoginPage"
      }
      identityProviders = {
        azureActiveDirectory = {
          enabled = true
          registration = {
            clientId                = var.dashboard.entra_client_id
            clientSecretSettingName = "dashboard-entra-client-secret"
            openIdIssuer            = "https://login.microsoftonline.com/${var.dashboard.entra_tenant_id}/v2.0"
          }
        }
      }
    }
  }
}

resource "azurerm_container_app" "teams_bot" {
  name                         = var.teams_bot.name
  resource_group_name          = var.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [var.teams_bot.identity_id]
  }

  template {
    # Pinned to a single replica (ADR-025): the bot shares the same mounted
    # SQLite file as the toolshed/dashboard and posts through the toolshed's
    # process-local rate limiter/breaker; a second replica adds no
    # coordination-safe capacity today.
    min_replicas = 1
    max_replicas = 1

    volume {
      name         = "sqlite-data"
      storage_type = "AzureFile"
      storage_name = azurerm_container_app_environment_storage.sqlite.name
    }

    container {
      name   = "teams-bot"
      image  = var.teams_bot.image
      cpu    = 0.5
      memory = "1Gi"

      dynamic "env" {
        for_each = var.env_vars
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secret_keys
        content {
          name        = env.value
          secret_name = local.secret_names[env.value]
        }
      }

      volume_mounts {
        name = "sqlite-data"
        path = "/data"
      }
    }
  }

  dynamic "secret" {
    for_each = local.secret_keys
    content {
      name  = local.secret_names[secret.value]
      value = var.secrets[secret.value]
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].container[0].image
    ]
  }
}

terraform {
  required_version = ">= 1.9"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
    # Milestone 14: azapi_resource.dashboard_easy_auth needs its own
    # required_providers block (same as modules/ai_foundry) -- Terraform
    # does not implicitly propagate a non-default-namespace provider's
    # source address ("azure/azapi", not "hashicorp/azapi") down into a
    # child module just because the root module declares it.
    azapi = {
      source  = "azure/azapi"
      version = "~> 1.0"
    }
  }
}
