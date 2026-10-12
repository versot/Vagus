use serde::Serialize;

use serde::Deserialize;

use std::collections::BTreeMap;

use std::fs;

use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    name: String,
    path: String,
    is_directory: bool,
    is_symlink: bool,
    size: u64,
    modified_at: Option<u128>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileCursor {
    is_directory: bool,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDirectoryPage {
    entries: Vec<FileEntry>,
    next_cursor: Option<FileCursor>,
    has_more: bool,
}

const DIRECTORY_PAGE_SIZE: usize = 200;

fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let path = Path::new(root)
        .canonicalize()
        .map_err(|error| format!("无法访问文件夹：{error}"))?;
    if !path.is_dir() {
        return Err("所选路径不是文件夹".to_string());
    }
    Ok(path)
}

fn checked_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("无法访问此路径：{error}"))?;
    if !path.starts_with(root) {
        return Err("只能访问已选择文件夹中的内容".to_string());
    }
    Ok(path)
}

#[tauri::command]
pub async fn filesystem_list_directory(
    root: String,
    path: String,
    cursor: Option<FileCursor>,
) -> Result<FileDirectoryPage, String> {
    tauri::async_runtime::spawn_blocking(move || list_directory(root, path, cursor))
        .await
        .map_err(|error| format!("无法读取文件夹：{error}"))?
}

fn list_directory(
    root: String,
    path: String,
    cursor: Option<FileCursor>,
) -> Result<FileDirectoryPage, String> {
    let root = canonical_root(&root)?;
    let directory = checked_path(&root, &path)?;
    if !directory.is_dir() {
        return Err("路径不是文件夹".to_string());
    }
    if cursor
        .as_ref()
        .is_some_and(|cursor| cursor.name.len() > 4096)
    {
        return Err("文件夹分页游标无效".to_string());
    }
    let after = cursor.map(|cursor| {
        (
            !cursor.is_directory,
            cursor.name.to_lowercase(),
            cursor.name,
        )
    });
    let mut page = BTreeMap::new();
    let mut has_more = false;
    for item in fs::read_dir(&directory).map_err(|error| format!("无法读取文件夹：{error}"))?
    {
        let item = item.map_err(|error| format!("读取文件信息失败：{error}"))?;
        let file_type = item.file_type().map_err(|error| error.to_string())?;
        let is_directory = file_type.is_dir();
        let name = item.file_name().to_string_lossy().into_owned();
        let key = (!is_directory, name.to_lowercase(), name.clone());
        if after.as_ref().is_some_and(|after| key <= *after) {
            continue;
        }
        let metadata = item.metadata().ok();
        page.insert(
            key,
            FileEntry {
                name,
                path: item.path().to_string_lossy().into_owned(),
                is_directory,
                is_symlink: file_type.is_symlink(),
                size: metadata
                    .as_ref()
                    .map(|metadata| metadata.len())
                    .unwrap_or(0),
                modified_at: metadata
                    .and_then(|metadata| metadata.modified().ok())
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis()),
            },
        );
        if page.len() > DIRECTORY_PAGE_SIZE {
            page.pop_last();
            has_more = true;
        }
    }
    let next_cursor = has_more.then(|| {
        let (is_directory, name) = page
            .last_key_value()
            .map(|(key, _)| (!key.0, key.2.clone()))
            .expect("a non-empty page has a cursor");
        FileCursor { is_directory, name }
    });
    Ok(FileDirectoryPage {
        entries: page.into_values().collect(),
        next_cursor,
        has_more,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    content: String,
    extension: String,
    is_markdown: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteResult {
    size: u64,
    modified_at: Option<u128>,
}

#[tauri::command]
pub async fn filesystem_read_file(root: String, path: String) -> Result<FileText, String> {
    tauri::async_runtime::spawn_blocking(move || read_file(root, path))
        .await
        .map_err(|error| format!("无法读取文件：{error}"))?
}

fn read_file(root: String, path: String) -> Result<FileText, String> {
    const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;
    let root = canonical_root(&root)?;
    let path = checked_path(&root, &path)?;
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("只能预览文件".to_string());
    }
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err("文件超过 2 MB，暂不支持预览".to_string());
    }
    let bytes = fs::read(&path).map_err(|error| format!("无法读取文件：{error}"))?;
    let content =
        String::from_utf8(bytes).map_err(|_| "此文件不是 UTF-8 文本，无法预览".to_string())?;
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_lowercase();
    Ok(FileText {
        content,
        is_markdown: matches!(extension.as_str(), "md" | "mdx"),
        extension,
    })
}

