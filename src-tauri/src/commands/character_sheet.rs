use crate::media::artifacts::generated_file_stem;
use crate::project::paths::ProjectRoot;
use crate::rendered;
use image::{ImageEncoder, RgbaImage};

fn cache_directory(sheet_id: &str) -> Result<String, String> {
    Ok(format!(
        "cache/character-sheets/{}",
        generated_file_stem(sheet_id)?
    ))
}

#[tauri::command]
pub(crate) fn save_character_sheet_view(
    folder_path: String,
    sheet_id: String,
    job_id: String,
    index: usize,
) -> Result<(), String> {
    let summary = rendered::summary(&job_id).ok_or("The character view is no longer in memory.")?;
    if summary.frame_count != 1 {
        return Err("Expected one character view.".into());
    }
    let pixels = rendered::frame(&job_id, 0)?.ok_or("The character view has no pixels.")?;
    write_view(
        &folder_path,
        &sheet_id,
        index,
        summary.width,
        summary.height,
        &pixels,
    )
}

fn write_view(
    folder: &str,
    sheet_id: &str,
    index: usize,
    width: u32,
    height: u32,
    pixels: &[u8],
) -> Result<(), String> {
    if index >= 4
        || width == 0
        || width > 2048
        || height == 0
        || height > 8192
        || pixels.len() != width as usize * height as usize * 4
    {
        return Err("Invalid character sheet view dimensions or pixels.".into());
    }
    let root = ProjectRoot::open(folder)?;
    let directory = root.directory(&cache_directory(sheet_id)?)?;
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(pixels, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|error| error.to_string())?;
    crate::storage::atomic::write_atomically(&directory.join(format!("{index}.png")), &png)
}

/// Assemble a square portrait and three tall views without stretching or cropping.
#[tauri::command]
pub(crate) fn combine_character_sheet(
    folder_path: String,
    sheet_id: String,
) -> Result<super::artifacts::GeneratedImageFile, String> {
    let root = ProjectRoot::open(&folder_path)?;
    let directory = cache_directory(&sheet_id)?;
    let mut views = Vec::new();
    let mut total_width = 0;
    let mut common_height = 0;
    for index in 0..4 {
        let path = root.existing(&format!("{directory}/{index}.png"))?;
        let (width, height) = image::image_dimensions(&path).map_err(|error| error.to_string())?;
        if width == 0 || width > 2048 || height == 0 || height > 8192 {
            return Err("Invalid character sheet view dimensions.".into());
        }
        if index > 0 && common_height != height {
            return Err("Character sheet views must have matching heights.".into());
        }
        common_height = height;
        total_width += width;
        views.push((path, width));
    }
    let mut sheet = RgbaImage::new(total_width, common_height);
    let mut x = 0;
    for (path, width) in views {
        let view = image::open(path)
            .map_err(|error| error.to_string())?
            .to_rgba8();
        image::imageops::replace(&mut sheet, &view, x, 0);
        x += i64::from(width);
    }
    super::artifacts::write_generated_png_frame(
        &folder_path,
        &sheet_id,
        sheet.width(),
        sheet.height(),
        sheet.as_raw(),
    )
}

#[tauri::command]
pub(crate) fn discard_character_sheet_views(
    folder_path: String,
    sheet_id: String,
) -> Result<(), String> {
    let root = ProjectRoot::open(&folder_path)?;
    let directory = cache_directory(&sheet_id)?;
    if root.path().join(&directory).exists() {
        // Canonical containment is checked before removing the job's own cache.
        std::fs::remove_dir_all(root.existing(&directory)?).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project_folder() -> tempfile::TempDir {
        let folder = tempfile::tempdir().unwrap();
        crate::project::storage::write_project(folder.path(), &crate::tests::created_fixture())
            .unwrap();
        folder
    }

    #[test]
    fn character_sheet_combines_four_views_in_order_and_cleans_only_its_cache() {
        let folder = project_folder();
        let path = folder.path().to_string_lossy().into_owned();
        let colors = [
            [255, 0, 0, 255],
            [0, 255, 0, 255],
            [0, 0, 255, 255],
            [255, 255, 0, 255],
        ];
        for (index, color) in colors.iter().enumerate() {
            let width = if index == 0 { 16 } else { 9 };
            write_view(
                &path,
                "sheet-test",
                index,
                width,
                16,
                &color.repeat(width as usize * 16),
            )
            .unwrap();
        }
        write_view(&path, "other-sheet", 0, 2, 3, &colors[0].repeat(6)).unwrap();
        let saved = combine_character_sheet(path.clone(), "sheet-test".into()).unwrap();
        assert_eq!((saved.width, saved.height), (43, 16));
        let image = image::open(folder.path().join(&saved.relative_path))
            .unwrap()
            .to_rgba8();
        for ((start, end), color) in [(0, 15), (16, 24), (25, 33), (34, 42)]
            .iter()
            .zip(colors.iter())
        {
            assert_eq!(image.get_pixel(*start, 0).0, *color);
            assert_eq!(image.get_pixel(*end, 15).0, *color);
        }
        discard_character_sheet_views(path.clone(), "sheet-test".into()).unwrap();
        assert!(!folder
            .path()
            .join("cache/character-sheets/sheet-test")
            .exists());
        assert!(folder
            .path()
            .join("cache/character-sheets/other-sheet/0.png")
            .exists());
        assert!(folder.path().join(saved.relative_path).exists());
        assert!(discard_character_sheet_views(path, "../other-sheet".into()).is_err());
    }

    #[test]
    fn character_sheet_rejects_missing_mismatched_and_oversized_views() {
        let folder = project_folder();
        let path = folder.path().to_string_lossy().into_owned();
        assert!(write_view(&path, "sheet", 4, 1, 1, &[0; 4]).is_err());
        assert!(write_view(&path, "sheet", 0, 2049, 1, &[0; 4]).is_err());
        write_view(&path, "sheet", 0, 1, 1, &[0; 4]).unwrap();
        assert!(combine_character_sheet(path.clone(), "sheet".into()).is_err());
        for index in 1..4 {
            write_view(&path, "sheet", index, 2, 2, &[0; 16]).unwrap();
        }
        assert!(combine_character_sheet(path, "sheet".into()).is_err());
        assert!(!folder.path().join("media/generated/sheet.png").exists());
    }
}
