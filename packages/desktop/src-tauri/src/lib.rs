use crate::diagnostics::PerformanceCaptureState;
use crate::power::{set_keep_awake, start_keep_awake_worker, KeepAwakeState};
use crate::resource_owners::release_window_resources;
#[cfg(target_os = "windows")]
use crate::settings::apply_browser_webview_settings;
use crate::settings::read_settings;
use crate::terminal::TerminalState;
use crate::tray::{configure_tray, TrayState};
use std::sync::Mutex;
use tauri::Manager;

mod attachments;
mod browser;
mod diagnostics;
mod host_runtime;
mod notifications;
mod power;
mod settings;
mod terminal;
mod tray;
mod windows;

mod filesystem;

mod external_open;

mod host_supervisor;

mod resource_owners;

#[cfg(feature = "stage-one-smoke")]
pub mod stage_one_smoke;

pub fn run() {
    #[cfg(target_os = "windows")]
    apply_browser_webview_settings();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            app.manage(TerminalState::default());
            app.manage(PerformanceCaptureState::default());
            let settings = read_settings(&app.handle())?;
            let keep_awake = KeepAwakeState(Mutex::new(start_keep_awake_worker()));
            app.manage(keep_awake);
            if let Err(error) = set_keep_awake(&app.handle(), settings.keep_awake) {
                eprintln!("Vagus could not apply keep-awake setting: {error}");
            }
            let tray_state = TrayState(Mutex::new(None));
            configure_tray(
                &app.handle(),
                settings.close_to_tray,
                &settings.interface_language,
                &tray_state.0,
            )
            .map_err(std::io::Error::other)?;
            app.manage(tray_state);
            app.manage(resource_owners::BrowserOwners::default());
            host_supervisor::start(app.handle().clone()).map_err(std::io::Error::other)?;
            if let Some(window) = app.get_webview_window("main") {
                let close_window = window.clone();
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if read_settings(&app_handle)
                            .map(|settings| settings.close_to_tray)
                            .unwrap_or(false)
                        {
                            api.prevent_close();
                            let _ = close_window.hide();
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_supervisor::host_startup_error,
            host_supervisor::host_connection,
            external_open::open_in_file_manager,
            external_open::open_pi_package_market,
            filesystem::filesystem_list_directory,
            filesystem::filesystem_read_file,
            filesystem::filesystem_read_image,
            filesystem::filesystem_write_file,
            filesystem::filesystem_open_path,
            filesystem::open_external_url,
            browser::browser_create,
            browser::browser_control,
            browser::browser_capture_element,
            browser::browser_clear_data,
            terminal::terminal_create,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            windows::open_session_window,
            windows::open_workspace_window,
            settings::get_app_settings,
            attachments::save_image_attachment,
            settings::save_app_settings,
            windows::restart_app,
            notifications::show_task_notification,
            diagnostics::start_performance_capture,
            diagnostics::append_performance_capture,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Vagus desktop");

    app.run(|handle, event| {
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } = &event
        {
            release_window_resources(handle, label);
        }
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<TerminalState>() {
                let terminals = state
                    .0
                    .lock()
                    .ok()
                    .map(|mut terminals| {
                        terminals
                            .drain()
                            .map(|(_, terminal)| terminal)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                for terminal in terminals {
                    if let Ok(mut child) = terminal.child.lock() {
                        let _ = child.kill();
                    }
                }
            }
            host_supervisor::stop(handle);
        }
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<KeepAwakeState>() {
                if let Ok(sender) = state.0.lock() {
                    let _ = sender.send(false);
                }
            }
        }
    });
}
