# Slopus — 0.4.0

Changes since 0.3.2.

## What's new

- **Image generators:** MOSS Image, Fibo 2.0 Base/Edit Turbo, and Krea 2 Turbo/Raw, with model-specific guidance, negative prompts and editing controls.
- **Music:** YuE2 and MiniMax Music3 generation, folders, drafts, continuous playback and timeline audio. Export WAV, MP3, FLAC, AAC/M4A or Opus/WebM/Ogg.
- **Album covers:** Generate artwork from a song’s context menu or the AI agent using a dedicated generator selected under Settings → Generators → Icons. The playback bar shows the current song’s cover, with a music-note placeholder when absent.
- **Video library:** Organize Videos → Scenes → Shots, play scenes together, split songs into scenes, and share prompts and timed references. Videos can override project Look and resolution settings, and dependent scenes can be queued together. Cancelling a generation also cancels its downstream dependents while preserving earlier generations.
- **Scene takes:** Keep up to four takes plus a draft, restore settings, choose the primary take, and upscale saved takes by 1.5×, 2× or 4×. Non-primary takes can be removed during generation.
- **Single Shot:** Continue with Context and Previous video anchors, optional generated endings, improved overlap joining and consistent Tone. Context guidance now matches the original anchor to reduce appearance degradation across continuations. Use Bridge for new connections instead of Long Shot.
- **Motions and agents:** Create editable JavaScript animations for the timeline or references. Agents can inspect media frames, generate music, assign generated songs as Video audio references and sync Motions to audio.
- **Image editing:** Combine or subtract lasso selections, queue batches of up to 100 images, and edit bounded regions of larger images while preserving their original resolution.
- **Live previews:** Watch MiniMax H3 video and image generation in the editor. Cancelling a video generation saves its latest available preview as the Take's video. Optional TAEH3 preview weights are available in Settings.
- **Generation effects:** LCS color steering, tone, sharpness and color stabilization, with step ranges and optional regions. LCS Drift adds configurable highlight compression and learned drift correction using an imported scene calibration, including on LAN workers.
- **Generator controls:** Compatible sampler/scheduler choices, including ER-SDE and Beta; global LoRAs, application ordering, scene overrides, Pika H3 Flex and Hyperflow 8-Step adapters.
- **Generator selection:** Video, image and music remember separate active generators. Saved takes show the used seed and generator, with a button to select that generator again.
- **Speech languages:** Set custom speech languages for shots.
- **Model downloads:** Shared H3 VAEs and text encoders, including Sol H3 VAE; VRAM compatibility warnings; Music3 INT8, FP16 and FP32 variants; updated FastH3 Omni weights.

## Fixes and improvements

- On first launch after updating, each recent project gets a one-time cleanup of orphaned generated media, latents and caches. Other projects receive the cleanup when first opened; files still referenced by the project are preserved.
- Saving now deletes unused files from replaced video takes and removed video, image and music generations, including latents and derived caches. Files still used by timeline clips, references or other generations are preserved; saved deletions cannot be undone.
- Fixed a Windows file-sharing error when Minimax reads a cropped image-edit reference.
- Local image edits now generate only the selected bounding box or lasso bounds, padded to multiples of 32, and merge into the original image without changing surrounding pixels.
- Generate's dropdown arrow now shares its neutral disabled colors while keeping available upscale actions accessible.
- Single Shot with Context video now matches the two-minute Keystone/Capstone test's fully locked 22-frame overlap, preserving earlier video and audio instead of regenerating their tail.
- Corrected Motion thumbnail sizing and title/duration alignment in the Timeline's list and grid layouts.
- Send additional agent messages while it is working; queued messages join its context when the current call or generation finishes.
- Limited generation progress updates to keep music playback controls responsive during song generation.
- Unavailable Generate buttons use a neutral background with readable text in both themes.
- Improved video playback, thumbnails and Back navigation.
- Video folders stack vertically beside video cards in grid view.
- The Timeline scene list browses video folders and videos, with Back as the first item inside each.
- A dedicated Timeline Motions tab creates empty Motions and browses existing ones for dragging onto tracks.
- Timeline preview selection follows the clip's displayed bounds, with correct move and resize gestures for portrait projects.
- Clicking empty space in the video or music library clears the selection.
- Image edits preserve their sources and settings. Generator lists and inspector controls are more compact and consistently ordered.
- Corrected First/Last Frame prompts, cached VAE checks across restarts and fixed AppImage launcher permissions.

- Update LAN workers alongside the app.
