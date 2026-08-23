# dsh-llm-providers Specification

## Purpose
TBD - created by archiving change migrate-pi-to-dsh. Update Purpose after archive.
## Requirements
### Requirement: Volces provider is registered as a dsh llm adapter plugin

The server SHALL register the Volces (火山引擎) OpenAI-compatible endpoint as a dsh `ctx.llm` adapter plugin (or llm profile entry) rather than a pi provider extension. The adapter SHALL carry the base URL, API key (resolved from `VOLCES_API_KEY` or the fallback), the `openai-completions` API style, and the model list (deepseek-v4-pro, glm-5.2, etc.). The Volces provider SHALL be added to the set of exposed providers in the model selector.

#### Scenario: Volces adapter loaded at startup
- **WHEN** the server starts with `VOLCES_API_KEY` set (or the fallback available)
- **THEN** the dsh runtime SHALL load the Volces llm adapter and Volces models SHALL appear in `list_models`

#### Scenario: Volces not configured
- **WHEN** `VOLCES_API_KEY` is unset and no fallback is available
- **THEN** the Volces adapter SHALL NOT be loaded and the server SHALL log a warning

### Requirement: LiteLLM provider is registered as a dsh llm adapter plugin

The server SHALL register a LiteLLM proxy as a dsh llm adapter plugin (replacing the `pi-provider-litellm` extension) when `LITELLM_BASE_URL` and `LITELLM_API_KEY` are set. The adapter SHALL discover its model list from the proxy rather than hardcoding. LiteLLM-routed models SHALL be included in the model selector when configured.

#### Scenario: LiteLLM adapter registered at startup
- **WHEN** the server starts with `LITELLM_BASE_URL` and `LITELLM_API_KEY` set to a reachable proxy
- **THEN** the dsh runtime SHALL load the LiteLLM llm adapter, register a provider named `litellm`, and discover its models from the proxy

#### Scenario: LiteLLM proxy unreachable at startup
- **WHEN** the server starts with `LITELLM_BASE_URL` set but the proxy is unreachable
- **THEN** the server SHALL bound discovery to a short timeout, log a warning, and continue with the Volces adapter still available

#### Scenario: LiteLLM not configured
- **WHEN** the server starts without `LITELLM_BASE_URL` or `LITELLM_API_KEY`
- **THEN** the server SHALL log a warning and continue without loading the LiteLLM adapter

### Requirement: Provider credentials are resolved per-request from a hot-reloaded store
The server SHALL route upstream provider API keys (`LLM_API_KEY`, `LITELLM_API_KEY`) into dsh's `dsh-credentials-local` hot-reloaded credential store (`.credentials.yaml`, 0600 perms) rather than reading them once from `process.env` at boot. A rotated key SHALL reach the **next LLM request** without a dsh process restart, because `dsh-credentials-local` resolves the key per request and hot-reloads the file. The store SHALL be seeded from `process.env` on first run when the file is absent.

#### Scenario: rotated key takes effect without restart
- **WHEN** an upstream provider API key is changed (written to `.credentials.yaml`)
- **THEN** the next LLM request SHALL use the new key
- **AND** the dsh process SHALL NOT be restarted

#### Scenario: credential store seeded from env on first run
- **WHEN** the server starts and `.credentials.yaml` is absent
- **THEN** the server SHALL seed it from the configured `process.env` keys
- **AND** the file SHALL be written with 0600 permissions

### Requirement: LiteLLM credentials do not leak to the browser
The server SHALL NOT expose `LITELLM_API_KEY` (or any upstream provider key) to the browser. The `/api/litellm/credentials` route SHALL be removed or replaced by the existing cookie-based auto-login used for the LiteLLM `/ui` iframe, so local mode aligns with the already-correct remote mode. Credentials SHALL remain server-side only (project convention: tokens never reach the browser).

#### Scenario: credentials route does not return the key
- **WHEN** a browser client requests the LiteLLM credentials endpoint
- **THEN** the response SHALL NOT contain the `LITELLM_API_KEY`
- **AND** LiteLLM UI access SHALL be provided via the server-set login cookie instead

