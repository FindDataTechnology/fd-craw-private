# model-selection Specification

## Purpose
TBD - created by archiving change add-mcp-skills-model-select. Update Purpose after archive.
## Requirements
### Requirement: Server lists available models to the client
The server SHALL respond to a `list_models` WebSocket message with the set of models available to the agent, each including its id, display name, and provider, sourced from the model registry's available models and scoped to the providers the server is configured to use. When LiteLLM is configured, LiteLLM-routed models SHALL be included and correctly identified.

#### Scenario: client requests the model list
- **WHEN** a WebSocket client sends `{ "type": "list_models" }`
- **THEN** the server SHALL reply with `{ "type": "models", "models": [ { "id": "...", "name": "...", "provider": "..." }, ... ] }` containing only models from the server's configured providers that have configured auth

#### Scenario: LiteLLM models appear in selector when configured
- **WHEN** the server starts with LiteLLM configured
- **AND** a client sends `{ "type": "list_models" }`
- **THEN** the server SHALL include LiteLLM-routed models in the `models` response
- **AND** the model selector dropdown SHALL display LiteLLM models as selectable options

### Requirement: Server communicates the active model
The server SHALL send the currently active model id to a client when its WebSocket connection opens, and SHALL send a `model_changed` event whenever the active model changes.

#### Scenario: client connects
- **WHEN** a WebSocket client establishes a connection
- **THEN** the server SHALL send `{ "type": "current_model", "id": "<active model id>" }`

#### Scenario: model is switched
- **WHEN** the active model changes from `glm-5.2` to `deepseek-v4-pro`
- **THEN** the server SHALL broadcast `{ "type": "model_changed", "id": "deepseek-v4-pro" }` to all clients

### Requirement: User can switch the active model at runtime
The server SHALL accept a `set_model` WebSocket message OR a `/model <id>` chat command and switch the agent session's active model via the SDK's runtime model-switch API, validating that the requested model is available and has configured auth. A `/model` command with no argument SHALL report the currently active model AND list all available selectable models. The switched model SHALL apply to the next agent turn. (Model switching is rejected while the agent is streaming, per the dedicated streaming-guard requirement.)

#### Scenario: user selects a valid model via the selector
- **WHEN** a client sends `{ "type": "set_model", "id": "deepseek-v4-flash" }` for a model in the available list
- **THEN** the server SHALL switch the session's active model and broadcast `model_changed` with the new id

#### Scenario: user switches model via the /model command
- **WHEN** a client sends `{ "type": "prompt", "text": "/model deepseek-v4-pro" }` for a model in the available list
- **THEN** the server SHALL switch the session's active model and broadcast `model_changed` with the new id
- **AND** SHALL broadcast a `command_use` event for the `model` command

#### Scenario: /model with no argument reports current model and lists available models
- **WHEN** a client sends `{ "type": "prompt", "text": "/model" }`
- **THEN** the server SHALL broadcast a `command_use` event reporting the currently active model
- **AND** SHALL include a list of all available selectable models in the message
- **AND** SHALL NOT switch the model

#### Scenario: user selects an unknown model
- **WHEN** a client sends `set_model` or `/model nonexistent` for a model not in the available list
- **THEN** the server SHALL send an `error` message and the active model SHALL remain unchanged

### Requirement: Model switching is disabled while the agent is streaming
The server SHALL reject a `set_model` request while the agent is mid-response, so that a turn is not interrupted by a model switch.

#### Scenario: switch attempted during streaming
- **WHEN** a client sends `set_model` while the agent is streaming a response
- **THEN** the server SHALL send an `error` message indicating the model cannot be changed mid-turn
- **AND** SHALL NOT switch the model

### Requirement: Server selects a default model at startup
The server SHALL select a default model when creating the agent session by passing an explicit model to the SDK. If the `DEFAULT_MODEL` environment variable is set and matches an available model id, that model SHALL be used. Otherwise the first available model with configured auth SHALL be used. Because the LiteLLM extension registers its models under upstream provider names (e.g. `deepseek`, `volcengine`, `openrouter`) with the LiteLLM API key - rather than a single `litellm` provider - and shadows the Volces provider when enabled, the first model with configured auth is a LiteLLM-routed model when LiteLLM is configured, and a Volces model otherwise. The selected default model SHALL be communicated to clients as the active model on connect. The model selector SHALL list models with configured auth (deduplicated by id), so LiteLLM models are selectable.

