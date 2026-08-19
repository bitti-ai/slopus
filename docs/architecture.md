# PolStudio architecture contract

## Product bar

In a blind side-by-side evaluation, a first-time creator should pick PolStudio over a conventional professional editor shell as the clearer path from an idea to an editable, generated timeline, without losing credible project, queue, reference, and editing controls.

## Project boundary

A project is a portable folder. Its source of truth is `pols.json`; every path stored in that file is relative to the project root. Generated and imported content lives below that root so moving or archiving the folder does not break it.

```text
project-folder/
  pols.json
  media/imported/
  media/generated/
  references/
  thumbnails/
  cache/
  exports/
```

The JSON document is versioned and includes project metadata, canvas settings, ordered timeline tracks and clips, reusable references, generation jobs, agent conversation, and provider settings. Runtime-only state never belongs in the file.

## Agent boundary

Providers are subprocess adapters with a shared request/event/result contract. Claude Code runs non-interactively with `--print --output-format stream-json` (never `--bare`, which reads neither OAuth nor the keychain and so rejects every subscription login); Codex runs non-interactively with `codex exec --ephemeral --ignore-user-config --json`. PolStudio owns process lifecycle, normalized streaming events, cancellation, session history, and schema validation. Provider output is treated as an untrusted proposal until it validates against the project schema.

An agent can answer, ask the user a question, or propose a full project mutation. Every mutation is applied by PolStudio and persisted atomically; providers never receive authority to write arbitrary files directly.

## MiniMax H3 prompt contract

Base prompts use the official three-field shape:

```text
integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
```

Shots are sequential, later shots carry increasing cut timestamps, camera moves combine motion type with meaningful amplitude and speed, and dialogue uses stable speaker IDs. Keyframe jobs prepend the appropriate first/last-frame alignment instruction. Full-reference jobs additionally define stable subject/picture/video/audio labels and retention relationships. The editor stores both the human creative brief and the compiled H3 prompt so either can be revised.

## Generation boundary

The vidfab C API is loaded dynamically by the Rust backend. It resolves requests immediately, runs asynchronously, permits only one active generation per process, reports progress from a worker thread, and returns raw planar RGB frames plus interleaved audio. PolStudio therefore owns:

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
3. Agent and generation: provider adapters, validated mutations, H3 prompt compiler, vidfab queue, progress, and cancellation.
4. References and polish: reusable text/image inputs, binding them to jobs, accessibility, responsive behavior, and end-to-end verification.
