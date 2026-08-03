# e2e-testing Specification

## Purpose
TBD - created by archiving change e2e-tests-and-bugfixes. Update Purpose after archive.
## Requirements
### Requirement: E2E suite launches an isolated server and drives the browser UI
The project SHALL provide a Playwright-based end-to-end test suite that launches the server fresh via a `webServer` config on an overridable test port (default 3100) bound to `127.0.0.1`, using throwaway store directories passed through `CHAT_HISTORY_STORE_DIR` and `DOCUMENTS_STORE_DIR` env vars so the user's real `chat-history-store/` and `documents-store/` are never touched. The suite SHALL drive the real browser UI (Chromium). The store directories SHALL default to their current hard-coded paths when the env vars are unset, so production behavior is unchanged.

#### Scenario: server boots fresh for the test run
- **WHEN** the test suite starts
- **THEN** Playwright SHALL launch `node server.js` with the test port and temp store-dir env vars
- **AND** SHALL wait for the server-ready stdout line before running tests
- **AND** SHALL tear the server down after the suite finishes

#### Scenario: test state is isolated from real data
- **WHEN** a test writes a document or chat session
- **THEN** the write SHALL land in the throwaway temp store directory
- **AND** SHALL NOT create or modify files under the project's real `chat-history-store/` or `documents-store/`

#### Scenario: store dirs default to current paths without env
- **WHEN** the server starts without `CHAT_HISTORY_STORE_DIR` or `DOCUMENTS_STORE_DIR` set
- **THEN** the modules SHALL use `chat-history-store/` and `documents-store/` exactly as before

### Requirement: E2E suite covers document management flows
The suite SHALL cover adding a text document and a markdown file upload, asserting each transitions to `ready`; listing documents; viewing a document's extracted content; and deleting a document (asserting it is removed). These flows SHALL NOT require an LLM call.

#### Scenario: text document uploads and becomes ready
- **WHEN** the test submits text content through the Documents tab
- **THEN** a document row SHALL appear and its status badge SHALL become `ready`

#### Scenario: markdown file uploads and becomes ready
- **WHEN** the test uploads a `.md` file through the file input
- **THEN** a document row SHALL appear and its status badge SHALL become `ready`

#### Scenario: document content is viewable and deletable
- **WHEN** the test clicks View on a ready document
- **THEN** the extracted content SHALL be displayed
- **WHEN** the test clicks Remove on a document
- **THEN** the row SHALL disappear from the list

### Requirement: E2E suite covers chat history flows
The suite SHALL cover starting a new chat session from the Chat History tab, asserting it appears in the session list, and viewing a session's messages read-only.

#### Scenario: new session appears in history
- **WHEN** the test clicks the New chat button in the Chat History tab
- **THEN** a new session SHALL appear in the session list
- **AND** SHALL be marked as the current session

#### Scenario: session messages are viewable
- **WHEN** the test opens a session in the Chat History tab
- **THEN** the session's messages SHALL render in order, read-only

### Requirement: E2E suite verifies a real chat turn saves history without duplicate text
The suite SHALL include a chat-turn test (isolated as a separate `@smoke` Playwright project) that sends one prompt, waits for the turn to complete, and asserts both that the rendered assistant text is not duplicated and that the resulting chat-history session contains the user message and the assistant reply.

#### Scenario: assistant text renders exactly once
- **WHEN** the test sends a prompt and the agent turn completes
- **THEN** the assistant bubble SHALL contain the response text exactly once (not repeated)

#### Scenario: chat turn is persisted to history
- **WHEN** the agent turn completes
- **THEN** the current chat-history session SHALL contain the user message and a non-empty assistant message

### Requirement: A single command runs the E2E suite
The project SHALL provide an `npm run test:e2e` script that runs the Playwright suite, and an `npm run test:e2e:smoke` script that includes the `@smoke` chat-turn project. Browser binaries SHALL be installable via `npx playwright install chromium`.

#### Scenario: run the fast suite
- **WHEN** a developer runs `npm run test:e2e`
- **THEN** the deterministic, no-LLM tests SHALL run against a freshly launched server

#### Scenario: run the full suite including the chat turn
- **WHEN** a developer runs `npm run test:e2e:smoke`
- **THEN** the chat-turn `@smoke` tests SHALL also run

### Requirement: E2E suite covers model switching flow
The suite SHALL cover switching models via the UI selector and via the `/model` chat command, asserting the `model_changed` event is broadcast, the selector updates, and an error is shown for invalid model ids.

