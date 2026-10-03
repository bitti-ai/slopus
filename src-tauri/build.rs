fn main() {
    // Recompile the executable's Windows resource when packaged icons change.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=../lib/slopfab/slopfab.dll");
    println!("cargo:rerun-if-changed=../lib/slopfab/libslopfab.so");
    validate_slopfab_runtime();
    tauri_build::build()
}

fn validate_slopfab_runtime() {
    use std::{fs::File, io::Read, path::Path};

    // Each platform bundles its own runtime (tauri.windows.conf.json and
    // tauri.linux.conf.json); fail before packaging an LFS pointer in its place.
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let (name, magic): (&str, &[u8]) = match os.as_str() {
        "windows" => ("slopfab.dll", b"MZ"),
        "linux" => ("libslopfab.so", b"\x7fELF"),
        _ => return,
    };
    assert_eq!(arch, "x86_64", "The vendored SlopFab runtime currently supports x86_64 only.");
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../lib/slopfab").join(name);
    let mut header = vec![0_u8; magic.len()];
    File::open(path).and_then(|mut file| file.read_exact(&mut header))
        .unwrap_or_else(|error| panic!("Missing SlopFab runtime {name}: {error}. Run git lfs pull."));
    assert_eq!(header, magic, "Invalid SlopFab runtime {name}; it may be a Git LFS pointer. Run git lfs pull.");
}
