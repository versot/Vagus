use crate::settings::read_settings;
use tauri::{AppHandle, Manager};
#[cfg(not(windows))]
use tauri_plugin_notification::NotificationExt;

#[tauri::command]
pub(crate) fn show_task_notification(
    app: AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    let settings = read_settings(&app)?;
    if !settings.task_notifications {
        return Ok(());
    }

    #[cfg(windows)]
    {
        let mut notification = notify_rust::Notification::new();
        notification.summary(&title).body(&body);

        // Match the Tauri notification plugin: development builds use the
        // PowerShell identity, while installed builds use the registered Vagus ID.
        let exe_dir = std::env::current_exe()
            .map_err(|error| error.to_string())?
            .parent()
            .ok_or_else(|| "无法读取应用程序目录".to_string())?
            .to_path_buf();
        if !exe_dir.ends_with("target/debug") && !exe_dir.ends_with("target/release") {
            notification.app_id(&app.config().identifier);
        }

        let handle = notification.show().map_err(|error| error.to_string())?;
        std::thread::spawn(move || {
            let _ =
                handle.wait_for_response(move |response: &notify_rust::NotificationResponse| {
                    if !response.is_default_action() {
                        return;
                    }
                    let window_app = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        if let Some(window) = window_app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    });
                });
        });
        return Ok(());
    }

    #[cfg(not(windows))]
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}
