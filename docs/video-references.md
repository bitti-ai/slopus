# Video references

## Animate

Download **Animate** in Settings → Generators, then select it in the Generator.
Choose one **Reference video** and one **Repainted scene frame** in the scene
inspector. The image should be a frame of the driving scene with the character
repainted, preserving pose, framing, background and lighting. A standalone
portrait is not an equivalent input. Continuation and refmods are unsupported.

Animate output is capped at **345 frames (14.375 seconds)**. SlopFab aligns
frame counts upward to `17*k + 5`; a 15-second request (360 frames at 24 fps)
would become 362 frames and exceed its 360-frame limit. Slopus caps requests
within the 15-second range at 345 frames before planning and generation, so
selecting 14.5 or 15 seconds produces 14.375 seconds of output.

Slopus enables SlopFab C API 1.10's Animate recipe and supplies the downloaded
362-token embedding and modality tags. Qwen and the tokenizer are neither
downloaded nor passed to Animate. The bundled fixed prompt remains descriptive
text; the DLL uses the frozen embedding instead of encoding it. Shot descriptions,
look, sound and music prompts are not used. Older DLLs report an update error.

Video trim and soundtrack settings come from References. When a soundtrack is
included and decoded, Slopus pins it in the output audio latents. This preserves
it through an audio-VAE round trip, not a sample-identical copy. Without attached
audio, the model generates audio. References are ordered video first and image
second, resized using the target canvas, and video flow shift is 3.

The template uses `Viggle-Animate-pruned_rank8_int8_convrot.safetensors` and
`viggle_animate_distillation_bf16.safetensors` from DeepBeepMeep/MiniMax-H3.
The enabled distillation LoRA has a **4-step override**, which takes precedence
over the scene's step count. Existing installations receive the template once
without replacing their default generator or local model paths.

The video/audio VAEs are still required. Animate also downloads its frozen
conditioning as an **Additional safetensor** into the weights folder. Existing
Animate templates receive this download entry once. In a custom Animate template,
set the conditioning file's **Use** to **Animate conditioning**. Slopus converts
the downloaded BF16 file losslessly to SlopFab's F32 layout and caches the result
beside it. Neither file is included in the installer or portable package.
See [embedding provenance](../src-tauri/assets/README.md).

**Known runtime limitation:** SlopFab's 2026-09-16 comparison with the new recipe
still produced a flat brown texture. Its VAE reference reconstruction succeeded
and pinned audio latents remained unchanged. This integration enables the recipe;
it does not resolve or validate the remaining conditioning/transformer failure.

## Adding video references

In **References**, choose **Add a reference → Other → New** to create an
**Uncategorized** reference, then choose **Add file** in its details. Video
can also be attached to an existing reference. The reference card shows the
video's first source frame, including after reopening the project; replacing
the video updates the icon. MP4, M4V, and MOV containers are accepted; the computer's WebCodecs
decoder must support the video codec. Video files remain at their original
locations. The project stores their paths and clip settings.

Reference preparation tries hardware decoding first, then automatic WebCodecs
decoder selection if that configuration is unavailable. This allows the webview
to use its software decoder for formats such as AV1 when hardware decoding is
unavailable.

Source videos may be longer than 15 seconds. Import initially selects the first
15 seconds, or the entire source if it is shorter (at least 2 seconds). Import
uses the actual video frame timestamps so fragmented MP4s with missing or
placeholder header durations can still be selected correctly.

Use **Position in full video** to move the reference segment anywhere in the
source. Drag the highlighted selection to move it without changing its length,
or drag either edge to trim it. The closer ruler displays up to 30 seconds at a
time so the edges remain usable on long videos. The start and duration fields
provide precise edits; all controls stay within the source and the 2–15 second
selection limit. The handles also support arrow keys (0.1 seconds), Shift+arrow
(1 second), Home, and End.

You can also seek in the video player and choose **Start at playhead**.
**Play selection** previews only the chosen segment and stops at its end.
**Include sound** controls the selected interval's soundtrack. Changing the
selection seeks the existing player without reloading the source. The segment
and sound setting are saved with the project and used during generation.

Each selected clip must last 2–15 seconds. A generation can use up to three video clips
totaling 15 seconds, alongside up to nine images. Cite the reference in a shot
just like an image reference. Use CUDA or Vulkan with a Ref2VA transformer,
such as the **References** generator. Vulkan video references require
floating-point video VAE encoder weights. Soundtracks on either backend also
require floating-point audio VAE encoder weights.

The prompt compiler numbers pictures and videos independently, in the order
the native request receives each kind. Video trim settings and soundtrack
choices are included in generation snapshots so changing them marks the
result as needing regeneration.

The work queue reads and demuxes the selected source using mp4box.js, decodes
the interval with WebCodecs, and uploads frames through binary Tauri IPC.
Frames are limited to the model's 24 fps cadence and a 768-pixel longest edge.
Only a small decoder batch is retained in the webview. The current Slopfab
API accepts host pixels, so this boundary requires readback; it does not
provide GPU texture interop. Slopfab copies pixels into its reference handle
and retains immutable snapshots when requests attach them. Optional mono or
stereo sound is decoded by the webview, trimmed, and sent as interleaved
float32 PCM. No FFmpeg is used.

Prepared native handles exist only during queued work. Completion, failure,
and cancellation release them; handles and decoded media are never written
into project JSON. Old DLLs fail with an explicit update message when their
video-reference symbols are absent.
