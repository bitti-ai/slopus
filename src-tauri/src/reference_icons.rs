use std::{fs, path::{Path, PathBuf}};

pub const RENDER_SIZE: u32 = 768;
pub const ICON_SIZE: u16 = 256;
pub const STEPS: i32 = 20;
const JPEG_QUALITY: u8 = 95;

fn builtin_directory(log_directory: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(log_directory).map_err(|error| error.to_string())?;
    let root = log_directory.canonicalize().map_err(|error| error.to_string())?;
    let directory = root.join("reference-icons");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let directory = directory.canonicalize().map_err(|error| error.to_string())?;
    if !directory.starts_with(&root) { return Err("Built-in icons must stay inside the log directory.".into()); }
    Ok(directory)
}

fn builtin_path(log_directory: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 160 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
        return Err("Invalid built-in reference icon ID.".into());
    }
    Ok(builtin_directory(log_directory)?.join(format!("{id}.jpg")))
}

pub fn save_builtin(log_directory: &Path, id: &str, rgba: &[u8]) -> Result<(), String> {
    let path = builtin_path(log_directory, id)?;
    crate::export::write_atomically(&path, &encode_jpeg(rgba)?)
}

pub fn read_builtin(log_directory: &Path, id: &str) -> Result<Vec<u8>, String> {
    let path = builtin_path(log_directory, id)?;
    let resolved = path.canonicalize().map_err(|error| error.to_string())?;
    if !resolved.starts_with(path.parent().unwrap()) { return Err("Built-in icon points outside its directory.".into()); }
    fs::read(resolved).map_err(|error| error.to_string())
}

pub fn list_builtin(log_directory: &Path) -> Result<Vec<String>, String> {
    let directory = builtin_directory(log_directory)?;
    let mut ids = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().map_err(|error| error.to_string())?.is_file() { continue; }
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jpg") { continue; }
        if let Some(id) = path.file_stem().and_then(|value| value.to_str()) {
            if builtin_path(log_directory, id).is_ok() { ids.push(id.to_string()); }
        }
    }
    ids.sort();
    Ok(ids)
}

fn downscale_rgb(rgba: &[u8]) -> Result<Vec<u8>, String> {
    let render_size = RENDER_SIZE as usize;
    let icon_size = ICON_SIZE as usize;
    if rgba.len() != render_size * render_size * 4 {
        return Err("The reference icon has an invalid pixel buffer.".into());
    }
    let scale = render_size / icon_size;
    let samples = (scale * scale) as u32;
    let mut rgb = Vec::with_capacity(icon_size * icon_size * 3);
    for row in 0..icon_size {
        for column in 0..icon_size {
            let mut sums = [0_u32; 3];
            for offset_row in 0..scale {
                for offset_column in 0..scale {
                    let index =
                        ((row * scale + offset_row) * render_size + column * scale + offset_column)
                            * 4;
                    for channel in 0..3 {
                        sums[channel] += u32::from(rgba[index + channel]);
                    }
                }
            }
            rgb.extend(sums.map(|sum| ((sum + samples / 2) / samples) as u8));
        }
    }
    Ok(rgb)
}

pub fn encode_jpeg(rgba: &[u8]) -> Result<Vec<u8>, String> {
    let rgb = downscale_rgb(rgba)?;
    let mut bytes = Vec::new();
    jpeg_encoder::Encoder::new(&mut bytes, JPEG_QUALITY)
        .encode(&rgb, ICON_SIZE, ICON_SIZE, jpeg_encoder::ColorType::Rgb)
        .map_err(|error| format!("Could not encode reference icon: {error}"))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtins_are_shared_in_a_subfolder_of_the_log_directory() {
        let root = tempfile::tempdir().unwrap();
        let logs = root.path().join("logs");
        let rgba = vec![127; RENDER_SIZE as usize * RENDER_SIZE as usize * 4];
        save_builtin(&logs, "character-alice", &rgba).unwrap();
        assert!(logs.join("reference-icons/character-alice.jpg").is_file());
        assert_eq!(list_builtin(&logs).unwrap(), ["character-alice"]);
        assert!(read_builtin(&logs, "character-alice").unwrap().starts_with(&[0xff, 0xd8]));
        assert!(save_builtin(&logs, "../escape", &rgba).is_err());
        assert!(read_builtin(&logs, "../escape").is_err());
        assert!(save_builtin(&logs, "invalid", &[0; 4]).is_err());
    }

    #[test]
    fn downscale_averages_each_three_by_three_block() {
        let mut rgba = vec![0; RENDER_SIZE as usize * RENDER_SIZE as usize * 4];
        for row in 0..RENDER_SIZE as usize {
            for column in 0..RENDER_SIZE as usize {
                let index = (row * RENDER_SIZE as usize + column) * 4;
                rgba[index..index + 4].copy_from_slice(&[
                    ((column % 3) * 90) as u8,
                    ((row % 3) * 60) as u8,
                    (column / 3) as u8,
                    255,
                ]);
            }
        }
        let rgb = downscale_rgb(&rgba).unwrap();
        assert_eq!(rgb.len(), ICON_SIZE as usize * ICON_SIZE as usize * 3);
        for (index, pixel) in rgb.chunks_exact(3).enumerate() {
            assert_eq!(pixel, [90, 60, (index % ICON_SIZE as usize) as u8]);
        }
    }

    #[test]
    fn incomplete_writes_are_invisible_and_do_not_replace_a_finished_icon() {
        let root = tempfile::tempdir().unwrap();
        let rgba = vec![127; RENDER_SIZE as usize * RENDER_SIZE as usize * 4];
        save_builtin(root.path(), "saved", &rgba).unwrap();
        let original = read_builtin(root.path(), "saved").unwrap();
        let directory = root.path().join("reference-icons");
        fs::write(directory.join("saved.jpg.part"), [0xff, 0xd8]).unwrap();
        fs::write(directory.join("interrupted.jpg.part"), [0xff, 0xd8]).unwrap();
        assert_eq!(list_builtin(root.path()).unwrap(), ["saved"]);
        assert_eq!(read_builtin(root.path(), "saved").unwrap(), original);
        assert!(read_builtin(root.path(), "interrupted").is_err());
        assert!(save_builtin(root.path(), "saved", &[0; 4]).is_err());
        assert_eq!(read_builtin(root.path(), "saved").unwrap(), original);
        save_builtin(root.path(), "saved", &vec![255; rgba.len()]).unwrap();
        let replaced = read_builtin(root.path(), "saved").unwrap();
        assert_ne!(replaced, original);
        assert!(replaced.ends_with(&[0xff, 0xd9]));
    }

    #[test]
    fn rejects_buffers_that_are_not_768_square_rgba() {
        assert!(encode_jpeg(&[]).is_err());
        assert!(encode_jpeg(&vec![0; 256 * 256 * 4]).is_err());
    }
}
