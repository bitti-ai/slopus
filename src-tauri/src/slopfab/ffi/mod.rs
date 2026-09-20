mod handles;
mod raw;
#[cfg(test)]
mod tests;
pub use handles::{FinishedGeneration, GenerationHandle, ProgressSink};
pub use raw::{cuda_device_names, gpu_devices, has_cuda_device, Plan, Progress};
use std::{
    path::{Path, PathBuf},
    ptr::NonNull,
    sync::Arc,
};

#[derive(Clone)]
pub struct Api {
    inner: Arc<raw::Api>,
    path: PathBuf,
}
impl Api {
    pub fn load(path: &Path) -> Result<Self, String> {
        let inner = raw::Api::load(path)?;
        inner.version()?;
        Ok(Self {
            inner: Arc::new(inner),
            path: path.to_owned(),
        })
    }
    pub fn version(&self) -> Result<String, String> {
        self.inner.version()
    }
    pub fn set_cuda_version(&self, v: &str) -> Result<(), String> {
        self.inner.set_cuda_version(v)
    }
    pub fn cuda_loaded_major(&self) -> Result<i32, String> {
        self.inner.cuda_loaded_major()
    }
    pub fn clear_reused_models(&self) -> Result<(), String> {
        self.inner.clear_reused_models()
    }
    pub fn prepare_lora_grid(
        &self,
        path: &Path,
        width: i32,
        allow_download: bool,
    ) -> Result<(), String> {
        self.inner.prepare_lora_grid(path, width, allow_download)
    }
    #[cfg(test)]
    pub fn disable_lora_preparation_for_test(&mut self) {
        Arc::get_mut(&mut self.inner)
            .expect("configure API before creating handles")
            .disable_lora_preparation_for_test();
    }
    #[cfg(test)]
    pub fn disable_animate_for_test(&mut self) {
        Arc::get_mut(&mut self.inner)
            .expect("configure API before creating handles")
            .disable_animate_for_test();
    }
    #[cfg(test)]
    pub fn disable_motion_cache_for_test(&mut self) {
        Arc::get_mut(&mut self.inner)
            .expect("configure API before creating handles")
            .disable_motion_cache_for_test();
    }
    fn check(&self, r: &RequestHandle) -> Result<(), String> {
        if Arc::ptr_eq(&self.inner, &r.api.inner) {
            Ok(())
        } else {
            Err("Request belongs to a different runtime instance.".into())
        }
    }
    pub fn set_prompt(&self, r: &RequestHandle, v: &str) -> Result<(), String> {
        self.check(r)?;
        self.inner.set_prompt(r.pointer.as_ptr(), v)
    }
    pub fn set_animate(&self, r: &RequestHandle, preserve_audio: bool) -> Result<(), String> {
        self.check(r)?;
        self.inner.set_animate(r.pointer.as_ptr(), preserve_audio)
    }
    pub fn set_prompt_embedding(&self, r: &RequestHandle, path: &Path) -> Result<(), String> {
        self.check(r)?;
        self.inner.set_prompt_embedding(r.pointer.as_ptr(), path)
    }
    pub fn set_resolution(&self, r: &RequestHandle, w: i32, h: i32) -> Result<(), String> {
        self.check(r)?;
        self.inner.set_resolution(r.pointer.as_ptr(), w, h)
    }
    pub fn set_frames(&self, r: &RequestHandle, v: i32) -> Result<(), String> {
        self.check(r)?;
        self.inner.set_frames(r.pointer.as_ptr(), v)
    }
    pub fn set_still_image(&self, r: &RequestHandle) -> Result<(), String> {
        self.check(r)?;
        self.inner.set_still_image(r.pointer.as_ptr())
    }
    pub fn set_save_latents(&self, r: &RequestHandle, path: &Path) -> Result<(), String> {
        self.check(r)?;
        self.inner.set_save_latents(r.pointer.as_ptr(), path)
    }
    pub fn set_continuation_file(
        &self,
        r: &RequestHandle,
        path: &Path,
        overlap: i32,
    ) -> Result<(), String> {
        self.check(r)?;
        self.inner
            .set_continuation_file(r.pointer.as_ptr(), path, overlap)
    }
    pub fn set_steps(&self, r: &RequestHandle, v: i32) -> Result<(), String> {
        self.check(r)?;
        self.inner.set_steps(r.pointer.as_ptr(), v)
    }
    pub fn set_seed(&self, r: &RequestHandle, v: u64) -> Result<(), String> {
        self.check(r)?;
        self.inner.set_seed(r.pointer.as_ptr(), v)
    }
    pub fn set_verbose(&self, r: &RequestHandle, v: bool) -> Result<(), String> {
        self.check(r)?;
        self.inner.set_verbose(r.pointer.as_ptr(), v)
    }
    pub fn set_reuse_models(&self, r: &RequestHandle, v: bool) -> Result<(), String> {
        self.check(r)?;
        self.inner.set_reuse_models(r.pointer.as_ptr(), v)
    }
    pub fn set_attention(&self, r: &RequestHandle, v: &str) -> Result<(), String> {
        self.check(r)?;
        self.inner.set_attention(r.pointer.as_ptr(), v)
    }
    pub fn set_motion_cache(&self, r: &RequestHandle, enabled: bool) -> Result<(), String> {
        self.check(r)?;
        self.inner.set_motion_cache(r.pointer.as_ptr(), enabled)
    }
    pub fn set_inference_backend(&self, r: &RequestHandle, backend: i32) -> Result<(), String> {
        self.check(r)?;
        self.inner
            .set_inference_backend(r.pointer.as_ptr(), backend)
    }
    pub fn set_model(&self, r: &RequestHandle, id: i32, path: &Path) -> Result<(), String> {
        self.check(r)?;
        self.inner.set_model(r.pointer.as_ptr(), id, path)
    }
    pub fn add_reference(&self, r: &RequestHandle, path: &Path) -> Result<(), String> {
        self.check(r)?;
        self.inner.add_reference(r.pointer.as_ptr(), path)
    }
    pub fn add_lora(&self, r: &RequestHandle, path: &Path, strength: f32) -> Result<(), String> {
        self.check(r)?;
        self.inner.add_lora(r.pointer.as_ptr(), path, strength)
    }
    pub fn add_refmod(
        &self,
        r: &RequestHandle,
        path: &Path,
        strength: f32,
        copies: i32,
    ) -> Result<(), String> {
        self.check(r)?;
        self.inner
            .add_refmod(r.pointer.as_ptr(), path, strength, copies)
    }
    pub fn resolve(&self, request: &RequestHandle) -> Result<Plan, String> {
        self.check(request)?;
        self.inner.resolve(request.pointer.as_ptr())
    }
    pub fn describe(&self, request: &RequestHandle) -> Result<String, String> {
        self.check(request)?;
        self.inner.describe(request.pointer.as_ptr())
    }
}

