# chat-streaming Specification

## Purpose
TBD - created by archiving change e2e-tests-and-bugfixes. Update Purpose after archive.
## Requirements
### Requirement: Keyboard shortcut toggles all thinking blocks
The chat UI SHALL support a keyboard shortcut (`Ctrl+O` or `Cmd+O` on macOS) to toggle the expansion state of all thinking blocks simultaneously.

#### Scenario: Ctrl+O toggles thinking block visibility
- **WHEN** the user presses `Ctrl+O` (Windows/Linux) or `Cmd+O` (macOS)
- **THEN** all thinking blocks in the chat SHALL toggle between collapsed/expanded state
- **AND** tool blocks and skill blocks SHALL NOT be affected

### Requirement: Assistant text is streamed to clients as deltas
The server SHALL stream assistant text to connected WebSocket clients as incremental `text` events (`{ type: "text", delta }`) as the model produces output, so the UI updates live during a turn.

#### Scenario: streamed text appears live
- **WHEN** the model emits a text delta during a turn
- **THEN** the server SHALL broadcast a `text` event carrying that delta
- **AND** the UI SHALL append the delta to the current assistant bubble

### Requirement: Each assistant text segment is emitted exactly once per turn
The server SHALL deliver each assistant text segment to clients exactly once per turn. The server SHALL NOT re-broadcast the full assistant text on both `message_end` and `agent_end`; the final text SHALL be emitted at most once, and only as a fallback when no text was streamed during the turn (e.g. a non-streaming model response).

#### Scenario: streaming model response is not duplicated
- **WHEN** the model streams its response via text deltas during the turn
- **THEN** the server SHALL NOT emit the full text again on `message_end` or `agent_end`
- **AND** the rendered assistant text SHALL equal the model's response exactly once

#### Scenario: non-streaming response is emitted once via fallback
- **WHEN** the model produces a response with no streamed text deltas
- **THEN** the server SHALL emit the final assistant text exactly once on turn completion
- **AND** the rendered assistant text SHALL equal the model's response exactly once

### Requirement: A failed or aborted turn resets streaming state and emits done
The server SHALL ensure that every agent turn ends with the streaming state reset and a `done` event broadcast to clients, regardless of whether the turn succeeded or failed. If `session.prompt()` rejects (e.g. a model API error) before the SDK emits `agent_end`, the server SHALL reset the streaming flag and broadcast `done` after broadcasting any `error`, so that the UI re-enables input and the model selector, model-switching and new-session creation are not permanently blocked, and the session list refreshes. The server SHALL NOT broadcast `done` more than once per turn.

#### Scenario: failed turn re-enables the UI
- **WHEN** an agent turn fails with an error before completion
- **THEN** the server SHALL broadcast an `error` followed by `done`
- **AND** the streaming flag SHALL be reset to false
- **AND** the model selector and input SHALL be re-enabled

#### Scenario: done is not duplicated
- **WHEN** the SDK emits `agent_end` after the server already broadcast `done` for a failed turn
- **THEN** the server SHALL NOT broadcast `done` a second time

### Requirement: Chat prompt submission does not throw errors
Submitting a chat prompt SHALL send the message over WebSocket and SHALL NOT throw JavaScript errors. The submit handler SHALL properly handle null or undefined references, check WebSocket connection state, and validate input before submission.

#### Scenario: submitting a valid prompt
- **WHEN** user types a valid message and clicks Send
- **THEN** the message SHALL be sent over the WebSocket
- **AND** no JavaScript error SHALL be thrown
- **AND** the input SHALL be disabled during streaming

#### Scenario: submitting with no WebSocket connection
- **WHEN** user submits a prompt when WebSocket is not connected
- **THEN** the UI SHALL show an error message
- **AND** SHALL NOT throw a JavaScript error
- **AND** the input SHALL remain enabled

### Requirement: Empty prompt submission is prevented
The UI SHALL prevent submission of empty or whitespace-only prompts. The send button SHALL be disabled when the input is empty.

#### Scenario: send button disabled for empty input
- **WHEN** the input is empty or contains only whitespace
- **THEN** the send button SHALL be disabled

#### Scenario: whitespace-only input not submitted
- **WHEN** user types only whitespace and tries to submit
- **THEN** no message SHALL be sent
- **AND** no error SHALL be thrown