#### Scenario: default is a LiteLLM model when LiteLLM is configured
- **WHEN** the server starts with LiteLLM configured and `DEFAULT_MODEL` unset
- **THEN** the agent session SHALL start on a LiteLLM-routed model (a model whose auth is the LiteLLM API key)
- **AND** the `current_model` sent on connect SHALL be that model's id
- **AND** the model selector SHALL show that model as selected

#### Scenario: DEFAULT_MODEL overrides the default
- **WHEN** the server starts with `DEFAULT_MODEL` set to a valid available model id
- **THEN** the agent session SHALL start on that model
- **AND** the `current_model` sent on connect SHALL be that model's id

#### Scenario: fallback to Volces when LiteLLM is not configured
- **WHEN** the server starts without LiteLLM configured
- **THEN** the agent session SHALL start on a Volces model
- **AND** the `current_model` sent on connect SHALL be that Volces model's id

#### Scenario: LiteLLM models are selectable
- **WHEN** a client sends `{ "type": "list_models" }` and LiteLLM is configured
- **THEN** the server SHALL include LiteLLM-routed models (those with configured auth) in the `models` response
- **AND** SHALL deduplicate them by id

### Requirement: Model selector is enabled as soon as models are known
The chat UI SHALL enable the model selector as soon as the available models are received, not only after the first agent turn completes. The selector SHALL be disabled while the agent is streaming and re-enabled when the turn ends (whether it succeeded or failed). The selector SHALL reflect the currently active model. The UI SHALL provide a command list popup showing available models as clickable items that trigger model selection. The click handler SHALL safely check for null DOM references before accessing properties.

#### Scenario: selector enabled on connect
- **WHEN** the page loads and the server sends the model list
- **THEN** the model selector SHALL be enabled
- **AND** SHALL reflect the currently active model

#### Scenario: selector re-enabled after a failed turn
- **WHEN** an agent turn ends with an error
- **THEN** the model selector SHALL be re-enabled

#### Scenario: model selection from command list
- **WHEN** the user opens the command list and clicks on a model name
- **THEN** the UI SHALL send a `set_model` message with the clicked model id
- **AND** SHALL reflect the new active model in the selector

### Requirement: Model selector input click does not throw errors
Clicking on the model selector input SHALL open the dropdown and SHALL NOT throw JavaScript errors. The click handler SHALL properly handle null or undefined references and ensure the dropdown state is managed correctly.

#### Scenario: clicking model selector opens dropdown
- **WHEN** user clicks on the model selector input
- **THEN** the model dropdown SHALL open
- **AND** no JavaScript error SHALL be thrown

#### Scenario: model selector shows current model
- **WHEN** the page loads and the current model is received
- **THEN** the model selector SHALL display the current model id
- **AND** the input SHALL not be empty

### Requirement: Sidebar model indicator is read-only
The sidebar's model display SHALL be a read-only chip showing the current default model id (sourced from the WS `current_model` event). Clicking the chip SHALL navigate the user to `/models` for the actual configuration. The legacy in-sidebar `<select>` for switching the model is replaced by the Set-as-default action on the Models page (see `llm-model-management`). The sidebar's Agent `<select>` is unchanged (it manages a different axis — `agent-local` vs `agent-remote`).

#### Scenario: clicking model chip navigates
- **WHEN** the user clicks the model chip in the sidebar
- **THEN** the router SHALL navigate to `/models`
- **AND** no model-switch WS message SHALL be sent

#### Scenario: model chip reflects current default
- **WHEN** the WS `current_model` event arrives
- **THEN** the sidebar model chip SHALL display the new model id
- **WHEN** the user changes the default on `/models`
- **THEN** a `model_changed` event SHALL be broadcast
- **AND** the chip SHALL update accordingly

