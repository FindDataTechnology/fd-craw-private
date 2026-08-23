# chat-history Specification

## Purpose
TBD - synced from change left-nav-docs-history. Update Purpose after archive.
## Requirements
### Requirement: Chat sessions are mirrored to the project database as the conversation progresses
The server SHALL mirror each chat session's user prompts and assistant responses into the project SQLite database (managed by `project-database`) as the conversation progresses - the user message on `prompt` and the assistant's final message on turn completion (`done`). This SHALL apply to **both local dsh agent turns and remote (catalog `agent-remote`) agent turns**: remote turns (streamed via `streamRemoteChat`) SHALL be persisted on stream completion via the same `recordMessage()` path as local turns, so a browser close/reopen does not leave a dangling user message with no reply. The project database SHALL be the store of record for the session list and read-only view APIs. The dsh runtime persists sessions by id to its own disk store; the server SHALL keep the SQLite mirror in sync as turns progress. The server SHALL track a current session in memory. Each session SHALL expose an id, a title (derived from the first user message), creation timestamp, and update timestamp. SQLite writes SHALL be atomic and crash-safe via transactions.

#### Scenario: user prompt is persisted
- **WHEN** the server receives a `prompt` WebSocket message for the current session
- **THEN** the server SHALL persist the user message to the project database for the current session
- **AND** the current session's update timestamp SHALL advance

#### Scenario: assistant turn is persisted on completion
- **WHEN** the agent turn completes (`done`)
- **THEN** the server SHALL persist the assistant's final message to the project database for the current session
- **AND** the session's update timestamp SHALL advance

#### Scenario: remote agent turn is persisted on completion
- **WHEN** a remote (catalog `agent-remote`) turn completes
- **THEN** the server SHALL persist the assistant's final aggregated text to the project database for the current session via `recordMessage()`
- **AND** the session's update timestamp SHALL advance
- **AND** a browser close/reopen SHALL show both the user message and the remote assistant reply

#### Scenario: session title derived from first message
- **WHEN** a session receives its first user message
- **THEN** the server SHALL set the session's display name to a truncated form of that message

### Requirement: Users can list past chat sessions
The server SHALL expose an endpoint and a WebSocket message that return a list of persisted chat sessions with their id, title, creation timestamp, update timestamp, and message count, ordered most-recently-updated first, sourced from the project SQLite database. The list SHALL NOT include full message bodies.

#### Scenario: list sessions
- **WHEN** a client requests the session list
- **THEN** the server SHALL return session metadata ordered by update timestamp descending
- **AND** SHALL NOT include message content in the list response

### Requirement: Users can start a new chat session
The server SHALL expose an endpoint, a `new_session` WebSocket message, AND a `/new` chat command to start a new chat session, each of which creates a new SDK session and makes it the current session. Subsequent prompts SHALL be appended to the new session. The previous session SHALL remain persisted and listed. Starting a new session SHALL be rejected while the agent is streaming. The server SHALL broadcast a refreshed session list after a new session is created.

#### Scenario: start a new session via the button
- **WHEN** a client starts a new chat session (button or `new_session` message) and the agent is not streaming
- **THEN** the server SHALL create a new SDK session and make it the current session
- **AND** the previous session SHALL remain persisted and listed

#### Scenario: start a new session via the /new command
- **WHEN** a client sends `{ "type": "prompt", "text": "/new" }` and the agent is not streaming
- **THEN** the server SHALL create a new SDK session and make it the current session
- **AND** SHALL broadcast a `command_use` event for the `new` command
- **AND** SHALL broadcast a refreshed session list

#### Scenario: new session rejected while streaming
- **WHEN** a client starts a new chat session while the agent is streaming
- **THEN** the server SHALL reject the request with an error
- **AND** the current session SHALL remain unchanged

### Requirement: Users can resume a past session into the live agent
The server SHALL allow a past session to be resumed into the live agent. Resuming a session SHALL load that session's message history into the agent's context so subsequent turns continue the conversation, and SHALL set it as the current session so new turns append to it. The server SHALL broadcast the loaded session's messages to clients so the chat view renders the resumed conversation.

#### Scenario: resume a session
- **WHEN** a client selects a past session to resume
- **THEN** the server SHALL load that session's message history into the agent's context
- **AND** SHALL set it as the current session
- **AND** SHALL broadcast the session's messages to clients for rendering

#### Scenario: resumed session continues the conversation
- **WHEN** the user sends a prompt after resuming a session
- **THEN** the agent SHALL respond with awareness of the resumed session's history
- **AND** the turn SHALL be appended to that session

### Requirement: Users can switch the active chat session
The server SHALL accept a `switch_session` WebSocket message and switch the live agent to the requested session by id using the SDK session manager's resume mechanism, broadcasting a `session_loaded` event carrying the session id, title, and message list. Switching SHALL be rejected while the agent is streaming. The active session SHALL be reflected as highlighted in the sidebar.

#### Scenario: switch to a session
- **WHEN** a client sends `switch_session` for a valid session id and the agent is not streaming
- **THEN** the server SHALL switch the live agent to that session
- **AND** SHALL broadcast `session_loaded` with that session's id, title, and messages

#### Scenario: switch rejected while streaming
- **WHEN** a client sends `switch_session` while the agent is streaming
- **THEN** the server SHALL send an error and the active session SHALL remain unchanged

#### Scenario: switch to an unknown session
- **WHEN** a client sends `switch_session` for an id that does not exist
- **THEN** the server SHALL send an error and the active session SHALL remain unchanged

### Requirement: Session list refreshes after every turn end
The server SHALL broadcast a refreshed session list whenever an agent turn ends, whether the turn succeeded or failed, so that a newly created session appears in the sidebar even when its first turn errors. The list SHALL also be broadcast when a client connects and when a session is created or switched.

#### Scenario: session list refreshes after a failed turn
- **WHEN** an agent turn ends with an error
- **THEN** the server SHALL broadcast a refreshed session list
- **AND** any session created during that turn SHALL appear in the list

