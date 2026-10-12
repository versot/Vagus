use crate::windows::show_main_window;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
#[cfg(windows)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::AppHandle;

pub(crate) struct TrayState(pub(crate) Mutex<Option<TrayIcon>>);

fn tray_labels(language: &str) -> (&'static str, &'static str) {
    match language {
        "zh-CN" => ("打开 Vagus", "退出"),
        "zh-TW" => ("開啟 Vagus", "結束"),
        "ja-JP" => ("Vagus を開く", "終了"),
        "ko-KR" => ("Vagus 열기", "종료"),
        "de-DE" => ("Vagus öffnen", "Beenden"),
        "fr-FR" => ("Ouvrir Vagus", "Quitter"),
        "es-ES" => ("Abrir Vagus", "Salir"),
        "pt-BR" => ("Abrir Vagus", "Sair"),
        "system" => system_tray_labels(),
        _ => ("Open Vagus", "Quit"),
    }
}

fn system_tray_labels() -> (&'static str, &'static str) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Globalization::GetUserDefaultUILanguage;
        let primary_language = unsafe { GetUserDefaultUILanguage() } & 0x03ff;
        return match primary_language {
            0x04 => ("打开 Vagus", "退出"),
            0x11 => ("Vagus を開く", "終了"),
            0x12 => ("Vagus 열기", "종료"),
            0x07 => ("Vagus öffnen", "Beenden"),
            0x0c => ("Ouvrir Vagus", "Quitter"),
            0x0a => ("Abrir Vagus", "Salir"),
            0x16 => ("Abrir Vagus", "Sair"),
            _ => ("Open Vagus", "Quit"),
        };
    }
    #[cfg(not(windows))]
    {
        ("打开 Vagus", "退出")
    }
}

pub(crate) fn configure_tray(
    app: &AppHandle,
    enabled: bool,
    language: &str,
    tray_state: &Mutex<Option<TrayIcon>>,
) -> Result<(), String> {
    let mut slot = tray_state
        .lock()
        .map_err(|_| "系统托盘状态不可用".to_string())?;
    if !enabled {
        if let Some(tray) = slot.take() {
            tray.set_visible(false).map_err(|error| error.to_string())?;
            app.remove_tray_by_id(tray.id());
        }
        return Ok(());
    }

    let (open_label, quit_label) = tray_labels(language);
    let open = MenuItem::with_id(app, "show", open_label, true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(app, &[&open, &quit]).map_err(|error| error.to_string())?;

    if let Some(tray) = slot.as_ref() {
        tray.set_menu(Some(menu))
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    let decoded_icon = image::load_from_memory(include_bytes!("../icons/icon.png"))
        .map_err(|error| error.to_string())?
        .into_rgba8();
    let (width, height) = decoded_icon.dimensions();
    let icon = tauri::image::Image::new_owned(decoded_icon.into_raw(), width, height);
    let builder = TrayIconBuilder::with_id("vagus-tray")
        .icon(icon)
        .tooltip("Vagus")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        });
    #[cfg(windows)]
    let builder = builder
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    let tray = builder.build(app).map_err(|error| error.to_string())?;
    *slot = Some(tray);
    Ok(())
}
