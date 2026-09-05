# Slopus architecture contract

## Product bar

In a blind side-by-side evaluation, a first-time creator should pick Slopus over a conventional professional editor shell as the clearer path from an idea to an editable, generated timeline, without losing credible project, queue, reference, and editing controls.

## Project boundary

A project is a portable folder. Its source of truth is `slopus.json` (older projects may still hold `polstudio.json`, `pols.json`, or `polstudio.project.json`, all of which still open). Paths in that file are one of two kinds: project-relative for what the folder contains — everything generated here, and imported images — and an absolute `sourcePath` for imported video and audio, which are never copied. A rush is tens of gigabytes and duplicating it to call the folder portable costs the user that disk for nothing.

```text
project-folder/
  slopus.json
  media/imported/
  media/generated/
  references/
  thumbnails/
  cache/
  exports/
```

The JSON document is versioned and includes project metadata, canvas settings, ordered timeline tracks and clips, reusable references, generation jobs, agent conversation, and provider settings. Runtime-only state never belongs in the file.

## Agent boundary

Providers are subprocess adapters with a shared request/event/result contract. Claude Code runs non-interactively with `--print --output-format stream-json` (never `--bare`, which reads neither OAuth nor the keychain and so rejects every subscription login); Codex runs non-interactively with `codex exec --ephemeral --ignore-user-config --json`. Slopus owns process lifecycle, normalized streaming events, cancellation, session history, and schema validation. Each provider receives the complete validated project document as read-only context, including fields the agent cannot modify. Machine-injected endpoint credentials are removed because they are not project data. Provider output is treated as an untrusted proposal until it validates against the project schema.

An agent can answer, ask the user a question, or propose a compact JSONL command stream ending in a `commit` summary. Commands target project, reference, scene, and shot domains by stable ID and expose only fields an agent may author; paths, assets, provider settings, generated output, progress, project identity, and schema version are not commandable. Slopus parses the stream into a typed Rust enum, dry-runs the complete batch, and returns it to the editor. The editor executes it again against its latest in-memory state, validates the complete resulting project, and persists it once through the normal atomic save queue. A failing command applies nothing, and providers never receive authority to write arbitrary files directly.

## MiniMax H3 prompt contract

Base prompts use the official three-field shape:

```text
integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
```

Shots are sequential, later shots carry increasing cut timestamps, camera moves combine motion type with meaningful amplitude and speed, and dialogue uses stable speaker IDs. Keyframe jobs prepend the appropriate first/last-frame alignment instruction. Full-reference jobs additionally define stable subject/picture/video/audio labels and retention relationships. The editor stores both the human creative brief and the compiled H3 prompt so either can be revised.

## Generation boundary

The slopfab C API is loaded dynamically by the Rust backend. It resolves requests immediately, runs asynchronously, permits only one active generation per process, reports progress from a worker thread, and returns raw planar RGB frames plus interleaved audio. Slopus therefore owns:

- compute-platform selection: CUDA 13 when usable, then CUDA 12, then Vulkan with exact attention;
- a serial generation queue and cancellation;
- thread-safe progress marshaling into Tauri events;
- safe lifetime management for request and generation handles;
- conversion of one frame at a time for preview;
- WebCodecs encoding and MP4 muxing in the host application;
- recovery metadata so interrupted jobs can be retried.

The application must fail gracefully when the DLL, model files, WebCodecs, or WebGPU are unavailable. A missing runtime disables generation, never project editing.

## Independently judged slices

1. Foundation: desktop shell, library, portable project persistence, schema, and always-visible agent prompt.
2. Timeline: preview, track controls, clips, playhead, selection, and credible editing interactions.
3. Agent and generation: provider adapters, validated command batches, H3 prompt compiler, slopfab queue, progress, and cancellation.
4. References and polish: reusable text/image inputs, binding them to jobs, accessibility, responsive behavior, and end-to-end verification.
