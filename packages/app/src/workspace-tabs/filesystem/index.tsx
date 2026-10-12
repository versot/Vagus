import { FolderTree } from "lucide-react";
import { LazyTabFeature } from "../lazy-tab-feature.js";
import { registerWorkspaceTab, type WorkspaceTabPageProps } from "../registry.js";

const loadFileSystem = () => import("./filesystem-view.js").then(module => ({ default: module.FileSystemView }));
function FileSystemPage({ instance, context, visible, onShowTooltip, onHideTooltip }: WorkspaceTabPageProps<{ root: string | null }>) {
  const props: import("./filesystem-view.js").FileSystemViewProps & { visible: boolean } = { initialRoot: instance.payload.root, contextRoot: context.cwd, onOpenUrl: context.openUrl, onShowTooltip, onHideTooltip, visible };
  return <LazyTabFeature load={loadFileSystem} props={props} />;
}

registerWorkspaceTab({
  type: "filesystem", titleKey: "文件系统", icon: FolderTree, instancePolicy: "single",
  closeLabelKey: "关闭文件系统标签", component: FileSystemPage,
  createPayload: context => ({ root: context.cwd }),
});
