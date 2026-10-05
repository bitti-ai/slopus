use crate::slopfab::upscale::{self, UpscaleConfig};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, LazyLock, Mutex,
    },
    time::Duration,
};
use tauri::ipc::{InvokeBody, Request, Response};

enum Output {
    Frame(Vec<u8>),
    Done(Result<u64, String>),
}
struct Session {
    input: Mutex<SyncSender<Option<Vec<u8>>>>,
    output: Mutex<Receiver<Output>>,
    stopped: Arc<AtomicBool>,
    frame_bytes: usize,
}
static SESSIONS: LazyLock<Mutex<HashMap<String, Arc<Session>>>> = LazyLock::new(Default::default);
fn session(id: &str) -> Result<Arc<Session>, String> {
    SESSIONS
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .cloned()
        .ok_or("Upscale session has ended.".into())
}
fn send<T>(sender: &SyncSender<T>, mut value: T, stop: &AtomicBool) -> Result<(), String> {
    loop {
        if stop.load(Ordering::Relaxed) {
            return Err("Upscaling cancelled.".into());
        }
        match sender.try_send(value) {
            Ok(()) => return Ok(()),
            Err(mpsc::TrySendError::Full(pending)) => {
                value = pending;
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                return Err("Upscaler stream closed.".into())
            }
        }
    }
}

#[tauri::command]
pub(crate) fn start_export_upscale(
    id: String,
    config: UpscaleConfig,
    input_width: u32,
    input_height: u32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    upscale::validate(&config, (input_width, input_height), (width, height))?;
    let mut sessions = SESSIONS.lock().map_err(|e| e.to_string())?;
    if !sessions.is_empty() {
        return Err("Another upscale export is already running.".into());
    }
    let (input_tx, input_rx) = mpsc::sync_channel(2);
    let (output_tx, output_rx) = mpsc::sync_channel(2);
    let stopped = Arc::new(AtomicBool::new(false));
    sessions.insert(
        id,
        Arc::new(Session {
            input: Mutex::new(input_tx),
            output: Mutex::new(output_rx),
            stopped: stopped.clone(),
            frame_bytes: input_width as usize * input_height as usize * 4,
        }),
    );
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            upscale::run(
                &config,
                (input_width, input_height),
                (width, height),
                5,
                &stopped,
                &mut || loop {
                    if stopped.load(Ordering::Relaxed) {
                        return Err("Upscaling cancelled.".into());
                    }
                    match input_rx.recv_timeout(Duration::from_millis(50)) {
                        Ok(frame) => return Ok(frame),
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(_) => return Err("Upscaler input closed.".into()),
                    }
                },
                &mut |frame| send(&output_tx, Output::Frame(frame), &stopped),
            )
        }))
        .unwrap_or_else(|_| Err("Upscale worker panicked.".into()));
        let _ = send(&output_tx, Output::Done(result), &stopped);
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn push_export_upscale(request: Request<'_>) -> Result<(), String> {
    let id = crate::commands::binary::decoded_header(&request, "x-upscale-id")?;
    let session = session(&id)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw RGBA pixels.".into());
    };
    if bytes.len() != session.frame_bytes {
        return Err("Invalid upscale frame size.".into());
    }
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        send(
            &*session.input.lock().map_err(|e| e.to_string())?,
            Some(bytes),
            &session.stopped,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn finish_export_upscale(id: String) -> Result<(), String> {
    let session = session(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        send(
            &*session.input.lock().map_err(|e| e.to_string())?,
            None,
            &session.stopped,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn read_export_upscale(id: String) -> Result<Response, String> {
    let session = session(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let receiver = session.output.lock().map_err(|e| e.to_string())?;
        loop {
            if session.stopped.load(Ordering::Relaxed) {
                return Err("Upscaling cancelled.".into());
            }
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(Output::Frame(bytes)) => return Ok(Response::new(bytes)),
                Ok(Output::Done(result)) => return result.map(|_| Response::new(Vec::<u8>::new())),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return Err("Upscaler output closed.".into()),
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) fn cancel_export_upscale(id: String) -> Result<(), String> {
    if let Some(session) = SESSIONS.lock().map_err(|e| e.to_string())?.remove(&id) {
        session.stopped.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_releases_a_producer_blocked_by_backpressure() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        sender.send(1).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let producer_stop = stop.clone();
        let producer = std::thread::spawn(move || send(&sender, 2, &producer_stop));
        stop.store(true, Ordering::Relaxed);
        assert!(producer.join().unwrap().unwrap_err().contains("cancelled"));
    }
}
