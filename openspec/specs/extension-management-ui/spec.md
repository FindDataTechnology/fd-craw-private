# extension-management-ui Specification

## Purpose
TBD - created by archiving change add-mcp-skills-management. Update Purpose after archive.
## Requirements
### Requirement: Extensions page is accessible from navigation
The application SHALL provide a dedicated Extensions page accessible via the sidebar navigation at route `/settings/extensions`.

#### Scenario: User navigates to extensions page
- **WHEN** the user clicks the "Extensions" link in the sidebar
- **THEN** the application SHALL navigate to `/settings/extensions`
- **AND** the Extensions page SHALL render with two tabs: "Installed" and "Market"

### Requirement: Installed tab lists all configured MCP servers
The Installed tab SHALL display a list of all configured MCP servers with their name, description (if available), connection status (connected/disconnected/error), and an enable/disable toggle.

#### Scenario: MCP servers are displayed
- **WHEN** the user views the Installed tab
- **THEN** the UI SHALL list each configured MCP server
- **AND** each entry SHALL show the server name, status indicator, and enable/disable toggle
- **AND** the list SHALL be sorted alphabetically by server name

#### Scenario: No MCP servers configured
- **WHEN** no MCP servers are configured
- **THEN** the UI SHALL display an empty state with a message "No MCP servers configured" and a button to add one

### Requirement: Installed tab lists all configured skills
The Installed tab SHALL display a list of all configured skills with their name, description, source (built-in or custom), and an enable/disable toggle.

#### Scenario: Skills are displayed
- **WHEN** the user views the Installed tab
- **THEN** the UI SHALL list each configured skill
- **AND** each entry SHALL show the skill name, description, source badge, and enable/disable toggle
- **AND** the list SHALL be sorted alphabetically by skill name

#### Scenario: No skills configured
- **WHEN** no skills are configured
- **THEN** the UI SHALL display an empty state with a message "No skills configured"

### Requirement: User can add a new MCP server
The UI SHALL provide an "Add MCP Server" button that opens a form to configure a new MCP server with fields for name, type (stdio or http), and type-specific configuration (command/args/env for stdio; url/headers for http).

#### Scenario: User adds a stdio MCP server
- **WHEN** the user clicks "Add MCP Server", selects type "stdio", fills in name, command, and args
- **AND** clicks "Save"
- **THEN** the server SHALL validate the configuration
- **AND** add the server to the MCP configuration
- **AND** attempt to connect to the server
- **AND** display the new server in the list with its connection status

#### Scenario: User adds an HTTP MCP server
- **WHEN** the user clicks "Add MCP Server", selects type "http", fills in name, URL, and optional headers
- **AND** clicks "Save"
- **THEN** the server SHALL validate the configuration
- **AND** add the server to the MCP configuration
- **AND** attempt to connect to the server
- **AND** display the new server in the list with its connection status

#### Scenario: Invalid configuration
- **WHEN** the user submits invalid configuration (e.g., missing required fields, malformed URL)
- **THEN** the UI SHALL display validation errors
- **AND** SHALL NOT save the configuration

### Requirement: User can remove an MCP server
The UI SHALL provide a "Remove" button for each MCP server that removes the server from the configuration and disconnects it.

#### Scenario: User removes an MCP server
- **WHEN** the user clicks "Remove" on an MCP server entry
- **AND** confirms the action in a confirmation dialog
- **THEN** the server SHALL disconnect from the MCP server
- **AND** remove it from the configuration
- **AND** remove it from the list

### Requirement: User can edit an MCP server configuration
The UI SHALL provide an "Edit" button for each MCP server that opens the configuration form pre-filled with the current values.

#### Scenario: User edits an MCP server
- **WHEN** the user clicks "Edit" on an MCP server entry
- **THEN** the UI SHALL open the configuration form with current values pre-filled
- **AND** when the user saves changes, the server SHALL disconnect from the old configuration
- **AND** reconnect with the new configuration
- **AND** update the list entry

### Requirement: User can enable or disable an MCP server
The enable/disable toggle SHALL control whether the MCP server is active. Disabled servers remain in the configuration but are not connected.

#### Scenario: User disables an MCP server
- **WHEN** the user toggles off an MCP server
- **THEN** the server SHALL disconnect from the MCP server
- **AND** mark it as disabled in the configuration
- **AND** the UI SHALL show the server as disabled (greyed out)

#### Scenario: User enables an MCP server
- **WHEN** the user toggles on a disabled MCP server
- **THEN** the server SHALL attempt to connect to the MCP server
- **AND** update the status indicator

### Requirement: User can add a custom skill
The UI SHALL provide an "Add Custom Skill" button that opens a form to create a new skill with fields for name, description, and skill content (markdown).

#### Scenario: User adds a custom skill
- **WHEN** the user clicks "Add Custom Skill", fills in name, description, and content
- **AND** clicks "Save"
- **THEN** the server SHALL create a new SKILL.md file in the skills directory
- **AND** register the skill with the agent
- **AND** display the new skill in the list

### Requirement: User can remove a custom skill
The UI SHALL provide a "Remove" button for custom skills that deletes the skill file and unregisters it.

