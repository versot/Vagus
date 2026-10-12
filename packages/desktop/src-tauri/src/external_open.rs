//! Fixed external application launchers. User paths are arguments, never shell commands.
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn open_path(path: String, application: String) -> Result<(), String> {
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("无法访问此路径：{error}"))?;
    let directory = if path.is_dir() {
        path.clone()
    } else {
        path.parent()
            .ok_or_else(|| "无法确定文件所在目录".to_string())?
            .to_path_buf()
    };
    #[cfg(windows)]
    {
        windows_launcher::open(&path, &directory, &application)
    }
    #[cfg(not(windows))]
    {
        let (program, target) = match application.as_str() {
            "vscode" => ("code", &path),
            "zed" => ("zed", &path),
            "default" => (
                if cfg!(target_os = "macos") {
                    "open"
                } else {
                    "xdg-open"
                },
                &path,
            ),
            "terminal" => (
                if cfg!(target_os = "macos") {
                    "open"
                } else {
                    "x-terminal-emulator"
                },
                &directory,
            ),
            "wsl" => return Err("WSL 仅在 Windows 上可用".to_string()),
            _ => return Err("不支持的打开方式".to_string()),
        };
        let mut command = Command::new(program);
        if application == "vscode" {
            command.arg("--reuse-window");
        }
        #[cfg(target_os = "macos")]
        if application == "terminal" {
            command.args(["-a", "Terminal"]);
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        if application == "terminal" {
            command.current_dir(&directory);
        }
        // Linux terminals differ in directory flags; inherit the working directory instead.
        if application != "terminal" || cfg!(target_os = "macos") {
            command.arg(target);
        }
        command
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("无法启动 {program}：{error}"))
    }
}

pub fn open_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_launcher::shell_open(std::ffi::OsStr::new(url))
    }
    #[cfg(not(windows))]
    {
        let program = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        Command::new(program)
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("无法打开默认浏览器：{error}"))
    }
}

