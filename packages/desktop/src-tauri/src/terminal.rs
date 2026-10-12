use crate::resource_owners;
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{
    mpsc::{self},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub(crate) struct TerminalState(pub(crate) Mutex<HashMap<String, Arc<TerminalProcess>>>);

pub(crate) struct TerminalProcess {
    pub(crate) owner: String,
    pub(crate) writer: Mutex<Box<dyn Write + Send>>,
    pub(crate) master: Mutex<Box<dyn MasterPty + Send>>,
    pub(crate) child: Mutex<Box<dyn PtyChild + Send + Sync>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalOutputEvent {
    terminal_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalExitEvent {
    terminal_id: String,
    code: Option<u32>,
}

pub(crate) const TERMINAL_OUTPUT_QUEUE_CAPACITY: usize = 64;

pub(crate) const TERMINAL_OUTPUT_BATCH_BYTES: usize = 32 * 1024;

pub(crate) const TERMINAL_OUTPUT_BATCH_INTERVAL_MS: u64 = 16;

pub(crate) fn terminal_output_channel() -> (mpsc::SyncSender<String>, mpsc::Receiver<String>) {
    mpsc::sync_channel(TERMINAL_OUTPUT_QUEUE_CAPACITY)
}

pub(crate) fn decode_terminal_bytes(pending: &mut Vec<u8>, bytes: &[u8], eof: bool) -> String {
    pending.extend_from_slice(bytes);
    let mut output = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(valid) => {
                output.push_str(valid);
                pending.clear();
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                let invalid = error.error_len();
                if valid > 0 {
                    output.push_str(std::str::from_utf8(&pending[..valid]).unwrap_or_default());
                    pending.drain(..valid);
                }
                if let Some(length) = invalid {
                    output.push('\u{fffd}');
                    pending.drain(..length);
                    continue;
                }
                break;
            }
        }
    }
    if eof && !pending.is_empty() {
        output.push_str(&String::from_utf8_lossy(pending));
        pending.clear();
    }
    output
}

#[cfg(test)]
mod terminal_decoder_tests {
    use super::{
        decode_terminal_bytes, terminal_output_channel, TERMINAL_OUTPUT_BATCH_BYTES,
        TERMINAL_OUTPUT_BATCH_INTERVAL_MS, TERMINAL_OUTPUT_QUEUE_CAPACITY,
    };
    use std::sync::mpsc::{self, TrySendError};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn preserves_utf8_characters_split_across_reads() {
        let mut pending = Vec::with_capacity(4);
        let bytes = "中".as_bytes();
        assert_eq!(decode_terminal_bytes(&mut pending, &bytes[..1], false), "");
        assert_eq!(decode_terminal_bytes(&mut pending, &bytes[1..2], false), "");
        assert_eq!(
            decode_terminal_bytes(&mut pending, &bytes[2..], false),
            "中"
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn emits_replacement_for_incomplete_utf8_at_eof() {
        let mut pending = Vec::with_capacity(4);
        assert_eq!(
            decode_terminal_bytes(&mut pending, &[0xE4, 0xB8], false),
            ""
        );
        assert_eq!(decode_terminal_bytes(&mut pending, &[], true), "�");
        assert!(pending.is_empty());
    }

    #[test]
    fn terminal_output_queues_bound_backpressure_and_remain_independent() {
        assert_eq!(TERMINAL_OUTPUT_QUEUE_CAPACITY, 64);
        assert_eq!(TERMINAL_OUTPUT_BATCH_BYTES, 32 * 1024);
        assert_eq!(TERMINAL_OUTPUT_BATCH_INTERVAL_MS, 16);
        let (tx_a, rx_a) = terminal_output_channel();
        let (tx_b, rx_b) = terminal_output_channel();
        for index in 0..TERMINAL_OUTPUT_QUEUE_CAPACITY {
            tx_a.send(format!("A{index}")).unwrap();
        }
        assert!(matches!(
            tx_a.try_send("overflow".into()),
            Err(TrySendError::Full(_))
        ));
        tx_b.try_send("B0".into()).unwrap();
        assert_eq!(
            rx_b.recv().unwrap(),
            "B0",
            "a saturated terminal cannot block another terminal's queue"
        );

        let (complete_tx, complete_rx) = mpsc::channel();
        let blocked_sender = thread::spawn(move || {
            tx_a.send("A64".into()).unwrap();
            complete_tx.send(()).unwrap();
        });
        let was_blocked = complete_rx.recv_timeout(Duration::from_millis(20)).is_err();
        assert_eq!(rx_a.recv().unwrap(), "A0");
        complete_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        blocked_sender.join().unwrap();
        for index in 1..TERMINAL_OUTPUT_QUEUE_CAPACITY {
            assert_eq!(rx_a.recv().unwrap(), format!("A{index}"));
        }
        assert_eq!(rx_a.recv().unwrap(), "A64");
        drop(rx_b);
        assert!(
            tx_b.send("closed".into()).is_err(),
            "closing a terminal receiver releases its producer"
        );
        assert!(
            was_blocked,
            "the producer must wait when the bounded queue is full"
        );
    }
}

#[tauri::command]
pub(crate) fn terminal_create(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, TerminalState>,
    terminal_id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let owner = resource_owners::trusted(&webview)?;
    if terminal_id.is_empty()
        || !terminal_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("无效的终端 ID".to_string());
    }
    {
        let terminals = state.0.lock().map_err(|_| "终端服务不可用".to_string())?;
        if let Some(existing) = terminals.get(&terminal_id) {
            return if existing.owner == owner {
                Ok(())
            } else {
                Err("终端不属于当前窗口".to_string())
            };
        }
    }

    let default_directory = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let directory = cwd.map(PathBuf::from).unwrap_or(default_directory);
    if !directory.is_dir() {
        return Err(format!("终端工作目录不存在：{}", directory.display()));
    }
    let system = native_pty_system();
    let pair = system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("无法创建终端：{error}"))?;
    let mut command = if cfg!(windows) {
        CommandBuilder::new("powershell.exe")
    } else {
        CommandBuilder::new(std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into()))
    };
    #[cfg(feature = "stage-one-smoke")]
    if let Some(index) = terminal_id.strip_prefix("throughput-") {
        if let (Some(script), Some(node)) = (
            std::env::var_os("VAGUS_SMOKE_TERMINAL_SCRIPT"),
            std::env::var_os("VAGUS_NODE_PATH"),
        ) {
            command = CommandBuilder::new(node);
            command.arg(script);
            command.env("VAGUS_SMOKE_TERMINAL_INDEX", index);
        }
    }
    command.cwd(directory);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("无法启动终端：{error}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|error| {
        let _ = child.kill();
        format!("无法读取终端输出：{error}")
    })?;
    let writer = pair.master.take_writer().map_err(|error| {
        let _ = child.kill();
        format!("无法写入终端：{error}")
    })?;
    let master = pair.master;
    let terminal = Arc::new(TerminalProcess {
        owner: owner.clone(),
        writer: Mutex::new(writer),
        master: Mutex::new(master),
        child: Mutex::new(child),
    });
    let conflicting_owner = {
        let mut terminals = state.0.lock().map_err(|_| "终端服务不可用".to_string())?;
        if let Some(existing) = terminals.get(&terminal_id) {
            Some(existing.owner.clone())
        } else {
            terminals.insert(terminal_id.clone(), terminal.clone());
            None
        }
    };
    if let Some(existing_owner) = conflicting_owner {
        if let Ok(mut child) = terminal.child.lock() {
            let _ = child.kill();
        }
        return if existing_owner == owner {
            Ok(())
        } else {
            Err("终端不属于当前窗口".to_string())
        };
    }

    let (output_tx, output_rx) = terminal_output_channel();
    let reader_id = terminal_id.clone();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let mut pending = Vec::with_capacity(4);
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let data = decode_terminal_bytes(&mut pending, &buffer[..count], false);
                    if !data.is_empty() && output_tx.send(data).is_err() {
                        return;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let trailing = decode_terminal_bytes(&mut pending, &[], true);
        if !trailing.is_empty() {
            let _ = output_tx.send(trailing);
        }
    });
    let emit_app = app.clone();
    let emit_owner = owner.clone();
    std::thread::spawn(move || {
        let mut batch = String::with_capacity(TERMINAL_OUTPUT_BATCH_BYTES);
        loop {
            match output_rx.recv_timeout(Duration::from_millis(TERMINAL_OUTPUT_BATCH_INTERVAL_MS)) {
                Ok(data) => {
                    batch.push_str(&data);
                    if batch.len() >= TERMINAL_OUTPUT_BATCH_BYTES {
                        let _ = emit_app.emit_to(
                            &emit_owner,
                            "terminal-output",
                            TerminalOutputEvent {
                                terminal_id: reader_id.clone(),
                                data: std::mem::take(&mut batch),
                            },
                        );
                        batch.reserve(TERMINAL_OUTPUT_BATCH_BYTES);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !batch.is_empty() {
                        let _ = emit_app.emit_to(
                            &emit_owner,
                            "terminal-output",
                            TerminalOutputEvent {
                                terminal_id: reader_id.clone(),
                                data: std::mem::take(&mut batch),
                            },
                        );
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        if !batch.is_empty() {
            let _ = emit_app.emit_to(
                &emit_owner,
                "terminal-output",
                TerminalOutputEvent {
                    terminal_id: reader_id.clone(),
                    data: batch,
                },
            );
        }
        let terminal = emit_app
            .state::<TerminalState>()
            .0
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(&reader_id).cloned());
        let code = terminal.and_then(|session| {
            session.child.lock().ok().and_then(|mut child| {
                child
                    .try_wait()
                    .ok()
                    .flatten()
                    .map(|status| status.exit_code())
            })
        });
        let _ = emit_app.emit_to(
            &emit_owner,
            "terminal-exit",
            TerminalExitEvent {
                terminal_id: reader_id,
                code,
            },
        );
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn terminal_write(
    webview: tauri::Webview,
    state: State<'_, TerminalState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let owner = resource_owners::trusted(&webview)?;
    let terminal = state
        .0
        .lock()
        .map_err(|_| "终端服务不可用".to_string())?
        .get(&terminal_id)
        .cloned()
        .ok_or_else(|| "终端已经关闭".to_string())?;
    if terminal.owner != owner {
        return Err("终端不属于当前窗口".to_string());
    }
    let mut writer = terminal
        .writer
        .lock()
        .map_err(|_| "终端输入不可用".to_string())?;
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| format!("无法写入终端：{error}"))
}

#[tauri::command]
pub(crate) fn terminal_resize(
    webview: tauri::Webview,
    state: State<'_, TerminalState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let owner = resource_owners::trusted(&webview)?;
    let terminal = state
        .0
        .lock()
        .map_err(|_| "终端服务不可用".to_string())?
        .get(&terminal_id)
        .cloned()
        .ok_or_else(|| "终端已经关闭".to_string())?;
    if terminal.owner != owner {
        return Err("终端不属于当前窗口".to_string());
    }
    let result = terminal
        .master
        .lock()
        .map_err(|_| "终端尺寸控制不可用".to_string())?
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("无法调整终端大小：{error}"));
    result
}

#[tauri::command]
pub(crate) fn terminal_close(
    webview: tauri::Webview,
    state: State<'_, TerminalState>,
    terminal_id: String,
) -> Result<(), String> {
    let owner = resource_owners::trusted(&webview)?;
    let terminal = {
        let mut terminals = state.0.lock().map_err(|_| "终端服务不可用".to_string())?;
        if terminals
            .get(&terminal_id)
            .is_some_and(|terminal| terminal.owner != owner)
        {
            return Err("终端不属于当前窗口".to_string());
        }
        terminals.remove(&terminal_id)
    };
    if let Some(terminal) = terminal {
        if let Ok(mut child) = terminal.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}
