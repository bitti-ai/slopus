# Slopfab 1.12 compatibility

Reviewed on 2026-09-20 against Slopfab commit `50ca721` and the local
`lib/slopfab/slopfab.dll`, which reports C API `1.12.0`.

## ABI and runtime

The refactor preserves the existing C function signatures and the layouts of
`slopfab_plan`, `slopfab_progress` and `slopfab_output`. Slopus's Rust bindings,
callbacks, reference handles and output ownership remain compatible.

The new session and JSON sampling/conditioning setters are additive. Slopus
can continue using the default session through its serialized generation
queue. `slopfab_reused_models_clear` still clears that default session when
the queue drains. Explicit session bindings are optional for future cache
isolation; they are not required for this update.

The C API continues to return pixels and PCM. Slopus still uses WebCodecs and
MP4 muxing; no FFmpeg dependency is introduced.

## Integration corrections

- Preview and execution requests now supply the same configured model paths.
  The planner reads SafeTensors metadata for model capabilities, geometry,
  sampling grids and conditioning policy. Omitting the transformer during
  preview could report different steps or accept a request execution rejects.
- Generation progress uses the resolved model evaluation count. A fixed grid
  from model or LoRA metadata can override the scene's explicit step count.
- The planning boundary message acknowledges metadata reads. Planning does
  not execute inference, but it is no longer accurate to say it opens no files.
- DLL integration tests use valid SafeTensors fixtures and the new Animate
  recipe diagnostics. Added coverage verifies model-driven sampling, early
  conditioning rejection and fixed-grid/MotionCache incompatibility on both
  CUDA and Vulkan requests. Missing model files still allow generic planning.

Scene and LoRA step overrides remain explicit requests, so the change to
Slopfab's inherited step defaults does not change Slopus's configured counts.
Slopus also supplies an explicit canvas; the CLI's new canvas defaults do not
change project resolution. Unsupported metadata combinations now surface
during planning instead of being deferred until generation.

## LoRA asset preparation

Inference no longer downloads a missing AdaLN timestep grid or rewrites the
adapter to embed it. This affects adapters that need rebasing onto an H3 table
model and do not already have an embedded grid. Slopus's current LoRA download
flow downloads the adapter itself; it does not prepare this companion asset.

For legacy H3 adapters, place `h3_silu_temb_grid.safetensors` beside the adapter,
or use Slopfab's explicit preparation command before selecting it in Slopus:

```powershell
slopfab.exe prepare-lora --adapter "D:\weights\adapter.safetensors" --width 2688 --download
```

That command explicitly downloads the pinned legacy grid and embeds it in the
adapter. Omit `--download` to use local assets only. Custom `slopfab.lora_grid`
metadata requires its declared local asset and matching identity/width; the
legacy downloader cannot supply arbitrary grids. Already embedded adapters
need no migration. Automatic asset preparation in Slopus would be a separate
download-workflow enhancement, not a C ABI binding change.

## Validation limits

All 26 Slopus Slopfab integration tests passed with the updated DLL, including
planning for both backends, Animate, MotionCache, video reference ownership,
continuation and still images. These tests do not run a full model inference;
CUDA/Vulkan numerical output and render performance were not revalidated here.
