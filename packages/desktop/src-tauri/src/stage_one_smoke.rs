//! Explicitly compiled native regression harness. Not present in release builds.
use std::{
    borrow::Cow,
    collections::HashMap,
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{
    utils::assets::{AssetKey, AssetsIter, CspHash},
    AppHandle, Assets, Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

struct BlankAssets;
impl Assets<tauri::Wry> for BlankAssets {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
        Some(Cow::Borrowed(b"<!doctype html><html><title>Native regression</title><body>Isolated regression</body></html>"))
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}
fn wait(condition: impl Fn() -> bool) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !condition() {
        if Instant::now() > deadline {
            return Err("Native regression timed out".to_string());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}
fn window(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .visible(false)
        .skip_taskbar(true)
        .inner_size(640.0, 480.0)
        .build()
        .map_err(|error| error.to_string())?;
    wait(|| {
        window
            .url()
            .is_ok_and(|url| url.host_str() == Some("tauri.localhost"))
    })?;
    Ok(window)
}
fn connection(app: &AppHandle, window: &WebviewWindow) -> Result<serde_json::Value, String> {
    let view = app
        .get_webview(window.label())
        .ok_or("Missing app WebView")?;
    serde_json::to_value(crate::host_supervisor::host_connection(app.clone(), view)?)
        .map_err(|error| error.to_string())
}
fn exercise(app: &AppHandle, page: &str) -> Result<serde_json::Value, String> {
    let main = window(app, "main")?;
    // The opt-in browser resource soak returns before creating the keeper window or any
    // PTYs, so its process tree represents only the smoke window, Host, and browser views.
    if let Some(milliseconds) = std::env::var("VAGUS_SMOKE_BROWSER_HOLD_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
    {
        let main_view = app.get_webview("main").ok_or("Main view absent")?;
        let browser_ids: Vec<String> = (0..3)
            .map(|index| format!("browser-profile-{index}"))
            .collect();
        for browser_id in &browser_ids {
            tauri::async_runtime::block_on(crate::browser::browser_create(
                app.clone(),
                main_view.clone(),
                main.label().to_string(),
                browser_id.clone(),
                None,
                page.to_string(),
                0.0,
                0.0,
                320.0,
                240.0,
            ))?;
        }
        wait(|| browser_ids.iter().all(|id| app.get_webview(id).is_some()))?;
        std::thread::sleep(Duration::from_millis(milliseconds.min(120_000)));
        for browser_id in &browser_ids {
            tauri::async_runtime::block_on(crate::browser::browser_control(
                app.clone(),
                main_view.clone(),
                browser_id.clone(),
                "close".to_string(),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            ))?;
        }
        wait(|| {
            browser_ids.iter().all(|id| {
                app.get_webview(id).is_none()
                    && !app
                        .state::<crate::resource_owners::BrowserOwners>()
                        .owns(id, main.label())
            })
        })?;
        std::thread::sleep(Duration::from_secs(15));
        return Ok(
            serde_json::json!({"browserResourceSoak":{"count":browser_ids.len(),"createdAndReleased":true,"profilesArePerTab":true},"scope":"browser-only resource soak; no keeper window or PTYs"}),
        );
    }
    let other = window(app, "workspace-keeper")?;
    let main_view = app.get_webview("main").ok_or("Main view absent")?;
    let other_view = app
        .get_webview("workspace-keeper")
        .ok_or("Other view absent")?;
    let output_counts: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));
    let output_samples: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
    let event_counts = output_counts.clone();
    let event_samples = output_samples.clone();
    let smoke_app = app.clone();
    main_view.listen_any("terminal-output", move |event| {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
            return;
        };
        let (Some(id), Some(data)) = (
            value.get("terminalId").and_then(|id| id.as_str()),
            value.get("data").and_then(|data| data.as_str()),
        ) else {
            return;
        };
        if let Ok(mut counts) = event_counts.lock() {
            *counts.entry(id.to_string()).or_default() += data.len();
        }
        if let Ok(mut samples) = event_samples.lock() {
            let sample = samples.entry(id.to_string()).or_default();
            if sample.len() < 300 {
                sample.extend(data.chars().take(300 - sample.len()));
            }
        }
        // The hidden smoke WebView has no xterm to answer the ConPTY device-status query.
        // A real terminal emulator replies with the current cursor position; simulate that here.
        if data.contains("\u{1b}[6n") {
            let terminal = smoke_app
                .state::<crate::terminal::TerminalState>()
                .0
                .lock()
                .ok()
                .and_then(|terminals| terminals.get(id).cloned());
            if let Some(terminal) = terminal {
                if let Ok(mut writer) = terminal.writer.lock() {
                    let _ = writer.write_all(b"\x1b[1;1R");
                    let _ = writer.flush();
                }
            }
        }
    });
    if connection(app, &main)? != connection(app, &other)? {
        return Err("Window bootstrap mismatch".to_string());
    }
    crate::terminal::terminal_create(
        app.clone(),
        other_view.clone(),
        app.state(),
        "keeper-terminal".to_string(),
        None,
        80,
        24,
    )?;
    tauri::async_runtime::block_on(crate::browser::browser_create(
        app.clone(),
        other_view.clone(),
        other.label().to_string(),
        "browser-keeper".to_string(),
        None,
        page.to_string(),
        0.0,
        0.0,
        320.0,
        240.0,
    ))?;
    if crate::terminal::terminal_write(
        main_view.clone(),
        app.state(),
        "keeper-terminal".to_string(),
        "bad".to_string(),
    )
    .is_ok()
    {
        return Err("Cross-window PTY write accepted".to_string());
    }
    if crate::host_supervisor::host_connection(
        app.clone(),
        app.get_webview("browser-keeper").ok_or("Browser absent")?,
    )
    .is_ok()
    {
        return Err("External browser received credential".to_string());
    }
    let simultaneous_browsers: Vec<String> = (0..3)
        .map(|index| format!("browser-profile-{index}"))
        .collect();
    for browser_id in &simultaneous_browsers {
        tauri::async_runtime::block_on(crate::browser::browser_create(
            app.clone(),
            main_view.clone(),
            main.label().to_string(),
            browser_id.clone(),
            None,
            page.to_string(),
            0.0,
            0.0,
            320.0,
            240.0,
        ))?;
    }
    wait(|| {
        simultaneous_browsers
            .iter()
            .all(|id| app.get_webview(id).is_some())
    })?;
    for browser_id in &simultaneous_browsers {
        tauri::async_runtime::block_on(crate::browser::browser_control(
            app.clone(),
            main_view.clone(),
            browser_id.clone(),
            "close".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        ))?;
    }
    wait(|| {
        simultaneous_browsers.iter().all(|id| {
            app.get_webview(id).is_none()
                && !app
                    .state::<crate::resource_owners::BrowserOwners>()
                    .owns(id, main.label())
        })
    })?;
    // Exercise three real PowerShell PTYs concurrently and verify every numbered line reaches
    // the owning WebView's batched terminal-output event stream.
    let terminal_ids: Vec<String> = (0..3).map(|index| format!("throughput-{index}")).collect();
    for terminal_id in &terminal_ids {
        crate::terminal::terminal_create(
            app.clone(),
            main_view.clone(),
            app.state(),
            terminal_id.clone(),
            None,
            120,
            30,
        )?;
    }
    let started = Instant::now();
    let output_deadline = Instant::now() + Duration::from_secs(45);
    let output_complete = || {
        let Ok(counts) = output_counts.lock() else {
            return false;
        };
        terminal_ids
            .iter()
            .all(|terminal_id| counts.get(terminal_id).copied().unwrap_or_default() >= 1000 * 200)
    };
    while !output_complete() && Instant::now() < output_deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    if !output_complete() {
        let counts = output_counts
            .lock()
            .map(|counts| counts.clone())
            .unwrap_or_default();
        let samples = output_samples
            .lock()
            .map(|samples| samples.clone())
            .unwrap_or_default();
        let statuses = app
            .state::<crate::terminal::TerminalState>()
            .0
            .lock()
            .map(|terminals| {
                terminal_ids
                    .iter()
                    .filter_map(|id| {
                        terminals.get(id).map(|terminal| {
                            (
                                id.clone(),
                                terminal.child.lock().ok().and_then(|mut child| {
                                    child
                                        .try_wait()
                                        .ok()
                                        .flatten()
                                        .map(|status| status.to_string())
                                }),
                            )
                        })
                    })
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        return Err(format!("Multi-PTY output timed out; bytes={counts:?}; samples={samples:?}; childStatus={statuses:?}; scriptConfigured={}; nodeConfigured={}", std::env::var_os("VAGUS_SMOKE_TERMINAL_SCRIPT").is_some(), std::env::var_os("VAGUS_NODE_PATH").is_some()));
    }
    let throughput_elapsed_ms = started.elapsed().as_millis().max(1);
    for terminal_id in &terminal_ids {
        crate::terminal::terminal_close(main_view.clone(), app.state(), terminal_id.clone())?;
    }
    let multi_pty_output_bytes: usize = terminal_ids
        .iter()
        .filter_map(|id| output_counts.lock().ok()?.get(id).copied())
        .sum();
    let baseline = app.webviews().len();
    for cycle in 0..30 {
        let label = format!("workspace-cycle-{cycle}");
        let browser = format!("browser-cycle-{cycle}");
        let terminal = format!("cycle-terminal-{cycle}");
        let current = window(app, &label)?;
        let view = app.get_webview(&label).ok_or("Cycle view absent")?;
        crate::terminal::terminal_create(
            app.clone(),
            view.clone(),
            app.state(),
            terminal.clone(),
            None,
            80,
            24,
        )?;
        tauri::async_runtime::block_on(crate::browser::browser_create(
            app.clone(),
            view,
            label,
            browser.clone(),
            None,
            page.to_string(),
            0.0,
            0.0,
            320.0,
            240.0,
        ))?;
        current.destroy().map_err(|error| error.to_string())?;
        wait(|| {
            app.get_webview(&browser).is_none()
                && app
                    .state::<crate::terminal::TerminalState>()
                    .0
                    .lock()
                    .is_ok_and(|terminals| terminals.len() == 1)
                && app.webviews().len() == baseline
        })?;
        if !app
            .state::<crate::resource_owners::BrowserOwners>()
            .owns("browser-keeper", other.label())
        {
            return Err("Other window browser was released".to_string());
        }
        crate::terminal::terminal_resize(
            other_view.clone(),
            app.state(),
            "keeper-terminal".to_string(),
            90,
            28,
        )?;
    }
    let mut previous = connection(app, &main)?;
    for _ in 0..3 {
        crate::host_supervisor::terminate_for_smoke(app)?;
        wait(|| connection(app, &main).is_ok_and(|current| current != previous))?;
        // Credential rotates before process creation; wait for the replacement to listen.
        let port = std::env::var("VAGUS_SMOKE_PORT").map_err(|error| error.to_string())?;
        wait(|| std::net::TcpStream::connect(format!("127.0.0.1:{port}")).is_ok())?;
        previous = connection(app, &main)?;
        std::thread::sleep(Duration::from_millis(300));
    }
    crate::host_supervisor::terminate_for_smoke(app)?;
    wait(|| {
        app.state::<crate::host_supervisor::HostStartupError>()
            .0
            .lock()
            .is_ok_and(|error| error.is_some())
    })?;
    if connection(app, &main).is_ok() {
        return Err("Exhausted restart budget not surfaced".to_string());
    }
    other.destroy().map_err(|error| error.to_string())?;
    wait(|| {
        app.state::<crate::terminal::TerminalState>()
            .0
            .lock()
            .is_ok_and(|terminals| terminals.is_empty())
            && app.get_webview("browser-keeper").is_none()
    })?;
    let terminal_output_bytes: Vec<usize> = terminal_ids
        .iter()
        .filter_map(|id| output_counts.lock().ok()?.get(id).copied())
        .collect();
    let min_bytes = terminal_output_bytes
        .iter()
        .copied()
        .min()
        .unwrap_or_default();
    let max_bytes = terminal_output_bytes
        .iter()
        .copied()
        .max()
        .unwrap_or_default();
    let fairness_percent = if max_bytes == 0 {
        0.0
    } else {
        min_bytes as f64 / max_bytes as f64 * 100.0
    };
    if fairness_percent < 90.0 {
        return Err(format!(
            "Multi-PTY byte fairness below 90%: {fairness_percent:.1}% ({terminal_output_bytes:?})"
        ));
    }
    Ok(
        serde_json::json!({"cycles":30,"nativeWebviewsReturnedToBaseline":true,"nativePtysReturnedToBaseline":true,"otherWindowPreserved":true,"browserBootstrapDenied":true,"hostRestarts":3,"restartBudgetExhaustionSurfaced":true,"simultaneousBrowserTabs":{"count":simultaneous_browsers.len(),"createdAndReleased":true,"profilesArePerTab":true},"multiPty":{"terminals":terminal_ids.len(),"expectedLinesPerTerminal":1000,"outputBytes":multi_pty_output_bytes,"perTerminalOutputBytes":terminal_output_bytes,"elapsedMs":throughput_elapsed_ms,"linesPerSecond":(terminal_ids.len()*1000) as f64/(throughput_elapsed_ms as f64/1000.0),"byteFairnessPercent":fairness_percent,"allTerminalsProgressed":true}}),
    )
}
pub fn run() {
    let directory =
        PathBuf::from(std::env::var_os("VAGUS_SMOKE_DIRECTORY").expect("Smoke directory required"));
    let port = std::env::var("VAGUS_SMOKE_PORT").expect("Smoke port required");
    let page = std::env::var("VAGUS_SMOKE_PAGE").expect("Smoke page required");
    let identifier = format!("sh.vagus.stageone.{}", std::process::id());
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = identifier;
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = None;
    context.set_assets(Box::new(BlankAssets));
    let output = directory.clone();
    let app = tauri::Builder::default().setup(move |app| {
        app.manage(crate::terminal::TerminalState::default()); app.manage(crate::resource_owners::BrowserOwners::default());
        let launch_directory = directory.clone(); let launch_port = port.clone();
        crate::host_supervisor::start_with(app.handle().clone(), format!("ws://127.0.0.1:{port}/rpc"), move |_, token| {
            let mut command = Command::new(std::env::var_os("VAGUS_NODE_PATH").unwrap_or_else(|| "node".into()));
            command.arg(std::env::var_os("VAGUS_SMOKE_HOST").ok_or("Host fixture required")?)
                .env("VAGUS_DATA_DIR", launch_directory.join("data")).env("VAGUS_HOST_PORT", &launch_port).env("VAGUS_HOST_TOKEN", token).env("VAGUS_MANAGED_HOST", "1")
                .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
            let mut child = command.spawn().map_err(|error| error.to_string())?;
            if let Err(error) = wait(|| std::net::TcpStream::connect(format!("127.0.0.1:{launch_port}")).is_ok()) { let _ = child.kill(); let _ = child.wait(); return Err(error); } Ok(child)
        }).map_err(std::io::Error::other)?;
        let handle = app.handle().clone(); let report = directory.join("native-result.json");
        std::thread::spawn(move || {
            let result = exercise(&handle, &page);
            let value = match &result { Ok(value) => value.clone(), Err(error) => serde_json::json!({"error":error}) };
            let data_path = handle.path().app_data_dir().ok();
            let _ = std::fs::write(report, serde_json::to_vec_pretty(&serde_json::json!({"ok":result.is_ok(),"result":value,"appDataDir":data_path})).unwrap());
            handle.exit(if result.is_ok() { 0 } else { 1 });
        }); Ok(())
    }).build(context).expect("Native smoke application failed to build");
    app.run(move |handle, event| {
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } = &event
        {
            crate::resource_owners::release_window_resources(handle, label);
        }
        if let tauri::RunEvent::Exit = event {
            crate::host_supervisor::stop(handle);
            for label in handle.windows().keys() {
                crate::resource_owners::release_window_resources(handle, label);
            }
            let _ = std::io::stdout().write_all(
                format!(
                    "Native result: {}\n",
                    output.join("native-result.json").display()
                )
                .as_bytes(),
            );
        }
    });
}
