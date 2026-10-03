use crate::window::{CloseDecision, ExitGuard};
use crate::{
    agent, app_paths, app_settings, commands, cuda_support, diagnostics, export, native_shell,
    slopfab, weights, window, worker,
};
use std::io;
/// Portable copies check for updates but open the release page for manual updates.
#[tauri::command]
fn app_updater_mode() -> Result<&'static str, String> {
    if cfg!(debug_assertions) { return Ok("disabled"); }
    /* On Linux the updater replaces only an AppImage (whose runtime sets
       APPIMAGE); .deb and .rpm installs belong to the package manager. */
    if cfg!(target_os = "linux") {
        return Ok(if std::env::var_os("APPIMAGE").is_some() { "installed" } else { "portable" });
    }
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let directory = exe.parent().ok_or("Could not locate the application folder.")?;
    Ok(if directory.join("slopus-portable").exists() { "portable" } else { "installed" })
}

#[tauri::command]
fn open_app_releases() -> Result<(), String> {
    crate::external_links::open_browser("https://github.com/bitti-ai/slopus/releases")
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
            /* Built hidden and shown at the end of setup, so the restore of the
               remembered size/position (tauri-plugin-window-state, which runs as
               the window is created) never shows as a jump. */
            let mut builder = tauri::WebviewWindowBuilder::from_config(app, window_config)?
                .data_directory(data_directory)
                .visible(false);
            #[cfg(windows)]
            {
                builder = builder
                    /* Needs WebView2 125+; older runtimes keep the classic bars. */
                    .scroll_bar_style(tauri::webview::ScrollBarStyle::FluentOverlay)
                    .general_autofill_enabled(false);
            }
            if native_shell::window_state_missing(app.handle()) {
                if let Ok(Some(monitor)) = app.primary_monitor() {
                    let area = monitor.work_area();
                    let (width, height) = native_shell::first_launch_size(
                        area.size.width,
                        area.size.height,
                        monitor.scale_factor(),
                        (
                            window_config.min_width.unwrap_or(900.0),
                            window_config.min_height.unwrap_or(650.0),
                        ),
                    );
                    builder = builder.inner_size(width, height).center();
                }
            }
            /* Mica on Windows 11: the window and the webview go transparent and
               the page is told before its first script runs (theme-boot.js
               reads the global). Windows 10 keeps the opaque ground. */
            let mica = native_shell::mica_supported();
            if mica {
                builder = builder
                    .transparent(true)
                    .background_color(tauri::window::Color(0, 0, 0, 0))
                    .effects(tauri::utils::config::WindowEffectsConfig {
                        effects: vec![tauri::window::Effect::Mica],
                        ..Default::default()
                    })
                    .initialization_script(native_shell::backdrop_script());
            }
            app.state::<native_shell::Backdrop>()
                .mica
                .store(mica, std::sync::atomic::Ordering::Release);
            let window = builder.build()?;
            native_shell::round_corners(&window);
            native_shell::disable_browser_behaviour(&window);
            #[cfg(target_os = "linux")]
            crate::linux_webview::configure(&window);
            native_shell::watch_accent(app.handle());
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
            app.state::<worker::Workers>().start(app.handle(), &app_paths::data_directory(app.handle()));
            window::apply_theme(&window);
            window.show()?;
            let _ = window.set_focus();
            Ok(())
        })
        .manage(crate::media::access::MediaAccess::default())
        .manage(agent::ProviderDiscovery::default())
        .manage(agent::AgentRuntime::default())
        .manage(slopfab::SlopfabRuntime::default())
        .manage(weights::WeightDownloads::default())
        .manage(worker::Workers::default())
        .manage(ExitGuard::default())
        .manage(native_shell::Backdrop::default())
        .manage(native_shell::SystemAccent::default())
        .on_menu_event(|app, event| {
            native_shell::handle_menu_event(app, event.id().as_ref());
        })
        .on_window_event(|window, event| {
            use tauri::Manager as _;
            use tauri_plugin_dialog::{DialogExt as _, MessageDialogButtons, MessageDialogKind};
            match event {
                /* The OS theme flipped: repaint the opaque ground (a no-op under
                   Mica, whose tint follows the window theme by itself). */
                tauri::WindowEvent::ThemeChanged(_) => {
                    if let Some(webview_window) = window.get_webview_window(window.label()) {
                        window::apply_theme(&webview_window);
                    }
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let guard = window.state::<ExitGuard>();
                    match guard.on_close_requested() {
                        CloseDecision::Close => {}
                        CloseDecision::Waiting => api.prevent_close(),
                        CloseDecision::Ask => {
                            api.prevent_close();
                            let jobs = guard
                                .jobs
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .clone();
                            let answering = window.clone();
                            /* Non-blocking: the box runs its own modal loop,
                               owned by (and disabling) this window, and the
                               answer arrives on the callback. Esc and the box's
                               own close button answer "Keep generating". */
                            window
                                .dialog()
                                .message(window::exit_guard_message(&jobs))
                                .title(window::EXIT_GUARD_TITLE)
                                .kind(MessageDialogKind::Warning)
                                .buttons(MessageDialogButtons::OkCancelCustom(
                                    window::EXIT_GUARD_CONFIRM.to_string(),
                                    window::EXIT_GUARD_CANCEL.to_string(),
                                ))
                                .parent(window)
                                .show(move |confirmed| {
                                    answering.state::<ExitGuard>().answered(confirmed);
                                    if confirmed {
                                        let _ = answering.destroy();
                                    }
                                });
                        }
                    }
                }
                _ => {}
            }
        })
        .plugin(tauri_plugin_dialog::init())
        /* Size, position and maximized only: decorations are always off and
           visibility is ours (the window is shown at the end of setup). */
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::artifacts::save_generated_image,
            commands::artifacts::open_image_source,
            commands::artifacts::export_generated_image,
            app_updater_mode,
            open_app_releases,
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
            commands::project::choose_new_project_folder,
            commands::project::inspect_new_project_folder,
            commands::media::choose_initial_reference_images,
            commands::media::choose_reference_image,
            commands::media::choose_reference_images,
            commands::media::choose_reference_video,
            commands::media::choose_reference_files,
            commands::generation::create_reference_video,
            commands::generation::append_reference_video,
            commands::generation::set_reference_video_audio,
            commands::generation::release_reference_videos,
            commands::generation::create_reference_audio,
            commands::generation::release_reference_audios,
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
            commands::workers::list_workers,
            commands::workers::select_worker,
            commands::workers::add_worker,
            commands::workers::remove_worker,
            commands::workers::set_worker_token,
            window::set_generation_active,
            window::answer_app_close,
            native_shell::system_accent_colors,
            native_shell::show_text_context_menu,
            native_shell::reveal_in_explorer,
            native_shell::pick_file,
            commands::artifacts::write_generated_video,
            commands::artifacts::write_scene_last_frame,
            commands::artifacts::write_reference_frame,
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
            export::default_export_destination,
            export::export_destination_exists,
            export::open_export_file,
            export::read_lut_file,
            export::write_export_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Slopus");
}
