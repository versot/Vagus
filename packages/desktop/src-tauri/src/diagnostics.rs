use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub(crate) struct PerformanceCaptureState(pub(crate) Mutex<Option<PathBuf>>);

#[tauri::command]
pub(crate) fn start_performance_capture(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, PerformanceCaptureState>,
) -> Result<Option<String>, String> {
    if window.label() != "main" || std::env::var("VAGUS_CAPTURE_PERF").ok().as_deref() != Some("1")
    {
        return Ok(None);
    }
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("diagnostics");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let path = directory.join(format!("performance-{}-{stamp}.jsonl", std::process::id()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    let header = serde_json::json!({"type":"capture-start","startedAtMs":stamp,"processId":std::process::id()});
    serde_json::to_writer(&mut file, &header).map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    *state.0.lock().map_err(|_| "性能采样状态不可用")? = Some(path.clone());
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub(crate) fn append_performance_capture(
    window: tauri::WebviewWindow,
    state: State<'_, PerformanceCaptureState>,
    snapshot: serde_json::Value,
) -> Result<bool, String> {
    if window.label() != "main" || std::env::var("VAGUS_CAPTURE_PERF").ok().as_deref() != Some("1")
    {
        return Ok(false);
    }
    let encoded = serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?;
    if encoded.len() > 64 * 1024 {
        return Err("性能采样超过单条预算".into());
    }
    let mut active = state.0.lock().map_err(|_| "性能采样状态不可用")?;
    let Some(path) = active.as_ref() else {
        return Ok(false);
    };
    if std::fs::metadata(path)
        .map_err(|error| error.to_string())?
        .len()
        >= 5 * 1024 * 1024
    {
        *active = None;
        return Ok(false);
    }
    let mut file = OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(&encoded)
        .map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    Ok(true)
}
