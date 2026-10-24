use super::*;
type Calibrate = unsafe extern "C" fn(*const Request, *const c_char, i32, i32, Option<unsafe extern "C" fn(i32, i32, *mut c_void) -> i32>, *mut c_void) -> i32;
type SetLcs = unsafe extern "C" fn(*mut Request, *const c_char, *const c_char) -> i32;
type SetMask = unsafe extern "C" fn(*mut Request, *const f32, usize) -> i32;
const UPDATE: &str = "Generation effects require SlopFab API 1.31 or newer. Update the runtime on the machine running generation.";

impl Api {
    pub fn require_lcs(&self) -> Result<(), String> {
        unsafe {
            self._library.get::<Calibrate>(b"slopfab_lcs_calibrate\0").map_err(|_| UPDATE)?;
            self._library.get::<SetLcs>(b"slopfab_request_set_lcs\0").map_err(|_| UPDATE)?;
            self._library.get::<SetMask>(b"slopfab_request_set_lcs_mask\0").map_err(|_| UPDATE)?;
        }
        Ok(())
    }
    pub fn set_lcs(&self, r: *mut Request, path: &Path, settings: &str) -> Result<(), String> {
        let path = path_cstring(path)?;
        let settings = CString::new(settings).map_err(|_| "Invalid LCS settings.")?;
        unsafe {
            let set = self._library.get::<SetLcs>(b"slopfab_request_set_lcs\0").map_err(|_| UPDATE)?;
            self.error(set(r, path.as_ptr(), settings.as_ptr()))
        }
    }
    pub fn set_lcs_mask(&self, r: *mut Request, mask: &[f32]) -> Result<(), String> {
        unsafe {
            let set = self._library.get::<SetMask>(b"slopfab_request_set_lcs_mask\0").map_err(|_| UPDATE)?;
            self.error(set(r, if mask.is_empty() { ptr::null() } else { mask.as_ptr() }, mask.len()))
        }
    }
    pub fn calibrate_lcs(&self, r: *mut Request, path: &Path, progress: &mut dyn FnMut(i32, i32) -> bool) -> Result<(), String> {
        let path = path_cstring(path)?;
        // Native calibration is synchronous and never retains this borrowed callback.
        struct Callback<'a>(&'a mut dyn FnMut(i32, i32) -> bool);
        unsafe extern "C" fn report(completed: i32, total: i32, data: *mut c_void) -> i32 {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let callback = &mut *data.cast::<Callback<'_>>();
                if (callback.0)(completed, total) { 0 } else { 1 }
            })).unwrap_or(2)
        }
        let mut callback = Callback(progress);
        unsafe {
            let calibrate = self._library.get::<Calibrate>(b"slopfab_lcs_calibrate\0").map_err(|_| UPDATE)?;
            self.error(calibrate(r, path.as_ptr(), 64, 256, Some(report), (&mut callback as *mut Callback<'_>).cast()))
        }
    }
}
