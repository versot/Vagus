use serde::Serialize;
use std::fs;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BrowserTitleChanged {
    browser_id: String,
    title: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BrowserFaviconChanged {
    browser_id: String,
    favicon_url: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BrowserNavigationChanged {
    browser_id: String,
    url: String,
    kind: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BrowserElementMessage {
    browser_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
}

fn browser_element_picker_script(mode: &str) -> String {
    let mode = serde_json::to_string(mode).unwrap_or_else(|_| "\"annotate\"".to_string());
    format!(
        r#"(() => {{
      window.__vagusElementPicker?.cancel?.();
      const mode = {mode};
      const outline = document.createElement('div');
      outline.style.cssText = 'all:initial;position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #818cf8;background:rgba(129,140,248,.10);border-radius:3px;display:none;box-sizing:border-box';
      document.documentElement.appendChild(outline);
      const host = document.createElement('div');
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;display:none;box-sizing:border-box';
      const shadow = host.attachShadow({{mode:'open'}});
      let target = null;
      let active = true;
      let payload = null;
      const findTarget = (event) => {{
        const element = document.elementFromPoint(event.clientX, event.clientY);
        return element && element !== outline && element !== host && !outline.contains(element) && !host.contains(element) ? element : null;
      }};
      const move = (event) => {{
        target = findTarget(event);
        if (!target) {{ outline.style.display = 'none'; return; }}
        const rect = target.getBoundingClientRect();
        outline.style.display = 'block';
        outline.style.left = rect.left + 'px'; outline.style.top = rect.top + 'px';
        outline.style.width = rect.width + 'px'; outline.style.height = rect.height + 'px';
      }};
      const emit = (kind, data) => {{
        const query = data ? '?data=' + encodeURIComponent(JSON.stringify(data)) : '';
        location.href = 'vagus-element://' + kind + query;
      }};
      const cleanup = () => {{
        active = false; outline.remove(); host.remove(); document.documentElement.style.cursor = '';
        document.removeEventListener('pointermove', move, true);
        document.removeEventListener('click', click, true);
        document.removeEventListener('keydown', keydown, true);
        window.__vagusElementPicker = null;
      }};
      const cancel = () => {{
        if (!active) return;
        cleanup();
        emit('cancelled');
      }};
      const click = (event) => {{
        if (event.composedPath().includes(host)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (!target || !active || payload) return;
        const element = target;
        const rect = element.getBoundingClientRect();
        const path = [];
        let current = element;
        while (current && current.nodeType === 1 && path.length < 5) {{
          let part = current.tagName.toLowerCase();
          if (current.id) {{ part += '#' + CSS.escape(current.id); path.unshift(part); break; }}
          const classes = [...current.classList].filter(Boolean).slice(0, 2);
          if (classes.length) part += '.' + classes.map(value => CSS.escape(value)).join('.');
          if (current.parentElement) {{
            const peers = [...current.parentElement.children].filter(item => item.tagName === current.tagName);
            if (peers.length > 1) part += `:nth-of-type(${{peers.indexOf(current) + 1}})`;
          }}
          path.unshift(part); current = current.parentElement;
        }}
        payload = {{
          selector: path.join(' > '), tag: element.tagName.toLowerCase(),
          text: (element.innerText || element.textContent || '').trim().slice(0, 500),
          html: element.outerHTML.slice(0, 4000),
          rect: {{x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: Math.max(1, Math.min(innerWidth, rect.right) - Math.max(0, rect.left)), height: Math.max(1, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top))}},
          url: location.href,
        }};
        outline.style.left = rect.left + 'px'; outline.style.top = rect.top + 'px';
        outline.style.width = rect.width + 'px'; outline.style.height = rect.height + 'px';
        outline.style.display = 'block'; outline.style.background = 'rgba(129,140,248,.06)';
        document.removeEventListener('pointermove', move, true);
        document.removeEventListener('click', click, true);
        document.documentElement.style.cursor = '';
        const width = Math.min(368, innerWidth - 24);
        const left = Math.max(12, Math.min(rect.left, innerWidth - width - 12));
        const top = rect.bottom + 10 + 68 < innerHeight ? rect.bottom + 10 : Math.max(12, rect.top - 68);
        host.style.left = left + 'px'; host.style.top = top + 'px'; host.style.width = width + 'px'; host.style.display = 'block';
        shadow.innerHTML = `<style>
          :host{{all:initial}} *{{box-sizing:border-box}} .card{{display:flex;align-items:center;gap:8px;height:54px;padding:0 14px;border:1px solid #3b3c40;border-radius:999px;color:#f3f4f6;background:#292a2e;box-shadow:0 8px 24px rgba(0,0,0,.34)}}
          input{{display:block;width:100%;height:38px;padding:0 10px;border:0;outline:none;color:#f3f4f6;background:transparent;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}} input::placeholder{{color:#85878d}}
        </style><div class="card"><input aria-label="添加评论" placeholder="添加评论…" maxlength="500" /></div>`;
        const input = shadow.querySelector('input');
        input.addEventListener('keydown', event => {{
          if (event.key !== 'Enter') return;
          event.preventDefault(); event.stopPropagation();
          if (!active) return;
          const note = input.value.trim().slice(0, 500);
          cleanup(); emit('selected', {{...payload, note}});
        }});
        input.focus();
      }};
      const keydown = (event) => {{
        if (event.key === 'Escape') {{ event.preventDefault(); event.stopImmediatePropagation(); cancel(); }}
      }};
      document.addEventListener('pointermove', move, true);
      document.addEventListener('click', click, true);
      document.addEventListener('keydown', keydown, true);
      document.documentElement.appendChild(host);
      window.__vagusElementPicker = {{mode, cancel}};
      document.documentElement.style.cursor = 'crosshair';
    }})();"#
    )
}

