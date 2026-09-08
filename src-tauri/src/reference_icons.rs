pub const RENDER_SIZE: u32 = 768;
pub const ICON_SIZE: u16 = 256;
pub const STEPS: i32 = 20;
const JPEG_QUALITY: u8 = 95;

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
    fn rejects_buffers_that_are_not_768_square_rgba() {
        assert!(encode_jpeg(&[]).is_err());
        assert!(encode_jpeg(&vec![0; 256 * 256 * 4]).is_err());
    }
}
