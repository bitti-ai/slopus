//! Files a worker holds for its clients: weights it downloaded itself, using
//! the same downloader and folders as the desktop app, and files clients
//! uploaded because they exist only on the client's disk.
use super::protocol::{safe_relative_path, valid_key, FilePreparation, FileRef};
use crate::weights;
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Mutex},
};

pub(crate) struct FileStore {
    uploads: PathBuf,
    weight_roots: Vec<PathBuf>,
    /// One download at a time, like the desktop app; parallel clients that
    /// need the same weights then find the finished file instead.
    downloads: Mutex<()>,
}

impl FileStore {
    pub(crate) fn new(data: &Path, weight_roots: Vec<PathBuf>) -> Result<Self, String> {
        let uploads = data.join("uploads");
        fs::create_dir_all(&uploads).map_err(|error| format!("Could not create {}: {error}", uploads.display()))?;
        Ok(Self { uploads, weight_roots, downloads: Mutex::new(()) })
    }

    fn upload_root(&self, key: &str) -> Result<PathBuf, String> {
        if !valid_key(key) {
            return Err("Invalid upload key.".into());
        }
        Ok(self.uploads.join(key))
    }

    fn entry_path(&self, key: &str, entry: &str) -> Result<PathBuf, String> {
        Ok(self.upload_root(key)?.join(safe_relative_path(entry)?))
    }

    /// Upload entries this worker does not hold yet.
    pub(crate) fn missing(&self, files: &[FileRef]) -> Result<Vec<(String, String)>, String> {
        let mut missing = Vec::new();
        for file in files {
            if let FileRef::Upload { key, entries, .. } = file {
                for entry in entries {
                    let path = self.entry_path(key, &entry.path)?;
                    if !fs::metadata(&path).is_ok_and(|meta| meta.is_file() && meta.len() == entry.bytes) {
                        missing.push((key.clone(), entry.path.clone()));
                    }
                }
            }
        }
        Ok(missing)
    }

    /// Streams one uploaded entry to disk. It only takes its final name once
    /// every announced byte has arrived.
    pub(crate) fn receive(&self, key: &str, entry: &str, bytes: u64, body: &mut dyn Read) -> Result<(), String> {
        let destination = self.entry_path(key, entry)?;
        let directory = destination.parent().ok_or("Invalid upload path.")?;
        fs::create_dir_all(directory).map_err(|error| error.to_string())?;
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).map_err(|error| error.to_string())?;
        let temporary = directory.join(format!(".upload-{:x}.part", u64::from_le_bytes(random)));
        let result = (|| {
            let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
            let copied = io::copy(&mut body.take(bytes), &mut file).map_err(|error| format!("Upload interrupted: {error}"))?;
            if copied != bytes {
                return Err(format!("Upload incomplete: received {copied} of {bytes} bytes."));
            }
            file.flush().map_err(|error| error.to_string())?;
            drop(file);
            if destination.exists() {
                fs::remove_file(&destination).map_err(|error| error.to_string())?;
            }
            fs::rename(&temporary, &destination).map_err(|error| error.to_string())
        })();
        let _ = fs::remove_file(&temporary);
        result
    }

    /// The local path for one file, without network access. Fails when the
    /// file still has to be uploaded or downloaded.
    pub(crate) fn resolve(&self, file: &FileRef) -> Result<PathBuf, String> {
        match file {
            FileRef::Url { url, lora } => {
                let path = weights::cached_weight(url, &self.weight_roots)
                    .ok_or_else(|| format!("The worker has not downloaded {url} yet."))?;
                if *lora && !prepared(&path) {
                    return Err(format!("The worker has not prepared the LoRA {url} yet."));
                }
                Ok(path)
            }
            FileRef::Upload { key, name, directory, entries, .. } => {
                if !self.missing(std::slice::from_ref(file))?.is_empty() {
                    return Err(format!("{name} has not been uploaded to the worker."));
                }
                if *directory {
                    self.upload_root(key)
                } else {
                    match entries.as_slice() {
                        [entry] if entry.path == *name => self.entry_path(key, name),
                        _ => Err(format!("{name} must be uploaded as one file.")),
                    }
                }
            }
        }
    }

    /// Downloads and prepares everything `files` names that is not here yet.
    pub(crate) fn prepare(
        &self,
        files: &[FileRef],
        cancelled: &AtomicBool,
        mut report: impl FnMut(&FilePreparation),
    ) -> Result<(), String> {
        let downloads: Vec<_> = files.iter().filter_map(|file| match file {
            FileRef::Url { url, lora } => Some((url, *lora)),
            FileRef::Upload { .. } => None,
        }).collect();
        let mut status = FilePreparation { state: "running".into(), files: downloads.len(), ..Default::default() };
        report(&status);
        for (url, lora) in downloads {
            status.file = Some(url.clone());
            status.downloaded = 0;
            status.total = None;
            report(&status);
            let path = match weights::cached_weight(url, &self.weight_roots) {
                Some(path) => path,
                None => {
                    let _one_at_a_time = self.downloads.lock().map_err(|_| "Download lock failed.")?;
                    weights::fetch_weight(url, &self.weight_roots, cancelled, |downloaded, total| {
                        status.downloaded = downloaded;
                        status.total = total;
                        report(&status);
                    })?
                }
            };
            if lora && !prepared(&path) {
                // Same preparation the desktop app runs after a LoRA download.
                // Wait for running jobs rather than failing like the UI does.
                let _models = crate::slopfab::MODEL_ACCESS.write().map_err(|_| "Model access lock failed.")?;
                weights::lora::prepare_exclusive(&path, 2688, true)?;
                mark_prepared(&path)?;
            }
            status.completed += 1;
            report(&status);
        }
        Ok(())
    }
}

