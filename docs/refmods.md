# Reference files and refmods

In References, select a reference and choose **Add file**. The same picker accepts
PNG, JPEG, WebP, MP4/M4V/MOV video, and standalone H3 refmod `.safetensors` files.
Multiple images and refmods can be attached together with one video. Adding a
video replaces that reference's existing video; other attachments remain.
Images are copied into the project. Videos and refmods stay at their original
locations, preserving access to any same-stem refmod metadata `.json` sidecar.
While refmods are attached, the prompt and **Add file** controls are disabled.
Use the trash icon beside **Refmods** to remove them and unlock those controls.
Existing prompts and other attachments are preserved.

Refmods contain pre-encoded image, video, or audio reference latents. They are
separate from LoRA weight adapters. Each refmod has **Strength** (0–1, default 1)
and **Copies** (1–10, default 1). Strength 0 disables it. More copies increase
the packed sequence size and GPU memory usage. The paths, strengths, copies,
and attachment order are saved in the project and captured in scene generation
snapshots. Refmods follow ordinary references in native requests and consume
neither Picture/Video labels nor Qwen vision tokens. Their metadata descriptions
and trigger words are not automatically inserted into the prompt.

The generation button in the corner of the normal icon slot creates an icon
with all enabled refmods on that reference active, even without a written
description. Other references in the
project are not attached. Editing or removing its refmods invalidates its icon;
an in-flight icon made with older settings is not attached. Existing icon queue,
cancellation, and project persistence behavior applies.

Refmods require a Ref2VA generator and a SlopFab DLL exposing the 1.8 refmod API.
Both CUDA and Vulkan use the same attachment path. SlopFab validates the tensors
and metadata, reporting incompatible files or bundles. Older DLLs remain usable
without refmods and give an explicit compatibility error when an enabled refmod
is submitted. Slopus does not train, pool, or optimize refmods.

## Exporting a reference as a refmod

Select a reference in References and choose **Export refmod** in the command
bar, or **Export as refmod…** in its context menu, then pick where to save the
`.safetensors` file. The export encodes the reference's own media with the
selected generator's video and audio VAEs: up to nine images, its video clip
(using the saved trim, with the soundtrack when **Include sound** is on), or
its sound clip. Text-only references and references that already use refmods
cannot be exported. The prompt is stored only as the file's description.

One image, a silent clip or a sound gives a standalone refmod. Several items
give a version-5 bundle: images first, then the clip and its soundtrack.
Frames-mode video references export their selected stills. Latents are saved
as F32 at SlopFab's native reference size (768-pixel short edge), without
pooling or refinement.

The export is a work queue item, so it waits behind running generations. It
cannot be cancelled once encoding starts. It needs SlopFab API 1.18, a
floating-point video VAE for images and video, and a floating-point audio VAE
for sound; no transformer or text encoder is loaded. With a LAN worker
selected, the worker encodes and the file is saved on this computer. Only the
VAEs and the reference's media are sent to it.

Attach the exported file to any reference with **Add file**.
