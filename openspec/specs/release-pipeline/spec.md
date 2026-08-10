# release-pipeline Specification

## Purpose
TBD - created by archiving change ci-build-installers. Update Purpose after archive.
## Requirements
### Requirement: Clean-checkout build is self-sufficient
The release pipeline SHALL build a working desktop installer from a fresh checkout with no pre-existing `resources/` directory and no hand-placed binaries. Every bundled resource selected by the resolved bundle manifest (`openconnector`, `python`, `litellm`, `node`, `postgres`) SHALL be produced by a build script invoked during `predist` and asserted present by `verify-bundle.js`; resources for components deselected in the manifest SHALL be skipped by `predist` and SHALL NOT be required by `verify-bundle.js`. `resources/node` SHALL always be built regardless of component selection.

#### Scenario: Fresh checkout builds the macOS installer
- **WHEN** a clean checkout is built on a macOS arm64 runner with the default (all-components) manifest
- **THEN** `predist` produces `resources/openconnector`, `resources/python`, `resources/litellm`, and `resources/node`
- **AND** `verify-bundle.js` passes asserting all four present
- **AND** `npm run dist` produces a `.dmg`

#### Scenario: Fresh checkout builds a lean installer
- **WHEN** a clean checkout is built with a manifest selecting only `openconnector`
- **THEN** `predist` produces `resources/node` and `resources/openconnector` and skips `resources/python`, `resources/litellm`, and `resources/postgres`
- **AND** `verify-bundle.js` passes asserting the selected set
- **AND** `npm run dist` produces a `.dmg` containing no python/litellm/postgres payload

#### Scenario: Bundled Node is reproducibly built
- **WHEN** `resources/node/` is absent
- **THEN** `scripts/build-node.js` downloads the standalone Node for the host platform
- **AND** `verify-bundle.js` fails the build if the platform-correct Node binary is missing

### Requirement: Platform matrix build
The release pipeline SHALL build the macOS (arm64 + x64) and Windows installers as parallel matrix jobs. The bundled Python/LiteLLM venv is host-interpreter-specific and cannot be cross-built; the macOS x64 build runs on the arm64 runner via Rosetta (`setup-node architecture: x64`), so `npm ci` compiles native addons for the x64 ABI and `build-node.js`/`build-python-litellm.js` (arch-aware via `process.arch`) fetch the x64 assets. The arch is selected per job by the `--arm64`/`--x64` flag (no `mac.target.arch` config list, which would make every job build all archs).

#### Scenario: macOS arm64 job builds the dmg
- **WHEN** the matrix job for `macos-latest` arm64 runs
- **THEN** it builds the arm64 `python-build-standalone` asset and venv
- **AND** produces the `Platform-<version>-arm64.dmg`

#### Scenario: macOS x64 job builds the dmg via Rosetta
- **WHEN** the matrix job for `macos-latest` x64 runs
- **THEN** it installs Rosetta and sets up x64 Node
- **AND** builds the x86_64-apple-darwin `python-build-standalone` asset and venv (python runs via Rosetta)
- **AND** produces the `Platform-<version>-x64.dmg`

#### Scenario: Windows x64 job builds the exe
- **WHEN** the matrix job for `windows-latest` runs
- **THEN** it builds the x86_64-msvc `python-build-standalone` asset and venv (`venv/Scripts/litellm.exe`)
- **AND** produces the `Platform Setup <version>.exe` (NSIS)

### Requirement: Bundled Node ABI matches the install-time Node ABI
Because native addons run under the bundled standalone Node with `npmRebuild: false`, the bundled Node SHALL be the same version as the Node that ran `npm ci`, so the compiled `.node` files (`better-sqlite3`, `tree-sitter`, `fsevents`) load without rebuild. `build-node.js` SHALL achieve this by downloading the standalone Node matching `process.version` (the Node running the build), making the invariant hold automatically in every environment.

