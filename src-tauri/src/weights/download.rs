use super::{cached_file, destination_name, CompletedFile};
use crate::storage::atomic::{atomic_replace, write_atomically};
use reqwest::{
    blocking::{Client, Response},
    header, StatusCode, Url,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[derive(Serialize, Deserialize)]
struct PartialFile {
    url: String,
    etag: Option<String>,
    total: Option<u64>,
    // Written only after EOF, size validation and syncing the file. This allows
    // recovery if the app exits between the final rename and completion record.
    #[serde(default)]
    complete: bool,
}

fn partial_record(destination: &Path, url: &Url) -> Option<PartialFile> {
    fs::read(destination.with_extension("part.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PartialFile>(&bytes).ok())
        .filter(|record| record.url == url.as_str())
}

pub(super) fn has_partial_download(url: &Url, directory: &Path) -> bool {
    let destination = directory.join(destination_name(url));
    partial_record(&destination, url).is_some_and(|record| {
        destination.with_extension("part").is_file() || (record.complete && destination.is_file())
    })
}

fn strong_etag(value: &str) -> bool {
    value.starts_with('"')
        && value.ends_with('"')
        && value.len() >= 2
        && !value[1..value.len() - 1]
            .bytes()
            .any(|byte| byte < 0x21 || byte == b'"' || byte == 0x7f)
}

fn response_etag(response: &Response) -> Option<String> {
    response
        .headers()
        .get(header::ETAG)
        .and_then(|value| value.to_str().ok())
        .filter(|value| strong_etag(value))
        .map(str::to_owned)
}

fn save_record(destination: &Path, record: &PartialFile) -> Result<(), String> {
    write_atomically(
        &destination.with_extension("part.json"),
        &serde_json::to_vec(record).map_err(|error| error.to_string())?,
    )
}

fn publish(destination: &Path, record: &PartialFile) -> Result<String, String> {
    let temporary = destination.with_extension("part");
    if temporary.exists() {
        atomic_replace(&temporary, destination).map_err(|error| error.to_string())?;
    }
    let completed = CompletedFile {
        url: record.url.clone(),
        bytes: record.total.ok_or("Missing completed download size.")?,
    };
    write_atomically(
        &destination.with_extension("complete.json"),
        &serde_json::to_vec(&completed).map_err(|error| error.to_string())?,
    )?;
    let _ = fs::remove_file(destination.with_extension("part.json"));
    Ok(destination.to_string_lossy().into_owned())
}

// RFC 9110: never append a different representation or an unexpected byte range.
// If-Range can omit the ETag in a 206 response; if present it must still match.
fn resumed_range(response: &Response, offset: u64, record: &PartialFile) -> Option<(u64, u64)> {
    if let Some(etag) = response.headers().get(header::ETAG) {
        if Some(etag.to_str().ok()?) != record.etag.as_deref() {
            return None;
        }
    }
    let range = response
        .headers()
        .get(header::CONTENT_RANGE)?
        .to_str()
        .ok()?
        .strip_prefix("bytes ")?;
    let (range, total) = range.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let (start, end, total) = (
        start.parse::<u64>().ok()?,
        end.parse::<u64>().ok()?,
        total.parse::<u64>().ok()?,
    );
    if start != offset
        || end < start
        || end >= total
        || record.total.is_some_and(|size| size != total)
        || response
            .content_length()
            .is_some_and(|size| size != end - start + 1)
    {
        return None;
    }
    Some((end + 1, total))
}

pub(super) fn transfer(
    url: &Url,
    directory: &Path,
    cancelled: &AtomicBool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<String, String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("Download cancelled.".into());
    }
    let destination = directory.join(destination_name(url));
    if cached_file(&destination, url) {
        return Ok(destination.to_string_lossy().into_owned());
    }
    let temporary = destination.with_extension("part");
    let saved = partial_record(&destination, url);
    if let Some(record) = &saved {
        if record.complete
            && !temporary.exists()
            && record.total.is_some_and(|size| {
                size > 0 && fs::metadata(&destination).is_ok_and(|file| file.len() == size)
            })
        {
            return publish(&destination, record);
        }
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Another Slopus process must not append to the same partial file.
        options.share_mode(0);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("Could not open partial download (it may be in use): {error}"))?;
    // Read metadata under the file lock; another process may have updated it
    // between the initial recovery check and opening the partial file.
    let saved = partial_record(&destination, url);
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    if let Some(record) = &saved {
        if record.complete && length > 0 && record.total == Some(length) {
            drop(file);
            return publish(&destination, record);
        }
    }
    let resume = saved.as_ref().filter(|record| {
        length > 0
            && !record.complete
            && record.total.is_none_or(|size| length < size)
            && record.etag.as_deref().is_some_and(strong_etag)
    });
    let mut offset = if resume.is_some() { length } else { 0 };
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(24 * 60 * 60))
        .build()
        .map_err(|error| error.to_string())?;
    let request = || {
        client
            .get(url.clone())
            .header(header::ACCEPT_ENCODING, "identity")
    };
    let mut pending = request();
    if let Some(record) = resume {
        pending = pending
            .header(header::RANGE, format!("bytes={offset}-"))
            .header(header::IF_RANGE, record.etag.as_deref().unwrap());
    }
    let mut response = pending
        .send()
        .map_err(|error| format!("Download failed: {error}"))?;
    let mut range = None;
    if let Some(record) = resume {
        if response.status() == StatusCode::PARTIAL_CONTENT {
            range = resumed_range(&response, offset, record);
        }
        if response.status() == StatusCode::RANGE_NOT_SATISFIABLE
            || (response.status() == StatusCode::PARTIAL_CONTENT && range.is_none())
        {
            drop(response);
            if cancelled.load(Ordering::Relaxed) {
                return Err("Download cancelled.".into());
            }
            response = request()
                .send()
                .map_err(|error| format!("Download failed: {error}"))?;
        }
    }
    response
        .error_for_status_ref()
        .map_err(|error| format!("Download failed: {error}"))?;
    if response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("text/html"))
    {
        return Err(
            "The URL returned a web page instead of a weight file. Use a direct download link."
                .into(),
        );
    }
    if response
        .headers()
        .get(header::CONTENT_ENCODING)
        .is_some_and(|value| value != "identity")
    {
        return Err("The server returned encoded data instead of the requested file bytes.".into());
    }
    let (end, total, etag) = if response.status() == StatusCode::OK {
        offset = 0;
        (
            response.content_length(),
            response.content_length(),
            response_etag(&response),
        )
    } else if response.status() == StatusCode::PARTIAL_CONTENT && range.is_some() {
        let (end, total) = range.unwrap();
        (Some(end), Some(total), resume.unwrap().etag.clone())
    } else {
        return Err("The server did not return the requested file bytes.".into());
    };
    if cancelled.load(Ordering::Relaxed) {
        return Err("Download cancelled.".into());
    }
    if total == Some(0) {
        return Err("The URL returned an empty weight file.".into());
    }
    if offset == 0 {
        // Truncate before replacing metadata, so a crash cannot pair old bytes
        // with a new ETag. Keep existing data untouched until a valid response.
        file.set_len(0).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut record = PartialFile {
        url: url.to_string(),
        etag,
        total,
        complete: false,
    };
    save_record(&destination, &record)?;
    let mut downloaded = offset;
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut last_progress = Instant::now();
    progress(downloaded, total);
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err("Download cancelled.".into());
        }
        let count = response
            .read(&mut buffer)
            .map_err(|error| format!("Download interrupted: {error}"))?;
        if count == 0 {
            break;
        }
        if end.is_some_and(|end| count as u64 > end.saturating_sub(downloaded)) {
            return Err("The server sent more bytes than the requested file range.".into());
        }
        file.write_all(&buffer[..count])
            .map_err(|error| format!("Could not write weights: {error}"))?;
        downloaded += count as u64;
        if last_progress.elapsed() >= Duration::from_millis(200) {
            progress(downloaded, total);
            last_progress = Instant::now();
        }
    }
    if downloaded == 0 || total.is_some_and(|total| downloaded != total) {
        return Err("The download is incomplete. Retry to continue downloading.".into());
    }
    if cancelled.load(Ordering::Relaxed) {
        return Err("Download cancelled.".into());
    }
    file.sync_all().map_err(|error| error.to_string())?;
    record.complete = true;
    record.total = Some(downloaded);
    save_record(&destination, &record)?;
    drop(file);
    let path = publish(&destination, &record)?;
    progress(downloaded, Some(downloaded));
    Ok(path)
}

#[cfg(test)]
mod tests;
