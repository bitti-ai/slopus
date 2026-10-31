# Slopus — 0.4.0

Changes since 0.3.2.

## What's new

- **Image generators:** MOSS Image, Fibo 2.0 Base/Edit Turbo, and Krea 2 Turbo/Raw, with model-specific guidance, negative prompts and editing controls.
- **Music:** YuE2 and MiniMax Music3 generation, folders, drafts, continuous playback and timeline audio. Export WAV, MP3, FLAC, AAC/M4A or Opus/WebM/Ogg.
- **Album covers:** Generate artwork from a song’s context menu using a dedicated generator selected under Settings → Generators → Icons.
- **Video library:** Organize Videos → Scenes → Shots, play scenes together, split songs into scenes, and share prompts and timed references. Videos can override project Look and resolution settings, and dependent scenes can be queued together. Cancelling a generation also cancels its downstream dependents while preserving earlier generations.
- **Scene takes:** Keep up to four takes plus a draft, restore settings, choose the primary take, and upscale saved takes by 1.5×, 2× or 4×. Non-primary takes can be removed during generation.
- **Single Shot:** Continue with Context and Previous video anchors, optional generated endings, improved overlap joining and consistent Tone. Context guidance now matches the original anchor to reduce appearance degradation across continuations. Use Bridge for new connections instead of Long Shot.
- **Motions and agents:** Create editable JavaScript animations for the timeline or references. Agents can inspect media frames, generate music and sync Motions to audio.
- **Image editing:** Combine or subtract lasso selections, queue batches of up to 100 images, and edit bounded regions of larger images while preserving their original resolution.
- **Live previews:** Watch MiniMax H3 video and image generation in the editor. Cancelling a video generation saves its latest available preview as the Take's video. Optional TAEH3 preview weights are available in Settings.
- **Generation effects:** LCS color steering, tone, sharpness and color stabilization, with step ranges and optional regions.
- **Generator controls:** Compatible sampler/scheduler choices, including ER-SDE and Beta; global LoRAs, application ordering, scene overrides, Pika H3 Flex and Hyperflow 8-Step adapters.
- **Generator selection:** Video, image and music remember separate active generators. Saved takes show the used seed and generator, with a button to select that generator again.
- **Speech languages:** Set custom speech languages for shots.
- **Model downloads:** Shared H3 VAEs and text encoders, including Sol H3 VAE; VRAM compatibility warnings; Music3 INT8, FP16 and FP32 variants; updated FastH3 Omni weights.

## Fixes and improvements

- Improved video playback, thumbnails and Back navigation.
- Video folders stack vertically beside video cards in grid view.
- The Timeline scene list browses video folders and videos, with Back as the first item inside each.
- Clicking empty space in the video or music library clears the selection.
- Image edits preserve their sources and settings. Generator lists and inspector controls are more compact and consistently ordered.
- Corrected First/Last Frame prompts, cached VAE checks across restarts and fixed AppImage launcher permissions.

- Update LAN workers alongside the app.
