# miniprogram-client Specification

## Purpose

Defines the WeChat mini-program thin client: how it carries the core chat
experience (streaming chat, session history, model/agent selection, attachment
upload) over the existing WebSocket and REST contracts, and how it behaves
under mini-program lifecycle constraints (backgrounding kills sockets; no DOM
means degraded rendering).

## Requirements

### Requirement: The mini-program client runs a chat turn over the existing WS contract

The mini-program client SHALL connect to the platform over WSS and use the
same JSON message protocol as the web client (`prompt` in; `user`,
`agent_start`, `text`, `thinking`, `tool_start`/`update`/`end`, `skill_use`,
`done`, `error` out). Streaming assistant text SHALL appear incrementally as
chunks arrive. A failed or errored turn SHALL surface the error to the user
and leave the composer usable.

#### Scenario: a full turn streams end to end

- **WHEN** the user sends a prompt and the assistant streams text chunks followed by `done`
- **THEN** the user turn and the incrementally-rendered assistant turn are visible in order, and the composer re-enables on `done`

#### Scenario: server reports an error mid-turn

- **WHEN** an `error` message arrives during a turn
- **THEN** the client shows the error in the conversation, stops the streaming state, and does not leave the UI stuck

### Requirement: Assistant messages render with degraded-but-defined markdown

While a turn is streaming, assistant text SHALL render as plain text (no
markdown parsing of partial content). After the turn completes, the final
assistant message SHALL render as markdown (headings, lists, links, tables,
inline code, fenced code blocks). Fenced code blocks SHALL render as monospace
blocks without syntax highlighting. Markdown links SHALL be tappable and open
through the mini program's navigation mechanism. Malformed markdown SHALL
never crash the message list.

#### Scenario: streaming shows plain text, completion renders markdown

- **WHEN** an assistant turn streams `# Hea` then `ding\n\n- item` and completes
- **THEN** during streaming the raw text is shown as-is, and after `done` the message renders a heading and a bullet list

#### Scenario: an echarts fence renders as a chart or degrades

- **WHEN** a completed assistant message contains a fenced `echarts` block
- **THEN** the client renders it as an interactive canvas chart, or when chart rendering fails, shows the block as an ordinary code block without surfacing an error

### Requirement: Session history is browsable

The client SHALL list past chat sessions with title and recency, and opening
one SHALL display its persisted messages read-only. Session metadata SHALL
come from the existing chat-history REST endpoints.

#### Scenario: opening a past session

- **WHEN** the user opens a listed session
- **THEN** its full message history renders read-only, and returning to the list preserves scroll position of the list

### Requirement: Model and agent selection work and respect the streaming guard

The client SHALL offer model selection and chat-agent selection sourced from
the same `list_models` / `list_agents` protocol messages as the web client.
Selection SHALL be surfaced through a single combined entry in the chat
header (agent · model) that opens a bottom selection panel; the panel SHALL
list agents and models, apply a choice immediately on tap, and be dismissible
without change via the mask or a close affordance. In an empty session the
panel SHALL also offer preset selection (broken presets excluded); once the
session has turns the preset section SHALL NOT appear. A switch SHALL be
rejected while a turn is streaming, matching the web contract, and the
previously selected model/agent SHALL remain reported as current after a
rejected switch. The combined entry SHALL reflect the currently selected
agent and model.

#### Scenario: switching models while idle vs streaming

- **WHEN** the user opens the selection panel, switches models while no turn is streaming, and dismisses the panel
- **THEN** the selection applies, is reflected in the combined header entry, and is reported as current
- **WHEN** the user attempts a switch while a turn is streaming
- **THEN** the switch is rejected and the previous selection remains current

#### Scenario: dismissing the panel changes nothing

- **WHEN** the user opens the selection panel and taps the mask (or close) without choosing
- **THEN** the panel closes and the previously selected agent/model/preset remain current

#### Scenario: presets appear only in an empty session

- **WHEN** the session has zero turns and the user opens the selection panel
- **THEN** preset choices are listed alongside agents and models
- **WHEN** the session already has turns
- **THEN** the panel offers agents and models only

### Requirement: The socket survives mini-program lifecycle events

When the mini program is backgrounded, the platform MAY drop the socket. On
return to foreground, the client SHALL detect a dead socket and re-establish
it promptly, replaying the protocol's initial state queries after reconnect.
Reconnect attempts SHALL use capped exponential backoff, and the connection
state SHALL be visible to the user while disconnected.

#### Scenario: background then foreground

