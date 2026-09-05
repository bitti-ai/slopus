//! What a finished generation leaves behind, between slopfab and the encoder.
//!
//! slopfab hands back raw pictures — planar RGB floats, one channel after
//! another, with every frame of a channel contiguous — and frees them when the
//! generation handle is destroyed. Nothing in this process can turn those into
//! an MP4: encoding is the webview's job, because WebCodecs owns the OS encoder
//! and Slopus ships no FFmpeg by design (see docs/architecture.md, and
//! CLAUDE.md on the licensing reason).
//!
//! So this module is the hand-off. It keeps the finished generation handle
//! alive, asks slopfab to convert only the frame the webview currently needs,
//! and releases the handle after WebCodecs has encoded and muxed the file.
//!
//! ## What this costs
//!
//! Only one RGBA frame is allocated per IPC request. Slopfab's decoded planar
//! floats remain owned by its generation handle, avoiding the former second
//! whole-video allocation and eager conversion pass.
//!
//! [`CAPACITY`] is what stops that growing without limit.

use std::{
    collections::VecDeque,
    sync::{LazyLock, Mutex},
};

/// How many finished renders may wait for the webview at once.
///
/// The queue is serial and the webview claims a render as soon as the event
/// announcing it lands, so one is the normal number and two is slack for a
/// window that was busy. Beyond that the OLDEST is dropped — its frames are
/// gone and the scene has to be rendered again. That is the honest trade: the
/// alternative is a process that grows by a gigabyte per abandoned render until
/// the machine gives out.
const CAPACITY: usize = 2;

pub trait FrameSource: Send {
    fn frame_rgba(&self, index: u32, width: u32, height: u32) -> Result<Vec<u8>, String>;
}

/// A finished render whose slopfab source is kept alive until encoding ends.
pub struct RenderedVideo {
    pub job_id: String,
    pub width: u32,
    pub height: u32,
    pub frame_count: u32,
    pub fps: f64,
    source: Box<dyn FrameSource>,
    /// Interleaved samples, as slopfab returned them.
    audio: Vec<f32>,
    pub audio_channels: u32,
    pub audio_sample_rate: u32,
}

impl RenderedVideo {
    /// One frame's pixels, converted on demand, or None past the last frame.
    pub fn frame(&self, index: u32) -> Result<Option<Vec<u8>>, String> {
        if index >= self.frame_count {
            return Ok(None);
        }
        self.source
            .frame_rgba(index, self.width, self.height)
            .map(Some)
    }

    /// The soundtrack as little-endian f32 bytes, which is what the webview's
    /// `Float32Array` reads without a conversion of its own.
    pub fn audio_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(self.audio.len() * 4);
        for sample in &self.audio {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }
}

/// How the floats slopfab returns map onto 0–255.
///
/// The C API documents the layout (planar RGB) but not the range, and the two
/// conventions a decoder can use — 0…1 and −1…1 — differ by a factor of two and
/// an offset. Getting it wrong is not subtle: a signed picture read as unsigned
/// is blown-out and half black. So it is READ off the pictures rather than
/// assumed, from the first frame, which is the smallest sample that can settle
/// it: a picture with any meaningfully negative value cannot be 0…1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg(test)]
pub enum Range {
    /// 0.0 is black, 1.0 is white.
    Unit,
    /// −1.0 is black, 1.0 is white.
    Signed,
}

#[cfg(test)]
impl Range {
    /// Anything below this is a negative the 0…1 convention has no room for.
    /// Not zero, because a decoder that clamps at zero still lands a whisker
    /// under it now and then.
    const NEGATIVE: f32 = -0.02;

    pub fn of(sample: &[f32]) -> Self {
        if sample.iter().any(|value| *value < Self::NEGATIVE) {
            Self::Signed
        } else {
            Self::Unit
        }
    }

    fn to_byte(self, value: f32) -> u8 {
        // NaN maps to black rather than to whatever `as u8` does with it, which
        // is 0 on every target Rust supports but is not something to lean on.
        if value.is_nan() {
            return 0;
        }
        let unit = match self {
            Self::Unit => value,
            Self::Signed => (value + 1.0) / 2.0,
        };
        (unit.clamp(0.0, 1.0) * 255.0).round() as u8
    }
}

