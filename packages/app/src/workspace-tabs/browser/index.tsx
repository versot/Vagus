import { Globe } from "lucide-react";
import { LazyTabFeature } from "../lazy-tab-feature.js";
import { registerWorkspaceTab, type WorkspaceTabPageProps } from "../registry.js";

const loadBrowser = () => import("./browser-view.js").then(module => ({ default: module.BrowserView }));
type BrowserPayload = { initialUrl: string | null };
function BrowserPage({ instance, context, visible, onUpdateTitle, onUpdateFavicon, onShowTooltip, onHideTooltip }: WorkspaceTabPageProps<BrowserPayload>) {
  const props: import("./browser-view.js").BrowserViewProps = { browserId: instance.id, initialUrl: instance.payload.initialUrl, context, visible, onUpdateTitle, onUpdateFavicon, onShowTooltip, onHideTooltip };
  return <LazyTabFeature load={loadBrowser} props={props} />;
}

registerWorkspaceTab({
  type: "browser", titleKey: "浏览器", icon: Globe, instancePolicy: "multiple", dynamicTitle: true, dynamicIcon: true,
  closeLabelKey: "关闭浏览器标签", component: BrowserPage, createPayload: (_context, input): BrowserPayload => {
    const value = input && typeof input === "object" && "url" in input && typeof input.url === "string" ? input.url : null;
    if (!value) return { initialUrl: null };
    try { const url = new URL(value); return { initialUrl: url.protocol === "http:" || url.protocol === "https:" ? url.href : null }; }
    catch { return { initialUrl: null }; }
  },
});
