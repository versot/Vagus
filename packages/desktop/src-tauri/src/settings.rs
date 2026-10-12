use crate::power::set_keep_awake;
use crate::tray::configure_tray;
use crate::tray::TrayState;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
pub(crate) fn apply_browser_webview_settings() {
    let Some(app_data) = std::env::var_os("APPDATA").map(PathBuf::from) else {
        return;
    };
    let settings_path = app_data.join("sh.vagus.desktop").join("settings.json");
    let enabled = std::fs::read(settings_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|settings| {
            settings
                .get("browserIgnoreCertificateErrors")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false);
    if !enabled {
        return;
    }
    let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    if existing
        .split_whitespace()
        .any(|argument| argument == "--ignore-certificate-errors")
    {
        return;
    }
    let args = if existing.trim().is_empty() {
        "--ignore-certificate-errors".to_string()
    } else {
        format!("{} --ignore-certificate-errors", existing.trim())
    };
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSettings {
    #[serde(default)]
    pub(crate) shortcut_overrides: std::collections::BTreeMap<String, String>,
    #[serde(default = "default_language")]
    pub(crate) interface_language: String,
    #[serde(default = "default_interface_theme")]
    pub(crate) interface_theme: String,
    #[serde(default = "default_ui_font_size")]
    pub(crate) ui_font_size: u8,
    #[serde(default = "default_light_code_theme")]
    pub(crate) light_code_theme: String,
    #[serde(default = "default_dark_code_theme")]
    pub(crate) dark_code_theme: String,
    #[serde(default = "default_true")]
    pub(crate) show_code_line_numbers: bool,
    #[serde(default)]
    pub(crate) wrap_code_lines: bool,
    #[serde(default = "default_code_font_size")]
    pub(crate) code_font_size: u8,
    #[serde(default)]
    pub(crate) http_proxy: String,
    #[serde(default)]
    pub(crate) browser_ignore_certificate_errors: bool,
    #[serde(default = "default_true")]
    pub(crate) task_notifications: bool,
    #[serde(default = "default_true")]
    pub(crate) notification_sound: bool,
    #[serde(default)]
    pub(crate) close_to_tray: bool,
    #[serde(default)]
    pub(crate) keep_awake: bool,
    #[serde(default)]
    pub(crate) data_directory: String,
    #[serde(default)]
    pub(crate) data_directory_format_version: u8,
    #[serde(default)]
    pub(crate) migration_from: Option<String>,
}

pub(crate) fn default_language() -> String {
    "system".to_string()
}

pub(crate) fn default_true() -> bool {
    true
}

pub(crate) fn default_interface_theme() -> String {
    "dark".to_string()
}

pub(crate) fn default_ui_font_size() -> u8 {
    14
}

pub(crate) fn default_code_font_size() -> u8 {
    12
}

pub(crate) fn default_light_code_theme() -> String {
    "github-light".to_string()
}

pub(crate) fn default_dark_code_theme() -> String {
    "github-dark".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            shortcut_overrides: std::collections::BTreeMap::new(),
            interface_language: default_language(),
            interface_theme: default_interface_theme(),
            ui_font_size: default_ui_font_size(),
            code_font_size: default_code_font_size(),
            light_code_theme: default_light_code_theme(),
            dark_code_theme: default_dark_code_theme(),
            show_code_line_numbers: true,
            wrap_code_lines: false,
            http_proxy: String::new(),
            browser_ignore_certificate_errors: false,
            task_notifications: true,
            notification_sound: true,
            close_to_tray: false,
            keep_awake: false,
            data_directory: String::new(),
            data_directory_format_version: 1,
            migration_from: None,
        }
    }
}

pub(crate) fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    Ok(config_dir.join("settings.json"))
}

pub(crate) fn read_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_file(app)?;
    match std::fs::read(&path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|error| format!("无法读取设置：{error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AppSettings::default()),
        Err(error) => Err(format!("无法读取设置：{error}")),
    }
}

pub(crate) fn write_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_file(app)?;
    let temp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    std::fs::write(&temp, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(temp, path).map_err(|error| error.to_string())
}

pub(crate) fn default_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().home_dir().map_err(|error| error.to_string())
}

