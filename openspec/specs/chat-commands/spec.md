# chat-commands Specification

## Purpose
TBD - created by archiving change chat-commands-and-session-fixes. Update Purpose after archive.
## Requirements
### Requirement: Server parses and dispatches general chat slash-commands
The server SHALL accept chat prompts whose first token is a slash-command and dispatch them according to a command table that includes `/model`, `/new`, `/clear`, `/help`, and `/skill:<name>`. Server-handled commands (`/model`, `/new`, `/skill:`) SHALL be dispatched to their behavior; client-handled commands (`/clear`, `/help`) SHALL be intercepted by the UI before the prompt is sent and SHALL NOT be forwarded to the agent. The raw text of a recognised server-handled command SHALL NOT be echoed as a normal user message. The UI SHALL clear the chat input field after executing any slash command.

#### Scenario: server-handled command is dispatched
- **WHEN** a client sends `{ "type": "prompt", "text": "/model deepseek-v4-pro" }`
- **THEN** the server SHALL dispatch the `/model` command
- **AND** SHALL NOT forward the raw `/model …` text to the agent as a user message

#### Scenario: client-handled command is not forwarded
- **WHEN** the user types `/clear` and sends
- **THEN** the UI SHALL handle the command locally
- **AND** SHALL NOT send a `prompt` message to the server

#### Scenario: unknown command falls through to the agent
- **WHEN** a client sends a prompt beginning with `/` that is not a recognised command
- **THEN** the server SHALL forward the text to the agent as a normal prompt

#### Scenario: input is cleared after slash command
- **WHEN** the user executes any slash command (local or server-handled)
- **THEN** the chat input field SHALL be cleared

### Requirement: Command invocations render as collapsible blocks
The chat UI SHALL render each server-handled command invocation as a collapsible `command_use` block showing the command name in its header and the arguments (and any informational message) in its body, in place of echoing the raw command text as a user message.

#### Scenario: command invocation displayed
- **WHEN** the server sends a `command_use` event for command `model` with args `deepseek-v4-pro`
- **THEN** the UI SHALL render a collapsible block with the command name `model` in its header
- **AND** the body SHALL show the arguments
- **AND** the raw `/model …` text SHALL NOT be rendered as a normal user message

### Requirement: Chat input provides unified slash-command autocomplete
The chat UI SHALL present a slash-command autocomplete popup listing all available commands - the meta-commands (`/model`, `/new`, `/clear`, `/help`) and the `/skill:<name>` commands sourced from the `skills` list - filtered by the text typed after `/`. The user SHALL be able to navigate the list with arrow keys and insert the selected command with Enter; Escape SHALL close the popup without inserting. Inserting a command SHALL NOT auto-send; the user may append arguments and send normally. The UI SHALL also provide a visible button to open a command list popup that shows all available commands and models.

#### Scenario: typing slash lists all commands
- **WHEN** the user types `/` at the start of the chat input
- **THEN** the UI SHALL show a popup listing the meta-commands and all available `/skill:` commands

#### Scenario: filtering by typed text
- **WHEN** the user types `/mod` in the chat input
- **THEN** the popup SHALL list only the commands whose names match `mod`

#### Scenario: enter inserts the command without sending
- **WHEN** the user selects a command in the popup and presses Enter
- **THEN** the command text SHALL be inserted into the chat input with a trailing space
- **AND** the popup SHALL close
- **AND** the message SHALL NOT be sent

#### Scenario: escape closes the popup without inserting
- **WHEN** the popup is open and the user presses Escape
- **THEN** the popup SHALL close
- **AND** no command SHALL be inserted into the input

#### Scenario: command list button opens popup
- **WHEN** the user clicks the command list button
- **THEN** the UI SHALL show a popup listing all available slash commands and models
- **AND** clicking a command SHALL insert it into the input
- **AND** clicking a model SHALL select it as the active model

