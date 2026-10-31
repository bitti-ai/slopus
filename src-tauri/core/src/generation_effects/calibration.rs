use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const LIMIT: usize = 256 * 1024;

/// The small fitted archive travels with projects and LAN requests, not a local path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DriftCalibration { pub name: String, pub data: String }

impl DriftCalibration {
    pub fn bytes(&self) -> Result<Vec<u8>, String> {
        let invalid = || "Invalid fitted LCS drift calibration.".to_string();
        if self.name.is_empty() || self.name.chars().count() > 200 || self.data.len() > LIMIT.div_ceil(3) * 4 { return Err(invalid()); }
        let bytes = base64::engine::general_purpose::STANDARD.decode(&self.data).map_err(|_| invalid())?;
        if bytes.len() < 8 || bytes.len() > LIMIT { return Err(invalid()); }
        let length = u64::from_le_bytes(bytes[..8].try_into().unwrap());
        if !(2..=65536).contains(&length) || length + 8 > bytes.len() as u64 { return Err(invalid()); }
        let start = 8 + length as usize;
        let header: Value = serde_json::from_slice(&bytes[8..start]).map_err(|_| invalid())?;
        let hash = header["__metadata__"]["vae_sha256"].as_str().unwrap_or("");
        if header["__metadata__"]["slopfab_lcs"] != "1" || hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) { return Err(invalid()); }
        let tensor = |name: &str, shape: &[usize]| -> Result<Vec<f64>, String> {
            let entry = &header[name];
            let begin = entry["data_offsets"][0].as_u64().ok_or_else(invalid)?;
            let end = entry["data_offsets"][1].as_u64().ok_or_else(invalid)?;
            if entry["dtype"] != "F32" || entry["shape"] != json!(shape)
                || end.checked_sub(begin) != Some((shape.iter().product::<usize>() * 4) as u64)
                || end > (bytes.len() - start) as u64 { return Err(invalid()); }
            let values: Vec<f64> = bytes[start + begin as usize..start + end as usize].chunks_exact(4)
                .map(|v| f32::from_le_bytes(v.try_into().unwrap()) as f64).collect();
            if !values.iter().all(|v| v.is_finite()) { return Err(invalid()); }
            Ok(values)
        };
        let basis = tensor("basis", &[96, 3])?;
        tensor("mean", &[96])?; tensor("anchor_lcs", &[8, 3])?; tensor("latent_mean", &[24])?;
        if tensor("latent_std", &[24])?.iter().any(|v| *v <= 0.) { return Err(invalid()); }
        tensor("explained_variance", &[1])?;
        let direction = tensor("drift_direction", &[96])?;
        let reference = tensor("drift_reference", &[2])?;
        let norm: f64 = direction.iter().map(|v| v * v).sum();
        let projection: f64 = (0..3).map(|axis| direction.iter().enumerate().map(|(i, v)| v * basis[i * 3 + axis]).sum::<f64>().powi(2)).sum();
        if (norm - 1.).abs() >= 0.0001 || projection.sqrt() >= 0.0001 || reference[1] < 0. { return Err(invalid()); }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portable_calibration_rejects_corrupt_and_unfitted_archives() {
        let fixture: Value = serde_json::from_str(include_str!("../../../../fixtures/generation-effects.json")).unwrap();
        let mut calibration: DriftCalibration = serde_json::from_value(fixture["drift"]["calibration"].clone()).unwrap();
        let mut bytes = calibration.bytes().unwrap();
        let start = 8 + u64::from_le_bytes(bytes[..8].try_into().unwrap()) as usize;
        let header: Value = serde_json::from_slice(&bytes[8..start]).unwrap();
        let offset = start + header["drift_direction"]["data_offsets"][0].as_u64().unwrap() as usize;
        bytes[offset + 12..offset + 16].copy_from_slice(&0_f32.to_le_bytes());
        calibration.data = base64::engine::general_purpose::STANDARD.encode(&bytes);
        assert!(calibration.bytes().is_err());
        calibration.data = base64::engine::general_purpose::STANDARD.encode(&bytes[..100]);
        assert!(calibration.bytes().is_err());
        calibration.data = "a".repeat(LIMIT * 2);
        assert!(calibration.bytes().is_err());
    }
}
