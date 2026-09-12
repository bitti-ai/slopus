# Video references

In **References**, choose **Import video**, or **Add video** on an existing
reference. MP4, M4V, and MOV containers are accepted; the computer's WebCodecs
decoder must support the video codec. Video files remain at their original
locations. The project stores their paths and clip settings.

Set the clip's start and duration, and choose whether to include its sound.
Each clip must last 2–15 seconds. A generation can use up to three video clips
totaling 15 seconds, alongside up to nine images. Cite the reference in a shot
just like an image reference. Use CUDA and a Ref2VA transformer, such as the
**References** generator. Soundtracks also require audio VAE encoder weights.

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
