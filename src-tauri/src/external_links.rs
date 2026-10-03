/// Open a trusted application-owned URL in the default browser.
pub(crate) fn open_browser(url: &str) -> Result<(), String> {
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
