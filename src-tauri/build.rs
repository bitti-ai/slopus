fn main() {
    // Recompile the executable's Windows resource when packaged icons change.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=../lib/slopfab/slopfab.dll");
    validate_slopfab_runtime();
    tauri_build::build()
}

fn validate_slopfab_runtime() {
    use std::{fs::File, io::Read, path::Path};

    // Fail before packaging an LFS pointer in place of the runtime DLL.
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../lib/slopfab/slopfab.dll");
    let mut header = [0_u8; 2];
    File::open(path).and_then(|mut file| file.read_exact(&mut header))
        .unwrap_or_else(|error| panic!("Missing SlopFab runtime slopfab.dll: {error}. Run git lfs pull."));
    assert_eq!(&header, b"MZ", "Invalid SlopFab runtime slopfab.dll; it may be a Git LFS pointer. Run git lfs pull.");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        assert_eq!(std::env::var("CARGO_CFG_TARGET_ARCH").as_deref(), Ok("x86_64"),
            "The vendored SlopFab runtime currently supports Windows x64 only.");
    }
}
