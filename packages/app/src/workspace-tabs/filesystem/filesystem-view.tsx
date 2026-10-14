import { invoke } from "@tauri-apps/api/core";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Code2,
  ExternalLink,
  File,
  FileCode2,
  FileText as FileTextIcon,
  Folder,
  FolderTree,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Search,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  createMarkdownComponents,
  markdownUrlTransform,
} from "../../features/conversation/components/markdown-components.js";
import i18n from "../../locales/i18n.js";
import { FilesystemCodeEditor } from "./filesystem-code-editor.js";
import "./filesystem-view.css";

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: number | null;
}
interface FileText {
  content: string;
  extension: string;
  isMarkdown: boolean;
}
interface FileCursor {
  isDirectory: boolean;
  name: string;
}
interface FolderPage {
  nextCursor: FileCursor | null;
  hasMore: boolean;
}
interface EntryTreeRow {
  kind: "entry";
  entry: FileEntry;
  depth: number;
  parent: string | null;
}
interface MoreTreeRow {
  kind: "more";
  folder: string;
  depth: number;
  parent: string;
}
type TreeRow = EntryTreeRow | MoreTreeRow;
const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
// Windows directory enumeration returns extended paths even when the chosen root does not.
const displayPath = (path: string) =>
  path
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "")
    .replace(/\\/g, "/");
const relativeTo = (path: string, root: string) => {
  const normalized = displayPath(path);
  const prefix = `${displayPath(root).replace(/\/$/, "")}/`;
  return normalized.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())
    ? normalized.slice(prefix.length)
    : normalized;
};
const parentPath = (path: string) => {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const parent = path.slice(0, separator);
  return separator === 0 ? path[0]! : parent.endsWith(":") ? parent + path[separator] : parent;
};
const isFolder = (entry: FileEntry) => entry.isDirectory && !entry.isSymlink;
const treeRowKey = (row: TreeRow) => (row.kind === "entry" ? row.entry.path : `load-more:${row.folder}`);
const TREE_ROW_HEIGHT = 31;
const TREE_OVERSCAN = 12;

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const namedFileIcons: Record<string, string> = {
  "package.json": "file-type-npm",
  "package-lock.json": "file-type-npm",
  "npm-shrinkwrap.json": "file-type-npm",
  "pnpm-lock.yaml": "file-type-pnpm",
  "pnpm-workspace.yaml": "file-type-pnpm",
  "yarn.lock": "file-type-yarn",
  "tsconfig.json": "file-type-tsconfig",
  "jsconfig.json": "file-type-json-official",
  dockerfile: "file-type-docker",
  "docker-compose.yml": "file-type-docker",
  "docker-compose.yaml": "file-type-docker",
  "cargo.toml": "file-type-rust",
  "cargo.lock": "file-type-rust",
  "go.mod": "file-type-go",
  "go.sum": "file-type-go",
  "requirements.txt": "file-type-python",
  "pyproject.toml": "file-type-python",
  pipfile: "file-type-python",
  pipfile_lock: "file-type-python",
  ".gitignore": "file-type-git",
  ".gitattributes": "file-type-git",
  ".gitmodules": "file-type-git",
  ".env": "file-type-dotenv",
  ".env.local": "file-type-dotenv",
  ".env.development": "file-type-dotenv",
  ".env.production": "file-type-dotenv",
  makefile: "file-type-bat",
  "readme.md": "file-type-markdown",
  license: "file-type-text",
};
const extensionFileIcons: Record<string, string> = {
  js: "file-type-js-official",
  mjs: "file-type-js-official",
  cjs: "file-type-js-official",
  jsx: "file-type-reactjs",
  ts: "file-type-typescript",
  mts: "file-type-typescript",
  cts: "file-type-typescript",
  tsx: "file-type-reactts",
  html: "file-type-html",
  htm: "file-type-html",
  css: "file-type-css",
  scss: "file-type-css",
  sass: "file-type-css",
  less: "file-type-css",
  json: "file-type-json-official",
  jsonc: "file-type-json-official",
  json5: "file-type-json-official",
  webmanifest: "file-type-json-official",
  py: "file-type-python",
  pyw: "file-type-python",
  rs: "file-type-rust",
  go: "file-type-go",
  java: "file-type-java",
  class: "file-type-java",
  cs: "file-type-csharp",
  cpp: "file-type-cpp",
  cc: "file-type-cpp",
  cxx: "file-type-cpp",
  c: "file-type-c",
  h: "file-type-c",
  swift: "file-type-swift",
  kt: "file-type-kotlin",
  kts: "file-type-kotlin",
  php: "file-type-php",
  rb: "file-type-ruby",
  sh: "file-type-shell",
  bash: "file-type-shell",
  zsh: "file-type-shell",
  ps1: "file-type-powershell",
  psm1: "file-type-powershell",
  bat: "file-type-bat",
  cmd: "file-type-bat",
  docker: "file-type-docker",
  yml: "file-type-yaml-official",
  yaml: "file-type-yaml-official",
  toml: "file-type-toml",
  env: "file-type-dotenv",
  md: "file-type-markdown",
  markdown: "file-type-markdown",
  mdx: "file-type-mdx",
  txt: "file-type-text",
  log: "file-type-text",
  pdf: "file-type-pdf",
  png: "file-type-image",
  jpg: "file-type-image",
  jpeg: "file-type-image",
  gif: "file-type-image",
  webp: "file-type-image",
  avif: "file-type-image",
  bmp: "file-type-image",
  ico: "file-type-image",
  tif: "file-type-image",
  tiff: "file-type-image",
  svg: "file-type-image",
  mp3: "file-type-audio",
  wav: "file-type-audio",
  ogg: "file-type-audio",
  flac: "file-type-audio",
  m4a: "file-type-audio",
  aac: "file-type-audio",
  mp4: "file-type-video",
  mov: "file-type-video",
  webm: "file-type-video",
  mkv: "file-type-video",
  avi: "file-type-video",
  xls: "file-type-excel",
  xlsx: "file-type-excel",
  csv: "file-type-excel",
  tsv: "file-type-excel",
  doc: "file-type-word",
  docx: "file-type-word",
  ppt: "file-type-powerpoint",
  pptx: "file-type-powerpoint",
  zip: "file-type-zip",
  "7z": "file-type-zip",
  rar: "file-type-zip",
  tar: "file-type-zip",
  gz: "file-type-zip",
  db: "file-type-sqlite",
  sqlite: "file-type-sqlite",
  sqlite3: "file-type-sqlite",
  sql: "file-type-sql",
  wasm: "file-type-wasm",
  xml: "file-type-xml",
  vue: "file-type-vue",
  svelte: "file-type-svelte",
  astro: "file-type-astro",
  angular: "file-type-angular",
};
const namedFolderIcons: Record<string, string> = {
  src: "folder-type-src",
  dist: "folder-type-dist",
  build: "folder-type-dist",
  assets: "folder-type-asset",
  asset: "folder-type-asset",
  node_modules: "folder-type-node",
  test: "folder-type-test",
  tests: "folder-type-test",
  __tests__: "folder-type-test",
  docs: "folder-type-docs",
  documentation: "folder-type-docs",
  ".git": "folder-type-git",
  ".github": "folder-type-github",
  components: "folder-type-component",
  component: "folder-type-component",
  public: "folder-type-public",
  images: "folder-type-images",
  img: "folder-type-images",
};

