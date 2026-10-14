import { Image } from "lucide-react";
import { LazyTabFeature } from "../lazy-tab-feature.js";
import { registerWorkspaceTab, type WorkspaceTabPageProps } from "../registry.js";
import { markdownImageFilePath } from "../../features/conversation/components/markdown-local-file.js";

type ImagePreviewPayload = { path: string; name: string; baseDirectory: string | null };
const loadImagePreview = () =>
  import("./image-preview-view.js").then((module) => ({ default: module.ImagePreviewView }));

function ImagePreviewPage({ instance, visible, onUpdateTitle }: WorkspaceTabPageProps<ImagePreviewPayload>) {
  const props: import("./image-preview-view.js").ImagePreviewViewProps = {
    ...instance.payload,
    visible,
    onUpdateTitle,
  };
  return <LazyTabFeature load={loadImagePreview} props={props} />;
}

registerWorkspaceTab({
  type: "image-preview",
  titleKey: "图片预览",
  icon: Image,
  instancePolicy: "multiple",
  temporary: true,
  availableInPicker: false,
  dynamicTitle: true,
  component: ImagePreviewPage,
  createPayload: (_context, input): ImagePreviewPayload => {
    const source = input && typeof input === "object" ? (input as { path?: unknown }).path : null;
    const path = typeof source === "string" ? markdownImageFilePath(source) : null;
    if (!path) throw new Error("Invalid local image path");
    const baseDirectory = (input as { baseDirectory?: unknown }).baseDirectory;
    return {
      path,
      name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
      baseDirectory: typeof baseDirectory === "string" ? baseDirectory : null,
    };
  },
});
