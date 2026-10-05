//! Streaming export restoration. Codecs and timestamps remain owned by Slopus.
use image::{imageops::FilterType, RgbaImage};
use std::{
    ffi::{c_char, c_void, CStr, CString},
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleConfig {
    pub method: UpscaleMethod,
    pub model_path: String,
    pub vae_path: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpscaleMethod {
    Realesrgan,
    Seedvr2,
}

type Read = unsafe extern "C" fn(*mut c_void, *mut f32, u64) -> i32;
type Write = unsafe extern "C" fn(*mut c_void, *const f32, u64) -> i32;
type Cancel = unsafe extern "C" fn(*mut c_void) -> i32;
type Progress = unsafe extern "C" fn(*mut c_void, *const c_char);
#[repr(C)]
struct SeedOptions {
    struct_size: u32,
    transformer: *const c_char,
    vae: *const c_char,
    width: i32,
    height: i32,
    segment_frames: i32,
    vae_tile: i32,
    device: i32,
    color_match: i32,
    seed: u64,
}
type SeedRun = unsafe extern "C" fn(
    *const SeedOptions,
    Read,
    Write,
    Cancel,
    Option<Progress>,
    *mut c_void,
    *mut u64,
) -> i32;
type RealRun = unsafe extern "C" fn(
    *const c_char,
    i32,
    i32,
    i32,
    i32,
    Read,
    Write,
    Cancel,
    *mut c_void,
    *mut u64,
) -> i32;

struct Stream<'a> {
    read: &'a mut dyn FnMut() -> Result<Option<Vec<u8>>, String>,
    write: &'a mut dyn FnMut(Vec<u8>) -> Result<(), String>,
    cancelled: &'a AtomicBool,
    input: (u32, u32),
    native_input: (u32, u32),
    native_output: (u32, u32),
    output: (u32, u32),
    error: Option<String>,
}
unsafe extern "C" fn read_frame(user: *mut c_void, data: *mut f32, count: u64) -> i32 {
    let stream = &mut *(user as *mut Stream<'_>);
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<i32, String> {
            if stream.cancelled.load(Ordering::Relaxed) {
                return Err("Upscaling cancelled.".into());
            }
            let Some(bytes) = (stream.read)()? else {
                return Ok(0);
            };
            let image = RgbaImage::from_raw(stream.input.0, stream.input.1, bytes)
                .ok_or("Invalid input frame length.")?;
            let image = if stream.input != stream.native_input {
                image::imageops::resize(
                    &image,
                    stream.native_input.0,
                    stream.native_input.1,
                    FilterType::Lanczos3,
                )
            } else {
                image
            };
            if count != image.width() as u64 * image.height() as u64 * 3 {
                return Err("Unexpected upscaler input geometry.".into());
            }
            let target = std::slice::from_raw_parts_mut(data, count as usize);
            for (rgb, pixel) in target.chunks_exact_mut(3).zip(image.pixels()) {
                for channel in 0..3 {
                    rgb[channel] = pixel[channel] as f32 / 255.0;
                }
            }
            Ok(1)
        }))
        .unwrap_or_else(|_| Err("Upscaler input callback panicked.".into()));
    match result {
        Ok(value) => value,
        Err(error) => {
            stream.error = Some(error);
            -1
        }
    }
}
unsafe extern "C" fn write_frame(user: *mut c_void, data: *const f32, count: u64) -> i32 {
    let stream = &mut *(user as *mut Stream<'_>);
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
            let (width, height) = stream.native_output;
            if count != width as u64 * height as u64 * 3 {
                return Err("Unexpected upscaler output geometry.".into());
            }
            let source = std::slice::from_raw_parts(data, count as usize);
            let mut rgba = RgbaImage::new(width, height);
            for (pixel, rgb) in rgba.pixels_mut().zip(source.chunks_exact(3)) {
                for channel in 0..3 {
                    pixel[channel] = (rgb[channel].clamp(0.0, 1.0) * 255.0).round() as u8;
                }
                pixel[3] = 255;
            }
            let rgba = if stream.native_output != stream.output {
                image::imageops::resize(
                    &rgba,
                    stream.output.0,
                    stream.output.1,
                    FilterType::Lanczos3,
                )
            } else {
                rgba
            };
            (stream.write)(rgba.into_raw())
        }))
        .unwrap_or_else(|_| Err("Upscaler output callback panicked.".into()));
    match result {
        Ok(()) => 0,
        Err(error) => {
            stream.error = Some(error);
            -1
        }
    }
}
unsafe extern "C" fn cancelled(user: *mut c_void) -> i32 {
    let stream = &*(user as *const Stream<'_>);
    i32::from(stream.cancelled.load(Ordering::Relaxed))
}

pub fn validate(
    config: &UpscaleConfig,
    input: (u32, u32),
    output: (u32, u32),
) -> Result<(), String> {
    if [input.0, input.1, output.0, output.1]
        .iter()
        .any(|n| *n == 0 || *n > 16384)
    {
        return Err("Upscale dimensions must be between 1 and 16384 pixels.".into());
    }
    if config.method == UpscaleMethod::Seedvr2 && (output.0 < 16 || output.1 < 16) {
        return Err("SeedVR2 output must be at least 16 pixels on each side.".into());
    }
    for path in std::iter::once(Some(config.model_path.as_str()))
        .chain((config.method == UpscaleMethod::Seedvr2).then_some(config.vae_path.as_deref()))
    {
        if !path.is_some_and(|path| std::path::Path::new(path).is_file()) {
            return Err("Upscaler weights are missing. Download them in Settings → Generator → Other weights.".into());
        }
    }
    Ok(())
}

pub fn run(
    config: &UpscaleConfig,
    input: (u32, u32),
    output: (u32, u32),
    segment_frames: i32,
    stop: &AtomicBool,
    read: &mut dyn FnMut() -> Result<Option<Vec<u8>>, String>,
    write: &mut dyn FnMut(Vec<u8>) -> Result<(), String>,
) -> Result<u64, String> {
    validate(config, input, output)?;
    // Do not compete with generation or weight preparation for GPU memory.
    let _models = loop {
        if stop.load(Ordering::Relaxed) {
            return Err("Upscaling cancelled.".into());
        }
        match super::MODEL_ACCESS.try_write() {
            Ok(lock) => break lock,
            Err(std::sync::TryLockError::WouldBlock) => {
                std::thread::sleep(std::time::Duration::from_millis(50))
            }
            Err(_) => return Err("Model access lock failed.".into()),
        }
    };
    let path = super::default_dll_path();
    let api = super::ffi::Api::load(&path)?;
    let backend = super::platform::detect_platform(&api).backend();
    if config.method == UpscaleMethod::Seedvr2 && backend != 0 {
        return Err("SeedVR2 requires an NVIDIA GPU with CUDA.".into());
    }
    api.clear_reused_models()?;
    let model = CString::new(config.model_path.as_str()).map_err(|e| e.to_string())?;
    let vae = CString::new(config.vae_path.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
    let seed = config.method == UpscaleMethod::Seedvr2;
    // Real-ESRGAN always creates 4x pixels; cap its working input so even a
    // large imported still stays within the 16384-pixel export limit.
    let scale = (4096.0 / input.0.max(input.1) as f64).min(1.0);
    let native_input = if seed {
        output
    } else {
        (
            (input.0 as f64 * scale).round().max(1.0) as u32,
            (input.1 as f64 * scale).round().max(1.0) as u32,
        )
    };
    let mut stream = Stream {
        read,
        write,
        cancelled: stop,
        input,
        output,
        error: None,
        native_input,
        native_output: if seed {
            output
        } else {
            (native_input.0 * 4, native_input.1 * 4)
        },
    };
    let user = &mut stream as *mut _ as *mut c_void;
    let mut written = 0;
    unsafe {
        let library = libloading::Library::new(path).map_err(|e| e.to_string())?;
        let status = if seed {
            let run = library
                .get::<SeedRun>(b"slopfab_seedvr2_upscale\0")
                .map_err(|_| "SeedVR2 export requires an updated SlopFab runtime.")?;
            let options = SeedOptions {
                struct_size: std::mem::size_of::<SeedOptions>() as u32,
                transformer: model.as_ptr(),
                vae: vae.as_ptr(),
                width: output.0 as i32,
                height: output.1 as i32,
                segment_frames,
                vae_tile: 256,
                device: 0,
                color_match: 1,
                seed: 666,
            };
            run(
                &options,
                read_frame,
                write_frame,
                cancelled,
                None,
                user,
                &mut written,
            )
        } else {
            let run = library
                .get::<RealRun>(b"slopfab_realesrgan_upscale\0")
                .map_err(|_| "Real-ESRGAN export requires SlopFab API 1.22 or later.")?;
            run(
                model.as_ptr(),
                native_input.0 as i32,
                native_input.1 as i32,
                backend,
                128,
                read_frame,
                write_frame,
                cancelled,
                user,
                &mut written,
            )
        };
        if let Some(error) = stream.error {
            return Err(error);
        }
        if status != 0 {
            let error = library
                .get::<unsafe extern "C" fn() -> *const c_char>(b"slopfab_last_error\0")
                .map_err(|e| e.to_string())?;
            let message = error();
            return Err(if message.is_null() {
                format!("Upscaling failed ({status}).")
            } else {
                CStr::from_ptr(message).to_string_lossy().into_owned()
            });
        }
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callbacks_preserve_packed_rgb() {
        let stop = AtomicBool::new(false);
        let mut input = Some(vec![255, 128, 0, 77, 0, 64, 255, 128]);
        let mut output = Vec::new();
        let mut read = || Ok(input.take());
        let mut write = |bytes| {
            output = bytes;
            Ok(())
        };
        let mut stream = Stream {
            read: &mut read,
            write: &mut write,
            cancelled: &stop,
            input: (2, 1),
            native_input: (2, 1),
            native_output: (2, 1),
            output: (2, 1),
            error: None,
        };
        let mut rgb = [0.0; 6];
        let user = &mut stream as *mut _ as *mut c_void;
        unsafe {
            assert_eq!(read_frame(user, rgb.as_mut_ptr(), 6), 1);
            assert_eq!(rgb, [1.0, 128.0 / 255.0, 0.0, 0.0, 64.0 / 255.0, 1.0]);
            assert_eq!(write_frame(user, rgb.as_ptr(), 6), 0);
            assert_eq!(read_frame(user, rgb.as_mut_ptr(), 6), 0);
        }
        drop(stream);
        assert_eq!(output, [255, 128, 0, 255, 0, 64, 255, 255]);
    }

    #[test]
    fn callbacks_report_failures_without_unwinding_across_the_abi() {
        let stop = AtomicBool::new(false);
        let mut read = || -> Result<Option<Vec<u8>>, String> { panic!("reader failed") };
        let mut write = |_| Ok(());
        let mut stream = Stream {
            read: &mut read,
            write: &mut write,
            cancelled: &stop,
            input: (1, 1),
            native_input: (1, 1),
            native_output: (1, 1),
            output: (1, 1),
            error: None,
        };
        let mut rgb = [0.0; 3];
        unsafe {
            assert_eq!(
                read_frame(&mut stream as *mut _ as *mut c_void, rgb.as_mut_ptr(), 3),
                -1
            );
        }
        assert!(stream.error.as_ref().unwrap().contains("panicked"));
        stop.store(true, Ordering::Relaxed);
        unsafe {
            assert_eq!(cancelled(&mut stream as *mut _ as *mut c_void), 1);
        }
    }

    #[test]
    fn seedvr2_requires_both_weights_and_rejects_invalid_sizes() {
        let weight = tempfile::NamedTempFile::new().unwrap();
        let mut config = UpscaleConfig {
            method: UpscaleMethod::Seedvr2,
            model_path: weight.path().to_string_lossy().into(),
            vae_path: None,
        };
        assert!(validate(&config, (32, 32), (64, 64)).is_err());
        config.vae_path = Some(config.model_path.clone());
        assert!(validate(&config, (32, 32), (64, 64)).is_ok());
        assert!(validate(&config, (0, 32), (64, 64)).is_err());
        assert!(validate(&config, (32, 32), (8, 8)).is_err());
    }
}
