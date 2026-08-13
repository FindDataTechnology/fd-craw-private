# web-chat-ui Specification

## Purpose
TBD - created by archiving change build-pi-web-chat. Update Purpose after archive.
## Requirements
### Requirement: Chat UI displays messages in a conversation view
The chat UI SHALL display user messages and assistant responses in a scrollable conversation area with distinct styling for each role.

#### Scenario: User sends a message
- **WHEN** the user types a message and submits it
- **THEN** the message SHALL appear in the conversation area with user styling (right-aligned, distinct background)

#### Scenario: Assistant responds with text
- **WHEN** the server sends text deltas for an assistant response
- **THEN** the text SHALL appear incrementally in the conversation area with assistant styling (left-aligned)

### Requirement: Chat UI shows tool execution status
The chat UI SHALL display tool execution start and end events inline with the conversation.

#### Scenario: Agent runs a tool
- **WHEN** the server sends a `tool_start` event
- **THEN** the UI SHALL display a tool indicator showing the tool name with a loading state
- **AND** when `tool_end` arrives, SHALL update the indicator to show success or error

### Requirement: Chat UI supports streaming text input
The chat UI SHALL provide a text input field with a send button and Enter key support for submitting prompts.

#### Scenario: User submits a prompt
- **WHEN** the user types text and presses Enter or clicks the Send button
- **THEN** the prompt SHALL be sent to the server via WebSocket and the input SHALL be cleared

#### Scenario: Empty input is rejected
- **WHEN** the user tries to submit an empty or whitespace-only message
- **THEN** the message SHALL NOT be sent

### Requirement: Chat UI handles WebSocket connection lifecycle
The chat UI SHALL connect to the WebSocket server on page load, display connection status, and reconnect on disconnect using exponential backoff. The reconnect delay SHALL be `min(30000, 1000 * 2^attempt)` milliseconds multiplied by ±25% jitter. The UI SHALL stop scheduling reconnect attempts after a maximum of 20 attempts. The attempt counter SHALL reset to 0 on a successful connection (`onopen`). The UI SHALL listen for the browser `online` event and, when the network is restored, clear any pending reconnect timer, reset the attempt counter, and reconnect immediately — bypassing the backoff. The unmount guard (`cancelled`) SHALL be preserved so a cleaned-up component does not reconnect or schedule further timers.

#### Scenario: connection lost triggers backoff
- **WHEN** the WebSocket connection drops and the component is still mounted
- **THEN** the UI SHALL show a "Disconnected" status
- **AND** SHALL schedule a reconnect after a jittered exponential delay (`min(30000, 1000 * 2^attempt)` × ±25%)

#### Scenario: backoff stops after the cap
- **WHEN** the connection has failed the maximum number of reconnect attempts (20)
- **THEN** the UI SHALL stop scheduling further reconnect attempts

#### Scenario: online event triggers immediate reconnect
- **WHEN** the browser fires the `online` event while disconnected and a reconnect timer may be pending
- **THEN** the UI SHALL clear the pending timer, reset the attempt counter to 0, and reconnect immediately

#### Scenario: successful connection resets the counter
- **WHEN** a reconnect attempt succeeds (`onopen`)
- **THEN** the attempt counter SHALL reset to 0

#### Scenario: unmount stops reconnection
- **WHEN** the component unmounts
- **THEN** the unmount guard SHALL prevent further reconnect attempts and clear any pending timer

### Requirement: Chat UI shows thinking blocks
The chat UI SHALL display thinking content from the agent in a collapsible block.

#### Scenario: Agent produces thinking output
- **WHEN** the server sends a `thinking` delta event
- **THEN** the UI SHALL display the thinking content in a collapsible, visually distinct block

