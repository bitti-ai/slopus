fn main() {
    // Same version and product name as Slopus.exe, from the shared workspace version.
    #[cfg(windows)]
    {
        let mut resource = tauri_winres::WindowsResource::new();
        resource.set("ProductName", "Slopus");
        resource.set("FileDescription", "Slopus LAN worker");
        resource.set_icon("../icons/icon.ico");
        if let Err(error) = resource.compile() {
            panic!("Could not embed the worker's Windows resources: {error}");
        }
    }
}
