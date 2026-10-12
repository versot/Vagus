import { SquareTerminal } from "lucide-react";
import { LazyTabFeature } from "../lazy-tab-feature.js";
import { registerWorkspaceTab, type WorkspaceTabPageProps } from "../registry.js";

type TerminalPayload = { cwd: string | null };
const loadTerminal = () => import("./terminal-view.js").then(module => ({ default: module.TerminalView }));
function TerminalPage({ instance, title, visible, onRename, onShowTooltip, onHideTooltip }: WorkspaceTabPageProps<TerminalPayload>) {
  const props: import("./terminal-view.js").TerminalViewProps = { terminalId: instance.id, label: title, cwd: instance.payload.cwd, visible, onRename, onShowTooltip, onHideTooltip };
  return <LazyTabFeature load={loadTerminal} props={props} />;
}

registerWorkspaceTab({
  type: "terminal", titleKey: "终端", icon: SquareTerminal, instancePolicy: "multiple", renameable: true,
  closeLabelKey: "关闭终端标签", panelClassName: "workspace-terminal-panel",
  component: TerminalPage, createPayload: context => ({ cwd: context.cwd }),
});
