resource "azapi_resource" "hub" {
  type      = "Microsoft.MachineLearningServices/workspaces@2024-04-01"
  name      = var.hub_name
  location  = var.location
  parent_id = data.azurerm_resource_group.main.id
  tags      = var.tags

  identity {
    type = "SystemAssigned"
  }

  body = {
    properties = {
      friendlyName = var.hub_name
      description  = "AI Foundry Hub for Minions Agent Framework"
      hbiWorkspace = false
      hubConfig = {
        defaultWorkspaceResourceGroup = data.azurerm_resource_group.main.id
      }
    }
    kind = "Hub"
  }
}

resource "azapi_resource" "project" {
  type      = "Microsoft.MachineLearningServices/workspaces@2024-04-01"
  name      = var.project_name
  location  = var.location
  parent_id = data.azurerm_resource_group.main.id
  tags      = var.tags

  body = {
    properties = {
      friendlyName  = var.project_name
      description   = "AI Foundry Project for Minions Agent Framework"
      hubResourceId = azapi_resource.hub.id
    }
    kind = "Project"
  }
}

resource "azapi_resource" "model_deployment" {
  for_each = { for d in var.model_deployments : d.name => d }

  type      = "Microsoft.MachineLearningServices/workspaces/deployments@2024-04-01"
  name      = each.value.name
  parent_id = azapi_resource.project.id

  body = {
    properties = {
      model = {
        format  = each.value.format
        name    = each.value.model_name
        version = each.value.version
      }
    }
    sku = {
      name     = each.value.sku
      capacity = each.value.capacity
    }
  }
}

resource "azurerm_role_assignment" "main" {
  for_each = { for idx, ra in var.role_assignments : idx => ra }

  scope                = azapi_resource.project.id
  role_definition_name = each.value.role_definition_name
  principal_id         = each.value.principal_id
}

terraform {
  required_version = ">= 1.9"

  required_providers {
    azapi = {
      source  = "azure/azapi"
      version = "~> 1.0"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

data "azurerm_resource_group" "main" {
  name = var.resource_group_name
}
