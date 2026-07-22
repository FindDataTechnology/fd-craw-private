# document-management Specification

## Purpose
TBD - synced from change left-nav-docs-history. Update Purpose after archive.
## Requirements
### Requirement: Document module is env-gated and degrades gracefully
The server SHALL initialize the document module at startup using the configured OpenAI-compatible provider (base URL, API key, model id) AND a ready project SQLite database. When either the provider configuration or the project database is unavailable, the server SHALL disable document ingestion/query and start normally with chat and other behavior unchanged. The document module SHALL use LlamaIndex.TS as its data-management framework, with PageIndex as the indexing layer accessed through LlamaIndex; LlamaIndex SHALL save document data into PageIndex and SHALL read structured data (source text, index data) from the project database.

#### Scenario: provider and database configured
- **WHEN** the provider base URL, API key, and model are configured at startup AND the project database is ready
- **THEN** the server SHALL initialize the document module and mount the `/api/documents/*` endpoints
- **AND** SHALL configure LlamaIndex's LLM settings to use the configured provider
- **AND** SHALL index documents through PageIndex accessed via LlamaIndex

#### Scenario: provider or database missing
- **WHEN** the provider configuration is missing OR the project database is unavailable
- **THEN** the server SHALL start without enabling document ingestion
- **AND** SHALL log a notice that the document module is disabled
- **AND** chat and other behavior SHALL remain unchanged

### Requirement: Users can ingest PDF, Markdown, text, and URL documents
The server SHALL accept document submissions of type PDF, Markdown, plain text, and URL. File uploads SHALL be accepted via multipart upload; text and URL SHALL be accepted via JSON. Each submitted document SHALL be queued for indexing. Indexing SHALL run in a serialized queue (one document at a time) with per-document failure isolation: a failure indexing one document SHALL NOT affect others. URL ingestion SHALL block private/local-network hosts (SSRF protection) and SHALL cap fetched content size and duration.

#### Scenario: upload a PDF
- **WHEN** a client uploads a PDF file to the document add endpoint
- **THEN** the server SHALL queue it for indexing using a PDF reader
- **AND** SHALL return the new document id with status `queued`

#### Scenario: submit a URL
- **WHEN** a client submits a URL for ingestion
- **THEN** the server SHALL fetch the URL only after confirming the host is not private or local
- **AND** SHALL cap the fetched content and abort on timeout

#### Scenario: URL points to a private host
- **WHEN** a client submits a URL whose host is loopback, private, link-local, or `.local`
- **THEN** the server SHALL reject it with a clear error and SHALL NOT fetch it

#### Scenario: indexing failure is isolated
- **WHEN** indexing one document fails
- **THEN** that document SHALL be marked `error` with its error message
- **AND** other queued documents SHALL continue to index normally

### Requirement: Document records, source text, and index are persisted to the project database atomically with restart reconciliation
The server SHALL persist each document's record (id, name, type, status, addedAt, error), extracted source text, and PageIndex index in the project SQLite database rather than per-document storage directories or a `manifest.json` file. Status changes SHALL be written in a single SQLite transaction so a crash mid-write cannot corrupt the registry. On restart, any document left in `queued` or `indexing` status SHALL be marked `error` because its in-memory ingestion payload is gone.

#### Scenario: status change is transactional
- **WHEN** a document's status changes
- **THEN** the server SHALL update the document's row in the project database within a single transaction

#### Scenario: interrupted indexing reconciled on restart
- **WHEN** the server restarts and finds a document in `queued` or `indexing` status
- **THEN** the server SHALL mark that document `error` with a message indicating indexing was interrupted

### Requirement: Users can list, view, and delete documents
The server SHALL expose endpoints to list documents (id, name, type, status, addedAt, error) from the project database, to view a document's extracted source text, and to delete a document (removing its database record, source text, and index row). Deletion SHALL be idempotent.

#### Scenario: list documents
- **WHEN** a client calls the document list endpoint
- **THEN** the server SHALL return the current document records from the project database without index payloads

#### Scenario: delete a document
- **WHEN** a client deletes a document by id
- **THEN** the server SHALL remove its database record, source text, and index row
- **AND** a subsequent delete of the same id SHALL succeed (idempotent)

