fn main() {
    // Recompile the executable's Windows resource when packaged icons change.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