pub(crate) fn resolved_data_directory(
    app: &AppHandle,
    settings: &AppSettings,
) -> Result<PathBuf, String> {
    // Version 0 settings stored the actual Vagus data directory. Keep reading that
    // format until normalize_data_directory_settings schedules its migration.
    if settings.data_directory_format_version == 0 {
        if settings.data_directory.trim().is_empty() {
            return Ok(app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?
                .join("workspace"));
        }
        return Ok(PathBuf::from(&settings.data_directory));
    }
    if settings.data_directory.trim().is_empty() {
        Ok(default_data_root(app)?.join(".vagus"))
    } else {
        Ok(PathBuf::from(&settings.data_directory).join(".vagus"))
    }
}

pub(crate) fn normalize_data_directory_settings(
    app: &AppHandle,
    settings: &mut AppSettings,
) -> Result<(), String> {
    if settings.data_directory_format_version != 0 {
        if settings.data_directory.trim().is_empty() {
            settings.data_directory = default_data_root(app)?.to_string_lossy().into_owned();
        }
        return Ok(());
    }

    let old_directory = resolved_data_directory(app, settings)?;
    let new_root = default_data_root(app)?;
    let new_directory = new_root.join(".vagus");
    settings.data_directory = new_root.to_string_lossy().into_owned();
    settings.data_directory_format_version = 1;
    if old_directory != new_directory && old_directory.exists() {
        settings.migration_from = Some(old_directory.to_string_lossy().into_owned());
    }
    write_settings(app, settings)
}