#[tauri::command]
pub async fn browser_create(
    app: AppHandle,
    webview: tauri::Webview,
    window_label: String,
    browser_id: String,
    profile_id: Option<String>,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let owner = crate::resource_owners::trusted(&webview)?;
    if owner != window_label {
        return Err("浏览器不属于当前窗口".to_string());
    }
    if !browser_id.starts_with("browser-")
        || !browser_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("无效的浏览器标签".to_string());
    }
    let parsed = url::Url::parse(&url).map_err(|_| "网址无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只支持 HTTP 或 HTTPS 网页".to_string());
    }
    let window = app
        .get_window(&window_label)
        .ok_or_else(|| "浏览器窗口已关闭".to_string())?;
    if app.get_webview(&browser_id).is_some() {
        return Err("浏览器标签已存在".to_string());
    }
    let profile_id = profile_id.unwrap_or_else(|| browser_id.clone());
    if !profile_id.starts_with("browser-")
        || !profile_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("无效的浏览器数据标识".to_string());
    }
    let profile = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(&profile_id)
        .join("browser-data")
        .join(&profile_id);
    app.state::<crate::resource_owners::BrowserOwners>()
        .claim(&browser_id, &owner)?;
    let title_app = app.clone();
    let title_window = window_label;
    let title_browser = browser_id.clone();
    let action_app = app.clone();
    let action_window = title_window.clone();
    let action_browser = browser_id.clone();
    let navigation_app = app.clone();
    let navigation_window = title_window.clone();
    let navigation_browser = browser_id.clone();
    let builder = tauri::webview::WebviewBuilder::new(browser_id.clone(), tauri::WebviewUrl::External(parsed))
        .data_directory(profile)
        .focused(false)
        .on_document_title_changed(move |_, title| {
            let _ = title_app.emit_to(&title_window, "browser-title-changed", BrowserTitleChanged {
                browser_id: title_browser.clone(), title,
            });
        })
        .on_page_load(move |webview, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished
                || !matches!(payload.url().scheme(), "http" | "https")
            {
                return;
            }
            let _ = navigation_app.emit_to(&navigation_window, "browser-navigation-changed", BrowserNavigationChanged {
                browser_id: navigation_browser.clone(), url: payload.url().as_str().to_string(), kind: "load".to_string(),
            });
            let script = r#"(() => {
              const notifyNavigation = kind => {
                const url = location.href;
                location.href = 'vagus-element://navigation?kind=' + kind + '&url=' + encodeURIComponent(url);
              };
              const pushState = history.pushState;
              history.pushState = function(...args) {
                const result = Reflect.apply(pushState, this, args);
                notifyNavigation('push');
                return result;
              };
              const replaceState = history.replaceState;
              history.replaceState = function(...args) {
                const result = Reflect.apply(replaceState, this, args);
                notifyNavigation('replace');
                return result;
              };
              addEventListener('popstate', () => notifyNavigation('pop'));
              addEventListener('hashchange', () => notifyNavigation('push'));
              const link = document.querySelector('link[rel~="icon" i], link[rel="shortcut icon" i], link[rel~="apple-touch-icon" i]');
              let icon = link?.href || new URL('/favicon.ico', location.href).href;
              if (!/^https?:\/\//i.test(icon)) icon = new URL('/favicon.ico', location.href).href;
              location.href = 'vagus-element://favicon?url=' + encodeURIComponent(icon.slice(0, 2048));
            })();"#;
            let _ = webview.eval(script);
        })
        .on_navigation(move |url| {
            if url.scheme() == "vagus-element" {
                let host = url.host_str().unwrap_or_default();
                if host == "selected" {
                    let data = url.query_pairs().find(|(key, _)| key == "data").map(|(_, value)| value.into_owned());
                    let _ = action_app.emit_to(&action_window, "browser-element-selected", BrowserElementMessage { browser_id: action_browser.clone(), data });
                } else if host == "cancelled" {
                    let _ = action_app.emit_to(&action_window, "browser-element-cancelled", BrowserElementMessage { browser_id: action_browser.clone(), data: None });
                } else if host == "navigation" {
                    let kind = url.query_pairs().find(|(key, _)| key == "kind").map(|(_, value)| value.into_owned());
                    let target = url.query_pairs().find(|(key, _)| key == "url").map(|(_, value)| value.into_owned());
                    if let (Some(kind), Some(target)) = (kind, target) {
                        let valid_kind = matches!(kind.as_str(), "push" | "replace" | "pop");
                        if valid_kind && target.len() <= 8192 && url::Url::parse(&target).is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https")) {
                            let _ = action_app.emit_to(&action_window, "browser-navigation-changed", BrowserNavigationChanged {
                                browser_id: action_browser.clone(), url: target, kind,
                            });
                        }
                    }
                } else if host == "favicon" {
                    if let Some((_, icon)) = url.query_pairs().find(|(key, _)| key == "url") {
                        let favicon_url = icon.into_owned();
                        if favicon_url.len() <= 2048
                            && url::Url::parse(&favicon_url).is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https"))
                        {
                            let _ = action_app.emit_to(&action_window, "browser-favicon-changed", BrowserFaviconChanged {
                                browser_id: action_browser.clone(), favicon_url,
                            });
                        }
                    }
                }
                false
            } else {
                matches!(url.scheme(), "http" | "https")
            }
        });
    let created = window
        .add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map(|_| ())
        .map_err(|error| error.to_string());
    if created.is_err() {
        app.state::<crate::resource_owners::BrowserOwners>()
            .release(&browser_id);
    } else if !app
        .state::<crate::resource_owners::BrowserOwners>()
        .owns(&browser_id, &owner)
    {
        if let Some(view) = app.get_webview(&browser_id) {
            let _ = view.close();
        }
        return Err("浏览器所属窗口已关闭".to_string());
    }
    created
}

