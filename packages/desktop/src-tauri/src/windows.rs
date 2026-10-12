use crate::settings::read_settings;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
pub(crate) fn restart_app(app: AppHandle) {
    app.restart();
}

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub(crate) async fn open_session_window(app: AppHandle, session_id: String) -> Result<(), String> {
    if session_id.is_empty()
        || !session_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("无效的聊天 ID".to_string());
    }

    let label = format!("chat-{session_id}");
    eprintln!("Opening Vagus chat window {label}");
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        &app,
        label,
        WebviewUrl::App(format!("?sessionId={session_id}").into()),
    )
    .title("Vagus")
    .inner_size(1440.0, 920.0)
    .min_inner_size(900.0, 620.0)
    .decorations(false)
    .transparent(false)
    .theme(if cfg!(windows) {
        Some(tauri::Theme::Dark)
    } else {
        None
    })
    .on_page_load(|window, payload| {
        eprintln!(
            "Vagus window {} page {:?}: {}",
            window.label(),
            payload.event(),
            payload.url()
        );
    })
    .build()
    .map_err(|error| format!("无法打开聊天窗口：{error}"))?;
    let close_window = window.clone();
    let app_handle = app.clone();
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
    Ok(())
}

#[tauri::command]
pub(crate) async fn open_workspace_window(app: AppHandle) -> Result<(), String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let label = format!("workspace-{stamp}");
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html".into()))
        .title("Vagus")
        .inner_size(1440.0, 920.0)
        .min_inner_size(900.0, 620.0)
        .decorations(false)
        .transparent(false)
        .theme(if cfg!(windows) {
            Some(tauri::Theme::Dark)
        } else {
            None
        })
        .build()
        .map_err(|error| format!("无法新建窗口：{error}"))?;
    let close_window = window.clone();
    let app_handle = app.clone();
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
    Ok(())
}