### Requirement: Document status transitions are broadcast as `documents_status` events
The server SHALL broadcast a `documents_status` WebSocket event whenever a document transitions to `queued`, `indexing`, `ready`, or `error`, carrying the document id, name, status, and (on error) the error message. This replaces the former `knowledge_status` event.

#### Scenario: status broadcast on transition
- **WHEN** a document transitions from `indexing` to `ready`
- **THEN** the server SHALL broadcast a `documents_status` event with that document's id, name, and status `ready`

### Requirement: Users can query the document collection
The server SHALL expose a query endpoint that retrieves over all `ready` documents and returns an answer and the source document names used. Retrieval SHALL use PageIndex as a vectorless (reasoning-based) index accessed through LlamaIndex.TS, so that no embedding model is required; LlamaIndex SHALL read document source text and index data from the project database.

#### Scenario: query the collection
- **WHEN** a client posts a query against the document collection
- **THEN** the server SHALL retrieve over all ready documents via PageIndex through LlamaIndex
- **AND** SHALL return an answer and the list of source document names used

#### Scenario: no ready documents
- **WHEN** a client posts a query and no documents are `ready`
- **THEN** the server SHALL return an empty answer with no sources

### Requirement: URL ingestion honors HTTP(S) proxy configuration
The document module SHALL honor the `https_proxy` (preferred) or `http_proxy` environment variable when fetching a URL for ingestion: when a proxy is configured, the fetch SHALL route through it so that URL uploads succeed in environments where direct egress is blocked. When no proxy is configured, the fetch SHALL behave as before (direct). SSRF protection (rejecting private/local-network hosts) SHALL still be applied to the target host before fetching, regardless of proxy use.

#### Scenario: URL fetch succeeds through a configured proxy
- **WHEN** a client submits a URL and `https_proxy` (or `http_proxy`) is set in the environment
- **AND** the target host is not private or local
- **THEN** the server SHALL fetch the URL through the proxy
- **AND** SHALL index the extracted text and transition the document to `ready`

#### Scenario: URL fetch is direct when no proxy is configured
- **WHEN** a client submits a URL and no proxy environment variable is set
- **THEN** the server SHALL fetch the URL directly (unchanged behavior)

#### Scenario: SSRF protection still applies with a proxy
- **WHEN** a client submits a URL whose host is loopback, private, link-local, or `.local`
- **THEN** the server SHALL reject it with a clear error and SHALL NOT fetch it, even if a proxy is configured

### Requirement: Document list status updates are race-free in the UI
The UI SHALL serialize document-list fetches so that overlapping fetches (for example, one triggered by an add and another by a `documents_status` event for the same document) cannot resolve out of order. A stale in-flight response SHALL NOT overwrite a newer status, so a document row SHALL always converge on its latest status and never remain stuck on an intermediate status such as `indexing`.

#### Scenario: overlapping list fetches do not stick the status
- **WHEN** a document is added and its `documents_status` events arrive while list fetches overlap
- **THEN** the document row SHALL converge on the final status (e.g. `ready`)
- **AND** SHALL NOT remain stuck on an earlier status because a stale fetch resolved last

### Requirement: Documents can be ingested via drag-and-drop and clipboard paste
The web UI SHALL accept document ingestion via site-wide drag-and-drop of files and clipboard paste, in addition to the Documents-tab forms. Dropped and pasted files SHALL be mapped by extension to a supported type (PDF, Markdown, DOCX, CSV, HTML, or JSON) and submitted through the existing document ingestion endpoint; files whose extension is not supported SHALL be rejected by the server (HTTP 415) and surfaced as a notice rather than silently classified. Pasted files SHALL be ingested as files; pasted plain text or URLs SHALL be ingested as text or URL respectively, but only when the paste target is not a text-editable element (`input`, `textarea`, or `[contenteditable]`) so normal text entry is not interrupted. Ingestion SHALL reuse the existing pipeline (serialized queue, SSRF protection, size and duration caps) and live status SHALL be surfaced through existing `documents_status` events plus a transient UI notice. When the document module is disabled, drag/paste SHALL show a notice and SHALL NOT call the ingestion endpoint.

