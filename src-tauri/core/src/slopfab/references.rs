use super::{config::Configuration, ffi};
use crate::settings::ProviderSetting;
use std::{
    collections::{BTreeMap, HashMap},
    sync::{atomic::Ordering, Arc, Mutex},
};

// A video owns its DLL and input buffers. Commands serialize mutations; the
// C API retains immutable snapshots when a plan/generation attaches a video.
#[derive(Clone, Default)]
pub struct ReferenceVideos {
    pub(super) videos: Arc<Mutex<HashMap<String, ffi::ReferenceVideoHandle>>>,
    pub(super) audios: Arc<Mutex<HashMap<String, Arc<ReferenceAudio>>>>,
    next: Arc<std::sync::atomic::AtomicU64>,
}

/// Decoded standalone reference audio. The C API copies the samples when a
/// request adds them, so the registry only keeps them until release.
pub struct ReferenceAudio {
    pub samples: Vec<f32>,
    pub channels: i32,
    pub sample_rate: i32,
}

impl ReferenceVideos {
    pub fn create_reference_video(
        &self,
        duration: f64,
        settings: &BTreeMap<String, ProviderSetting>,
    ) -> Result<String, String> {
        let configuration = Configuration::from_settings(settings);
        let api = ffi::Api::load(&configuration.dll_path)?;
        api.version()?;
        let video = ffi::ReferenceVideoHandle::new(api, duration, configuration.dll_path)?;
        let mut videos = self
            .videos
            .lock()
            .map_err(|_| "Reference video lock failed.")?;
        if videos.len() >= 3 {
            return Err("At most three video references can be prepared at once.".into());
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed).to_string();
        videos.insert(id.clone(), video);
        Ok(id)
    }

    pub fn append_reference_video(
        &self,
        id: &str,
        bytes: &[u8],
        width: i32,
        height: i32,
        timestamp: f64,
    ) -> Result<(), String> {
        self.videos
            .lock()
            .map_err(|_| "Reference video lock failed.")?
            .get_mut(id)
            .ok_or("The prepared reference video no longer exists.")?
            .append(bytes, width, height, timestamp)
    }

    pub fn set_reference_video_audio(
        &self,
        id: &str,
        bytes: &[u8],
        channels: i32,
        sample_rate: i32,
    ) -> Result<(), String> {
        if bytes.len() % 4 != 0 {
            return Err("Reference audio must contain complete float32 samples.".into());
        }
        let samples: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
            .collect();
        self.videos
            .lock()
            .map_err(|_| "Reference video lock failed.")?
            .get_mut(id)
            .ok_or("The prepared reference video no longer exists.")?
            .set_audio(&samples, channels, sample_rate)
    }

    pub fn create_reference_audio(
        &self,
        bytes: &[u8],
        channels: i32,
        sample_rate: i32,
    ) -> Result<String, String> {
        if !(1..=2).contains(&channels) || sample_rate <= 0 {
            return Err("Reference audio must be mono or stereo with a positive sample rate.".into());
        }
        let samples = float_samples(bytes)?;
        if samples.is_empty() || samples.len() % channels as usize != 0 {
            return Err("Reference audio must contain complete sample frames.".into());
        }
        let mut audios = self
            .audios
            .lock()
            .map_err(|_| "Reference audio lock failed.")?;
        if audios.len() >= 3 {
            return Err("At most three audio references can be prepared at once.".into());
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed).to_string();
        audios.insert(
            id.clone(),
            Arc::new(ReferenceAudio {
                samples,
                channels,
                sample_rate,
            }),
        );
        Ok(id)
    }

    pub fn release_reference_audios(&self, ids: &[String]) -> Result<(), String> {
        let mut audios = self
            .audios
            .lock()
            .map_err(|_| "Reference audio lock failed.")?;
        for id in ids {
            audios.remove(id);
        }
        Ok(())
    }

    pub(super) fn reference_audio(&self, id: &str) -> Result<Arc<ReferenceAudio>, String> {
        self.audios
            .lock()
            .map_err(|_| "Reference audio lock failed.")?
            .get(id)
            .cloned()
            .ok_or_else(|| "The prepared reference audio no longer exists. Please retry generation.".into())
    }

    pub fn release_reference_videos(&self, ids: &[String]) -> Result<(), String> {
        let mut videos = self
            .videos
            .lock()
            .map_err(|_| "Reference video lock failed.")?;
        for id in ids {
            videos.remove(id);
        }
        Ok(())
    }
}

fn float_samples(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() % 4 != 0 {
        return Err("Reference audio must contain complete float32 samples.".into());
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
        .collect())
}
