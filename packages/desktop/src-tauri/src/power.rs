use std::sync::{
    mpsc::{self, Sender},
    Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub(crate) struct KeepAwakeState(pub(crate) Mutex<Sender<bool>>);

pub(crate) fn start_keep_awake_worker() -> Sender<bool> {
    let (sender, receiver) = mpsc::channel::<bool>();
    std::thread::spawn(move || {
        let mut active = false;
        loop {
            let requested = if active {
                match receiver.recv_timeout(Duration::from_secs(30)) {
                    Ok(value) => Some(value),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            } else {
                match receiver.recv() {
                    Ok(value) => Some(value),
                    Err(_) => break,
                }
            };
            if let Some(enabled) = requested {
                active = enabled;
            }
            #[cfg(target_os = "windows")]
            if active || requested.is_some() {
                unsafe {
                    use windows_sys::Win32::System::Power::{
                        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
                    };
                    let flags = if active {
                        ES_CONTINUOUS | ES_SYSTEM_REQUIRED
                    } else {
                        ES_CONTINUOUS
                    };
                    let _ = SetThreadExecutionState(flags);
                }
            }
        }
        #[cfg(target_os = "windows")]
        unsafe {
            use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
            let _ = SetThreadExecutionState(ES_CONTINUOUS);
        }
    });
    sender
}

pub(crate) fn set_keep_awake(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let state = app
        .try_state::<KeepAwakeState>()
        .ok_or_else(|| "防休眠服务尚未启动".to_string())?;
    let result = state
        .0
        .lock()
        .map_err(|_| "防休眠服务不可用".to_string())?
        .send(enabled)
        .map_err(|_| "防休眠服务已退出".to_string());
    result
}
