use super::{config::Configuration, ffi};
use crate::project::ProviderSetting;
use std::{
    collections::{BTreeMap, HashMap},
    sync::{atomic::Ordering, Arc, Mutex},
};

// A video owns its DLL and input buffers. Commands serialize mutations; the
// C API retains immutable snapshots when a plan/generation attaches a video.
#[derive(Clone, Default)]
pub struct ReferenceVideos {
    pub(super) videos: Arc<Mutex<HashMap<String, ffi::ReferenceVideoHandle>>>,
    next: Arc<std::sync::atomic::AtomicU64>,
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
