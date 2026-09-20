use crate::window::{CloseDecision, ExitGuard};
use crate::{
    agent, app_paths, app_settings, commands, cuda_support, diagnostics, export, slopfab, weights,
    window,
};
use std::io;
/// Portable distributions carry a marker because Windows updates launch an
/// installer and cannot replace a portable folder in place.
#[tauri::command]
fn app_updater_enabled() -> bool {
    !cfg!(debug_assertions)
        && std::env::current_exe()
            .ok()
            .and_then(|exe| {
                exe.parent()
                    .map(|dir| !dir.join("slopus-portable").exists())
            })
            .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager as _;
            let data_directory = app_paths::prepare(app.handle())?;
            app_settings::ensure_file(&data_directory)?;
            let window_config = app
                .config()
                .app
                .windows
                .first()
                .ok_or_else(|| io::Error::other("Missing main window configuration"))?;
            tauri::WebviewWindowBuilder::from_config(app, window_config)?
                .data_directory(data_directory)
                .build()?;
            match diagnostics::initialize(app.handle()) {
                Ok(info) => diagnostics::info(
                    "app",
                    "startup",
                    "Slopus started.",
                    serde_json::json!({
                        "version": app.package_info().version.to_string(),
                        "os": std::env::consts::OS,
                        "architecture": std::env::consts::ARCH,
                        "sessionId": info.session_id,
                    }),
                ),
                Err(error) => eprintln!("Could not initialize diagnostic logging: {error}"),
            }
            if let Some(window) = app.get_webview_window("main") {
                window::apply_theme(&window);
            }
            Ok(())
        })
        .manage(crate::media::access::MediaAccess::default())
        .manage(agent::ProviderDiscovery::default())
        .manage(agent::AgentRuntime::default())
        .manage(slopfab::SlopfabRuntime::default())
        .manage(weights::WeightDownloads::default())
        .manage(ExitGuard::default())
        .on_window_event(|window, event| {
            use tauri::{Emitter as _, Manager as _};
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            let guard = window.state::<ExitGuard>();
            match guard.on_close_requested() {
                CloseDecision::Close => {}
                CloseDecision::Waiting => api.prevent_close(),
                CloseDecision::Ask => {
                    api.prevent_close();
                    // If the question cannot even be delivered there is nobody
                    // to answer it, and refusing to close would be worse than
                    // closing unasked.
                    if window.emit("app-close-requested", ()).is_err() {
                        guard.answered(true);
                        let _ = window.destroy();
                    }
                }
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            app_updater_enabled,
            weights::download_weight,
            weights::lora::prepare_lora,
            weights::cancel_weight_download,
            weights::check_weight_files,
            weights::find_downloaded_weights,
            weights::remove_downloaded_weights,
            weights::weight_download_hardware,
            cuda_support::open_cuda_download,
            commands::diagnostics::write_diagnostic_log,
            commands::diagnostics::diagnostic_log_info,
            commands::diagnostics::reveal_diagnostic_log,
            commands::project::open_project,
            commands::project::delete_project,
            commands::project::choose_project_folder,
            commands::media::choose_initial_reference_images,
            commands::media::choose_reference_image,
            commands::media::choose_reference_images,
            commands::media::choose_reference_video,
            commands::media::choose_reference_files,
            commands::generation::create_reference_video,
            commands::generation::append_reference_video,
            commands::generation::set_reference_video_audio,
            commands::generation::release_reference_videos,
            commands::media::import_media_files,
            commands::media::read_project_file,
            commands::media::read_external_media_file,
            commands::project::create_project,
            commands::project::save_project,
            commands::runtime::runtime_status,
            commands::agent::list_agent_models,
            commands::runtime::slopfab_status,
            commands::runtime::choose_engine_path,
            commands::agent::run_agent_turn,
            commands::agent::execute_agent_commands,
            commands::agent::cancel_agent_turn,
            commands::generation::resolve_slopfab_plan,
            commands::generation::enqueue_slopfab_generation,
            commands::generation::cancel_slopfab_generation,
            window::set_generation_active,
            window::answer_app_close,
            commands::artifacts::write_generated_video,
            commands::artifacts::write_scene_last_frame,
            commands::artifacts::write_timeline_thumbnail,
            commands::artifacts::purge_timeline_thumbnails,
            commands::artifacts::generated_summary,
            commands::artifacts::save_reference_icon,
            commands::artifacts::list_builtin_reference_icons,
            commands::artifacts::read_builtin_reference_icon,
            commands::artifacts::save_builtin_reference_icon,
            commands::artifacts::generated_frame,
            commands::artifacts::generated_audio,
            commands::artifacts::release_generated_frames,
            export::choose_export_destination,
            export::write_export_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Slopus");
}
