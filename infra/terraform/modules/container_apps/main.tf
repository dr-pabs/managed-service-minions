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

      volume_mount {
        name       = "sqlite-data"
        mount_path = "/data"
      }
    }

    custom_scale_rule {
      name             = "service-bus-scale"
      custom_rule_type = "azure-servicebus"

      metadata = {
        namespaceName    = var.orchestrator.service_bus_rule.namespace_name
        topicName        = var.orchestrator.service_bus_rule.topic_name
        subscriptionName = var.orchestrator.service_bus_rule.subscription_name
        messageCount     = "3"
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

      volume_mount {
        name       = "sqlite-data"
        mount_path = "/data"
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
    min_replicas = 1
    max_replicas = 3

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

      volume_mount {
        name       = "sqlite-data"
        mount_path = "/data"
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
    min_replicas = 1
    max_replicas = 3

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

      volume_mount {
        name       = "sqlite-data"
        mount_path = "/data"
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

      volume_mount {
        name       = "sqlite-data"
        mount_path = "/data"
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