#### Scenario: User removes a custom skill
- **WHEN** the user clicks "Remove" on a custom skill entry
- **AND** confirms the action
- **THEN** the server SHALL delete the SKILL.md file
- **AND** unregister the skill from the agent
- **AND** remove it from the list

#### Scenario: Built-in skills cannot be removed
- **WHEN** a skill is marked as built-in
- **THEN** the "Remove" button SHALL NOT be displayed

### Requirement: User can edit a custom skill
The UI SHALL provide an "Edit" button for custom skills that opens the skill editor with current content.

#### Scenario: User edits a custom skill
- **WHEN** the user clicks "Edit" on a custom skill
- **THEN** the UI SHALL open the skill editor with current content pre-filled
- **AND** when the user saves changes, the server SHALL update the SKILL.md file
- **AND** re-register the skill with the agent

### Requirement: User can enable or disable a skill
The enable/disable toggle SHALL control whether the skill is available to the agent. Disabled skills remain in the configuration but are not registered.

#### Scenario: User disables a skill
- **WHEN** the user toggles off a skill
- **THEN** the server SHALL unregister the skill from the agent
- **AND** mark it as disabled
- **AND** the UI SHALL show the skill as disabled

#### Scenario: User enables a skill
- **WHEN** the user toggles on a disabled skill
- **THEN** the server SHALL register the skill with the agent
- **AND** update the UI to show it as enabled

### Requirement: MCP setup form is generated from config template
When the user installs an MCP server from the market whose `requiresConfig` is `true`, the add-server form SHALL render in a setup mode generated from the entry's `configTemplate`, rather than pre-filling the raw manual-add fields with placeholder strings. The form SHALL be data-driven from the template — one labeled field per `configTemplate.env` key and one labeled field per placeholder argument — not hardcoded per server.

#### Scenario: setup form renders a field per env key
- **WHEN** the user clicks "Install" on a needs-config MCP server whose template has `env: { GITHUB_PERSONAL_ACCESS_TOKEN: "your_token_here" }`
- **THEN** the form SHALL render a labeled text input whose label is the env key `GITHUB_PERSONAL_ACCESS_TOKEN`
- **AND** the input SHALL be empty with the template's placeholder value as a hint
- **AND** the template's `installInstructions` SHALL be shown as help text

#### Scenario: setup form renders a field per placeholder argument
- **WHEN** the user clicks "Install" on a needs-config MCP server whose template has `args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/directory"]`
- **THEN** the form SHALL render a labeled text input for the `/path/to/allowed/directory` argument
- **AND** the literal arguments `-y` and `@modelcontextprotocol/server-filesystem` SHALL be shown as read-only, non-editable values

#### Scenario: Add is disabled until required fields are filled
- **WHEN** the setup form is open and one or more placeholder fields are empty
- **THEN** the Add button SHALL be disabled
- **WHEN** the user fills every placeholder field with a non-empty value
- **THEN** the Add button SHALL become enabled

#### Scenario: submitted config is reconstructed from field values
- **WHEN** the user fills the setup form fields and clicks Add
- **THEN** the system SHALL reconstruct the server config by preserving template literal arguments in order and substituting the filled values into placeholder positions
- **AND** the `env` object SHALL contain only the filled env-key values
- **AND** the server SHALL be added with the reconstructed config and appear in the Installed tab

#### Scenario: manual add and edit keep the raw form
- **WHEN** the user clicks "Add MCP" without a market template, or clicks "Edit" on an existing server
- **THEN** the form SHALL render the raw manual-add fields (command, args, env JSON, url, headers JSON) as before
- **AND** the setup-mode fields SHALL NOT be rendered

### Requirement: MCP Servers and Skills are top-level routes
The web UI SHALL mount the MCP Servers management page at `/mcp` and the Skills management page at `/skills` (replacing the legacy `/extensions/mcp` and `/extensions/skills` sub-routes). The legacy `/extensions` parent page and its two-card selector SHALL be removed; visiting `/extensions` SHALL redirect to `/mcp`. Visiting the legacy `/extensions/mcp` or `/extensions/skills` paths SHALL redirect to the new top-level routes (`/mcp` and `/skills` respectively) so existing deep-links and bookmarks continue to work.

#### Scenario: visit legacy extensions path
- **WHEN** the user navigates to `/extensions`
- **THEN** the router SHALL redirect to `/mcp`
- **WHEN** the user navigates to `/extensions/mcp`
- **THEN** the router SHALL redirect to `/mcp`
- **WHEN** the user navigates to `/extensions/skills`
- **THEN** the router SHALL redirect to `/skills`

#### Scenario: new top-level routes work directly
- **WHEN** the user clicks the "MCP Servers" sidebar tab
- **THEN** the URL SHALL be `/mcp` and the MCP management page SHALL render
- **AND** the Installed / Market sub-tabs SHALL behave as before (this change does not touch the MCP management page itself)

### Requirement: Installed / Market tabs preserved
The MCP and Skills management pages SHALL keep their existing Installed / Market sub-tabs and the existing add/edit/remove/toggle behavior. This change only moves the route; the management UX is unchanged.

#### Scenario: sub-tabs still work at new route
- **WHEN** the user visits `/mcp`
- **THEN** the MCP management page SHALL render with the Installed / Market sub-tabs
- **AND** selecting Market SHALL show the MCP market view exactly as before this change