#[tauri::command]
pub async fn filesystem_write_file(
    root: String,
    path: String,
    content: String,
    expected_content: String,
) -> Result<FileWriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || write_file(root, path, content, expected_content))
        .await
        .map_err(|error| format!("无法保存文件：{error}"))?
}

fn write_file(
    root: String,
    path: String,
    content: String,
    expected_content: String,
) -> Result<FileWriteResult, String> {
    const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
    if content.len() > MAX_FILE_BYTES {
        return Err("文件超过 2 MB，暂不支持编辑".to_string());
    }
    let root = canonical_root(&root)?;
    let raw_path = Path::new(&path);
    let link_metadata =
        fs::symlink_metadata(raw_path).map_err(|error| format!("无法访问此路径：{error}"))?;
    if link_metadata.file_type().is_symlink() {
        return Err("不支持编辑符号链接".to_string());
    }
    let path = checked_path(&root, &path)?;
    let metadata = fs::metadata(&path).map_err(|error| format!("无法访问此文件：{error}"))?;
    if !metadata.is_file() {
        return Err("只能编辑文件".to_string());
    }
    if metadata.len() as usize > MAX_FILE_BYTES {
        return Err("文件超过 2 MB，暂不支持编辑".to_string());
    }
    let current_bytes = fs::read(&path).map_err(|error| format!("无法读取文件：{error}"))?;
    let current = String::from_utf8(current_bytes)
        .map_err(|_| "此文件不是 UTF-8 文本，无法编辑".to_string())?;
    if current != expected_content {
        return Err("文件在编辑期间已被外部更改，请重新读取后再保存".to_string());
    }
    fs::write(&path, content.as_bytes()).map_err(|error| format!("无法保存文件：{error}"))?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("文件已保存，但无法读取更新后的文件信息：{error}"))?;
    Ok(FileWriteResult {
        size: metadata.len(),
        modified_at: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis()),
    })
}

#[tauri::command]
pub async fn filesystem_open_path(path: String, application: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::external_open::open_path(path, application))
        .await
        .map_err(|error| format!("无法启动外部应用：{error}"))?
}

#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "网址无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只支持打开 HTTP 或 HTTPS 网页".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("不支持打开包含用户名或密码的网址".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || crate::external_open::open_url(parsed.as_str()))
        .await
        .map_err(|error| format!("无法打开默认浏览器：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::{list_directory, FileCursor, DIRECTORY_PAGE_SIZE};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn directory_pages_are_bounded_sorted_and_complete() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "vagus-filesystem-pages-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("folder-a")).unwrap();
        fs::create_dir_all(root.join("folder-b")).unwrap();
        for index in 0..205 {
            fs::write(root.join(format!("file-{index:03}.txt")), []).unwrap();
        }

        let mut cursor: Option<FileCursor> = None;
        let mut names = Vec::new();
        let mut page_count = 0;
        loop {
            let page = list_directory(
                root.to_string_lossy().into_owned(),
                root.to_string_lossy().into_owned(),
                cursor,
            )
            .unwrap();
            assert!(page.entries.len() <= DIRECTORY_PAGE_SIZE);
            page_count += 1;
            names.extend(page.entries.iter().map(|entry| entry.name.clone()));
            if !page.has_more {
                assert!(page.next_cursor.is_none());
                break;
            }
            let next = page
                .next_cursor
                .expect("a non-final page must have a cursor");
            assert_eq!(next.name, page.entries.last().unwrap().name);
            cursor = Some(next);
        }

        assert_eq!(page_count, 2);
        assert_eq!(names.len(), 207);
        assert_eq!(
            names.iter().collect::<std::collections::HashSet<_>>().len(),
            names.len()
        );
        assert_eq!(
            &names[..2],
            &["folder-a".to_string(), "folder-b".to_string()]
        );
        assert_eq!(
            &names[2..],
            &(0..205)
                .map(|index| format!("file-{index:03}.txt"))
                .collect::<Vec<_>>()
        );
        fs::remove_dir_all(root).unwrap();
    }
}