/// Turns slopfab's planar float pictures into the RGBA the webview can encode.
///
/// The C API declares the layout as `[channels][frames][height][width]`: all
/// red frames first, then all green frames, then all blue frames. In
/// particular, it is not `[frames][channels][height][width]`. Treating it as
/// frame-major makes an RGB render look like the same third-length motion clip
/// played three times, once from each channel plane.
///
/// One channel is greyscale and is written to all three; more than three means
/// the first three are the colour and the rest is not ours to interpret.
#[cfg(test)]
pub fn rgba_from_planar(
    video: &[f32],
    frame_count: u32,
    width: u32,
    height: u32,
    channels: u32,
) -> Result<Vec<u8>, String> {
    let (frames, width_px, height_px, planes) = (
        frame_count as usize,
        width as usize,
        height as usize,
        channels as usize,
    );
    if frames == 0 || width_px == 0 || height_px == 0 || planes == 0 {
        return Err("The render returned no pictures.".to_string());
    }
    let pixels = width_px * height_px;
    let expected = frames
        .checked_mul(planes)
        .and_then(|value| value.checked_mul(pixels))
        .ok_or_else(|| "The render's dimensions do not fit in memory.".to_string())?;
    if video.len() < expected {
        return Err(format!(
            "The render says it has {frames} frames of {width_px}×{height_px}×{planes}, which is {expected} values, but only {} came back.",
            video.len()
        ));
    }
    let channel_stride = frames * pixels;
    let range = if (0..planes).any(|channel| {
        let start = channel * channel_stride;
        Range::of(&video[start..start + pixels]) == Range::Signed
    }) {
        Range::Signed
    } else {
        Range::Unit
    };
    let mut rgba = vec![255u8; frames * pixels * 4];
    for frame in 0..frames {
        let frame_offset = frame * pixels;
        let red = &video[frame_offset..frame_offset + pixels];
        let green = if planes >= 2 {
            &video[channel_stride + frame_offset..channel_stride + frame_offset + pixels]
        } else {
            red
        };
        let blue = if planes >= 3 {
            &video[2 * channel_stride + frame_offset..2 * channel_stride + frame_offset + pixels]
        } else {
            red
        };
        let out = &mut rgba[frame * pixels * 4..(frame + 1) * pixels * 4];
        for pixel in 0..pixels {
            out[pixel * 4] = range.to_byte(red[pixel]);
            out[pixel * 4 + 1] = range.to_byte(green[pixel]);
            out[pixel * 4 + 2] = range.to_byte(blue[pixel]);
            // Alpha was filled with 255 up front; a generated frame is opaque.
        }
    }
    Ok(rgba)
}

/// Builds the hand-off around a source that owns the finished slopfab handle.
#[allow(clippy::too_many_arguments)]
pub fn from_source(
    job_id: &str,
    source: Box<dyn FrameSource>,
    audio: &[f32],
    frame_count: u32,
    width: u32,
    height: u32,
    channels: u32,
    video_float_count: usize,
    fps: f64,
    audio_channels: u32,
    audio_sample_rate: u32,
) -> Result<RenderedVideo, String> {
    let expected_video_values = (frame_count as usize)
        .checked_mul(width as usize)
        .and_then(|value| value.checked_mul(height as usize))
        .and_then(|value| value.checked_mul(channels as usize))
        .ok_or_else(|| "The render's dimensions do not fit in memory.".to_string())?;
    if frame_count == 0 || width == 0 || height == 0 || channels != 3 {
        return Err(format!(
            "The render returned {frame_count} frames of {width}x{height}x{channels}."
        ));
    }
    if video_float_count < expected_video_values {
        return Err(format!(
            "The decoded video needs {expected_video_values} values but only {video_float_count} came back."
        ));
    }
    if !audio.is_empty()
        && (audio_channels == 0
            || audio_sample_rate == 0
            || audio.len() % audio_channels as usize != 0)
    {
        return Err(format!(
            "The render returned {} audio samples with {audio_channels} channels at {audio_sample_rate} Hz.",
            audio.len()
        ));
    }
    Ok(RenderedVideo {
        job_id: job_id.to_string(),
        width,
        height,
        frame_count,
        fps,
        source,
        audio: audio.to_vec(),
        audio_channels,
        audio_sample_rate,
    })
}

#[cfg(test)]
struct OwnedRgba(Vec<u8>);

#[cfg(test)]
impl FrameSource for OwnedRgba {
    fn frame_rgba(&self, index: u32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        let size = width as usize * height as usize * 4;
        let start = index as usize * size;
        self.0
            .get(start..start + size)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| format!("Frame {index} is outside the owned test video."))
    }
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn from_output(
    job_id: &str,
    video: &[f32],
    audio: &[f32],
    frame_count: u32,
    width: u32,
    height: u32,
    channels: u32,
    fps: f64,
    audio_channels: u32,
    audio_sample_rate: u32,
) -> Result<RenderedVideo, String> {
    let rgba = rgba_from_planar(video, frame_count, width, height, channels)?;
    from_source(
        job_id,
        Box::new(OwnedRgba(rgba)),
        audio,
        frame_count,
        width,
        height,
        channels,
        video.len(),
        fps,
        audio_channels,
        audio_sample_rate,
    )
}

