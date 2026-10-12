use tauri::State;

use std::collections::VecDeque;
use std::io::Write;
use std::process::Child;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Webview};

pub struct HostProcess {
    url: String,
    child: Mutex<Option<Child>>,
    token: Mutex<String>,
    stopping: AtomicBool,
}
#[derive(serde::Serialize)]
pub struct HostConnection {
    url: String,
    token: String,
}

fn credential() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "无法生成本机 Host 凭证".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Default)]
struct RestartBudget {
    failures: VecDeque<Instant>,
}
impl RestartBudget {
    fn next(&mut self, now: Instant) -> Option<Duration> {
        while self
            .failures
            .front()
            .is_some_and(|last| now.duration_since(*last) >= Duration::from_secs(60))
        {
            self.failures.pop_front();
        }
        if self.failures.len() >= 3 {
            return None;
        }
        self.failures.push_back(now);
        Some(Duration::from_millis(
            250 * (1 << (self.failures.len() - 1)),
        ))
    }
}

pub fn stopping(app: &AppHandle) -> bool {
    app.try_state::<HostProcess>()
        .is_some_and(|state| state.stopping.load(Ordering::SeqCst))
}

pub fn start(app: AppHandle) -> Result<(), String> {
    start_with(
        app,
        "ws://127.0.0.1:4317/rpc".to_string(),
        crate::host_runtime::run_host,
    )
}

pub(crate) fn start_with(
    app: AppHandle,
    url: String,
    launch: impl Fn(&AppHandle, &str) -> Result<Child, String> + Send + 'static,
) -> Result<(), String> {
    let token = credential()?;
    app.manage(HostProcess {
        url,
        child: Mutex::new(None),
        token: Mutex::new(token.clone()),
        stopping: AtomicBool::new(false),
    });
    app.manage(crate::host_supervisor::HostStartupError(Mutex::new(None)));
    match launch(&app, &token) {
        Ok(child) => {
            *app.state::<HostProcess>()
                .child
                .lock()
                .map_err(|_| "Host 管理不可用")? = Some(child)
        }
        Err(error) => {
            *app.state::<crate::host_supervisor::HostStartupError>()
                .0
                .lock()
                .map_err(|_| "Host 管理不可用")? = Some(error);
            return Ok(());
        }
    }
    std::thread::spawn(move || {
        let mut budget = RestartBudget::default();
        loop {
            std::thread::sleep(Duration::from_millis(250));
            if stopping(&app) {
                return;
            }
            let exited = {
                let state = app.state::<HostProcess>();
                let Ok(mut slot) = state.child.lock() else {
                    return;
                };
                match slot.as_mut().map(Child::try_wait) {
                    Some(Ok(Some(_))) => {
                        slot.take();
                        true
                    }
                    Some(Err(_)) => {
                        if let Some(mut child) = slot.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                        true
                    }
                    _ => false,
                }
            };
            if !exited {
                continue;
            }
            let _ = app.emit("host-lifecycle", "reconnecting");
            loop {
                let Some(delay) = budget.next(Instant::now()) else {
                    if let Ok(mut error) = app
                        .state::<crate::host_supervisor::HostStartupError>()
                        .0
                        .lock()
                    {
                        *error = Some(
                            "本机 Host 连续异常退出，自动恢复已停止，请重启应用并查看 Host 日志。"
                                .to_string(),
                        );
                    }
                    let _ = app.emit("host-lifecycle", "failed");
                    return;
                };
                std::thread::sleep(delay);
                if stopping(&app) {
                    return;
                }
                let token = match credential() {
                    Ok(token) => token,
                    Err(_) => return,
                };
                if let Ok(mut current) = app.state::<HostProcess>().token.lock() {
                    *current = token.clone();
                }
                match launch(&app, &token) {
                    Ok(mut child) => {
                        if stopping(&app) {
                            let _ = child.kill();
                            let _ = child.wait();
                            return;
                        }
                        if let Ok(mut slot) = app.state::<HostProcess>().child.lock() {
                            *slot = Some(child);
                        }
                        if let Ok(mut error) = app
                            .state::<crate::host_supervisor::HostStartupError>()
                            .0
                            .lock()
                        {
                            *error = None;
                        }
                        let _ = app.emit("host-lifecycle", "ready");
                        break;
                    }
                    Err(error) => {
                        if stopping(&app) {
                            return;
                        }
                        eprintln!("Vagus Host restart failed: {error}");
                    }
                }
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn host_connection(app: AppHandle, webview: Webview) -> Result<HostConnection, String> {
    crate::resource_owners::trusted(&webview)?;
    if let Some(error) = app
        .state::<crate::host_supervisor::HostStartupError>()
        .0
        .lock()
        .map_err(|_| "Host 管理不可用")?
        .as_ref()
    {
        return Err(error.clone());
    }
    let token = app
        .state::<HostProcess>()
        .token
        .lock()
        .map_err(|_| "Host 管理不可用")?
        .clone();
    Ok(HostConnection {
        url: app.state::<HostProcess>().url.clone(),
        token,
    })
}

#[cfg(feature = "stage-one-smoke")]
pub(crate) fn terminate_for_smoke(app: &AppHandle) -> Result<(), String> {
    app.state::<HostProcess>()
        .child
        .lock()
        .map_err(|_| "Host lock")?
        .as_mut()
        .ok_or("Host absent")?
        .kill()
        .map_err(|error| error.to_string())
}

pub fn stop(app: &AppHandle) {
    let Some(state) = app.try_state::<HostProcess>() else {
        return;
    };
    state.stopping.store(true, Ordering::SeqCst);
    let child = state.child.lock().ok().and_then(|mut slot| slot.take());
    if let Some(mut child) = child {
        if let Some(input) = child.stdin.as_mut() {
            let _ = input.write_all(b"shutdown\n");
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_are_random_and_32_bytes() {
        let a = credential().unwrap();
        assert_eq!(a.len(), 64);
        assert_ne!(a, credential().unwrap());
    }
    #[test]
    fn restarts_are_bounded_and_reset_after_a_minute() {
        let now = Instant::now();
        let mut budget = RestartBudget::default();
        for _ in 0..3 {
            assert!(budget.next(now).is_some());
        }
        assert!(budget.next(now).is_none());
        assert!(budget.next(now + Duration::from_secs(61)).is_some());
    }
}

pub(crate) struct HostStartupError(pub(crate) Mutex<Option<String>>);

#[tauri::command]
pub(crate) fn host_startup_error(state: State<'_, HostStartupError>) -> Option<String> {
    state.0.lock().ok()?.clone()
}
