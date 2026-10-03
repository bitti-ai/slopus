use super::*;
use std::{net::TcpListener, thread::JoinHandle};

fn server(responses: Vec<&'static [u8]>) -> (Url, JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let task = std::thread::spawn(move || {
        responses
            .into_iter()
            .map(|response| {
                let started = Instant::now();
                let mut connection = loop {
                    match listener.accept() {
                        Ok((connection, _)) => break connection,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && started.elapsed() < Duration::from_secs(5) =>
                        {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(error) => panic!("Expected download request: {error}"),
                    }
                };
                connection.set_nonblocking(false).unwrap();
                connection
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 1024];
                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let count = connection.read(&mut buffer).unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                let _ = connection.write_all(response);
                String::from_utf8(request).unwrap().to_ascii_lowercase()
            })
            .collect()
    });
    (
        Url::parse(&format!("http://{address}/model.safetensors")).unwrap(),
        task,
    )
}

fn seed_partial(
    directory: &Path,
    url: &Url,
    bytes: &[u8],
    etag: Option<&str>,
    complete: bool,
) -> std::path::PathBuf {
    fs::create_dir_all(directory).unwrap();
    let destination = directory.join(destination_name(url));
    fs::write(destination.with_extension("part"), bytes).unwrap();
    save_record(
        &destination,
        &PartialFile {
            url: url.to_string(),
            etag: etag.map(str::to_owned),
            total: Some(10),
            complete,
        },
    )
    .unwrap();
    destination
}

const FULL: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nETag: \"one\"\r\nConnection: close\r\n\r\n1234567890";
const REMAINDER: &[u8] = b"HTTP/1.1 206 Partial Content\r\nContent-Length: 6\r\nContent-Range: bytes 4-9/10\r\nETag: \"one\"\r\nConnection: close\r\n\r\n567890";

#[test]
fn interrupted_download_resumes_from_disk_with_range_and_version_and_full_progress() {
    let (url, task) = server(vec![
        b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nETag: \"one\"\r\nConnection: close\r\n\r\n1234",
        REMAINDER,
    ]);
    let folder = tempfile::tempdir().unwrap();
    assert!(transfer(&url, folder.path(), &AtomicBool::new(false), |_, _| {}).is_err());
    let destination = folder.path().join(destination_name(&url));
    assert_eq!(
        fs::read(destination.with_extension("part")).unwrap(),
        b"1234"
    );
    assert!(!cached_file(&destination, &url));
    // No in-memory download state is reused, just as after restarting the app.
    let mut events = Vec::new();
    let result = transfer(
        &url,
        folder.path(),
        &AtomicBool::new(false),
        |bytes, total| events.push((bytes, total)),
    )
    .unwrap();
    assert_eq!(fs::read(result).unwrap(), b"1234567890");
    assert_eq!(events.first(), Some(&(4, Some(10))));
    assert_eq!(events.last(), Some(&(10, Some(10))));
    assert!(cached_file(&destination, &url));
    assert!(!destination.with_extension("part").exists());
    assert!(!destination.with_extension("part.json").exists());
    let requests = task.join().unwrap();
    assert!(!requests[0].contains("range:"));
    assert!(requests[1].contains("range: bytes=4-\r\n"));
    assert!(requests[1].contains("if-range: \"one\"\r\n"));
}

#[test]
fn cancellation_keeps_partial_bytes_for_the_next_download() {
    let (url, task) = server(vec![REMAINDER, REMAINDER]);
    let folder = tempfile::tempdir().unwrap();
    let destination = seed_partial(folder.path(), &url, b"1234", Some("\"one\""), false);
    let cancelled = AtomicBool::new(false);
    assert_eq!(
        transfer(&url, folder.path(), &cancelled, |_, _| cancelled
            .store(true, Ordering::Relaxed))
        .unwrap_err(),
        "Download cancelled."
    );
    assert_eq!(
        fs::read(destination.with_extension("part")).unwrap(),
        b"1234"
    );
    let result = transfer(&url, folder.path(), &AtomicBool::new(false), |_, _| {}).unwrap();
    assert_eq!(fs::read(result).unwrap(), b"1234567890");
    assert!(task
        .join()
        .unwrap()
        .iter()
        .all(|request| request.contains("range: bytes=4-\r\n")));
}