function FileGlyph({
  name,
  isDirectory,
  expanded = false,
  isRoot = false,
}: {
  name: string;
  isDirectory: boolean;
  expanded?: boolean;
  isRoot?: boolean;
}) {
  const fileName = name.toLowerCase();
  let iconName: string;
  if (isDirectory) {
    const folderIcon = isRoot ? "default-root-folder" : (namedFolderIcons[fileName] ?? "default-folder");
    iconName = expanded ? `${folderIcon}-opened` : folderIcon;
  } else {
    const extension = fileName.includes(".") ? (fileName.split(".").pop() ?? "") : "";
    iconName = namedFileIcons[fileName] ?? extensionFileIcons[extension] ?? "default-file";
  }
  return (
    <img
      className="filesystem-vscode-icon"
      src={`/vscode-icons/${iconName}.svg`}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

export type FileSystemViewProps = {
  initialRoot: string | null;
  contextRoot: string | null;
  onOpenUrl?(url: string): void;
  onShowTooltip?(event: MouseEvent<HTMLElement>, label: string): void;
  onHideTooltip?(): void;
};
export function FileSystemView({
  initialRoot,
  contextRoot,
  onOpenUrl,
  onShowTooltip,
  onHideTooltip,
}: FileSystemViewProps) {
  const [root, setRoot] = useState(initialRoot ?? contextRoot);
  const [entriesByFolder, setEntriesByFolder] = useState<Record<string, FileEntry[]>>({});
  const [folderPages, setFolderPages] = useState<Record<string, FolderPage>>({});
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(initialRoot || contextRoot ? [initialRoot ?? contextRoot!] : []),
  );
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [focusPath, setFocusPath] = useState(initialRoot ?? contextRoot ?? "");
  const [preview, setPreview] = useState<FileText | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [reading, setReading] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);
  const [search, setSearch] = useState("");
  const [treeVisible, setTreeVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());
  const [folderErrors, setFolderErrors] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState("");
  const [treeViewport, setTreeViewport] = useState({ top: 0, height: 0 });
  const generation = useRef(0);
  const fileRequest = useRef(0);
  const attemptedDraft = useRef("");
  const draftRef = useRef(draft);
  const pendingFolders = useRef(new Set<string>());
  const folderPagesRef = useRef<Record<string, FolderPage>>({});
  const treeRef = useRef<HTMLDivElement>(null);
  const treeScrollFrame = useRef<number | null>(null);
  const previewRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openWrapRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);

  const tooltip = (label: string) => ({
    onMouseEnter: (event: MouseEvent<HTMLElement>) => onShowTooltip?.(event, label),
    onMouseLeave: onHideTooltip,
  });
  const invalidate = useCallback(() => {
    generation.current++;
    fileRequest.current++;
    pendingFolders.current.clear();
  }, []);
  useEffect(
    () => () => {
      invalidate();
    },
    [invalidate],
  );

  const loadFolder = useCallback(
    async (folder: string, activeRoot = root, append = false) => {
      if (!activeRoot || pendingFolders.current.has(folder)) return;
      const cursor = append ? folderPagesRef.current[folder]?.nextCursor : null;
      if (append && !cursor) return;
      const batch = generation.current;
      pendingFolders.current.add(folder);
      setLoadingFolders((current) => new Set(current).add(folder));
      setFolderErrors((current) => {
        const next = { ...current };
        delete next[folder];
        return next;
      });
      try {
        const page = await invoke<{ entries: FileEntry[]; nextCursor: FileCursor | null; hasMore: boolean }>(
          "filesystem_list_directory",
          { root: activeRoot, path: folder, cursor },
        );
        if (batch === generation.current) {
          setEntriesByFolder((current) => ({
            ...current,
            [folder]: append ? [...(current[folder] ?? []), ...page.entries] : page.entries,
          }));
          const nextPages = {
            ...folderPagesRef.current,
            [folder]: { nextCursor: page.nextCursor, hasMore: page.hasMore },
          };
          folderPagesRef.current = nextPages;
          setFolderPages(nextPages);
        }
      } catch (reason) {
        if (batch === generation.current) setFolderErrors((current) => ({ ...current, [folder]: messageOf(reason) }));
      } finally {
        if (batch === generation.current) {
          pendingFolders.current.delete(folder);
          setLoadingFolders((current) => {
            const next = new Set(current);
            next.delete(folder);
            return next;
          });
        }
      }
    },
    [root],
  );
  useEffect(() => {
    if (root) void loadFolder(root);
  }, [root, loadFolder]);

  const chooseRoot = async () => {
    if (preview && draft !== preview.content) {
      setActionError(i18n.t("当前文件有未保存更改，请先保存或取消编辑。"));
      return;
    }
    onHideTooltip?.();
    setMenuOpen(false);
    try {
      const chosen = await openFolderDialog({
        directory: true,
        multiple: false,
        title: i18n.t("选择工作区文件夹"),
        ...(root ? { defaultPath: root } : {}),
      });
      if (typeof chosen !== "string" || chosen === root) return;
      invalidate();
      setRoot(chosen);
      setFocusPath(chosen);
      setExpanded(new Set([chosen]));
      setEntriesByFolder({});
      folderPagesRef.current = {};
      setFolderPages({});
      setLoadingFolders(new Set());
      setFolderErrors({});
      setActionError("");
      setSelected(null);
      setPreview(null);
      setReading(false);
      setPreviewError("");
      setSearch("");
      setDraft("");
    } catch (reason) {
      setActionError(messageOf(reason));
    }
  };

  const readFile = async (entry: FileEntry, discardDraft = false) => {
    if (!discardDraft && preview && draft !== preview.content) {
      setActionError(i18n.t("当前文件有未保存更改，请先保存或取消编辑。"));
      return;
    }
    const request = ++fileRequest.current;
    setSelected(entry);
    setMenuOpen(false);
    setPreview(null);
    setPreviewError("");
    setReading(true);
    setDraft("");
    setActionError("");
    try {
      const content = await invoke<FileText>("filesystem_read_file", { root, path: entry.path });
      if (request === fileRequest.current) {
        setPreview(content);
        draftRef.current = content.content;
        setDraft(content.content);
        setSourceMode(content.isMarkdown);
        previewRef.current?.scrollTo(0, 0);
      }
    } catch (reason) {
      if (request === fileRequest.current) setPreviewError(messageOf(reason));
    } finally {
      if (request === fileRequest.current) setReading(false);
    }
  };

  const toggleFolder = (path: string, open = !expanded.has(path)) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
    if (open && (!entriesByFolder[path] || folderErrors[path])) void loadFolder(path);
  };
  const selectEntry = (entry: FileEntry) => {
    if (entry.path === selected?.path && preview) return;
    if (preview && draft !== preview.content && entry.path !== selected?.path) {
      setActionError(i18n.t("当前文件有未保存更改，请先保存或取消编辑。"));
      return;
    }
    setFocusPath(entry.path);
    if (isFolder(entry)) toggleFolder(entry.path);
    else {
      setSourceMode(false);
      void readFile(entry);
    }
  };
  const refresh = () => {
    if (!root) return;
    if (preview && draft !== preview.content) {
      setActionError(i18n.t("当前文件有未保存更改，请先保存或取消编辑。"));
      return;
    }
    invalidate();
    setEntriesByFolder({});
    folderPagesRef.current = {};
    setFolderPages({});
    setFolderErrors({});
    setLoadingFolders(new Set());
    for (const folder of new Set([root, ...expanded])) void loadFolder(folder);
    if (selected) void readFile(selected);
  };

  const rows = useMemo<TreeRow[]>(() => {
    if (!root) return [];
    const query = search.trim().toLocaleLowerCase();
    const visit = (folder: string, depth: number): TreeRow[] => {
      const result: TreeRow[] = [];
      for (const entry of entriesByFolder[folder] ?? []) {
        const children = isFolder(entry) && (expanded.has(entry.path) || query) ? visit(entry.path, depth + 1) : [];
        const relative = relativeTo(entry.path, root);
        if (!query || relative.toLocaleLowerCase().includes(query) || children.length) {
          result.push({ kind: "entry", entry, depth, parent: folder }, ...children);
        }
      }
      if (folderPages[folder]?.hasMore) result.push({ kind: "more", folder, depth, parent: folder });
      return result;
    };
    const rootEntry: FileEntry = {
      path: root,
      name: basename(root),
      isDirectory: true,
      isSymlink: false,
      size: 0,
      modifiedAt: null,
    };
    return [
      { kind: "entry", entry: rootEntry, depth: 0, parent: null },
      ...(expanded.has(root) || query ? visit(root, 1) : []),
    ];
  }, [entriesByFolder, expanded, folderPages, root, search]);
  const tabPath = rows.some((row) => treeRowKey(row) === focusPath) ? focusPath : root;
  const virtualStart = Math.max(0, Math.floor(treeViewport.top / TREE_ROW_HEIGHT) - TREE_OVERSCAN);
  const virtualEnd = Math.min(
    rows.length,
    Math.ceil((treeViewport.top + treeViewport.height) / TREE_ROW_HEIGHT) + TREE_OVERSCAN,
  );
  const visibleRows = rows.slice(virtualStart, virtualEnd);
  useEffect(
    () => () => {
      if (treeScrollFrame.current !== null) cancelAnimationFrame(treeScrollFrame.current);
    },
    [],
  );
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const update = () => setTreeViewport({ top: tree.scrollTop, height: tree.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(tree);
    return () => observer.disconnect();
  }, [treeVisible]);
  const focusRow = (path: string) => {
    setFocusPath(path);
    const index = rows.findIndex((row) => treeRowKey(row) === path);
    const tree = treeRef.current;
    if (!tree || index < 0) return;
    const top = index * TREE_ROW_HEIGHT;
    if (top < tree.scrollTop) tree.scrollTop = top;
    else if (top + TREE_ROW_HEIGHT > tree.scrollTop + tree.clientHeight)
      tree.scrollTop = top + TREE_ROW_HEIGHT - tree.clientHeight;
    setTreeViewport({ top: tree.scrollTop, height: tree.clientHeight });
    requestAnimationFrame(() => tree.querySelector<HTMLButtonElement>(`[data-tree-index="${index}"]`)?.focus());
  };
  const treeKeyDown = (event: KeyboardEvent<HTMLButtonElement>, row: TreeRow, index: number) => {
    const key = event.key;
    if (row.kind === "more") {
      if (["Enter", " "].includes(key)) {
        event.preventDefault();
        event.stopPropagation();
        void loadFolder(row.folder, root, true);
        return;
      }
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "Home", "End"].includes(key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (key === "ArrowUp" || key === "ArrowDown")
        focusRow(treeRowKey(rows[Math.max(0, Math.min(rows.length - 1, index + (key === "ArrowDown" ? 1 : -1)))]!));
      else if (key === "Home" || key === "End") focusRow(treeRowKey(rows[key === "Home" ? 0 : rows.length - 1]!));
      else focusRow(row.parent);
      return;
    }
    const entry = row.entry;
    const folder = isFolder(entry);
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (key === "ArrowUp" || key === "ArrowDown")
      focusRow(treeRowKey(rows[Math.max(0, Math.min(rows.length - 1, index + (key === "ArrowDown" ? 1 : -1)))]!));
    else if (key === "Home" || key === "End") focusRow(treeRowKey(rows[key === "Home" ? 0 : rows.length - 1]!));
    else if (key === "ArrowRight" && folder) {
      if (!search.trim() && !expanded.has(entry.path)) toggleFolder(entry.path, true);
      else if (rows[index + 1]?.parent === entry.path) focusRow(treeRowKey(rows[index + 1]!));
    } else if (key === "ArrowLeft") {
      if (!search.trim() && folder && expanded.has(entry.path)) toggleFolder(entry.path, false);
      else if (row.parent) focusRow(row.parent);
    }
  };

  const closeMenu = () => {
    setMenuOpen(false);
    openButtonRef.current?.focus();
  };
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      if (!openWrapRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    return () => document.removeEventListener("pointerdown", dismissOutside, true);
  }, [menuOpen]);
  const openWith = async (application: string) => {
    const target = selected?.path ?? root;
    if (!target) return;
    closeMenu();
    setActionError("");
    // A shell opens the containing directory when a file is being previewed.
    const path =
      selected && ["terminal", "wsl"].includes(application)
        ? (Object.entries(entriesByFolder).find(([, entries]) => entries.some((entry) => entry.path === target))?.[0] ??
          parentPath(target))
        : target;
    try {
      await invoke("filesystem_open_path", { path, application });
    } catch (reason) {
      setActionError(messageOf(reason));
    }
  };
  const saveFile = useCallback(async () => {
    if (!root || !selected || !preview || selected.isSymlink || saving || draft === preview.content) return;
    if (new TextEncoder().encode(draft).byteLength > 2 * 1024 * 1024) {
      setActionError(i18n.t("文件超过 2 MB，暂不支持编辑"));
      return;
    }
    setSaving(true);
    setActionError("");
    try {
      const result = await invoke<{ size: number; modifiedAt: number | null }>("filesystem_write_file", {
        root,
        path: selected.path,
        content: draft,
        expectedContent: preview.content,
      });
      const savedPreview = { ...preview, content: draft };
      const savedEntry = { ...selected, size: result.size, modifiedAt: result.modifiedAt };
      setPreview(savedPreview);
      if (draftRef.current === draft) setDraft(draft);
      setSelected(savedEntry);
      setEntriesByFolder((current) =>
        Object.fromEntries(
          Object.entries(current).map(([folder, entries]) => [
            folder,
            entries.map((entry) => (entry.path === savedEntry.path ? savedEntry : entry)),
          ]),
        ),
      );
    } catch (reason) {
      attemptedDraft.current = draftRef.current;
      setActionError(messageOf(reason));
    } finally {
      setSaving(false);
    }
  }, [draft, preview, root, saving, selected]);
  useEffect(() => {
    if (
      !preview ||
      !selected ||
      selected.isSymlink ||
      draft === preview.content ||
      saving ||
      attemptedDraft.current === draft
    )
      return;
    const timer = window.setTimeout(() => {
      attemptedDraft.current = draft;
      void saveFile();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [draft, preview, saveFile, saving, selected]);
  const relativePath = selected && root ? relativeTo(selected.path, root) : "";
  const markdownPreviewTooLarge = Boolean(preview?.isMarkdown && preview.content.length > 100_000);

  return (
    <section className={`filesystem-view${treeVisible ? " has-tree" : ""}`}>
      <header className="filesystem-toolbar">
        <div className="filesystem-breadcrumb">
          <button
            type="button"
            aria-label={i18n.t("选择工作区文件夹")}
            {...tooltip(root ?? i18n.t("选择工作区文件夹"))}
            onClick={() => void chooseRoot()}
          >
            <Folder size={15} />
            <span>{root ? basename(root) : i18n.t("选择文件夹")}</span>
            <ChevronDown size={12} />
          </button>
          {relativePath && (
            <>
              <ChevronRight size={13} />
              <span {...tooltip(selected!.path)}>{relativePath}</span>
            </>
          )}
        </div>
        <div className="filesystem-toolbar-actions">
          <button
            type="button"
            aria-label={i18n.t("刷新文件列表")}
            {...tooltip(i18n.t("刷新文件列表"))}
            disabled={!root || loadingFolders.size > 0}
            onClick={() => {
              onHideTooltip?.();
              refresh();
            }}
          >
            <RefreshCw size={15} className={loadingFolders.size ? "filesystem-spinning" : ""} />
          </button>
          <div ref={openWrapRef} className="filesystem-open-wrap">
            <button
              ref={openButtonRef}
              type="button"
              aria-label={i18n.t("打开方式")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              {...tooltip(i18n.t("打开方式"))}
              disabled={!root}
              onClick={() => {
                onHideTooltip?.();
                setMenuOpen((value) => !value);
              }}
            >
              <ExternalLink size={15} />
              <ChevronDown size={12} />
            </button>
            {menuOpen && (
              <div
                ref={menuRef}
                className="filesystem-open-menu"
                role="menu"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    closeMenu();
                  } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                    event.preventDefault();
                    event.stopPropagation();
                    const items = Array.from(
                      event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]"),
                    );
                    const index = items.indexOf(document.activeElement as HTMLButtonElement);
                    items[
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? items.length - 1
                          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
                    ]?.focus();
                  } else if (event.key === "Tab") setMenuOpen(false);
                }}
              >
                <button type="button" role="menuitem" onClick={() => void openWith("vscode")}>
                  <Code2 size={15} />
                  VS Code
                </button>
                <button type="button" role="menuitem" onClick={() => void openWith("zed")}>
                  <Code2 size={15} />
                  Zed
                </button>
                <button type="button" role="menuitem" onClick={() => void openWith("default")}>
                  <ExternalLink size={15} />
                  {i18n.t("默认应用")}
                </button>
                <div className="filesystem-menu-divider" />
                <button type="button" role="menuitem" onClick={() => void openWith("terminal")}>
                  <SquareTerminal size={15} />
                  {i18n.t("终端")}
                </button>
                <button type="button" role="menuitem" onClick={() => void openWith("wsl")}>
                  <SquareTerminal size={15} />
                  WSL
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label={i18n.t(treeVisible ? "隐藏文件列表" : "显示文件列表")}
            aria-pressed={treeVisible}
            {...tooltip(i18n.t(treeVisible ? "隐藏文件列表" : "显示文件列表"))}
            onClick={() => {
              onHideTooltip?.();
              setTreeVisible((value) => !value);
            }}
          >
            <Folder size={16} />
          </button>
        </div>
      </header>
      {actionError && (
        <div className="filesystem-action-error" role="alert">
          <span>{actionError}</span>
          {preview && draft !== preview.content && selected && (
            <button type="button" className="filesystem-reload-button" onClick={() => void readFile(selected, true)}>
              {i18n.t("放弃更改并重新读取")}
            </button>
          )}
          <button type="button" aria-label={i18n.t("关闭")} onClick={() => setActionError("")}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className="filesystem-body">
        <div className="filesystem-document">
          {selected && (
            <header className="filesystem-document-header">
              <div className="filesystem-document-name">
                <FileGlyph name={selected.name} isDirectory={false} />
                <strong>{selected.name}</strong>
              </div>
              <div className="filesystem-document-controls">
                {preview?.isMarkdown && (
                  <div className="filesystem-mode" role="group" aria-label={i18n.t("文件预览")}>
                    <button type="button" aria-pressed={!sourceMode} onClick={() => setSourceMode(false)}>
                      {i18n.t("阅读预览")}
                    </button>
                    <button type="button" aria-pressed={sourceMode} onClick={() => setSourceMode(true)}>
                      {i18n.t("源代码")}
                    </button>
                  </div>
                )}
                {preview && !selected.isSymlink && draft !== preview.content && (
                  <span className={`filesystem-save-dirty${saving ? " is-saving" : " is-dirty"}`} role="status">
                    {saving ? i18n.t("保存中…") : i18n.t("有未保存的更改")}
                  </span>
                )}
              </div>
            </header>
          )}
          <main
            ref={previewRef}
            className="filesystem-preview"
            aria-label={i18n.t("文件预览")}
            aria-busy={reading}
            tabIndex={0}
          >
            {!root ? (
              <button type="button" className="filesystem-empty" onClick={() => void chooseRoot()}>
                <FolderTree size={32} />
                <strong>{i18n.t("选择文件夹")}</strong>
                <span>{i18n.t("选择一个文件夹以浏览文件")}</span>
              </button>
            ) : reading ? (
              <div className="filesystem-empty" role="status">
                <LoaderCircle size={24} className="filesystem-spinning" />
                <span>{i18n.t("正在读取…")}</span>
              </div>
            ) : previewError ? (
              <div className="filesystem-empty is-error" role="alert">
                <File size={30} />
                <strong>{i18n.t("无法预览此文件")}</strong>
                <span>{previewError}</span>
                <div className="filesystem-empty-actions">
                  <button type="button" onClick={() => selected && void readFile(selected)}>
                    {i18n.t("重试")}
                  </button>
                  <button type="button" onClick={() => void openWith("default")}>
                    {i18n.t("默认应用")}
                  </button>
                </div>
              </div>
            ) : preview ? (
              sourceMode || !preview.isMarkdown || markdownPreviewTooLarge ? (
                <>
                  <FilesystemCodeEditor
                    key={selected?.path ?? ""}
                    filePath={selected?.path ?? ""}
                    value={draft}
                    readOnly={Boolean(selected?.isSymlink)}
                    ariaLabel={i18n.t("文件内容")}
                    onChange={(value) => {
                      attemptedDraft.current = "";
                      draftRef.current = value;
                      setActionError("");
                      setDraft(value);
                    }}
                    onSave={saveFile}
                  />
                  {markdownPreviewTooLarge && !sourceMode && (
                    <div className="filesystem-markdown-budget" role="status">
                      {i18n.t("Markdown 文件较大，已显示源码以保持界面响应")}
                    </div>
                  )}
                </>
              ) : (
                <article className="filesystem-markdown">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={createMarkdownComponents(onOpenUrl)}
                    urlTransform={markdownUrlTransform}
                  >
                    {draft}
                  </ReactMarkdown>
                </article>
              )
            ) : (
              <div className="filesystem-empty">
                <FileCode2 size={32} />
                <strong>{i18n.t("打开文件")}</strong>
                <span>{i18n.t("从文件列表中选择文件以预览内容")}</span>
              </div>
            )}
          </main>
          {selected && (
            <footer className="filesystem-document-status">
              <span>
                {selected.isSymlink ? <LockKeyhole size={12} /> : <FileTextIcon size={12} />}
                {selected.isSymlink
                  ? i18n.t("只读")
                  : preview?.isMarkdown && !sourceMode
                    ? i18n.t("阅读预览")
                    : i18n.t("可编辑")}
              </span>
              <span>{formatSize(selected.size)}</span>
              {preview && (
                <>
                  <span>UTF-8</span>
                  <span>{i18n.t("行数：{{count}}", { count: draft.replace(/\n$/, "").split("\n").length })}</span>
                  {!selected.isSymlink && <span>Ctrl+S</span>}
                </>
              )}
            </footer>
          )}
        </div>
        {treeVisible && (
          <aside className="filesystem-tree" aria-label={i18n.t("文件列表")}>
            <header className="filesystem-tree-header">
              <span>{i18n.t("文件列表")}</span>
              <button
                type="button"
                aria-label={i18n.t("折叠文件夹")}
                {...tooltip(i18n.t("折叠文件夹"))}
                disabled={!root}
                onClick={() => {
                  onHideTooltip?.();
                  setExpanded(new Set(root ? [root] : []));
                  if (root) setFocusPath(root);
                }}
              >
                <ChevronsDownUp size={15} />
              </button>
            </header>
            <label className="filesystem-search">
              <Search size={14} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={i18n.t("筛选文件…")}
                aria-label={i18n.t("筛选文件")}
              />
              {search && (
                <button type="button" aria-label={i18n.t("清除搜索")} onClick={() => setSearch("")}>
                  <X size={13} />
                </button>
              )}
            </label>
            <div
              ref={treeRef}
              className="filesystem-tree-scroll"
              role="tree"
              aria-label={i18n.t("文件列表")}
              onScroll={(event) => {
                const target = event.currentTarget;
                if (treeScrollFrame.current !== null) return;
                treeScrollFrame.current = requestAnimationFrame(() => {
                  treeScrollFrame.current = null;
                  setTreeViewport({ top: target.scrollTop, height: target.clientHeight });
                });
              }}
            >
              {virtualStart > 0 && (
                <div
                  aria-hidden="true"
                  className="filesystem-tree-virtual-spacer"
                  style={{ height: virtualStart * TREE_ROW_HEIGHT }}
                />
              )}
              {visibleRows.map((row, offset) => {
                const index = virtualStart + offset;
                const key = treeRowKey(row);
                if (row.kind === "more")
                  return (
                    <button
                      type="button"
                      key={key}
                      data-tree-index={index}
                      className="filesystem-tree-row filesystem-tree-load-more"
                      style={{ "--tree-depth": row.depth } as CSSProperties}
                      role="treeitem"
                      tabIndex={tabPath === key ? 0 : -1}
                      aria-level={row.depth + 1}
                      aria-posinset={index + 1}
                      aria-setsize={rows.length}
                      aria-selected="false"
                      disabled={loadingFolders.has(row.folder)}
                      onFocus={() => setFocusPath(key)}
                      onClick={() => void loadFolder(row.folder, root, true)}
                      onKeyDown={(event) => treeKeyDown(event, row, index)}
                    >
                      {loadingFolders.has(row.folder) ? (
                        <LoaderCircle size={13} className="filesystem-spinning" />
                      ) : (
                        <ChevronDown size={13} />
                      )}
                      <span>{i18n.t("加载更多文件")}</span>
                    </button>
                  );
                const entry = row.entry;
                return (
                  <button
                    type="button"
                    key={key}
                    data-tree-index={index}
                    className={`filesystem-tree-row${isFolder(entry) ? " is-directory" : ""}${selected?.path === entry.path ? " is-selected" : ""}${index === 0 ? " is-root" : ""}`}
                    style={{ "--tree-depth": row.depth } as CSSProperties}
                    role="treeitem"
                    tabIndex={tabPath === key ? 0 : -1}
                    aria-level={row.depth + 1}
                    aria-posinset={index + 1}
                    aria-setsize={rows.length}
                    aria-selected={selected?.path === entry.path}
                    aria-expanded={isFolder(entry) ? expanded.has(entry.path) || !!search.trim() : undefined}
                    onFocus={() => setFocusPath(entry.path)}
                    onClick={() => selectEntry(entry)}
                    onKeyDown={(event) => treeKeyDown(event, row, index)}
                  >
                    {loadingFolders.has(entry.path) ? (
                      <LoaderCircle size={13} className="filesystem-spinning" />
                    ) : isFolder(entry) ? (
                      expanded.has(entry.path) || search.trim() ? (
                        <ChevronDown size={13} />
                      ) : (
                        <ChevronRight size={13} />
                      )
                    ) : (
                      <span className="filesystem-tree-spacer" />
                    )}
                    <FileGlyph
                      name={entry.name}
                      isDirectory={isFolder(entry)}
                      expanded={expanded.has(entry.path) || !!search.trim()}
                      isRoot={index === 0}
                    />
                    <span>{entry.name}</span>
                    {entry.isSymlink && <small>{i18n.t("链接")}</small>}
                  </button>
                );
              })}
              {virtualEnd < rows.length && (
                <div
                  aria-hidden="true"
                  className="filesystem-tree-virtual-spacer"
                  style={{ height: (rows.length - virtualEnd) * TREE_ROW_HEIGHT }}
                />
              )}
              {Object.entries(folderErrors).map(([folder, error]) => (
                <div className="filesystem-tree-error" role="alert" key={folder}>
                  <strong>{basename(folder)}</strong>
                  <span>{error}</span>
                  <button
                    type="button"
                    onClick={() =>
                      void loadFolder(
                        folder,
                        root,
                        Boolean(entriesByFolder[folder]?.length && folderPages[folder]?.hasMore),
                      )
                    }
                  >
                    {i18n.t("重试")}
                  </button>
                </div>
              ))}
              {!loadingFolders.size &&
                !Object.keys(folderErrors).length &&
                root &&
                rows.length === 1 &&
                (expanded.has(root) || search.trim()) && (
                  <div className="filesystem-tree-status">
                    {i18n.t(search.trim() ? "没有匹配的文件" : "文件夹为空")}
                  </div>
                )}
            </div>
            {search.trim() && <div className="filesystem-filter-note">{i18n.t("仅筛选已展开过的文件夹")}</div>}
          </aside>
        )}
      </div>
    </section>
  );
}