static WAITING: LazyLock<Mutex<VecDeque<RenderedVideo>>> = LazyLock::new(Default::default);

/// Puts a finished render where the webview can fetch it. Returns what had to
/// be dropped to make room, so the caller can say so rather than let a render
/// disappear quietly.
pub fn keep(video: RenderedVideo) -> Option<String> {
    let Ok(mut waiting) = WAITING.lock() else {
        return None;
    };
    // A second run of the same scene replaces the first: the frames the user
    // wants are the ones they just watched being made.
    waiting.retain(|held| held.job_id != video.job_id);
    waiting.push_back(video);
    if waiting.len() > CAPACITY {
        return waiting.pop_front().map(|dropped| dropped.job_id);
    }
    None
}

/// Reads something out of one waiting render. Nothing is copied for a job that
/// is not there — the answer is None and the caller says so.
fn with<T>(job_id: &str, read: impl FnOnce(&RenderedVideo) -> T) -> Option<T> {
    let waiting = WAITING.lock().ok()?;
    waiting.iter().find(|held| held.job_id == job_id).map(read)
}

pub fn frame(job_id: &str, index: u32) -> Result<Option<Vec<u8>>, String> {
    let waiting = WAITING
        .lock()
        .map_err(|_| "Finished-render lock failed.".to_string())?;
    match waiting.iter().find(|held| held.job_id == job_id) {
        Some(video) => video.frame(index),
        None => Ok(None),
    }
}

pub fn audio(job_id: &str) -> Option<Vec<u8>> {
    with(job_id, RenderedVideo::audio_bytes)
}

/// What the webview needs before it can encode: the shape of the pictures it is
/// about to ask for, one at a time, and how much sound came with them.
///
/// Read from the STORE rather than from the event that announced the render.
/// The event is a notification — it can be missed, it can arrive at a window
/// that is reloading — and the only authority on what can still be encoded is
/// what is still held.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedSummary {
    pub job_id: String,
    pub width: u32,
    pub height: u32,
    pub frame_count: u32,
    pub fps: f64,
    pub audio_channels: u32,
    pub audio_sample_rate: u32,
    /// Interleaved samples across every channel, so an empty soundtrack is
    /// distinguishable from one that has not been read yet.
    pub audio_samples: u32,
}

pub fn summary(job_id: &str) -> Option<RenderedSummary> {
    with(job_id, |video| RenderedSummary {
        job_id: video.job_id.clone(),
        width: video.width,
        height: video.height,
        frame_count: video.frame_count,
        fps: video.fps,
        audio_channels: video.audio_channels,
        audio_sample_rate: video.audio_sample_rate,
        audio_samples: video.audio.len() as u32,
    })
}

/// Hands the memory back. Called when the webview has written the file, and
/// when it has given up on writing it — a render nobody can encode is still a
/// gigabyte nobody should be holding.
pub fn release(job_id: &str) -> bool {
    let Ok(mut waiting) = WAITING.lock() else {
        return false;
    };
    let before = waiting.len();
    waiting.retain(|held| held.job_id != job_id);
    waiting.len() != before
}

#[cfg(test)]
mod tests {
    use super::*;

    fn planar(
        frames: usize,
        width: usize,
        height: usize,
        channels: usize,
        value: impl Fn(usize) -> f32,
    ) -> Vec<f32> {
        (0..frames * channels * width * height).map(value).collect()
    }

    #[test]
    fn planes_become_pixels_in_the_right_order() {
        // One 2×1 frame: red plane, then green, then blue.
        let video = vec![
            1.0, 0.0, /* R */ 0.0, 1.0, /* G */ 0.0, 0.0, /* B */
        ];
        let rgba = rgba_from_planar(&video, 1, 2, 1, 3).unwrap();
        assert_eq!(rgba, vec![255, 0, 0, 255, 0, 255, 0, 255]);
    }

    #[test]
    fn channel_major_frames_are_not_read_as_repeated_temporal_blocks() {
        // [R0, R1, G0, G1, B0, B1], exactly as slopfab's C API returns it.
        // Distinct channels and frames make a channel/frame transposition
        // visible instead of letting a greyscale fixture hide it.
        let video = vec![0.1, 0.4, 0.2, 0.5, 0.3, 0.6];
        let rgba = rgba_from_planar(&video, 2, 1, 1, 3).unwrap();
        assert_eq!(rgba, vec![26, 51, 77, 255, 102, 128, 153, 255]);
    }