#### Scenario: dropping a supported file ingests it
- **WHEN** the user drops a supported file (for example a PDF or DOCX) onto the page
- **THEN** the UI SHALL submit the file to the document ingestion endpoint
- **AND** a `documents_status` event SHALL eventually transition the document to `ready`

#### Scenario: dropping an unsupported file is rejected
- **WHEN** the user drops a file with an unsupported extension onto the page
- **THEN** the UI SHALL submit it and the server SHALL respond with HTTP 415
- **AND** the UI SHALL show a notice that the file type is not supported

#### Scenario: pasting text outside an editable field ingests it
- **WHEN** the user pastes plain text while not focused in an `input`, `textarea`, or `[contenteditable]` element
- **THEN** the UI SHALL ingest the pasted text as a text document

### Requirement: Documents added during a session are surfaced in the chat view
The chat UI SHALL show a banner at the top of the chat view listing documents added during the current page session, each with its name and live indexing status, driven by the existing `documents_status` WebSocket events. The banner SHALL be hidden when empty and SHALL cap the number of shown documents to the most recent few. Documents remain a global collection; the banner reflects additions made in the current page session, not a per-chat-session scope.

#### Scenario: a newly added document appears in the chat banner
- **WHEN** the user adds a document (drag-drop, paste, or the Documents panel)
- **THEN** the chat view banner SHALL show the document with status `queued` or `indexing`
- **AND** SHALL update the chip to `ready` or `error` as `documents_status` events arrive

#### Scenario: banner is hidden when no documents have been added
- **WHEN** no documents have been added in the current page session
- **THEN** the chat view banner SHALL be hidden

### Requirement: Users can ingest DOCX, CSV, HTML, and JSON documents via LlamaIndex readers
The server SHALL accept document submissions of type DOCX (`.docx`), CSV (`.csv`), HTML (`.html`/`.htm`), and JSON (`.json`) via multipart upload, in addition to PDF, Markdown, text, and URL. Each new type SHALL be parsed by the corresponding `@llamaindex/readers` reader (`DocxReader`, `CSVReader`, `HTMLReader`, `JSONReader`) to extract text, which SHALL then be indexed through PageIndex and persisted to the project database using the same pipeline (serialized queue, per-document failure isolation, transactional status writes) as the existing types. A failure to extract text from a supported type SHALL mark that document `error` without affecting others. (PPTX is not supported because `@llamaindex/readers` ships no PPTX reader.)

#### Scenario: upload a DOCX
- **WHEN** a client uploads a `.docx` file to the document add endpoint
- **THEN** the server SHALL extract its text via a LlamaIndex DOCX reader
- **AND** SHALL queue it for indexing and return the new document id with status `queued`

#### Scenario: upload a CSV
- **WHEN** a client uploads a `.csv` file to the document add endpoint
- **THEN** the server SHALL extract its text via a LlamaIndex CSV reader
- **AND** SHALL queue it for indexing and return the new document id with status `queued`

#### Scenario: upload an HTML file
- **WHEN** a client uploads a `.html` or `.htm` file to the document add endpoint
- **THEN** the server SHALL extract its text via a LlamaIndex HTML reader
- **AND** SHALL queue it for indexing and return the new document id with status `queued`

#### Scenario: extraction failure is isolated
- **WHEN** text extraction fails for one supported document
- **THEN** that document SHALL be marked `error` with its error message
- **AND** other queued documents SHALL continue to index normally

### Requirement: Unsupported file types are rejected with a clear error
The server SHALL reject multipart uploads whose file extension is not one of the supported types (`.pdf`, `.md`, `.markdown`, `.docx`, `.csv`, `.html`, `.htm`, `.json`) with an HTTP 415 response and a clear error message, and SHALL NOT classify an unsupported file as Markdown or attempt to decode its bytes as text.

#### Scenario: unsupported extension is rejected
- **WHEN** a client uploads a file with an unsupported extension (for example `.png` or `.zip`)
- **THEN** the server SHALL respond with HTTP 415 and a message naming the supported types
- **AND** SHALL NOT create a document record or queue indexing

#### Scenario: drag-dropped unsupported file is rejected
- **WHEN** the UI submits an unsupported file via the drag-and-drop or paste path
- **THEN** the server SHALL respond with HTTP 415
- **AND** the UI SHALL surface a notice to the user

