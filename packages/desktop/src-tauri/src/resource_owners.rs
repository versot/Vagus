use crate::terminal::TerminalState;
use tauri::{AppHandle, Manager};

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Webview;

#[derive(Default)]
pub struct BrowserOwners(Mutex<HashMap<String, String>>);
impl BrowserOwners {
    pub fn claim(&self, id: &str, owner: &str) -> Result<(), String> {
        let mut owners = self.0.lock().map_err(|_| "浏览器资源不可用")?;
        if owners.contains_key(id) {
            return Err("浏览器实例已存在".to_string());
        }
        owners.insert(id.to_string(), owner.to_string());
        Ok(())
    }
    pub fn owns(&self, id: &str, owner: &str) -> bool {
        self.0
            .lock()
            .is_ok_and(|owners| owners.get(id).is_some_and(|current| current == owner))
    }
    pub fn release(&self, id: &str) {
        if let Ok(mut owners) = self.0.lock() {
            owners.remove(id);
        }
    }
    pub fn drain_window(&self, owner: &str) -> Vec<String> {
        let Ok(mut owners) = self.0.lock() else {
            return Vec::new();
        };
        let ids: Vec<_> = owners
            .iter()
            .filter(|(_, current)| current.as_str() == owner)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            owners.remove(id);
        }
        ids
    }
}
fn trusted_surface(label: &str, url: &url::Url, development: bool) -> bool {
    let app_label =
        label == "main" || label.starts_with("chat-") || label.starts_with("workspace-");
    let production = matches!(url.scheme(), "http" | "https" | "tauri")
        && url.host_str()
            == Some(if url.scheme() == "tauri" {
                "localhost"
            } else {
                "tauri.localhost"
            })
        && url.port().is_none();
    let dev = development
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
        && url.port() == Some(5173);
    app_label && (production || dev)
}
pub fn trusted(webview: &Webview) -> Result<String, String> {
    let url = webview.url().map_err(|_| "无法验证调用来源")?;
    if !trusted_surface(webview.label(), &url, cfg!(debug_assertions)) {
        return Err("此页面无权访问桌面服务".to_string());
    }
    Ok(webview.window().label().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origins_and_labels_are_both_required() {
        assert!(trusted_surface(
            "workspace-1",
            &url::Url::parse("http://tauri.localhost/").unwrap(),
            false
        ));
        assert!(!trusted_surface(
            "browser-1",
            &url::Url::parse("http://tauri.localhost/").unwrap(),
            false
        ));
        assert!(!trusted_surface(
            "main",
            &url::Url::parse("https://example.com").unwrap(),
            false
        ));
        assert!(!trusted_surface(
            "main",
            &url::Url::parse("http://localhost:5173").unwrap(),
            false
        ));
        assert!(trusted_surface(
            "main",
            &url::Url::parse("http://localhost:5173").unwrap(),
            true
        ));
    }
    #[test]
    fn thirty_cycles_release_only_the_destroyed_window() {
        let registry = BrowserOwners::default();
        registry.claim("other", "workspace-2").unwrap();
        for index in 0..30 {
            let id = format!("browser-{index}");
            registry.claim(&id, "main").unwrap();
            assert!(!registry.owns(&id, "workspace-2"));
            assert_eq!(registry.drain_window("main"), vec![id.clone()]);
            assert!(!registry.owns(&id, "main"));
        }
        assert!(registry.owns("other", "workspace-2"));
    }
}

pub(crate) fn release_window_resources(handle: &AppHandle, label: &str) {
    if let Some(owners) = handle.try_state::<BrowserOwners>() {
        for id in owners.drain_window(label) {
            if let Some(webview) = handle.get_webview(&id) {
                let _ = webview.close();
            }
        }
    }
    if let Some(state) = handle.try_state::<TerminalState>() {
        let removed = state
            .0
            .lock()
            .ok()
            .map(|mut terminals| {
                let ids: Vec<_> = terminals
                    .iter()
                    .filter(|(_, terminal)| terminal.owner == label)
                    .map(|(id, _)| id.clone())
                    .collect();
                ids.into_iter()
                    .filter_map(|id| terminals.remove(&id))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for terminal in removed {
            if let Ok(mut child) = terminal.child.lock() {
                let _ = child.kill();
            }
        }
    }
}