#[tauri::command]
pub async fn browser_control(
    app: AppHandle,
    webview: tauri::Webview,
    browser_id: String,
    action: String,
    url: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
    mode: Option<String>,
    show: Option<bool>,
) -> Result<(), String> {
    let owner = crate::resource_owners::trusted(&webview)?;
    if !app
        .state::<crate::resource_owners::BrowserOwners>()
        .owns(&browser_id, &owner)
    {
        return Err("浏览器不属于当前窗口或已关闭".to_string());
    }
    if !browser_id.starts_with("browser-")
        || !browser_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("无效的浏览器标签".to_string());
    }
    let webview = app
        .get_webview(&browser_id)
        .ok_or_else(|| "浏览器标签已关闭".to_string())?;
    match action.as_str() {
        "navigate" => {
            let target = url.ok_or_else(|| "缺少网址".to_string())?;
            let parsed = url::Url::parse(&target).map_err(|_| "网址无效".to_string())?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err("只支持 HTTP 或 HTTPS 网页".to_string());
            }
            webview.navigate(parsed).map_err(|error| error.to_string())
        }
        "back" => webview
            .eval("window.history.back()")
            .map_err(|error| error.to_string()),
        "forward" => webview
            .eval("window.history.forward()")
            .map_err(|error| error.to_string()),
        "reload" => webview.reload().map_err(|error| error.to_string()),
        "set-bounds" => {
            let bounds = tauri::Rect {
                position: tauri::LogicalPosition::new(
                    x.ok_or_else(|| "缺少浏览器位置".to_string())?,
                    y.ok_or_else(|| "缺少浏览器位置".to_string())?,
                )
                .into(),
                size: tauri::LogicalSize::new(
                    width.ok_or_else(|| "缺少浏览器尺寸".to_string())?.max(1.0),
                    height.ok_or_else(|| "缺少浏览器尺寸".to_string())?.max(1.0),
                )
                .into(),
            };
            webview
                .set_bounds(bounds)
                .map_err(|error| error.to_string())?;
            if show.unwrap_or(false) {
                webview.show().map_err(|error| error.to_string())
            } else {
                Ok(())
            }
        }
        "hide" => webview.hide().map_err(|error| error.to_string()),
        "close" => {
            let result = webview.close().map_err(|error| error.to_string());
            if result.is_ok() {
                app.state::<crate::resource_owners::BrowserOwners>()
                    .release(&browser_id);
            }
            result
        }
        "pick-element" => {
            let picker_mode = mode
                .as_deref()
                .filter(|value| matches!(*value, "annotate" | "screenshot"))
                .ok_or_else(|| "缺少元素选择模式".to_string())?;
            webview
                .eval(&browser_element_picker_script(picker_mode))
                .map_err(|error| error.to_string())
        }
        "cancel-element-picker" => webview
            .eval("window.__vagusElementPicker?.cancel()")
            .map_err(|error| error.to_string()),
        "devtools" => {
            webview.open_devtools();
            Ok(())
        }
        _ => Err("不支持的浏览器操作".to_string()),
    }
}

