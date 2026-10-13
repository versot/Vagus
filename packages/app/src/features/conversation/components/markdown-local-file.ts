const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "tif", "tiff", "svg"]);

function isImagePath(path: string): boolean {
  return imageExtensions.has(path.split(/[?#]/, 1)[0]!.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "");
}

/** Recognize explicit local image paths without treating ordinary site-relative URLs as files. */
export function markdownImageFilePath(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== "file:" || (url.hostname && url.hostname.toLowerCase() !== "localhost")) return null;
      let path = decodeURIComponent(url.pathname);
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
      if (/^[a-z]:\//i.test(path)) path = path.replaceAll("/", "\\");
      return isImagePath(path) ? path : null;
    } catch {
      return null;
    }
  }
  let path = value;
  try {
    path = decodeURIComponent(value);
  } catch {
    /* Keep literal percent characters in valid paths. */
  }
  if (/^[a-z]:[\\/]/i.test(path)) return isImagePath(path) ? path : null;
  if (/^\/(?:Users|home|tmp|var|Volumes|private|mnt|media|root)\//i.test(path)) return isImagePath(path) ? path : null;
  if (!/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[\\/]/.test(path) && isImagePath(path)) return path;
  return null;
}
