import { invoke } from "@tauri-apps/api/core";
import { Image, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import i18n from "../../locales/i18n.js";
import "./image-preview-view.css";

type ImageFile = { name: string; size: number; dataUrl: string };
export type ImagePreviewViewProps = {
  path: string;
  name: string;
  baseDirectory: string | null;
  visible: boolean;
  onUpdateTitle?(title: string): void;
};

export function ImagePreviewView({ path, name, baseDirectory, onUpdateTitle }: ImagePreviewViewProps) {
  const [image, setImage] = useState<ImageFile | null>(null);
  const [error, setError] = useState("");
  const onUpdateTitleRef = useRef(onUpdateTitle);
  onUpdateTitleRef.current = onUpdateTitle;
  useEffect(() => {
    let active = true;
    onUpdateTitleRef.current?.(name);
    setImage(null);
    setError("");
    void invoke<ImageFile>("filesystem_read_image", { path, baseDirectory })
      .then((result) => {
        if (active) setImage(result);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [baseDirectory, name, path]);

  return (
    <section className="workspace-image-preview" aria-label={i18n.t("图片预览")}>
      <header className="workspace-image-preview-toolbar">
        <div className="workspace-image-preview-file">
          <Image size={15} aria-hidden="true" />
          <strong title={path}>{name}</strong>
        </div>
        <span title={path}>{path}</span>
      </header>
      <main className="workspace-image-preview-stage" aria-busy={!image && !error}>
        {image ? (
          <img src={image.dataUrl} alt={image.name} />
        ) : error ? (
          <div className="workspace-image-preview-state is-error" role="alert">
            <Image size={28} />
            <strong>{i18n.t("无法预览此图片")}</strong>
            <span>{error}</span>
          </div>
        ) : (
          <div className="workspace-image-preview-state" role="status">
            <LoaderCircle size={22} className="workspace-image-preview-spinner" />
            <span>{i18n.t("正在读取图片…")}</span>
          </div>
        )}
      </main>
      {image && (
        <footer className="workspace-image-preview-status">
          {new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(image.size / 1024)} KB
        </footer>
      )}
    </section>
  );
}