pub(crate) fn copy_directory_contents(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    std::fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for item in std::fs::read_dir(source).map_err(|error| error.to_string())? {
        let item = item.map_err(|error| error.to_string())?;
        let source_path = item.path();
        let target_path = destination.join(item.file_name());
        let metadata =
            std::fs::symlink_metadata(&source_path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            copy_directory_contents(&source_path, &target_path)?;
        } else if metadata.is_file() {
            if target_path.exists() {
                return Err(format!("目标目录已包含同名文件：{}", target_path.display()));
            }
            std::fs::copy(&source_path, &target_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn apply_pending_data_migration(
    app: &AppHandle,
    settings: &mut AppSettings,
) -> Result<(), String> {
    let Some(source) = settings.migration_from.as_deref() else {
        return Ok(());
    };
    let source = PathBuf::from(source);
    let destination = resolved_data_directory(app, settings)?;
    if source == destination {
        settings.migration_from = None;
        write_settings(app, settings)?;
        return Ok(());
    }
    if source.exists() {
        let parent = destination
            .parent()
            .ok_or_else(|| "数据目录不能是文件系统根目录".to_string())?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let staging = parent.join(format!(".vagus-data-migration-{}", std::process::id()));
        if staging.exists() {
            std::fs::remove_dir_all(&staging).map_err(|error| error.to_string())?;
        }
        copy_directory_contents(&source, &staging)
            .map_err(|error| format!("迁移 Vagus 数据失败：{error}"))?;
        if destination.exists() {
            std::fs::remove_dir(&destination)
                .map_err(|error| format!("目标数据目录必须为空：{error}"))?;
        }
        std::fs::rename(&staging, &destination)
            .map_err(|error| format!("无法启用新数据目录：{error}"))?;
    }
    settings.migration_from = None;
    write_settings(app, settings)
}

#[tauri::command]
pub(crate) fn get_app_settings(app: AppHandle) -> Result<AppSettings, String> {
    let mut settings = read_settings(&app)?;
    normalize_data_directory_settings(&app, &mut settings)?;
    Ok(settings)
}

#[tauri::command]
pub(crate) async fn save_app_settings(
    app: AppHandle,
    mut settings: AppSettings,
) -> Result<AppSettings, String> {
    validate_shortcut_overrides(&settings.shortcut_overrides)?;
    if ![
        "system", "zh-CN", "en-US", "ja-JP", "ko-KR", "de-DE", "fr-FR", "es-ES", "pt-BR",
    ]
    .contains(&settings.interface_language.as_str())
    {
        return Err("不支持的界面语言".to_string());
    }
    settings.http_proxy = settings.http_proxy.trim().to_string();
    if !["light", "dark", "system"].contains(&settings.interface_theme.as_str())
        || !["github-light", "solarized-light"].contains(&settings.light_code_theme.as_str())
        || !["github-dark", "monokai"].contains(&settings.dark_code_theme.as_str())
        || !(12..=20).contains(&settings.ui_font_size)
        || !(10..=20).contains(&settings.code_font_size)
    {
        return Err("外观设置无效".to_string());
    }
    if !settings.http_proxy.is_empty() {
        let parsed = url::Url::parse(&settings.http_proxy)
            .map_err(|_| "代理地址无效，请输入完整的 HTTP 或 HTTPS 地址。".to_string())?;
        if !(parsed.scheme() == "http" || parsed.scheme() == "https") || parsed.host_str().is_none()
        {
            return Err("代理地址需要是完整的 HTTP 或 HTTPS 地址。".to_string());
        }
    }
    let mut current = read_settings(&app)?;
    normalize_data_directory_settings(&app, &mut current)?;
    settings.data_directory_format_version = 1;
    let old_directory = resolved_data_directory(&app, &current)?;
    let new_directory = resolved_data_directory(&app, &settings)?;
    if old_directory != new_directory {
        if new_directory.starts_with(&old_directory) {
            return Err("数据目录不能选择当前 Vagus 数据目录的子目录。".to_string());
        }
        if new_directory.exists() && !new_directory.is_dir() {
            return Err("数据存储路径必须是文件夹。".to_string());
        }
        if new_directory.exists()
            && std::fs::read_dir(&new_directory)
                .map_err(|error| error.to_string())?
                .next()
                .is_some()
        {
            return Err("目标数据目录必须为空，Vagus 会在重启时安全迁移现有数据。".to_string());
        }
        settings.migration_from = Some(old_directory.to_string_lossy().into_owned());
    } else {
        settings.migration_from = current.migration_from.take();
    }
    set_keep_awake(&app, settings.keep_awake)?;
    write_settings(&app, &settings)?;
    if let Some(state) = app.try_state::<TrayState>() {
        configure_tray(
            &app,
            settings.close_to_tray,
            &settings.interface_language,
            &state.0,
        )?;
    }
    app.emit("app-settings:updated", &settings)
        .map_err(|error| error.to_string())?;
    Ok(settings)
}

pub(crate) fn valid_shortcut_binding(binding: &str) -> bool {
    if binding.is_empty() {
        return true;
    }
    let mut parts: Vec<&str> = binding.split('+').collect();
    let Some(code) = parts.pop() else {
        return false;
    };
    let order = ["Ctrl", "Alt", "Shift", "Meta"];
    let canonical: Vec<&str> = order
        .into_iter()
        .filter(|modifier| parts.contains(modifier))
        .collect();
    if parts != canonical || parts.contains(&"Meta") {
        return false;
    }
    let function_key = code
        .strip_prefix('F')
        .and_then(|value| value.parse::<u8>().ok())
        .is_some_and(|number| (1..=24).contains(&number) && code == format!("F{number}"));
    let letter = code
        .strip_prefix("Key")
        .is_some_and(|value| value.len() == 1 && value.as_bytes()[0].is_ascii_uppercase());
    let digit = code
        .strip_prefix("Digit")
        .is_some_and(|value| value.len() == 1 && value.as_bytes()[0].is_ascii_digit());
    let other = [
        "Comma",
        "Period",
        "Slash",
        "Backslash",
        "Semicolon",
        "Quote",
        "BracketLeft",
        "BracketRight",
        "Minus",
        "Equal",
        "Backquote",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
    ]
    .contains(&code);
    if !(function_key || letter || digit || other) {
        return false;
    }
    if !function_key && !(parts.contains(&"Ctrl") || parts.contains(&"Alt")) {
        return false;
    }
    if binding == "Alt+F4" {
        return false;
    }
    if letter
        && parts.first() == Some(&"Ctrl")
        && (parts.len() == 1 || parts == ["Ctrl", "Shift"])
        && ["KeyA", "KeyC", "KeyV", "KeyX", "KeyY", "KeyZ"].contains(&code)
    {
        return false;
    }
    true
}

pub(crate) fn validate_shortcut_overrides(
    overrides: &std::collections::BTreeMap<String, String>,
) -> Result<(), String> {
    #[derive(Deserialize)]
    struct ShortcutDefault {
        id: String,
        binding: String,
    }
    // Runtime matching, displayed hints, and persistence use this same action registry.
    let defaults: Vec<ShortcutDefault> = serde_json::from_str(include_str!(
        "../../../app/src/features/settings/keyboard-shortcuts-defaults.json"
    ))
    .map_err(|_| "快捷键定义无效".to_string())?;
    if overrides.iter().any(|(id, binding)| {
        !defaults.iter().any(|definition| &definition.id == id) || !valid_shortcut_binding(binding)
    }) {
        return Err("快捷键绑定无效".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    for definition in defaults {
        let binding = overrides.get(&definition.id).unwrap_or(&definition.binding);
        if !binding.is_empty() && !seen.insert(binding.clone()) {
            return Err("快捷键存在冲突，请为每个操作设置不同的组合。".to_string());
        }
    }
    Ok(())
}
