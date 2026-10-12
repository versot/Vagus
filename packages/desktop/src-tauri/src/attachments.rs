use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub(crate) async fn save_image_attachment(
    app: AppHandle,
    name: String,
    mime_type: String,
    data_url: String,
    dialog_title: String,
    filter_name: String,
) -> Result<bool, String> {
    let extension = match mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => return Err("不支持保存此图片格式".to_string()),
    };
    let prefix = format!("data:{mime_type};base64,");
    let encoded = data_url
        .strip_prefix(&prefix)
        .ok_or_else(|| "图片数据格式无效".to_string())?;
    if encoded.len() > 22 * 1024 * 1024 {
        return Err("图片超过 16 MB，暂不支持保存".to_string());
    }
    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| "图片数据无效".to_string())?;
    if bytes.is_empty() || bytes.len() > 16 * 1024 * 1024 {
        return Err("图片超过 16 MB，暂不支持保存".to_string());
    }
    let valid_signature = match mime_type.as_str() {
        "image/png" => bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        _ => false,
    };
    if !valid_signature {
        return Err("图片数据与文件类型不匹配".to_string());
    }
    let basename = std::path::Path::new(&name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("image");
    let mut file_name = basename.to_string();
    if std::path::Path::new(&file_name).extension().is_none() {
        file_name.push('.');
        file_name.push_str(extension);
    }
    let selected = app
        .dialog()
        .file()
        .set_title(dialog_title)
        .set_file_name(file_name)
        .add_filter(filter_name, &["png", "jpg", "jpeg", "webp", "gif"])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(false);
    };
    let path = selected.into_path().map_err(|error| error.to_string())?;
    std::fs::write(path, bytes).map_err(|error| error.to_string())?;
    Ok(true)
}