#[test]
fn another_interruption_retains_newly_appended_bytes() {
    let (url, task) = server(vec![
        b"HTTP/1.1 206 Partial Content\r\nContent-Length: 6\r\nContent-Range: bytes 4-9/10\r\nETag: \"one\"\r\nConnection: close\r\n\r\n56",
        b"HTTP/1.1 206 Partial Content\r\nContent-Length: 4\r\nContent-Range: bytes 6-9/10\r\nConnection: close\r\n\r\n7890",
    ]);
    let folder = tempfile::tempdir().unwrap();
    let destination = seed_partial(folder.path(), &url, b"1234", Some("\"one\""), false);
    assert!(transfer(&url, folder.path(), &AtomicBool::new(false), |_, _| {}).is_err());
    assert_eq!(
        fs::read(destination.with_extension("part")).unwrap(),
        b"123456"
    );
    let result = transfer(&url, folder.path(), &AtomicBool::new(false), |_, _| {}).unwrap();
    assert_eq!(fs::read(result).unwrap(), b"1234567890");
    assert!(task.join().unwrap()[1].contains("range: bytes=6-\r\n"));
}

#[test]
fn full_response_to_range_restarts_instead_of_appending_changed_or_duplicate_data() {
    let (url, task) = server(vec![FULL]);
    let folder = tempfile::tempdir().unwrap();
    seed_partial(folder.path(), &url, b"old!", Some("\"old\""), false);
    let mut events = Vec::new();
    let result = transfer(
        &url,
        folder.path(),
        &AtomicBool::new(false),
        |bytes, total| events.push((bytes, total)),
    )
    .unwrap();
    assert_eq!(fs::read(result).unwrap(), b"1234567890");
    assert_eq!(events.first(), Some(&(0, Some(10))));
    assert!(task.join().unwrap()[0].contains("if-range: \"old\""));
}

#[test]
fn invalid_or_changed_ranges_restart_with_an_unconditional_request() {
    for response in [
        &b"HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */3\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"[..],
        &b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-5/10\r\nContent-Length: 6\r\nConnection: close\r\n\r\nwrong!"[..],
        &b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 4-9/11\r\nContent-Length: 6\r\nConnection: close\r\n\r\nwrong!"[..],
        &b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 4-9/10\r\nContent-Length: 6\r\nETag: \"two\"\r\nConnection: close\r\n\r\nwrong!"[..],
        &b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 4-9/10\r\nContent-Length: 5\r\nConnection: close\r\n\r\nwrong"[..],
        &b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 4-3/10\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"[..],
    ] {
        let (url, task) = server(vec![response, FULL]);
        let folder = tempfile::tempdir().unwrap();
        seed_partial(folder.path(), &url, b"1234", Some("\"one\""), false);
        let result = transfer(&url, folder.path(), &AtomicBool::new(false), |_, _| {}).unwrap();
        assert_eq!(fs::read(result).unwrap(), b"1234567890");
        assert!(!task.join().unwrap()[1].contains("range:"));
    }
}

#[test]
fn missing_or_weak_validators_restart_instead_of_combining_unverifiable_files() {
    for etag in [None, Some("W/\"weak\""), Some("malformed")] {
        let (url, task) = server(vec![FULL]);
        let folder = tempfile::tempdir().unwrap();
        seed_partial(folder.path(), &url, b"old!", etag, false);
        let result = transfer(&url, folder.path(), &AtomicBool::new(false), |_, _| {}).unwrap();
        assert_eq!(fs::read(result).unwrap(), b"1234567890");
        assert!(!task.join().unwrap()[0].contains("range:"));
    }
}

#[test]
fn failed_or_html_responses_do_not_destroy_saved_progress() {
    for response in [
        &b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"[..],
        &b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"[..],
        &b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\nConnection: close\r\n\r\nerror"[..],
    ] {
        let (url, task) = server(vec![response]);
        let folder = tempfile::tempdir().unwrap();
        let destination = seed_partial(folder.path(), &url, b"1234", Some("\"one\""), false);
        assert!(transfer(&url, folder.path(), &AtomicBool::new(false), |_, _| {}).is_err());
        assert_eq!(fs::read(destination.with_extension("part")).unwrap(), b"1234");
        assert_eq!(partial_record(&destination, &url).unwrap().etag.as_deref(), Some("\"one\""));
        assert!(!cached_file(&destination, &url));
        task.join().unwrap();
    }
}

