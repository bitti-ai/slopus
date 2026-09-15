# Video references

## Animate

Download **Animate** in Settings → Generators, then select it in the Generator.
Choose a **Reference video** in the scene inspector. Animate requires a video
and sends an empty text prompt; shot descriptions, look, sound and music prompts
are not used. Video trim and soundtrack settings still come from References.

The template uses `Viggle-Animate-pruned_rank8_int8_convrot.safetensors` and
`viggle_animate_distillation_bf16.safetensors` from DeepBeepMeep/MiniMax-H3.
The enabled distillation LoRA has a **4-step override**, which takes precedence
over the scene's step count. Existing installations receive the template once
without replacing their default generator or local model paths.

This uses the DLL's generic H3 reference-generation API with the Viggle
checkpoint. Its shared text encoder and video/audio VAEs are still required.
It does not reproduce upstream Viggle's frozen-embedding character-replacement
pipeline. Planning is tested on both CUDA and Vulkan; rendered animation quality
requires a run with the downloaded weights and a compatible GPU.

## Adding video references

In **References**, choose **Add a reference → Other → New** to create an
**Uncategorized** reference, then choose **Add file** in its details. Video
can also be attached to an existing reference. The reference card shows the
video's first source frame, including after reopening the project; replacing
the video updates the icon. MP4, M4V, and MOV containers are accepted; the computer's WebCodecs
decoder must support the video codec. Video files remain at their original
locations. The project stores their paths and clip settings.

Set the clip's start and duration, and choose whether to include its sound.
Each clip must last 2–15 seconds. A generation can use up to three video clips
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