fn prepared_marker(path: &Path) -> PathBuf {
    path.with_extension("worker-prepared")
}

fn prepared(path: &Path) -> bool {
    let size = fs::metadata(path).map(|meta| meta.len()).ok();
    fs::read_to_string(prepared_marker(path)).ok().and_then(|text| text.trim().parse().ok()) == size
}

fn mark_prepared(path: &Path) -> Result<(), String> {
    let size = fs::metadata(path).map_err(|error| error.to_string())?.len();
    fs::write(prepared_marker(path), size.to_string()).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::protocol::UploadEntry;

    fn upload(name: &str, directory: bool, entries: &[(&str, u64)]) -> FileRef {
        FileRef::Upload {
            key: "00112233aabbccdd".into(), name: name.into(), directory, lora: false,
            entries: entries.iter().map(|(path, bytes)| UploadEntry { path: path.to_string(), bytes: *bytes }).collect(),
        }
    }

    #[test]
    fn uploads_resolve_only_once_every_byte_has_arrived() {
        let folder = tempfile::tempdir().unwrap();
        let store = FileStore::new(folder.path(), vec![folder.path().join("weights")]).unwrap();
        let file = upload("a.png", false, &[("a.png", 4)]);
        assert_eq!(store.missing(std::slice::from_ref(&file)).unwrap().len(), 1);
        assert!(store.resolve(&file).is_err());
        assert!(store.receive("00112233aabbccdd", "a.png", 4, &mut &b"da"[..]).is_err());
        assert!(store.resolve(&file).is_err());
        store.receive("00112233aabbccdd", "a.png", 4, &mut &b"data"[..]).unwrap();
        assert!(store.missing(std::slice::from_ref(&file)).unwrap().is_empty());
        assert_eq!(fs::read(store.resolve(&file).unwrap()).unwrap(), b"data");
    }

    #[test]
    fn folders_resolve_to_their_root_and_refuse_escaping_entries() {
        let folder = tempfile::tempdir().unwrap();
        let store = FileStore::new(folder.path(), Vec::new()).unwrap();
        let tokenizer = upload("tokenizer", true, &[("vocab.json", 2), ("nested/merges.txt", 1)]);
        store.receive("00112233aabbccdd", "vocab.json", 2, &mut &b"{}"[..]).unwrap();
        store.receive("00112233aabbccdd", "nested/merges.txt", 1, &mut &b"m"[..]).unwrap();
        let root = store.resolve(&tokenizer).unwrap();
        assert!(root.join("nested").join("merges.txt").is_file());
        assert!(store.receive("00112233aabbccdd", "../escape", 1, &mut &b"x"[..]).is_err());
        assert!(store.receive("../../x", "a", 1, &mut &b"x"[..]).is_err());
        assert!(!folder.path().join("escape").exists());
    }

    #[test]
    fn urls_must_be_downloaded_before_they_resolve() {
        let folder = tempfile::tempdir().unwrap();
        let store = FileStore::new(folder.path(), vec![folder.path().join("weights")]).unwrap();
        let file = FileRef::Url { url: "https://example.com/model.safetensors".into(), lora: false };
        assert!(store.resolve(&file).unwrap_err().contains("not downloaded"));
    }
}