    #[test]
    fn a_signed_picture_is_recognised_and_shifted_rather_than_clipped() {
        // −1…1: mid grey is 0.0 here and would read as black on the 0…1 rule.
        assert_eq!(Range::of(&[-1.0, 0.0, 1.0]), Range::Signed);
        let video = vec![-1.0, 0.0, 1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 1.0];
        let rgba = rgba_from_planar(&video, 1, 3, 1, 3).unwrap();
        assert_eq!(
            &rgba[..12],
            &[0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]
        );
    }

    #[test]
    fn a_unit_picture_keeps_its_own_scale() {
        assert_eq!(Range::of(&[0.0, 0.5, 1.0]), Range::Unit);
        let video = vec![0.0, 0.5, 1.0, 0.0, 0.5, 1.0, 0.0, 0.5, 1.0];
        let rgba = rgba_from_planar(&video, 1, 3, 1, 3).unwrap();
        assert_eq!(
            &rgba[..12],
            &[0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]
        );
    }

    #[test]
    fn out_of_range_and_not_a_number_land_inside_the_byte() {
        let video = vec![
            2.0,
            f32::NAN,
            -0.001,
            2.0,
            f32::NAN,
            -0.001,
            2.0,
            f32::NAN,
            -0.001,
        ];
        let rgba = rgba_from_planar(&video, 1, 3, 1, 3).unwrap();
        assert_eq!(
            &rgba[..12],
            &[255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255]
        );
    }

    #[test]
    fn one_plane_is_greyscale_rather_than_a_red_picture() {
        let rgba = rgba_from_planar(&[0.5], 1, 1, 1, 1).unwrap();
        assert_eq!(rgba, vec![128, 128, 128, 255]);
    }

    #[test]
    fn a_short_buffer_is_refused_rather_than_read_past_its_end() {
        let video = planar(2, 4, 4, 3, |_| 0.5);
        assert!(rgba_from_planar(&video, 3, 4, 4, 3).is_err());
        assert!(rgba_from_planar(&video, 2, 4, 4, 3).is_ok());
        assert!(rgba_from_planar(&[], 0, 4, 4, 3).is_err());
    }

    #[test]
    fn malformed_interleaved_audio_is_refused_at_the_handoff() {
        assert!(from_output(
            "bad-audio",
            &[0.5, 0.5, 0.5],
            &[0.1, 0.2, 0.3],
            1,
            1,
            1,
            3,
            24.0,
            2,
            32_000
        )
        .is_err());
        assert!(from_output(
            "bad-rate",
            &[0.5, 0.5, 0.5],
            &[0.1, 0.2],
            1,
            1,
            1,
            3,
            24.0,
            2,
            0
        )
        .is_err());
    }

    fn sample(job_id: &str) -> RenderedVideo {
        from_output(
            job_id,
            &[0.5, 0.5, 0.5],
            &[0.25, -0.25],
            1,
            1,
            1,
            3,
            24.0,
            2,
            48_000,
        )
        .unwrap()
    }

    #[test]
    fn a_render_is_held_until_it_is_released() {
        release("held");
        assert!(frame("held", 0).unwrap().is_none());
        keep(sample("held"));
        assert_eq!(frame("held", 0).unwrap().unwrap(), vec![128, 128, 128, 255]);
        assert_eq!(
            summary("held").unwrap(),
            RenderedSummary {
                job_id: "held".into(),
                width: 1,
                height: 1,
                frame_count: 1,
                fps: 24.0,
                audio_channels: 2,
                audio_sample_rate: 48_000,
                audio_samples: 2
            },
        );
        // Past the last frame is an absence, not a panic and not a short read.
        assert!(frame("held", 1).unwrap().is_none());
        // f32 little-endian, which is what the webview reads it back as.
        assert_eq!(
            audio("held").unwrap(),
            0.25f32
                .to_le_bytes()
                .iter()
                .chain(&(-0.25f32).to_le_bytes())
                .copied()
                .collect::<Vec<u8>>()
        );
        assert!(release("held"));
        assert!(!release("held"));
        assert!(frame("held", 0).unwrap().is_none());
    }

    #[test]
    fn a_second_run_of_one_scene_replaces_the_first() {
        release("same");
        keep(sample("same"));
        keep(sample("same"));
        assert!(release("same"));
        assert!(!release("same"), "one job may only ever hold one render");
    }

    #[test]
    fn the_oldest_render_is_dropped_rather_than_the_process_growing_without_limit() {
        for id in ["cap-1", "cap-2", "cap-3"] {
            release(id);
        }
        assert_eq!(keep(sample("cap-1")), None);
        assert_eq!(keep(sample("cap-2")), None);
        // Whatever else is waiting from another test, pushing past the cap
        // reports what it evicted rather than losing it silently.
        let evicted = keep(sample("cap-3"));
        assert!(evicted.is_some());
        for id in ["cap-1", "cap-2", "cap-3"] {
            release(id);
        }
    }
}
