**Stack:** Tauri 2.0 (Rust backend), React/TS (UI), WebCodecs (Media), WebGPU (Rendering).

1. **Demux:** `mp4box.js` extracts raw chunks from `.mp4`.
2. **Decode:** WebCodecs `VideoDecoder` uses OS hardware to decode chunks to `VideoFrame`.
3. **Process:** WebGPU imports `VideoFrame` (`importExternalTexture`) for **zero-copy** GPU shader processing.
4. **Encode:** WebCodecs `VideoEncoder` hardware-compresses processed frames into chunks.
5. **Mux:** `mp4-muxer` packages chunks into a final `.mp4`.

* **Performance:** Frames stay in VRAM. Has to support smooth scrubbing.
* **No FFmpeg:** Escapes GPL/LGPL licensing complications.

Commit often with short messages.