- **WHEN** the user backgrounds the mini program mid-conversation and returns after the socket was dropped
- **THEN** the socket is re-established without user action, state queries are replayed, and the conversation view is intact

#### Scenario: server unreachable

- **WHEN** the backend is unreachable for an extended period
- **THEN** reconnect attempts back off to at most one attempt per 30 seconds and the UI shows a disconnected state with a manual retry affordance

### Requirement: The composer supports attachments via document ingestion

The user SHALL be able to attach a file in the composer. The file SHALL be
uploaded through the platform's existing document-ingestion endpoint (the
same multipart path the web composer uses), and an ingested attachment SHALL
be referenced in the prompt as `@doc:<id>` so the assistant can read its
content. A file whose content cannot be extracted SHALL still be attachable
when the response carries a stored original (matching the web composer's
chip behavior). An upload failure SHALL surface an error without blocking
the text of the prompt.

#### Scenario: attach and send

- **WHEN** the user attaches a file and sends a prompt
- **THEN** the file is uploaded through the document-ingestion endpoint first, the prompt carries its `@doc:<id>` reference, and both the text and the attachment appear in the rendered user turn

#### Scenario: upload failure does not eat the prompt

- **WHEN** an attachment upload fails
- **THEN** an error is surfaced, the attachment is not referenced in the prompt, and the typed text remains sendable

### Requirement: The chat page header follows a three-zone layout

The chat page header SHALL present three affordances: a history entry that
opens the sessions page, the combined agent·model entry (per the selection
requirement), and a new-session action. The header SHALL NOT contain the
server-address setting; that setting SHALL be reachable from the sessions
(history) page. The connection banner (connecting / disconnected / retry)
SHALL keep appearing above the header independently of this layout.

#### Scenario: header renders the three zones

- **WHEN** the chat page is mounted
- **THEN** the header shows a history entry, one combined agent·model entry, and a new-session action, and no server-setting control

#### Scenario: server address is set from the history page

- **WHEN** the user opens the sessions page and uses the server-settings entry there
- **THEN** the address can be edited and saved, and saving triggers a reconnect — the same behavior the chat-header entry had

### Requirement: The composer renders as a card with inline controls

The composer SHALL render as a single rounded card containing the text input,
any pending attachment chips, and a controls row — attach action on the left,
send/stop control on the right — inside the card. The send control SHALL do
nothing when the draft is empty and no attachment is attached, and while a
configuration switch is pending. While a turn streams, the send control SHALL
be replaced by a stop control whose activation locally finalizes the turn.
The composer's bottom padding SHALL account for the device safe-area inset so
the controls are never overlapped by the home indicator, and keyboard lift
SHALL keep the card visible above the keyboard.

#### Scenario: composer card holds input, chips, and controls together

- **WHEN** the user attaches a document and types a draft
- **THEN** the attachment chip and the text input are visible inside the same card as the attach and send controls

#### Scenario: send becomes stop while streaming

- **WHEN** a turn is streaming
- **THEN** the right-hand control is a stop control, and tapping it finalizes the turn locally and restores the send control

### Requirement: The empty-session welcome offers suggested prompts that prefill the draft

When the session has no turns, the chat page SHALL present a centered welcome
containing a greeting and four suggested-prompt cards. Tapping a card SHALL
prefill the draft with the prompt text; it SHALL NOT send. The welcome SHALL
also offer a link to the sessions (history) page.

#### Scenario: tapping a suggested prompt prefills without sending

- **WHEN** the welcome is showing and the user taps a suggested-prompt card
- **THEN** the composer draft contains that prompt text and no prompt message is sent

### Requirement: Assistant turns expose copy and regenerate actions

Every completed (non-streaming) assistant turn SHALL expose a copy action that
places the turn's text content — the concatenated plain text of its text
blocks, in order — on the clipboard and confirms with a toast. The most
recent assistant turn SHALL additionally expose a regenerate action when no
turn is streaming; activating it SHALL re-send the last user prompt as a new
appended turn, leaving prior history unmutated. Regenerate SHALL NOT appear
on a non-latest assistant turn or when no user turn precedes it.

#### Scenario: copy places the turn text on the clipboard

- **WHEN** the user taps the copy action of a completed assistant turn
- **THEN** the clipboard holds the turn's text-block content and a confirmation toast appears

#### Scenario: regenerate appends an honest new turn

- **WHEN** the user taps regenerate on the latest assistant turn while nothing is streaming
- **THEN** the last user prompt is re-sent as a new prompt and a new user+assistant turn pair is appended — the previous turns are unchanged