#### Scenario: model selector loads models and reflects active model
- **WHEN** the page loads and the server sends the model list
- **THEN** the model selector SHALL be populated with available models
- **AND** SHALL reflect the currently active model sent in `current_model`

#### Scenario: switch model via UI selector
- **WHEN** the test selects a different model from the dropdown
- **THEN** the server SHALL broadcast `model_changed` with the new id
- **AND** the selector SHALL be updated to show the new active model

#### Scenario: switch model via /model command
- **WHEN** the test sends `/model <id>` through the chat input
- **THEN** the server SHALL broadcast `model_changed` with the new id
- **AND** a command use event SHALL be shown confirming the switch

#### Scenario: invalid model id shows error
- **WHEN** the test sends `/model nonexistent-model-id`
- **THEN** an error event SHALL be shown
- **AND** the active model SHALL remain unchanged

### Requirement: E2E suite covers document chat (RAG) flow
The suite SHALL cover the "Ask the collection" flow: adding a text document, waiting for it to be ready, querying the document collection, and verifying an answer is returned with source document names. This test SHALL be marked `@smoke` since it requires an LLM call.

#### Scenario: query document collection returns an answer
- **WHEN** the test adds a text document with known content, waits for it to be ready, and submits a query through the "Ask the collection" input
- **THEN** an answer SHALL be displayed in the answer area
- **AND** the answer SHALL reference the source document name

#### Scenario: empty collection query returns empty answer
- **WHEN** the test queries the collection with no ready documents
- **THEN** an empty or placeholder answer SHALL be shown
- **AND** no source document names SHALL be listed

### Requirement: E2E suite covers thinking block keyboard shortcut
The E2E suite SHALL test that thinking blocks are displayed when the agent produces reasoning output, and that the `Ctrl+O` keyboard shortcut toggles their visibility.

#### Scenario: Thinking block appears when agent produces reasoning
- **WHEN** the agent sends a `thinking` event during a turn
- **THEN** a thinking block SHALL appear in the chat
- **AND** the block SHALL be expanded by default

#### Scenario: Ctrl+O toggles thinking block state
- **GIVEN** a thinking block is present and expanded in the chat
- **WHEN** the test presses `Ctrl+O`
- **THEN** the thinking block SHALL collapse
- **WHEN** the test presses `Ctrl+O` again
- **THEN** the thinking block SHALL expand

### Requirement: E2E suite covers app shell navigation
The suite SHALL verify the sidebar contains all current navigation tabs and that switching between tabs works correctly.

#### Scenario: sidebar shows current navigation tabs
- **WHEN** the app loads
- **THEN** the sidebar SHALL show the navigation tabs including chat, dashboard, documents, openconnector, and litellm

### Requirement: E2E suite covers dashboard tab
The suite SHALL verify the dashboard tab loads and displays its content correctly.

#### Scenario: dashboard tab loads and displays content
- **WHEN** the user clicks the Dashboard tab
- **THEN** the dashboard view SHALL be displayed
- **AND** SHALL contain the expected dashboard content

### Requirement: E2E suite covers LiteLLM web UI tab
The suite SHALL verify the LiteLLM tab loads and displays its content correctly.

#### Scenario: LiteLLM tab loads and displays content
- **WHEN** the user clicks the LiteLLM tab
- **THEN** the LiteLLM view SHALL be displayed
- **AND** SHALL contain the expected LiteLLM content

### Requirement: E2E suite verifies SQLite persistence
The suite SHALL verify document metadata and preferences are persisted to SQLite and survive server restart.

#### Scenario: document list is served from SQLite database
- **WHEN** a document is created
- **THEN** it SHALL appear in the document list
- **AND** the document SHALL persist in the SQLite database

#### Scenario: preferences round-trip through the API
- **WHEN** a preference is saved
- **THEN** the same value SHALL be returned when queried

### Requirement: E2E suite covers collections functionality
The suite SHALL verify collections can be created, documents added to collections, and collections can be listed and deleted.

#### Scenario: collections CRUD operations
- **WHEN** a collection is created
- **THEN** it SHALL appear in the collections list
- **WHEN** a document is added to a collection
- **THEN** the document SHALL be listed under that collection
- **WHEN** a document is removed from a collection
- **THEN** the document SHALL NOT appear under that collection
- **WHEN** a collection is deleted
- **THEN** it SHALL NOT appear in the collections list

