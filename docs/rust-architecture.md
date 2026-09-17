# Rust architecture

The four former files over 1,000 lines (`lib.rs`, `slopfab.rs`, `agent.rs`, and
`agent_commands.rs`) are split by responsibility. Existing IPC names, project
JSON, JSONL commands, event payloads, and reference import policies are preserved.

| Area | Responsibilities |
| --- | --- |
| `app.rs`, `window.rs`, `commands/` | Tauri setup, window lifecycle, dialogs, IPC and event delivery |
| `project/` | Document types, compatibility migrations, ordered validation, persistence and lifecycle |
| `project/commands/` | Restricted command vocabulary, JSONL parsing, transactional batches and domain handlers |
| `media/`, `storage/` | Format catalog, session access, confined project artifacts and atomic replacement |
| `agent/` | Turn protocol, correction budget, semantic policy, cancellation and provider discovery |
| `agent/providers/` | Claude/Codex CLI adapters and compatible HTTP endpoints behind one turn interface |
| `generation/models/` | Model defaults, capabilities, authoring instructions and shot-setting validation |
| `slopfab/` | Native runtime configuration, planning, serial generation queue, icons and references |
| `slopfab/ffi/` | Private ABI bindings, library ownership, handles, callbacks and output access |

## Adding a generation model

1. Define a `ModelDefinition` under `generation/models/` and register its persisted
   ID in `find`. Specify scene defaults, generation limits, authoring instructions,
   vocabulary and shot-setting validation. Unknown IDs remain readable data and
   do not acquire H3 authoring instructions; unregistered documents retain the
   existing v1 validation limits.
2. Use `SceneDefaults` with the command batch executor and `GenerationJob::draft`.
   Individual command handlers do not need model-specific constructors. Existing
   callers select the default model; a model-selection feature must pass the same
   selected defaults during both agent validation and command execution.
3. Implement the engine mapping separately. H3/Animate request construction is
   in `slopfab/h3.rs`; the queue, cancellation, events, file services and native
   ownership code are reusable. Registering a profile alone does not add a native
   engine, model download configuration, or frontend prompt compiler.
4. Update the frontend's model selection, schema limits and compiler as appropriate.
   H3's shot vocabulary now has one source in
   `shared/models/minimax-h3-shot-tags.json`, consumed by both Rust and TypeScript.
   Preserve the persisted IDs when changing labels or adding options.

Agent transport providers are a separate concern from generation models.
`AgentProvider::run_turn` gives CLI and HTTP transports the same sanitized project
context, cancellation flag, deadline and event callback. Provider settings are
removed from model context; credentials remain in the selected transport session.

## Ownership and compatibility

- `ProjectRoot` checks canonical containment before writing through each directory
  component. `MediaAccess`, `ProviderDiscovery` and prepared native reference
  registries belong to application state instead of process-wide registries.
- Atomic writes create a unique sibling with `create_new`, sync it, replace the
  destination, and clean up only that owned temporary file on failure.
- Command batches mutate a clone, collect derived effects, then validate. Missing,
  null and populated patch fields have explicit `Patch<T>` variants. Validators
  run in the original normalization/migration order. Correction budgets use
  structured issue keys, with a per-issue limit and an overall limit.
- Starting a native generation consumes its request. The generation retains the
  request, callback and DLL; error cleanup cancels and joins before destruction.
  Only completed generations can enter the render store. Raw pointers stay in
  `ffi`, and Rust output snapshots contain owned audio and scalar metadata.
- Video remains native-owned until encoding finishes; the existing frame-at-a-time
  RGBA transfer to WebCodecs is preserved. This refactor adds neither a new GPU
  interop path nor a different decoder/encoder. There is no FFmpeg dependency.

## Verification

Run `cargo test --manifest-path src-tauri/Cargo.toml`, `npm test`, and `npm run build`.
Native tests exercise the bundled DLL's ABI, planning, reference snapshots and
handle ownership without loading model weights. They do not verify a full GPU
render; that requires installed weights and suitable hardware.

Ordinary tests compare serialized documents with committed frontend fixtures and
do not rewrite them. To deliberately update the wire fixtures in PowerShell:

```powershell
$env:SLOPUS_UPDATE_FIXTURES = '1'
try {
    cargo test --manifest-path src-tauri/Cargo.toml serialized_wire_format_matches_frontend_fixtures
} finally {
    Remove-Item Env:SLOPUS_UPDATE_FIXTURES
}
npm test
```

Review the fixture diff before committing any wire-format change.