#[cfg(windows)]
mod windows_launcher {
    use super::*;
    use std::ffi::OsStr;
    use std::os::windows::{ffi::OsStrExt, process::CommandExt};
    use std::process::Stdio;
    use windows_sys::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_EXPAND_SZ,
        RRF_RT_REG_SZ,
    };
    use windows_sys::Win32::System::Threading::{CREATE_NEW_CONSOLE, CREATE_NO_WINDOW};
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    // Explorer, editor CLIs and WSL do not consistently accept Rust's verbatim canonical paths.
    fn ordinary_path(path: &Path) -> PathBuf {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
        path.to_path_buf()
    }

    fn registry_string(hive: HKEY, key: &str, value: Option<&str>) -> Option<String> {
        let key = wide(OsStr::new(key));
        let value = value.map(|value| wide(OsStr::new(value)));
        let value_pointer = value
            .as_ref()
            .map_or(std::ptr::null(), |value| value.as_ptr());
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
        let mut bytes = 0;
        unsafe {
            if RegGetValueW(
                hive,
                key.as_ptr(),
                value_pointer,
                flags,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut bytes,
            ) != 0
                || bytes == 0
                || bytes > 131_072
            {
                return None;
            }
            let mut buffer = vec![0_u16; (bytes as usize + 1) / 2];
            if RegGetValueW(
                hive,
                key.as_ptr(),
                value_pointer,
                flags,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut bytes,
            ) != 0
            {
                return None;
            }
            let length = buffer
                .iter()
                .position(|value| *value == 0)
                .unwrap_or(buffer.len());
            Some(String::from_utf16_lossy(&buffer[..length]))
        }
    }

    fn app_paths(executable: &str) -> Option<PathBuf> {
        let key = format!(r"Software\Microsoft\Windows\CurrentVersion\App Paths\{executable}");
        [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
            .into_iter()
            .filter_map(|hive| registry_string(hive, &key, None))
            .map(|value| PathBuf::from(value.trim().trim_matches('"')))
            .find(|path| path.is_file())
    }

    fn editor_path(application: &str) -> Result<PathBuf, String> {
        let (executable, label, install_folder) = match application {
            "vscode" => ("Code.exe", "VS Code", "Microsoft VS Code"),
            "zed" => ("zed.exe", "Zed", "Zed"),
            _ => return Err("不支持的打开方式".to_string()),
        };
        if let Some(path) = app_paths(executable) {
            return Ok(path);
        }
        let mut paths = Vec::new();
        if let Some(path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&path));
        }
        // A running desktop process can have a PATH from before an editor was installed.
        for (hive, key) in [
            (HKEY_CURRENT_USER, "Environment"),
            (
                HKEY_LOCAL_MACHINE,
                r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
            ),
        ] {
            if let Some(path) = registry_string(hive, key, Some("Path")) {
                paths.extend(std::env::split_paths(OsStr::new(&path)));
            }
        }
        for directory in paths {
            // Never execute .cmd/.bat launchers or search the current project directory.
            if !directory.is_absolute() {
                continue;
            }
            let candidate = directory.join(executable);
            if candidate.is_file() {
                return Ok(candidate);
            }
            if application == "vscode"
                && directory
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case("bin"))
            {
                if let Some(parent) = directory.parent() {
                    let candidate = parent.join(executable);
                    if candidate.is_file() {
                        return Ok(candidate);
                    }
                }
            }
        }
        for variable in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(base) = std::env::var_os(variable) {
                let base = PathBuf::from(base);
                for directory in [
                    base.join(install_folder),
                    base.join("Programs").join(install_folder),
                ] {
                    for candidate in [
                        directory.join(executable),
                        directory.join("bin").join(executable),
                    ] {
                        if candidate.is_file() {
                            return Ok(candidate);
                        }
                    }
                }
            }
        }
        Err(format!("未找到 {label}，请先安装该应用或将其加入 PATH。"))
    }

    fn system_program(relative: &str, label: &str) -> Result<PathBuf, String> {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        let path = PathBuf::from(root).join("System32").join(relative);
        if path.is_file() {
            Ok(path)
        } else {
            Err(format!("未找到 {label}，请确认该系统组件已安装。"))
        }
    }

    pub(super) fn shell_open(target: &OsStr) -> Result<(), String> {
        let operation = wide(OsStr::new("open"));
        let target = wide(target);
        // File association handlers can be COM shell extensions on this worker thread.
        let initialized =
            unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32) };
        if initialized < 0 && initialized != RPC_E_CHANGED_MODE {
            return Err("无法初始化 Windows 文件关联服务。".to_string());
        }
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        } as isize;
        if initialized >= 0 {
            unsafe {
                CoUninitialize();
            }
        }
        match result {
            value if value > 32 => Ok(()),
            2 | 3 => Err("无法打开：文件或关联应用不存在。".to_string()),
            5 => Err("无法打开：系统拒绝访问此文件。".to_string()),
            27 | 31 => Err("此文件没有关联的默认应用，请先在 Windows 中选择打开方式。".to_string()),
            value => Err(format!("无法通过默认应用打开（Windows 错误 {value}）。")),
        }
    }

    pub(super) fn open(path: &Path, directory: &Path, application: &str) -> Result<(), String> {
        let path = ordinary_path(path);
        let directory = ordinary_path(directory);
        match application {
            "default" => shell_open(path.as_os_str()),
            "vscode" | "zed" => {
                let executable = editor_path(application)?;
                let label = if application == "vscode" {
                    "VS Code"
                } else {
                    "Zed"
                };
                let mut command = Command::new(executable);
                if application == "vscode" {
                    command.arg("--reuse-window");
                }
                command
                    .arg(path)
                    .env_remove("ELECTRON_RUN_AS_NODE")
                    .creation_flags(CREATE_NO_WINDOW)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map(|_| ())
                    .map_err(|error| format!("无法启动 {label}：{error}"))
            }
            "terminal" => {
                let executable =
                    system_program(r"WindowsPowerShell\v1.0\powershell.exe", "PowerShell")?;
                Command::new(executable)
                    .args(["-NoLogo", "-NoExit"])
                    .current_dir(directory)
                    .creation_flags(CREATE_NEW_CONSOLE)
                    .spawn()
                    .map(|_| ())
                    .map_err(|error| format!("无法启动 PowerShell：{error}"))
            }
            "wsl" => {
                let executable = system_program("wsl.exe", "WSL")?;
                // WSL accepts an absolute Windows path; do not assume its automount root is /mnt.
                Command::new(executable)
                    .arg("--cd")
                    .arg(&directory)
                    .current_dir(directory)
                    .creation_flags(CREATE_NEW_CONSOLE)
                    .spawn()
                    .map(|_| ())
                    .map_err(|error| format!("无法启动 WSL：{error}"))
            }
            _ => Err("不支持的打开方式".to_string()),
        }
    }
}

#[tauri::command]
pub(crate) fn open_in_file_manager(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.is_dir() {
        return Err(format!("工作目录不存在或无法访问：{}", path.display()));
    }

    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法在文件管理器中打开 {}：{error}", path.display()))
}

#[tauri::command]
pub(crate) fn open_pi_package_market() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command
        .arg("https://pi.dev/packages")
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开 Pi 包市场：{error}"))
}
