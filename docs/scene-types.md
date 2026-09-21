# Scene types

The Scene panel saves a type on each scene:

- **First & Last Frame** keeps the existing shot descriptions, speech, Look, sound, music and optional frame anchors. Older scenes without a type use this type.
- **Animate** uses an Animate generator, one driving video and one repainted scene frame. It does not send a text prompt.
- **Character Replace** gives each shot a source video selector, a new character reference selector and an optional description identifying the character to replace. The character reference must contain an image. Blank target descriptions mean the main character.

Character Replace sends only references selected by its shots, in project order. Frame anchors, continuation, old action text and style settings are inactive in this mode. Switching back retains the shot descriptions and character selections. The video reference's saved trim and soundtrack setting apply to generation.

The generated prompt follows the [MiniMax H3 full-reference guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md): six sections, a video-editing task prefix, independently numbered image/video/audio payloads, and explicit retention instructions. It replaces the target's appearance while retaining motion, timing, camera work, environment and other characters. Character images define the replacement identity rather than anchoring a frame. Enabled soundtracks are reused in the corresponding shots.

Generation requires both references for every shot and respects the existing limits of three video references, nine images and 15 seconds of total video reference material. The generator picker still selects the active engine for the queue: incompatible scenes are excluded from Generate All. Changing a scene type selects a compatible downloaded generator when one is available. Character Replace requires reference-capable MiniMax weights, such as References or Singularity; known First/Last Frame weights are rejected.
