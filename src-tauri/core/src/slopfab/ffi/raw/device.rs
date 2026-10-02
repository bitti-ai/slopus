use super::*;
pub fn has_cuda_device() -> bool {
    // CUDA's driver API uses the system calling convention on Windows.
    // Keep the library alive until both calls have returned.
    unsafe {
        #[cfg(windows)]
        let driver = libloading::os::windows::Library::load_with_flags(
            "nvcuda.dll",
            0x00000800, // LOAD_LIBRARY_SEARCH_SYSTEM32
        )
        .map(Library::from);
        #[cfg(not(windows))]
        let driver = Library::new("libcuda.so.1");
        let Ok(library) = driver else { return false };
        let Ok(init) = library.get::<unsafe extern "system" fn(u32) -> i32>(b"cuInit\0") else {
            return false;
        };
        let Ok(count) =
            library.get::<unsafe extern "system" fn(*mut i32) -> i32>(b"cuDeviceGetCount\0")
        else {
            return false;
        };
        let mut devices = 0;
        init(0) == 0 && count(&mut devices) == 0 && devices > 0
    }
}
pub fn cuda_device_names() -> Vec<String> {
    gpu_devices()
        .into_iter()
        .map(|device| device.name)
        .collect()
}

pub fn gpu_devices() -> Vec<crate::slopfab::GpuDevice> {
    // The display driver's API is available without the CUDA toolkit.
    // Keep the library and fixed-size name buffer alive for every call.
    unsafe {
        #[cfg(windows)]
        let driver = libloading::os::windows::Library::load_with_flags(
            "nvcuda.dll",
            0x00000800, // LOAD_LIBRARY_SEARCH_SYSTEM32
        )
        .map(Library::from);
        #[cfg(not(windows))]
        let driver = Library::new("libcuda.so.1");
        let Ok(library) = driver else {
            return Vec::new();
        };
        let Ok(init) = library.get::<unsafe extern "system" fn(u32) -> i32>(b"cuInit\0") else {
            return Vec::new();
        };
        let Ok(count) =
            library.get::<unsafe extern "system" fn(*mut i32) -> i32>(b"cuDeviceGetCount\0")
        else {
            return Vec::new();
        };
        let Ok(get) =
            library.get::<unsafe extern "system" fn(*mut i32, i32) -> i32>(b"cuDeviceGet\0")
        else {
            return Vec::new();
        };
        let Ok(name) = library
            .get::<unsafe extern "system" fn(*mut c_char, i32, i32) -> i32>(b"cuDeviceGetName\0")
        else {
            return Vec::new();
        };
        let memory = library
            .get::<unsafe extern "system" fn(*mut usize, i32) -> i32>(b"cuDeviceTotalMem_v2\0")
            .ok();
        let mut count_value = 0;
        if init(0) != 0 || count(&mut count_value) != 0 {
            return Vec::new();
        }
        (0..count_value)
            .filter_map(|ordinal| {
                let mut device = 0;
                let mut buffer = [0u8; 256];
                if get(&mut device, ordinal) != 0
                    || name(buffer.as_mut_ptr().cast(), buffer.len() as i32, device) != 0
                {
                    return None;
                }
                let end = buffer
                    .iter()
                    .position(|byte| *byte == 0)
                    .unwrap_or(buffer.len());
                let mut memory_bytes = 0usize;
                if let Some(memory) = &memory {
                    if memory(&mut memory_bytes, device) != 0 {
                        memory_bytes = 0;
                    }
                }
                Some(crate::slopfab::GpuDevice {
                    name: String::from_utf8_lossy(&buffer[..end]).into_owned(),
                    memory_bytes: memory_bytes as u64,
                })
            })
            .collect()
    }
}
