const CUDA_DOWNLOADS: &str = "https://developer.nvidia.com/cuda-downloads";
const CUDA_12_8_DOWNLOADS: &str = "https://developer.nvidia.com/cuda-12-8-0-download-archive";

fn download_url(version: &str) -> Result<&'static str, String> {
    match version {
        "latest" => Ok(CUDA_DOWNLOADS),
        "12.8" => Ok(CUDA_12_8_DOWNLOADS),
        _ => Err("Unsupported CUDA download version.".into()),
    }
}

#[tauri::command]
pub fn open_cuda_download(version: String) -> Result<(), String> {
    // Only these two download pages can be opened by this command.
    let url = download_url(&version)?;
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let operation: Vec<u16> = "open\0".encode_utf16().collect();
        let target: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        // Both strings are NUL-terminated and remain alive for the shell call.
        let result = unsafe {
            ShellExecuteW(std::ptr::null_mut(), operation.as_ptr(), target.as_ptr(),
                std::ptr::null(), std::ptr::null(), 1)
        };
        if result as isize <= 32 {
            return Err("Could not open the browser. Copy the download link into your browser.".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let program = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(program).arg(url).spawn()
            .map(|_| ())
            .map_err(|error| format!("Could not open the browser: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_opens_the_requested_nvidia_download_pages() {
        assert_eq!(download_url("latest").unwrap(), CUDA_DOWNLOADS);
        assert_eq!(download_url("12.8").unwrap(), CUDA_12_8_DOWNLOADS);
        assert!(download_url("https://example.com").is_err());
        assert!(download_url("file:///C:/Windows").is_err());
    }
}
