//! Settings → Workers: the LAN workers this computer can generate on.
use crate::worker::{WorkerList, Workers};

async fn run<T: Send + 'static>(
    workers: &Workers,
    work: impl FnOnce(&Workers) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let workers = workers.clone();
    tauri::async_runtime::spawn_blocking(move || work(&workers))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn list_workers(workers: tauri::State<'_, Workers>) -> Result<WorkerList, String> {
    run(&workers, |workers| Ok(workers.list())).await
}

/// `None` generates on this computer.
#[tauri::command]
pub(crate) async fn select_worker(
    workers: tauri::State<'_, Workers>,
    id: Option<String>,
) -> Result<WorkerList, String> {
    run(&workers, move |workers| workers.select(id)).await
}

#[tauri::command]
pub(crate) async fn add_worker(
    workers: tauri::State<'_, Workers>,
    address: String,
) -> Result<WorkerList, String> {
    run(&workers, move |workers| workers.add(&address)).await
}

#[tauri::command]
pub(crate) async fn remove_worker(
    workers: tauri::State<'_, Workers>,
    key: String,
) -> Result<WorkerList, String> {
    run(&workers, move |workers| Ok(workers.remove(&key))).await
}

#[tauri::command]
pub(crate) async fn set_worker_token(
    workers: tauri::State<'_, Workers>,
    id: String,
    token: String,
) -> Result<WorkerList, String> {
    run(&workers, move |workers| Ok(workers.set_token(&id, &token))).await
}
