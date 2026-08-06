# app-navigation Specification

## Purpose
TBD - synced from change left-nav-docs-history. Update Purpose after archive.
## Requirements
### Requirement: Left sidebar navigation shell with a canonical tab set
The web UI SHALL provide a persistent left sidebar navigation containing, in order, the view tabs: Chat, Dashboard, Documents, OpenConnector, and LiteLLM (the LiteLLM tab SHALL be present only when LiteLLM is configured, per the "LiteLLM management entry in the sidebar" requirement). The standalone "Chat History" tab and its `/history` route SHALL be removed; chat sessions are instead surfaced as a session-list region within the sidebar (per the "Chat session list in the sidebar" requirement). Each view tab SHALL correspond to exactly one main-content panel. On initial load the UI SHALL activate the Chat tab. The sidebar session-list region SHALL remain visible regardless of which view tab is active. The displayed label of each view tab SHALL be resolved from the internationalization (`i18n`) resource bundle, keyed by a stable identifier, so that the label follows the active locale while the tab's identity, ordering, and icon remain stable.

#### Scenario: initial load shows the Chat tab
- **WHEN** the page loads
- **THEN** the sidebar SHALL render the view tabs Chat, Dashboard, Documents, and OpenConnector (and LiteLLM when configured)
- **AND** the Chat tab SHALL be the active tab
- **AND** the Chat panel SHALL be visible and all other panels SHALL be hidden

#### Scenario: canonical tab ordering and labels
- **WHEN** the sidebar renders
- **THEN** the view tabs SHALL appear in the order Chat, Dashboard, Documents, OpenConnector, LiteLLM (when configured)
- **AND** each tab SHALL display a label resolved from the `common` i18n bundle under a stable key, alongside a stable icon
- **AND** the tab's stable identifier and ordering SHALL NOT change when the active locale changes
- **AND** no standalone "Chat History" tab SHALL be present
- **AND** no `/history` route SHALL be registered

#### Scenario: tab labels follow the active locale
- **WHEN** the active locale changes from `en` to `zh-CN`
- **THEN** the displayed label of each view tab SHALL update to its Simplified-Chinese value
- **AND** the tab set, ordering, and icons SHALL remain unchanged

#### Scenario: History route is absent
- **WHEN** the user navigates to `/history`
- **THEN** the router SHALL NOT render a dedicated History page
- **AND** SHALL redirect to the default chat route (the session list in the sidebar remains the sole session-access surface)

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
The sidebar SHALL render a chat-session list region containing a "+ New chat" action and the list of persisted chat sessions, each row showing its title and last-updated time. The currently active session SHALL be visually distinguished. Clicking a session row SHALL switch the active chat to that session (governed by the `chat-history` capability). The session list SHALL be refreshed when sessions are created, switched, or updated. The "+ New chat" action SHALL navigate the main content area to the chat view (the `/chat` route in the SPA) regardless of which view is currently active, so the user lands on the fresh chat immediately; creating a new chat from a non-chat view SHALL switch the user to the chat view rather than leaving them on the current view.

#### Scenario: session list renders in the sidebar
- **WHEN** the page loads with one or more persisted sessions
- **THEN** the sidebar SHALL list each session's title and last-updated time
- **AND** the active session SHALL be highlighted

#### Scenario: new chat from the sidebar while on the chat view
- **WHEN** the user clicks "+ New chat" while the chat view is active
- **THEN** a new chat session SHALL be created and become the active session
- **AND** the session list SHALL refresh with the new session highlighted
- **AND** the main content area SHALL remain on the chat view

#### Scenario: new chat from a non-chat page
- **WHEN** the user clicks "+ New chat" while a non-chat view (e.g. Documents, Dashboard, History, OpenConnector, LiteLLM) is active
- **THEN** a new chat session SHALL be created and become the active session
- **AND** the main content area SHALL navigate to the chat view
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