#[tauri::command]
pub async fn browser_capture_element(
    app: AppHandle,
    webview: tauri::Webview,
    browser_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    let owner = crate::resource_owners::trusted(&webview)?;
    if !app
        .state::<crate::resource_owners::BrowserOwners>()
        .owns(&browser_id, &owner)
    {
        return Err("此窗口不拥有该浏览器".to_string());
    }
    if !browser_id.starts_with("browser-")
        || !browser_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("无效的浏览器标签".to_string());
    }
    if ![x, y, width, height].iter().all(|value| value.is_finite())
        || x < 0.0
        || y < 0.0
        || width <= 0.0
        || height <= 0.0
        || width > 4096.0
        || height > 4096.0
    {
        return Err("所选元素区域无效".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        use webview2_com::{
            CallDevToolsProtocolMethodCompletedHandler,
            Microsoft::Web::WebView2::Win32::ICoreWebView2,
        };
        use windows::core::HSTRING;
        let webview = app
            .get_webview(&browser_id)
            .ok_or_else(|| "浏览器标签已关闭".to_string())?;
        let params = serde_json::json!({ "format": "png", "fromSurface": true, "captureBeyondViewport": false,
            "clip": { "x": x, "y": y, "width": width, "height": height, "scale": 1.0 } }).to_string();
        let (sender, receiver) = std::sync::mpsc::channel::<Result<String, String>>();
        webview
            .with_webview(move |platform| {
                let setup = (|| -> Result<(), String> {
                    unsafe {
                        let controller = platform.controller();
                        let core: ICoreWebView2 = controller
                            .CoreWebView2()
                            .map_err(|error| error.to_string())?;
                        let method = HSTRING::from("Page.captureScreenshot");
                        let parameters = HSTRING::from(params);
                        let callback_sender = sender.clone();
                        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                            move |status, json| {
                                let result =
                                    status.map(|()| json).map_err(|error| error.to_string());
                                let _ = callback_sender.send(result);
                                Ok(())
                            },
                        ));
                        core.CallDevToolsProtocolMethod(&method, &parameters, &handler)
                            .map_err(|error| error.to_string())
                    }
                })();
                if let Err(error) = setup {
                    let _ = sender.send(Err(error));
                }
            })
            .map_err(|error| error.to_string())?;
        let response = receiver
            .recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|_| "网页截图超时".to_string())??;
        let data = serde_json::from_str::<serde_json::Value>(&response)
            .map_err(|error| format!("无法解析网页截图：{error}"))?
            .get("data")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "网页没有返回截图".to_string())?
            .to_string();
        if data.len() > 7 * 1024 * 1024 {
            return Err("截图超过 5 MB，无法添加到对话".to_string());
        }
        Ok(format!("data:image/png;base64,{data}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, x, y, width, height);
        Err("网页元素截图目前仅支持 Windows".to_string())
    }
}

#[tauri::command]
pub async fn browser_clear_data(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    crate::resource_owners::trusted(&webview)?;
    let browser_views = app
        .webviews()
        .into_iter()
        .filter(|(label, _)| label.starts_with("browser-"))
        .collect::<Vec<_>>();
    if browser_views.is_empty() {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        let profiles = fs::read_dir(&app_data)
            .map_err(|error| format!("无法访问浏览器数据目录：{error}"))?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let label = entry.file_name().to_string_lossy().into_owned();
                (label.starts_with("browser-") && entry.file_type().ok()?.is_dir())
                    .then(|| entry.path().join("browser-data").join(&label))
            })
            .filter(|profile| profile.is_dir())
            .collect::<Vec<_>>();
        for profile in profiles {
            let cleaner_label = format!(
                "browser-cleaner-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_micros()
            );
            let webview = tauri::WebviewWindowBuilder::new(
                &app,
                &cleaner_label,
                tauri::WebviewUrl::External(
                    url::Url::parse("about:blank").map_err(|error| error.to_string())?,
                ),
            )
            .data_directory(profile)
            .inner_size(1.0, 1.0)
            .decorations(false)
            .skip_taskbar(true)
            .visible(false)
            .build()
            .map_err(|error| format!("无法清理浏览器数据：{error}"))?;
            let result = webview
                .clear_all_browsing_data()
                .map_err(|error| error.to_string());
            let _ = webview.close();
            result?;
        }
    } else {
        for (_, webview) in browser_views {
            webview
                .clear_all_browsing_data()
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}