#### Scenario: Bundled Node matches the build-time Node
- **WHEN** the workflow sets up Node (via `setup-node`) and runs `predist`
- **THEN** `build-node.js` downloads the standalone Node whose version equals the running `process.version`
- **AND** that version is the same one `npm ci` compiled the native addons against
- **AND** the bundled Node therefore loads `better-sqlite3`/`tree-sitter`/`fsevents` without rebuild

### Requirement: Tag-triggered release
The release pipeline SHALL publish a GitHub Release with all installers (mac arm64 + x64 + win) attached when a `v*` tag is pushed, and SHALL also support an on-demand (`workflow_dispatch`) build that uploads artifacts without cutting a release.

#### Scenario: Tag push creates a release
- **WHEN** a tag matching `v*` is pushed
- **THEN** all matrix jobs build their installer
- **AND** a GitHub Release is created (or updated) with the `.dmg` and `.exe` attached

#### Scenario: Manual dispatch uploads artifacts
- **WHEN** the workflow is run via `workflow_dispatch`
- **THEN** the installers are built and uploaded as workflow artifacts
- **AND** no GitHub Release is created

### Requirement: Signing and notarization gated on secrets
The release pipeline SHALL sign and notarize the installers when the required secrets are present, and SHALL produce a successful unsigned build when they are absent. A missing certificate SHALL NOT fail a CI build. Notarization SHALL use electron-builder's built-in `mac.notarize` (delegating to `@electron/notarize`) which skips with a warning when the `APPLE_*` env vars are absent.

#### Scenario: Secrets present - signed release
- **WHEN** `CSC_LINK` + `CSC_KEY_PASSWORD` are set on macOS (signing) and `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` are set (notarization), and `WIN_CSC_LINK` on Windows
- **THEN** the macOS app is signed and notarized
- **AND** the Windows installer is signed
- **AND** (once entitlements for the bundled Node are added) the signed macOS app passes Gatekeeper

#### Scenario: Secrets absent - unsigned build succeeds
- **WHEN** no signing secrets are set
- **THEN** electron-builder skips signing and notarization with warnings (not errors)
- **AND** the build completes successfully
- **AND** produces an unsigned `.dmg` / `.exe` usable for internal/CI smoke testing

### Requirement: Build caching for cost and reproducibility
The release pipeline SHALL cache the Python pip cache, the `resources/` directory (keyed by OS and `platformBundles`), and the electron-builder cache, so that repeated builds do not re-download python-build-standalone or re-install `litellm[proxy]`. The `resources/` cache key SHALL additionally hash `platform.bundle.json` and the resolved component selection (`PLATFORM_BUNDLE_COMPONENTS`), so a component-selection change never restores a stale cache built for a different component set.

#### Scenario: Cached resources are reused
- **WHEN** a second build runs on the same OS with unchanged `platformBundles` and unchanged component selection
- **THEN** `predist` skips rebuilding already-present `resources/`
- **AND** the pip cache is reused for the litellm install

#### Scenario: Component selection change invalidates the cache
- **WHEN** a build runs with a component selection different from the cached build
- **THEN** the resources cache key differs and the cache is not restored
- **AND** `predist` builds exactly the newly selected component set

### Requirement: Dispatch-time component selection
The release workflow SHALL expose a `workflow_dispatch` input for component selection (comma-separated component names, or `all` / `none`), passed to the build as `PLATFORM_BUNDLE_COMPONENTS`. When the input is empty, the build SHALL use the manifest's `components` selections unchanged. Tag-triggered builds SHALL use the manifest unchanged.

#### Scenario: Manual dispatch builds a lean installer
- **WHEN** the workflow is dispatched with component input `openconnector`
- **THEN** all matrix jobs build installers containing only the node + openconnector payloads
- **AND** the artifacts are distinguishable from full-bundle artifacts

#### Scenario: Empty input defers to the manifest
- **WHEN** the workflow is dispatched with an empty component input
- **THEN** the build resolves components from `platform.bundle.json`

