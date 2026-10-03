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
    crate::external_links::open_browser(url)
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
