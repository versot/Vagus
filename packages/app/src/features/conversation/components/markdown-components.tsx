import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ComponentProps, MouseEvent as ReactMouseEvent } from "react";
import { defaultUrlTransform } from "react-markdown";
import { MarkdownCodeBlock } from "../../../components/code-block.js";
import { markdownImageFilePath } from "./markdown-local-file.js";

export function markdownUrlTransform(value: string): string {
  return markdownImageFilePath(value) ? value : defaultUrlTransform(value);
}

export function createMarkdownComponents(onOpenUrl?: (url: string) => void) {
  return {
    pre: MarkdownCodeBlock,
    img: ({ src, alt, ...props }: ComponentProps<"img">) => {
      const path = src ? markdownImageFilePath(src) : null;
      if (!path) return <img {...props} src={src} alt={alt ?? ""} />;
      return (
        <button type="button" className="markdown-local-image" onClick={() => onOpenUrl?.(path)} title={path}>
          {alt || path.split(/[\\/]/).pop()}
        </button>
      );
    },
    a: ({ href, children, ...props }: ComponentProps<"a">) => {
      const openLink = (event: ReactMouseEvent<HTMLAnchorElement>) => {
        // Markdown links must never navigate the app's main WebView.
        event.preventDefault();
        if (!href) return;
        let url: URL;
        try {
          url = new URL(href);
        } catch {
          return;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") return;
        if (onOpenUrl) onOpenUrl(url.href);
        else if (isTauri()) void invoke("open_external_url", { url: url.href }).catch(() => undefined);
        else window.open(url.href, "_blank", "noopener,noreferrer");
      };
      return (
        <a
          {...props}
          href={href}
          onClick={openLink}
          onAuxClick={(event) => {
            if (event.button === 1) openLink(event);
          }}
        >
          {children}
        </a>
      );
    },
  };
}
