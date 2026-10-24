//! Avoid rereading multi-GB VAEs while their identity and change stamps match.
use std::{collections::BTreeMap, fs::File, path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}, time::SystemTime};

#[derive(PartialEq, Eq)]
struct FileStamp {
    bytes: u64,
    modified: SystemTime,
    identity: [u64; 4],
}

impl FileStamp {
    fn read(file: &File) -> Result<Self, String> {
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        #[cfg(unix)]
        let identity = {
            use std::os::unix::fs::MetadataExt;
            [metadata.dev(), metadata.ino(), metadata.ctime() as u64, metadata.ctime_nsec() as u64]
        };
        #[cfg(windows)]
        let identity = {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, GetFileInformationByHandleEx, BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FileBasicInfo};
            let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
            let mut basic: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
            let handle = file.as_raw_handle();
            // ChangeTime also detects same-size edits whose mtime was restored.
            if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 || unsafe {
                GetFileInformationByHandleEx(handle, FileBasicInfo, (&mut basic as *mut FILE_BASIC_INFO).cast(), std::mem::size_of::<FILE_BASIC_INFO>() as u32)
            } == 0 { return Err(std::io::Error::last_os_error().to_string()); }
            [u64::from(info.dwVolumeSerialNumber), u64::from(info.nFileIndexHigh), u64::from(info.nFileIndexLow), basic.ChangeTime as u64]
        };
        Ok(Self { bytes: metadata.len(), modified: metadata.modified().map_err(|e| e.to_string())?, identity })
    }
}

#[derive(Default)]
pub(super) struct Fingerprints(BTreeMap<PathBuf, (FileStamp, String)>);

pub(super) fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) { Err("Generation effects preparation cancelled.".into()) } else { Ok(()) }
}

impl Fingerprints {
    pub(super) fn get(&mut self, vae: &Path, cancel: &AtomicBool, hash: impl FnOnce(&mut File) -> Result<String, String>) -> Result<String, String> {
        check_cancel(cancel)?;
        let path = vae.canonicalize().map_err(|e| format!("Cannot locate the VAE for generation effects: {e}"))?;
        let mut file = File::open(&path).map_err(|e| format!("Cannot read the VAE for generation effects: {e}"))?;
        let stamp = FileStamp::read(&file)?;
        if let Some((cached_stamp, digest)) = self.0.get(&path) {
            if cached_stamp == &stamp { return Ok(digest.clone()); }
        }
        // Remove obsolete entries even if hashing is subsequently cancelled.
        self.0.remove(&path);
        let digest = hash(&mut file)?;
        check_cancel(cancel)?;
        if FileStamp::read(&file)? != stamp || FileStamp::read(&File::open(&path).map_err(|e| e.to_string())?)? != stamp {
            return Err("The VAE changed while checking generation effects. Retry generation.".into());
        }
        if self.0.len() >= 32 { self.0.clear(); }
        self.0.insert(path, (stamp, digest.clone()));
        Ok(digest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Read};
    fn hash(file: &mut File) -> Result<String, String> {
        let mut value = String::new(); file.read_to_string(&mut value).map_err(|e| e.to_string())?; Ok(value)
    }
    #[test]
    fn unchanged_vae_is_not_read_and_replacements_and_edits_invalidate() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("vae");
        fs::write(&path, "first").unwrap();
        let cancel = AtomicBool::new(false); let mut cache = Fingerprints::default();
        assert_eq!(cache.get(&path, &cancel, hash).unwrap(), "first");
        assert_eq!(cache.get(&path, &cancel, |_| panic!("unchanged VAE must not be read")).unwrap(), "first");
        let time = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, "other").unwrap();
        File::options().write(true).open(&path).unwrap().set_modified(time).unwrap();
        assert_eq!(cache.get(&path, &cancel, hash).unwrap(), "other");
        let replacement = dir.path().join("replacement"); fs::write(&replacement, "third").unwrap();
        File::options().write(true).open(&replacement).unwrap().set_modified(time).unwrap();
        fs::remove_file(&path).unwrap(); fs::rename(replacement, &path).unwrap();
        assert_eq!(cache.get(&path, &cancel, hash).unwrap(), "third");
        fs::remove_file(&path).unwrap();
        assert!(cache.get(&path, &cancel, hash).is_err());
    }
    #[test]
    fn failed_cancelled_and_changed_reads_are_never_cached() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("vae");
        fs::write(&path, "first").unwrap();
        let cancel = AtomicBool::new(false); let mut cache = Fingerprints::default();
        assert!(cache.get(&path, &cancel, |_| Err("read error".into())).is_err());
        assert!(cache.get(&path, &cancel, |_| { cancel.store(true, Ordering::Release); Ok("bad".into()) }).is_err());
        cancel.store(false, Ordering::Release);
        assert!(cache.get(&path, &cancel, |_| { fs::write(&path, "changed").unwrap(); Ok("bad".into()) }).is_err());
        assert_eq!(cache.get(&path, &cancel, hash).unwrap(), "changed");
        cancel.store(true, Ordering::Release);
        assert!(cache.get(&path, &cancel, |_| panic!("cancel before cache lookup")).is_err());
    }
}
