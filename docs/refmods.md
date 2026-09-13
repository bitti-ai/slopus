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
is submitted. Slopus does not encode, train, or optimize refmods.
