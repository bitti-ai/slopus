//! Bounded RGBA transport shared by desktop exports and LAN workers.
use std::sync::{atomic::{AtomicBool, Ordering}, mpsc::{self, Receiver, SyncSender}, Arc, Mutex};
use std::time::{Duration, Instant};

enum Output { Frame(Vec<u8>), Done(Result<u64, String>) }
pub struct Session {
    input: Mutex<SyncSender<Option<Vec<u8>>>>,
    output: Mutex<Receiver<Output>>,
    pub stopped: Arc<AtomicBool>,
    frame_bytes: usize,
    touched: Mutex<Instant>,
}

pub fn frame_bytes(width: u32, height: u32) -> Result<usize, String> {
    let bytes = width as u64 * height as u64 * 4;
    if width == 0 || height == 0 || width > 16384 || height > 16384 || bytes > 512 * 1024 * 1024 {
        return Err("Invalid upscale frame dimensions (maximum 512 MB per frame).".into());
    }
    Ok(bytes as usize)
}

fn send<T>(sender: &SyncSender<T>, mut value: T, stop: &AtomicBool) -> Result<(), String> {
    loop {
        if stop.load(Ordering::Relaxed) { return Err("Upscaling cancelled.".into()); }
        match sender.try_send(value) {
            Ok(()) => return Ok(()),
            Err(mpsc::TrySendError::Full(pending)) => { value = pending; std::thread::sleep(Duration::from_millis(10)); }
            Err(_) => return Err("Upscaler stream closed.".into()),
        }
    }
}

impl Session {
    pub fn start<F>(input: (u32, u32), output: (u32, u32), run: F) -> Result<Arc<Self>, String>
    where F: FnOnce(&AtomicBool, &mut (dyn FnMut() -> Result<Option<Vec<u8>>, String> + Send), &mut (dyn FnMut(Vec<u8>) -> Result<(), String> + Send)) -> Result<u64, String> + Send + 'static {
        let frame_bytes = frame_bytes(input.0, input.1)?;
        let output_bytes = self::frame_bytes(output.0, output.1)?;
        let (input_tx, input_rx) = mpsc::sync_channel(2);
        let (output_tx, output_rx) = mpsc::sync_channel(2);
        let stopped = Arc::new(AtomicBool::new(false));
        let session = Arc::new(Self { input: Mutex::new(input_tx), output: Mutex::new(output_rx), stopped: stopped.clone(), frame_bytes, touched: Mutex::new(Instant::now()) });
        std::thread::spawn(move || {
            let read_stop = stopped.clone();
            let mut read = move || loop {
                if read_stop.load(Ordering::Relaxed) { return Err("Upscaling cancelled.".into()); }
                match input_rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(frame) => return Ok(frame),
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(_) => return Err("Upscaler input closed.".into()),
                }
            };
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&stopped, &mut read, &mut |frame| {
                if frame.len() != output_bytes { return Err("Upscaler returned invalid frame dimensions.".into()); }
                send(&output_tx, Output::Frame(frame), &stopped)
            }))).unwrap_or_else(|_| Err("Upscale worker panicked.".into()));
            let _ = send(&output_tx, Output::Done(result), &stopped);
        });
        Ok(session)
    }
    pub fn touch(&self) { if let Ok(mut at) = self.touched.lock() { *at = Instant::now(); } }
    pub fn idle_for(&self) -> Duration { self.touched.lock().map(|at| at.elapsed()).unwrap_or_default() }
    pub fn push(&self, bytes: Vec<u8>) -> Result<(), String> {
        self.touch();
        if bytes.len() != self.frame_bytes { return Err("Invalid upscale frame size.".into()); }
        send(&*self.input.lock().map_err(|e| e.to_string())?, Some(bytes), &self.stopped)
    }
    pub fn finish(&self) -> Result<(), String> {
        self.touch();
        send(&*self.input.lock().map_err(|e| e.to_string())?, None, &self.stopped)
    }
    pub fn read(&self) -> Result<Vec<u8>, String> {
        self.touch();
        let receiver = self.output.lock().map_err(|e| e.to_string())?;
        loop {
            if self.stopped.load(Ordering::Relaxed) { return Err("Upscaling cancelled.".into()); }
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(Output::Frame(bytes)) => return Ok(bytes),
                Ok(Output::Done(result)) => return result.map(|_| Vec::new()),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return Err("Upscaler output closed.".into()),
            }
        }
    }
    pub fn cancel(&self) { self.stopped.store(true, Ordering::Relaxed); }
}
impl Drop for Session { fn drop(&mut self) { self.cancel(); } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streams_frames_and_finishes() {
        let session = Session::start((1, 1), (1, 1), |_, read, write| {
            let mut count = 0;
            while let Some(frame) = read()? { write(frame)?; count += 1; }
            Ok(count)
        }).unwrap();
        session.push(vec![1, 2, 3, 4]).unwrap(); session.finish().unwrap();
        assert_eq!(session.read().unwrap(), vec![1, 2, 3, 4]);
        assert!(session.read().unwrap().is_empty());
    }
    #[test]
    fn cancellation_releases_blocked_reader() {
        let session = Session::start((1, 1), (1, 1), |_, read, _| { read()?; Ok(0) }).unwrap();
        let waiting = session.clone();
        let reader = std::thread::spawn(move || waiting.read());
        session.cancel();
        assert!(reader.join().unwrap().unwrap_err().contains("cancelled"));
    }
}
