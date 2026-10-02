fn main() {
    // Stage the SlopFab runtime beside this build's executables (the worker,
    // and test binaries, which look one folder up from deps/). The desktop
    // app stages it through Tauri resources as well; the copy is identical.
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../lib/slopfab/slopfab.dll");
    println!("cargo:rerun-if-changed={}", source.display());
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    // OUT_DIR is target/<profile>/build/<crate>-<hash>/out.
    if let Some(profile) = out.ancestors().nth(3) {
        let destination = profile.join("slopfab.dll");
        let stale = std::fs::metadata(&destination).ok().map(|meta| meta.len()) != std::fs::metadata(&source).ok().map(|meta| meta.len());
        if source.is_file() && stale {
            let _ = std::fs::copy(&source, destination);
        }
    }
}
