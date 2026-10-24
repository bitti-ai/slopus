//! Resolution-independent lasso outlines become exact pixel masks at submission.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MaskPoint { pub x: f64, pub y: f64 }

pub fn validate_polygon(points: &[MaskPoint], width: i32, height: i32) -> Result<(), String> {
    if !(1..=8192).contains(&width) || !(1..=8192).contains(&height) || !(3..=2048).contains(&points.len())
        || points.iter().any(|p| !p.x.is_finite() || !p.y.is_finite() || p.x < 0.0 || p.y < 0.0 || p.x > width as f64 || p.y > height as f64) {
        return Err("Lasso masks require 3 to 2048 finite points inside the image.".into());
    }
    let first = &points[0];
    let nonempty = points.iter().find(|p| p.x != first.x || p.y != first.y).is_some_and(|second|
        points.iter().any(|p| ((second.x - first.x) * (p.y - first.y) - (second.y - first.y) * (p.x - first.x)).abs() > 1e-9));
    if !nonempty { return Err("The lasso must enclose an area.".into()); }
    Ok(())
}

pub fn validate_contours(contours: &[Vec<MaskPoint>], width: i32, height: i32) -> Result<(), String> {
    if contours.is_empty() || contours.len() > 256 || contours.iter().map(Vec::len).sum::<usize>() > 8192 {
        return Err("Lasso masks require 1 to 256 contours and at most 8192 points.".into());
    }
    for points in contours { validate_polygon(points, width, height)?; }
    Ok(())
}

/// Even-odd fill, four vertical samples and exact horizontal coverage. Only
/// the edge pixels blend; pixels outside the outline remain zero. Row storage
/// stays bounded even for the largest supported canvas.
pub fn rasterize_polygon(points: &[MaskPoint], width: i32, height: i32) -> Result<Vec<u8>, String> {
    rasterize_contours(&[points.to_vec()], width, height)
}

pub fn rasterize_contours(contours: &[Vec<MaskPoint>], width: i32, height: i32) -> Result<Vec<u8>, String> {
    validate_contours(contours, width, height)?;
    let mut mask = vec![0; width as usize * height as usize];
    let mut intersections = Vec::with_capacity(contours.iter().map(Vec::len).sum());
    let mut coverage = vec![0.0_f64; width as usize];
    let top = contours.iter().flatten().map(|p| p.y).fold(f64::INFINITY, f64::min).floor() as usize;
    let bottom = contours.iter().flatten().map(|p| p.y).fold(0.0_f64, f64::max).ceil() as usize;
    for y in top..bottom.min(height as usize) {
        coverage.fill(0.0);
        for sample in 0..4 {
            let scan_y = y as f64 + (sample as f64 + 0.5) / 4.0;
            intersections.clear();
            for (a, b) in contours.iter().flat_map(|points| points.iter().zip(points.iter().cycle().skip(1))) {
                if (a.y > scan_y) != (b.y > scan_y) {
                    intersections.push(a.x + (scan_y - a.y) * (b.x - a.x) / (b.y - a.y));
                }
            }
            intersections.sort_by(f64::total_cmp);
            for pair in intersections.chunks_exact(2) {
                let left = pair[0].clamp(0.0, width as f64);
                let right = pair[1].clamp(0.0, width as f64);
                for x in left.floor() as usize..(right.ceil() as usize).min(width as usize) {
                    coverage[x] += (right.min(x as f64 + 1.0) - left.max(x as f64)).max(0.0) / 4.0;
                }
            }
        }
        for (x, value) in coverage.iter().enumerate() { mask[y * width as usize + x] = (value.clamp(0.0, 1.0) * 255.0).round() as u8; }
    }
    if !mask.iter().any(|value| *value != 0) { return Err("The lasso is too small at this generation resolution.".into()); }
    Ok(mask)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn points(values: &[(f64, f64)]) -> Vec<MaskPoint> { values.iter().map(|&(x, y)| MaskPoint { x, y }).collect() }
    #[test]
    fn concave_masks_preserve_pixels_outside_the_outline() {
        let polygon = points(&[(1.0, 1.0), (7.0, 1.0), (7.0, 3.0), (3.0, 3.0), (3.0, 7.0), (1.0, 7.0)]);
        let mask = rasterize_polygon(&polygon, 8, 8).unwrap();
        assert_eq!(mask[2 * 8 + 6], 255);
        assert_eq!(mask[6 * 8 + 2], 255);
        assert_eq!(mask[6 * 8 + 6], 0);
        assert_eq!(mask[0], 0);
        let mut reversed = polygon; reversed.reverse();
        assert_eq!(mask, rasterize_polygon(&reversed, 8, 8).unwrap());
    }
    #[test]
    fn antialiases_edges_and_accepts_full_canvas_and_crossed_outlines() {
        let mask = rasterize_polygon(&points(&[(0.0, 0.0), (8.0, 0.0), (0.0, 8.0)]), 8, 8).unwrap();
        assert!(mask.iter().any(|v| *v > 0 && *v < 255));
        assert_eq!(mask[63], 0);
        assert!(rasterize_polygon(&points(&[(0.0, 0.0), (8.0, 0.0), (8.0, 8.0), (0.0, 8.0)]), 8, 8).unwrap().iter().all(|v| *v == 255));
        assert!(rasterize_polygon(&points(&[(0.0, 0.0), (8.0, 8.0), (0.0, 8.0), (8.0, 0.0)]), 8, 8).is_ok());
    }
    #[test]
    fn compound_masks_preserve_holes_and_disconnected_pieces() {
        let outer = points(&[(1.0, 1.0), (6.0, 1.0), (6.0, 6.0), (1.0, 6.0)]);
        let hole = points(&[(2.0, 2.0), (4.0, 2.0), (4.0, 4.0), (2.0, 4.0)]);
        let island = points(&[(7.0, 0.0), (8.0, 0.0), (8.0, 8.0), (7.0, 8.0)]);
        let mask = rasterize_contours(&[outer.clone(), hole, island], 8, 8).unwrap();
        assert_eq!(mask[3 * 8 + 3], 0);
        assert_eq!(mask[4 * 8 + 4], 255);
        assert_eq!(mask[7 * 8 + 7], 255);
        assert_eq!(mask[7 * 8 + 6], 0);
        assert!(rasterize_contours(&[], 8, 8).is_err());
        assert!(rasterize_contours(&[outer.clone(), outer], 8, 8).is_err());
    }
    #[test]
    fn rejects_invalid_and_empty_polygons() {
        for polygon in [points(&[]), points(&[(1.0, 1.0), (2.0, 2.0), (3.0, 3.0)]), points(&[(-1.0, 0.0), (4.0, 0.0), (0.0, 4.0)]), points(&[(f64::NAN, 0.0), (4.0, 0.0), (0.0, 4.0)]), points(&[(0.0, 0.0), (9.0, 0.0), (0.0, 4.0)])] {
            assert!(rasterize_polygon(&polygon, 8, 8).is_err());
        }
    }
}
