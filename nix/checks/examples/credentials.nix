{
  env = { LLM_GATEWAY_URL = "https://gateway.internal/v1"; };
  secretEnv = { LLM_GATEWAY_KEY = "$(cat /run/secrets/gateway-key)"; };
  piFiles = { "models.json" = ./models.json; };
}
