name_prefix    = "goose"
environment    = "dev"
location       = "westus2"
enable_grafana = true

tags = {
  environment = "dev"
  project     = "minions-agent-framework"
}

# ── Azure AI Foundry model deployments ───────────────────────────────────────
# Only populate this if you are serving models through Azure AI Foundry.
# Leave empty (default []) if you are using external providers exclusively.
#
# format = "OpenAI"  → Azure OpenAI Service model (default)
# format = "Azure"   → Azure AI Foundry catalog model (requires catalog access)
#
# Set name to match the deployment field in rules/models.yaml for that tier.
# Set model_name and version to whatever the Azure portal / catalog shows as
# current for your chosen model — do not hardcode versions here.
#
# Example structure (fill in your chosen model names and current versions):
#
# ai_model_deployments = [
#   {
#     name       = "my-fast-model"        # must match rules/models.yaml fast.deployment
#     model_name = "<azure-model-name>"
#     version    = "<current-version>"
#     sku        = "GlobalStandard"
#     capacity   = 50
#     format     = "OpenAI"
#   },
#   {
#     name       = "my-reasoning-model"   # must match rules/models.yaml reasoning.deployment
#     model_name = "<azure-model-name>"
#     version    = "<current-version>"
#     sku        = "GlobalStandard"
#     capacity   = 50
#     format     = "OpenAI"
#   },
#   # Catalog model (Claude, Deepseek, Qwen, etc.) via Azure AI Foundry marketplace:
#   # {
#   #   name       = "my-review-model"    # must match rules/models.yaml code_review.deployment
#   #   model_name = "<catalog-model-id>" # as shown in the AI Foundry catalog
#   #   version    = "<catalog-version>"
#   #   sku        = "Serverless"
#   #   capacity   = 1
#   #   format     = "Azure"
#   # },
# ]

ai_model_deployments = []

# ── External model provider API keys ─────────────────────────────────────────
# Use the provider's native env var name as the key. The value is stored in
# Key Vault and injected into each container at runtime.
#
# model_provider_keys = {
#   ANTHROPIC_API_KEY = ""   # Anthropic (Claude family)
#   OPENAI_API_KEY    = ""   # OpenAI API
#   DEEPSEEK_API_KEY  = ""   # Deepseek (deepseek.com)
#   ZHIPU_API_KEY     = ""   # ZhipuAI / z.ai
#   # Add any other provider key your chosen models require.
# }

model_provider_keys = {}

# ── External / local model endpoint overrides ─────────────────────────────────
# For providers not at their standard URL — local Ollama/vLLM/llama.cpp servers,
# private proxies, or compatible third-party services.
#
# model_provider_endpoints = {
#   OLLAMA_HOST     = "http://my-ollama-host:11434"   # Ollama
#   OPENAI_BASE_URL = "http://my-vllm:8000/v1"        # vLLM or any OpenAI-compat server
#   # Add any other endpoint env var your chosen provider's SDK looks for.
# }

model_provider_endpoints = {}