/// Owns its library; native requests cannot outlive the DLL or cross instances.
pub struct RequestHandle {
    api: Api,
    pointer: NonNull<raw::Request>,
}
impl RequestHandle {
    pub fn new(api: &Api) -> Result<Self, String> {
        let pointer = NonNull::new(api.inner.create_request()?).ok_or("Empty native request.")?;
        Ok(Self {
            api: api.clone(),
            pointer,
        })
    }
    pub fn start(self, callback: Option<ProgressSink>) -> Result<GenerationHandle, String> {
        GenerationHandle::start(self, callback)
    }
}
impl Drop for RequestHandle {
    fn drop(&mut self) {
        self.api.inner.destroy_request(self.pointer.as_ptr());
    }
}

pub struct ReferenceVideoHandle(raw::ReferenceVideoHandle);
impl ReferenceVideoHandle {
    pub fn new(api: Api, duration: f64, path: PathBuf) -> Result<Self, String> {
        if api.path != path {
            return Err("Reference video runtime mismatch.".into());
        }
        raw::ReferenceVideoHandle::new(api.inner, duration, path).map(Self)
    }
    pub fn append(&mut self, bytes: &[u8], w: i32, h: i32, time: f64) -> Result<(), String> {
        self.0.append(bytes, w, h, time)
    }
    pub fn set_audio(&mut self, samples: &[f32], channels: i32, rate: i32) -> Result<(), String> {
        self.0.set_audio(samples, channels, rate)
    }
    pub fn has_audio(&self) -> bool {
        self.0.has_audio()
    }
    pub fn attach(&self, request: &RequestHandle, path: &Path) -> Result<(), String> {
        if request.api.path != path {
            return Err("Reference video runtime mismatch.".into());
        }
        self.0.attach(request.pointer.as_ptr(), path)
    }
}