#[test]
fn restart_recovers_finished_download_on_either_side_of_the_final_rename() {
    for renamed in [false, true] {
        let folder = tempfile::tempdir().unwrap();
        let url = Url::parse("http://127.0.0.1:1/finished.safetensors").unwrap();
        let destination = seed_partial(folder.path(), &url, b"1234567890", Some("\"one\""), true);
        if renamed {
            fs::rename(destination.with_extension("part"), &destination).unwrap();
        }
        let result = transfer(&url, folder.path(), &AtomicBool::new(false), |_, _| {}).unwrap();
        assert_eq!(fs::read(result).unwrap(), b"1234567890");
        assert!(cached_file(&destination, &url));
    }
}

#[test]
fn resumed_download_uses_existing_fallback_before_a_new_preferred_folder() {
    let (url, task) = server(vec![REMAINDER]);
    let folder = tempfile::tempdir().unwrap();
    let preferred = folder.path().join("new-preferred");
    let fallback = folder.path().join("fallback");
    let destination = seed_partial(&fallback, &url, b"1234", Some("\"one\""), false);
    let result = super::super::transfer_from_roots(
        &url,
        &[preferred.clone(), fallback],
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap();
    assert_eq!(Path::new(&result), destination);
    assert!(!preferred.exists());
    assert!(task.join().unwrap()[0].contains("range: bytes=4-\r\n"));
}

#[test]
fn damaged_or_unrelated_metadata_cannot_resume_a_partial_file() {
    for metadata in [
        b"broken".as_slice(),
        br#"{"url":"https://other.example/file","etag":"\"one\"","total":10}"#,
    ] {
        let (url, task) = server(vec![FULL]);
        let folder = tempfile::tempdir().unwrap();
        let destination = seed_partial(folder.path(), &url, b"old!", Some("\"one\""), false);
        fs::write(destination.with_extension("part.json"), metadata).unwrap();
        let result = transfer(&url, folder.path(), &AtomicBool::new(false), |_, _| {}).unwrap();
        assert_eq!(fs::read(result).unwrap(), b"1234567890");
        assert!(!task.join().unwrap()[0].contains("range:"));
    }
}

#[test]
fn short_chunked_range_is_not_published_and_encoded_data_is_rejected() {
    for response in [
        &b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 4-9/10\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\n56\r\n0\r\n\r\n"[..],
        &b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 4-9/10\r\nContent-Encoding: gzip\r\nContent-Length: 6\r\nConnection: close\r\n\r\n567890"[..],
    ] {
        let (url, task) = server(vec![response]);
        let folder = tempfile::tempdir().unwrap();
        let destination = seed_partial(folder.path(), &url, b"1234", Some("\"one\""), false);
        assert!(transfer(&url, folder.path(), &AtomicBool::new(false), |_, _| {}).is_err());
        assert!(!destination.exists());
        assert!(!cached_file(&destination, &url));
        task.join().unwrap();
    }
}

#[cfg(windows)]
#[test]
fn another_process_cannot_write_to_an_active_partial_download() {
    use std::os::windows::fs::OpenOptionsExt;
    let folder = tempfile::tempdir().unwrap();
    let url = Url::parse("http://127.0.0.1:1/locked.safetensors").unwrap();
    let destination = seed_partial(folder.path(), &url, b"1234", Some("\"one\""), false);
    let locked = OpenOptions::new()
        .write(true)
        .share_mode(0)
        .open(destination.with_extension("part"))
        .unwrap();
    assert!(
        transfer(&url, folder.path(), &AtomicBool::new(false), |_, _| {})
            .unwrap_err()
            .contains("may be in use")
    );
    drop(locked);
    assert_eq!(
        fs::read(destination.with_extension("part")).unwrap(),
        b"1234"
    );
}
