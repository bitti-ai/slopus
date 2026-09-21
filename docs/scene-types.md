# Scene types

The Scene panel saves a type on each scene:

- **First & Last Frame** keeps the existing shot descriptions, speech, Look, sound, music and optional frame anchors. Older scenes without a type use this type.
- **Animate** uses an Animate generator, one driving video and one repainted scene frame. It does not send a text prompt.
- **Character Replace** gives each shot a source video selector, a new character reference selector and an optional description identifying the character to replace. The character reference must contain an image. Blank target descriptions mean the main character.
- **Extend** takes a source video in the Scene panel and uses the shot descriptions as the continuation prompt.
- **Bridge** takes start and end video references in the Scene panel and uses the shot descriptions as the prompt for the connecting segment.

Character Replace sends only references selected by its shots, in project order. Frame anchors, continuation, old action text and style settings are inactive in this mode. Switching back retains the shot descriptions and character selections. The video reference's saved trim and soundtrack setting apply to generation.

The generated prompt follows the [MiniMax H3 full-reference guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md): six sections, a video-editing task prefix, independently numbered image/video/audio payloads, and explicit retention instructions. It replaces the target's appearance while retaining motion, timing, camera work, environment and other characters. Character images define the replacement identity rather than anchoring a frame. Enabled soundtracks are reused in the corresponding shots.

Generation requires both references for every shot and respects the existing limits of three video references, nine images and 15 seconds of total video reference material. The generator picker still selects the active engine for the queue: incompatible scenes are excluded from Generate All. Changing a scene type selects a compatible downloaded generator when one is available. Character Replace requires reference-capable MiniMax weights, such as References or Singularity; known First/Last Frame weights are rejected.

Extend and Bridge require reference-capable weights and SlopFab API 1.14. The app decodes the selected reference ranges with WebCodecs. At generation time the runtime encodes the start video's last 22 frames into VAE latents at the project canvas. Bridge also encodes the end video's first 22 frames. These guides share the generated segment's spatial coordinates and sit immediately before/after it in the model's temporal coordinates. The encoded boundaries use the existing reference cache. No source latent files or FFmpeg decoding are required.

Each source range must contain at least 22 frames at 24 fps (0.917 seconds); ranges still share the 15-second video-reference budget. Start/end ordering is independent of library order. Frame anchors, previous-scene continuation and other references are inactive in these modes. Sound and speech are generated from the prompt; source soundtracks are not copied. Scene length controls only the new segment, which is the only video added to the timeline. Add the source clips on either side when arranging the complete sequence.
