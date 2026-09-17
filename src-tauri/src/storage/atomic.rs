use std::{fs, io, path::{Path, PathBuf}};
#[cfg(not(windows))]
pub(crate) fn atomic_replace(temporary: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(temporary, destination)?;
    fs::File::open(destination.parent().expect("project file has a parent"))?.sync_all()
}

#[cfg(windows)]
pub(crate) fn atomic_replace(temporary: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::GetLastError,
        Storage::FileSystem::{
            MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH,
        },
    };

    let temporary_wide: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let succeeded = unsafe {
        if destination.exists() {
            ReplaceFileW(
                destination_wide.as_ptr(),
                temporary_wide.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } else {
            MoveFileExW(
                temporary_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if succeeded == 0 {
        let code = unsafe { GetLastError() };
        Err(io::Error::from_raw_os_error(code as i32))
    } else {
        Ok(())
    }
}

pub(crate) fn write_atomically(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut temporary = destination.as_os_str().to_os_string();
    temporary.push(".part");
    let temporary = PathBuf::from(temporary);
    use std::io::Write;
    let written = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not write {}: {error}", temporary.to_string_lossy()));
    }
    if let Err(error) = atomic_replace(&temporary, destination) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Could not save {}: {error}",
            destination.to_string_lossy()
        ));
    }
    Ok(())
}