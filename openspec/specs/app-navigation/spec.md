# app-navigation Specification

## Purpose
TBD - synced from change left-nav-docs-history. Update Purpose after archive.
## Requirements
### Requirement: Left sidebar navigation shell with a canonical tab set
The web UI SHALL provide a persistent left sidebar navigation containing, in order, the view tabs: Chat, Documents, and OpenConnector. The standalone "Chat History" tab SHALL be removed; chat sessions are instead surfaced as a session-list region within the sidebar. Each view tab SHALL correspond to exactly one main-content panel. On initial load the UI SHALL activate the Chat tab. The sidebar session-list region SHALL remain visible regardless of which view tab is active.

#### Scenario: initial load shows the Chat tab
- **WHEN** the page loads
- **THEN** the sidebar SHALL render the view tabs Chat, Documents, and OpenConnector
- **AND** the Chat tab SHALL be the active tab
- **AND** the Chat panel SHALL be visible and all other panels SHALL be hidden

#### Scenario: canonical tab ordering and labels
- **WHEN** the sidebar renders
- **THEN** the view tabs SHALL appear in the order Chat, Documents, OpenConnector
- **AND** each tab SHALL display a stable label and icon
- **AND** no standalone "Chat History" tab SHALL be present

### Requirement: Selecting a tab shows its panel and hides the others
The UI SHALL switch the main content area to the selected tab's panel when the user clicks a sidebar tab. The previously active panel SHALL be hidden. The active tab SHALL be visually distinguished from inactive tabs.

#### Scenario: user switches tabs
- **WHEN** the user clicks the "Documents" tab while the Chat tab is active
- **THEN** the Documents panel SHALL become visible
- **AND** the Chat panel SHALL be hidden
- **AND** the "Documents" tab SHALL be marked active and the "Chat" tab SHALL be marked inactive

#### Scenario: only one panel visible at a time
- **WHEN** any tab is active
- **THEN** exactly one main-content panel SHALL be visible
- **AND** no two panels SHALL be visible simultaneously

### Requirement: Chat session list in the sidebar
The sidebar SHALL render a chat-session list region containing a "+ New chat" action and the list of persisted chat sessions, each row showing its title and last-updated time. The currently active session SHALL be visually distinguished. Clicking a session row SHALL switch the active chat to that session (governed by the `chat-history` capability). The session list SHALL be refreshed when sessions are created, switched, or updated.

#### Scenario: session list renders in the sidebar
- **WHEN** the page loads with one or more persisted sessions
- **THEN** the sidebar SHALL list each session's title and last-updated time
- **AND** the active session SHALL be highlighted

#### Scenario: new chat from the sidebar
- **WHEN** the user clicks "+ New chat"
- **THEN** a new chat session SHALL be created and become the active session
- **AND** the session list SHALL refresh with the new session highlighted

#### Scenario: selecting a session switches chats
- **WHEN** the user clicks a session row
- **THEN** that session SHALL become the active chat
- **AND** its messages SHALL be rendered in the chat view

### Requirement: LiteLLM management entry in the sidebar
The sidebar SHALL render a LiteLLM nav entry that, when activated, switches the main content area to an in-app LiteLLM view embedding the proxy's management UI through the server's `/litellm-web` reverse proxy (governed by the `litellm-web` capability), mirroring how OpenConnector embeds its runtime UI. The entry SHALL be shown only when LiteLLM is configured; when LiteLLM is not configured the entry SHALL be absent. The entry SHALL NOT open the management UI in a new browser tab as its primary action.

#### Scenario: entry shown when LiteLLM is configured
- **WHEN** the page loads and LiteLLM is configured
- **THEN** the sidebar SHALL render a LiteLLM nav entry

#### Scenario: entry hidden when LiteLLM is not configured
- **WHEN** the page loads and LiteLLM is not configured
- **THEN** the sidebar SHALL NOT render a LiteLLM nav entry

#### Scenario: activating the entry opens the in-app view
- **WHEN** the user clicks the LiteLLM nav entry
- **THEN** the main content area SHALL switch to the LiteLLM view
- **AND** the view SHALL embed the management UI via the `/litellm-web` proxy

### Requirement: Drag-drop overlay is subtle and label-free
The drag-drop overlay SHALL NOT display a prominent text label such as "Drop files to add to documents". Drop feedback SHALL be conveyed by a transient toast and the chat-view document banner; the overlay, if shown during a drag, SHALL be a subtle visual affordance without prominent text.

#### Scenario: dragging a file shows no prominent label
- **WHEN** the user drags a file over the page
- **THEN** the overlay SHALL NOT display a prominent text label
- **AND** drop feedback SHALL be conveyed by the toast and/or the chat-view document banner

