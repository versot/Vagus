use crate::host_supervisor;
use crate::settings::apply_pending_data_migration;
use crate::settings::normalize_data_directory_settings;
use crate::settings::read_settings;
use crate::settings::resolved_data_directory;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub(crate) fn host_entry(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("host")
        .join("server.js");
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../host/dist/server.js");
    let entry = if cfg!(debug_assertions) && development.is_file() {
        // In development, always use the freshly built workspace Host. Tauri's
        // copied resource can lag behind protocol changes and reject new RPCs.
        development
    } else if bundled.is_file() {
        bundled
    } else if development.is_file() {
        development
    } else {
        return Err(format!("Host 文件不存在：{}", bundled.display()));
    };

    // Tauri can return Windows paths with the extended-length `\\?\` prefix.
    // Node's Windows entrypoint resolver mishandles that form and treats `C:` as
    // the script path, so pass it the ordinary drive-letter path instead.
    #[cfg(windows)]
    let entry = entry
        .to_string_lossy()
        .strip_prefix(r"\\?\")
        .map(PathBuf::from)
        .unwrap_or(entry);

    Ok(entry)
}

fn parse_login_shell_node(output: &[u8]) -> Option<PathBuf> {
    String::from_utf8_lossy(output)
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with('/'))
        .map(PathBuf::from)
}

#[cfg(target_os = "macos")]
fn node_from_login_shell() -> Option<PathBuf> {
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/zsh".into());
    let output = Command::new(shell).args(["-lic", "command -v node"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_login_shell_node(&output.stdout).filter(|path| path.is_file())
}

fn node_command() -> PathBuf {
    if let Some(configured) = std::env::var_os("VAGUS_NODE_PATH") {
        return PathBuf::from(configured);
    }
    #[cfg(target_os = "macos")]
    if let Some(node) = node_from_login_shell() {
        return node;
    }
    PathBuf::from("node")
}

pub(crate) fn run_host(app: &AppHandle, token: &str) -> Result<Child, String> {
    let entry = host_entry(app)?;
    let host_address = "127.0.0.1:4317";
    let reservation = std::net::TcpListener::bind(host_address)
        .map_err(|error| format!("本机 Host 端口 4317 不可用：{error}"))?;
    drop(reservation);
    let mut settings = read_settings(app)?;
    normalize_data_directory_settings(app, &mut settings)?;
    apply_pending_data_migration(app, &mut settings)?;
    let data_dir = resolved_data_directory(app, &settings)?;
    std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    let node = node_command();
    let mut command = Command::new(&node);
    let host_log_path = data_dir.join("host.log");
    let host_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&host_log_path)
        .map_err(|error| format!("无法创建 Pi Host 日志：{error}"))?;
    writeln!(
        &host_log,
        "Starting Host: node={} entry={} cwd={}",
        node.to_string_lossy(),
        entry.display(),
        std::env::current_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|error| format!("<unavailable: {error}>"))
    )
    .map_err(|error| format!("无法写入 Pi Host 日志：{error}"))?;
    let host_stdout = host_log
        .try_clone()
        .map_err(|error| format!("无法打开 Pi Host 日志：{error}"))?;
    command
        .arg(entry)
        .env("VAGUS_DATA_DIR", data_dir)
        .env("VAGUS_HOST_PORT", "4317")
        .env("VAGUS_MANAGED_HOST", "1")
        .env("VAGUS_HOST_TOKEN", token)
        .env("VAGUS_ALLOWED_ORIGINS", if cfg!(debug_assertions) { r#"["http://tauri.localhost","https://tauri.localhost","tauri://localhost","http://localhost:5173","http://127.0.0.1:5173"]"# } else { r#"["http://tauri.localhost","https://tauri.localhost","tauri://localhost"]"# })
        .stdin(Stdio::piped())
        .stdout(Stdio::from(host_stdout))
        .stderr(Stdio::from(host_log));
    if !settings.http_proxy.is_empty() {
        command
            .env("HTTP_PROXY", &settings.http_proxy)
            .env("http_proxy", &settings.http_proxy)
            .env("HTTPS_PROXY", &settings.http_proxy)
            .env("https_proxy", &settings.http_proxy)
            .env("ALL_PROXY", &settings.http_proxy)
            .env("all_proxy", &settings.http_proxy);
    } else {
        command
            .env_remove("HTTP_PROXY")
            .env_remove("http_proxy")
            .env_remove("HTTPS_PROXY")
            .env_remove("https_proxy")
            .env_remove("ALL_PROXY")
            .env_remove("all_proxy");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|error| {
        #[cfg(target_os = "macos")]
        let hint = "请确认 Node.js 22.13+ 已安装，并可通过登录 shell 的 node 命令找到；也可设置 VAGUS_NODE_PATH";
        #[cfg(not(target_os = "macos"))]
        let hint = "请确认 Node.js 22.13+ 已安装且位于 PATH，或设置 VAGUS_NODE_PATH";
        format!("无法启动本机 Pi Host：{error}。{hint}。")
    })?;
    let mut ready = false;
    // The first launch can import a large legacy workspace before listening.
    for _ in 0..600 {
        if host_supervisor::stopping(app) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Host 启动已取消".to_string());
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Err(format!(
                "Pi Host 启动失败，退出状态：{status}。日志：{}",
                host_log_path.display()
            ));
        }
        if std::net::TcpStream::connect_timeout(
            &host_address.parse().unwrap(),
            Duration::from_millis(120),
        )
        .is_ok()
        {
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                return Err(format!(
                    "Pi Host 启动失败，退出状态：{status}。日志：{}",
                    host_log_path.display()
                ));
            }
            ready = true;
            break;
        }
        sleep(Duration::from_millis(100));
    }
    if !ready {
        let _ = child.kill();
        return Err("Pi Host 启动超时。请确认 Node.js 版本不低于 22.13、端口 4317 未被占用，并查看 Host 日志中的历史迁移错误。".to_string());
    }
    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::parse_login_shell_node;
    use std::path::PathBuf;

    #[test]
    fn parses_node_path_after_login_shell_startup_output() {
        let output = b"shell startup message\n/opt/homebrew/bin/node\n";

        assert_eq!(
            parse_login_shell_node(output),
            Some(PathBuf::from("/opt/homebrew/bin/node"))
        );
    }

    #[test]
    fn rejects_a_command_name_without_an_absolute_path() {
        assert_eq!(parse_login_shell_node(b"node\n"), None);
    }
}
