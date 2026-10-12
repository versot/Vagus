import type { Project, WorkspaceSession } from "@vagus/client";
import {
  Archive,
  ArrowDownUp, Check, ChevronDown, ChevronRight, Ellipsis, Folder, FolderOpen, FolderPlus, Import, List, LoaderCircle,
  PanelLeft,
  Pin, PinOff,
  Plus, Search, SquarePen,
} from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef, type CSSProperties, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ClaudeIcon } from "../../../components/icons/claude-icon.js";
import { CodexIcon } from "../../../components/icons/codex-icon.js";
import { OpenCodeIcon } from "../../../components/icons/opencode-icon.js";
import { PiIcon } from "../../../components/icons/pi-icon.js";
import { QoderIcon } from "../../../components/icons/qoder-icon.js";
import { ZCodeIcon } from "../../../components/icons/zcode-icon.js";
import i18n from "../../../locales/i18n.js";
import { hasUnreadAssistantReply } from "../../../shell/workspace-utils.js";
import { VirtualSessionList } from "./virtual-session-list.js";

export type WorkspaceSidebarModel = {
  sidebarRef: RefObject<HTMLElement | null>;
  projectsHeadingRef: RefObject<HTMLDivElement | null>;
  recentHeadingRef: RefObject<HTMLDivElement | null>;
  width: number;
  collapsed: boolean;
  projects: Project[];
  sessions: WorkspaceSession[];
  unpinnedProjects: Project[];
  pinnedProjects: Project[];
  pinnedSessions: WorkspaceSession[];
  unpinnedSessions: WorkspaceSession[];
  recentSessions: WorkspaceSession[];
  pinnedSessionIds: string[];
  pinnedProjectIds: string[];
  sessionViewedAt: Record<string, string>;
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  projectMenuId: string | undefined;
  sessionMenuId: string | undefined;
  draggingSessionId: string | null;
  dragTargetSessionId: string | null;
  draggingProjectId: string | null;
  dragTargetProjectId: string | null;
  expandedProjectSessions: string[];
  collapsedProjects: string[];
  creatingSession: boolean;
  importingSessions: boolean;
  groupMode: "project" | "merged";
  sortMode: "recent" | "manual";
  projectsSectionCollapsed: boolean;
  recentSectionCollapsed: boolean;
  pinnedSectionCollapsed: boolean;
  menuOpen: boolean;
  menuClosing: boolean;
  menuSource: "projects" | "recent" | "project-row" | "other";
  menuTop: number;
  menuLeft: number;
  popupOpenVersion: number;
  popupEnteringVersion: number;
};

export type WorkspaceSidebarActions = {
  onOpenSearch(): void;
  onGoHome(): void;
  onToggleSidebarMenu(event: MouseEvent<HTMLButtonElement>, source: "projects" | "recent" | "project-row" | "other"): void;
  onOpenSidebarSectionMenu(event: MouseEvent<HTMLElement>, source: "projects" | "recent"): void;
  onCloseSidebarMenu(): void;
  onHandleDismissContextMenu(event: MouseEvent<HTMLButtonElement>): void;
  onSetGroupMode(mode: "project" | "merged"): void;
  onSetSortMode(mode: "recent" | "manual"): void;
  onToggleSection(section: "projects" | "recent" | "pinned"): void;
  onToggleProject(project: Project): void;
  onToggleProjectSessions(project: Project): void;
  onOpenSession(session: WorkspaceSession): void;
  onSessionContextMenu(event: MouseEvent<HTMLDivElement>, session: WorkspaceSession): void;
  onProjectContextMenu(event: MouseEvent<HTMLDivElement>, project: Project): void;
  onOpenProjectMenu(event: MouseEvent<HTMLButtonElement>, project: Project): void;
  onCreateSession(projectId?: string | null): void;
  onImportSessions(): void;
  onAddProject(): void;
  onShowSessionHover(session: WorkspaceSession, row: HTMLDivElement): void;
  onShowProjectHover(project: Project, row: HTMLDivElement): void;
  onHoverLeave(): void;
  onShowTooltip(event: MouseEvent<HTMLElement>, label: string, shortcut?: string, placement?: "above" | "below" | "right"): void;
  onClearTooltip(): void;
  onToggleSessionPin(session: WorkspaceSession): void;
  onArchiveSession(session: WorkspaceSession): void;
  onSessionPointerDown(event: PointerEvent<HTMLDivElement>, session: WorkspaceSession): void;
  onSessionPointerMove(event: PointerEvent<HTMLDivElement>): void;
  onSessionPointerUp(event: PointerEvent<HTMLDivElement>): void;
  onSessionClickCapture(event: MouseEvent<HTMLDivElement>): void;
  onProjectPointerDown(event: PointerEvent<HTMLDivElement>, project: Project): void;
  onProjectPointerMove(event: PointerEvent<HTMLDivElement>): void;
  onProjectPointerUp(event: PointerEvent<HTMLDivElement>): void;
  onProjectPointerCancel(event: PointerEvent<HTMLDivElement>): void;
  onProjectClickCapture(event: MouseEvent<HTMLDivElement>): void;
};

const SessionTitle = memo(function SessionTitle({ title }: { title: string }) {
  const titleRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = titleRef.current;
    const text = element?.firstElementChild;
    if (!element || !text) return;
    const updateOverflow = () => element.classList.toggle("has-overflow", text.scrollWidth > element.clientWidth + 1);
    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(element);
    observer.observe(text);
    return () => observer.disconnect();
  }, [title]);
  return <span className="session-title" ref={titleRef}><span className="session-title-text">{title}</span></span>;
});

const providerNames: Record<string, string> = { pi: "Pi", claude: "Claude Code", codex: "Codex", opencode: "OpenCode", qoder: "Qoder", zcode: "ZCode" };

function SessionProviderMark({ providerId }: { providerId: string }) {
  const name = providerNames[providerId] ?? providerId.replace(/[-_]+/gu, " ").replace(/^./u, (character) => character.toLocaleUpperCase());
  const icon = providerId === "pi" ? <PiIcon size={13} />
    : providerId === "claude" ? <ClaudeIcon size={13} />
      : providerId === "codex" ? <CodexIcon size={13} />
        : providerId === "opencode" ? <OpenCodeIcon size={13} />
          : providerId === "qoder" ? <QoderIcon size={13} />
            : providerId === "zcode" ? <ZCodeIcon size={13} />
              : <span className="session-provider-fallback" aria-hidden="true">{name.slice(0, 1)}</span>;
  return <span className={`session-provider-mark session-provider-${providerId}`} role="img" aria-label={name}>{icon}</span>;
}

export function WorkspaceSidebar({ model, actions }: { model: WorkspaceSidebarModel; actions: WorkspaceSidebarActions }) {
  const latestActions = useRef(actions);
  useLayoutEffect(() => { latestActions.current = actions; });
  const stableActions = useMemo(() => Object.fromEntries((Object.keys(actions) as (keyof WorkspaceSidebarActions)[]).map((key) => [key, (...args: unknown[]) => Reflect.apply(latestActions.current[key], undefined, args)])) as WorkspaceSidebarActions, []);
  return <SidebarContent model={model} actions={stableActions} />;
}

const SidebarContent = memo(function SidebarContent({ model, actions }: { model: WorkspaceSidebarModel; actions: WorkspaceSidebarActions }) {
  useTranslation();
  const m = model;
  const a = actions;
  const hasSessions = m.sessions.length > 0;
  const sessionsByProject = useMemo(() => {
    const groups = new Map<string | null, WorkspaceSession[]>();
    for (const session of m.unpinnedSessions) {
      const group = groups.get(session.projectId) ?? [];
      group.push(session);
      groups.set(session.projectId, group);
    }
    return groups;
  }, [m.unpinnedSessions]);

  const updateSessionTitleScroll = (row: HTMLDivElement, active: boolean) => {
    const title = row.querySelector<HTMLElement>(".session-title");
    const text = title?.firstElementChild as HTMLElement | null;
    if (!title || !text) return;
    if (!active) {
      title.classList.remove("is-overflowing");
      title.style.removeProperty("--session-title-distance");
      title.style.removeProperty("--session-title-duration");
      return;
    }
    const distance = title.clientWidth - text.scrollWidth;
    if (distance < -1) {
      title.style.setProperty("--session-title-distance", `${distance}px`);
      title.style.setProperty("--session-title-duration", `${Math.abs(distance) / 32}s`);
      title.classList.add("is-overflowing");
    }
  };

  const renderSessionRow = (session: WorkspaceSession, rowClass = "") => {
    const pinned = m.pinnedSessionIds.includes(session.id);
    const unread = hasUnreadAssistantReply(session, m.sessionViewedAt);
    const working = session.state === "starting" || session.state === "running";
    const showUnread = unread && !working;
    return <div key={session.id} data-session-id={session.id} role="group" draggable={false} className={`session-row ${rowClass} ${m.selectedSessionId === session.id ? "is-selected" : ""} ${m.sessionMenuId === session.id ? "has-open-menu" : ""} ${m.draggingSessionId === session.id ? "is-dragging" : ""} ${m.dragTargetSessionId === session.id ? "is-drop-target" : ""} ${m.sortMode === "manual" ? "is-manual-sort" : ""}`} onContextMenu={(event) => a.onSessionContextMenu(event, session)} onMouseEnter={(event) => { updateSessionTitleScroll(event.currentTarget, true); a.onShowSessionHover(session, event.currentTarget); }} onMouseLeave={(event) => { updateSessionTitleScroll(event.currentTarget, false); a.onHoverLeave(); }} onPointerDown={(event) => a.onSessionPointerDown(event, session)} onPointerMove={a.onSessionPointerMove} onPointerUp={a.onSessionPointerUp} onPointerCancel={a.onSessionPointerUp} onClickCapture={a.onSessionClickCapture}>
      <button className="session-open" onClick={() => a.onOpenSession(session)}><span className="session-leading-space" aria-hidden="true" /><SessionTitle title={session.title} /><SessionProviderMark providerId={session.providerId ?? "pi"} /></button>
      {working && <LoaderCircle className="session-working-indicator" size={14} aria-label={i18n.t("工作中")} role="status" />}
      {showUnread && <span className="session-unread-indicator" title={i18n.t("AI 回复未读")} aria-label={i18n.t("AI 回复未读")} />}
      <span className="session-row-actions">
        <button className={`session-action pin-action ${pinned ? "is-pinned" : ""}`} title="" aria-label={i18n.t(pinned ? "取消置顶：{{title}}" : "置顶：{{title}}", { title: session.title })} aria-pressed={pinned} onMouseEnter={(event) => a.onShowTooltip(event, i18n.t(pinned ? i18n.t("取消置顶") : i18n.t("置顶聊天")))} onMouseLeave={a.onClearTooltip} onClick={() => { a.onClearTooltip(); a.onToggleSessionPin(session); }}>{pinned ? <PinOff size={15} /> : <Pin size={15} />}</button>
        <button className="session-action archive-action" title="" aria-label={i18n.t("归档：{{title}}", { title: session.title })} onMouseEnter={(event) => a.onShowTooltip(event, i18n.t(i18n.t("归档聊天")))} onMouseLeave={a.onClearTooltip} onClick={() => { a.onClearTooltip(); a.onArchiveSession(session); }}><Archive size={15} /></button>
      </span>
    </div>;
  };

  const renderProjectGroup = (project: Project, rowClass = "") => {
    const sessions = sessionsByProject.get(project.id) ?? [];
    const expanded = m.expandedProjectSessions.includes(project.id);
    const visibleSessions = expanded ? sessions : sessions.slice(0, 5);
    const collapsed = m.collapsedProjects.includes(project.id);
    const dragging = m.draggingProjectId === project.id;
    const dropTarget = m.dragTargetProjectId === project.id;
    return <div className={`project-group ${rowClass} ${collapsed ? "is-collapsed" : ""} ${m.sortMode === "manual" ? "is-manual-sort" : ""} ${dragging ? "is-dragging" : ""} ${dropTarget ? "is-drop-target" : ""}`} key={project.id} onPointerDown={(event) => a.onProjectPointerDown(event, project)} onPointerMove={a.onProjectPointerMove} onPointerUp={a.onProjectPointerUp} onPointerCancel={a.onProjectPointerCancel} onClickCapture={a.onProjectClickCapture}>
      <div data-project-id={project.id} className={`project-row ${m.selectedProjectId === project.id && !m.selectedSessionId ? "is-selected" : ""} ${m.projectMenuId === project.id ? "has-open-menu" : ""}`} onContextMenu={(event) => a.onProjectContextMenu(event, project)} onMouseEnter={(event) => a.onShowProjectHover(project, event.currentTarget)} onMouseLeave={a.onHoverLeave}>
        <button className="project-open" aria-expanded={!collapsed} aria-label={i18n.t(collapsed ? "展开项目 {{name}}" : "收起项目 {{name}}", { name: project.name })} onClick={() => a.onToggleProject(project)}>
          <span className="project-leading">{collapsed ? <Folder size={17} /> : <FolderOpen size={17} />}</span><span className="project-name">{project.name}</span>
        </button>
        <span className="project-actions"><button aria-label={i18n.t("{{name}} 项目选项", { name: project.name })} aria-haspopup="menu" aria-expanded={m.projectMenuId === project.id} onClick={(event) => a.onOpenProjectMenu(event, project)}><Ellipsis size={16} /></button><button aria-label={i18n.t("新建会话")} disabled={m.creatingSession} onClick={() => a.onCreateSession(project.id)}><SquarePen size={15} /></button></span>
      </div>
      <div className="session-list-clip" aria-hidden={collapsed} inert={collapsed}><div className="session-list"><VirtualSessionList sessions={visibleSessions} renderRow={renderSessionRow} selectedId={m.selectedSessionId} draggingId={m.draggingSessionId} />{sessions.length > 5 && <button className="show-more" onClick={() => a.onToggleProjectSessions(project)}>{expanded ? i18n.t("收起显示") : i18n.t("展开显示")}</button>}</div></div>
    </div>;
  };

  return <aside ref={m.sidebarRef} className={`sidebar ${m.collapsed ? "collapsed" : ""}`} style={{ "--sidebar-requested-width": `${m.width}px`, width: m.collapsed ? 0 : "var(--sidebar-layout-width)" } as CSSProperties} onTransitionEnd={(event) => {
    if (event.target === event.currentTarget && event.propertyName === "width") delete event.currentTarget.dataset.userWidthMotion;
  }}>
    <div className="sidebar-content"><div className="sidebar-content-inner">
      <div className="sidebar-header"><button className="brand-button" onClick={a.onGoHome}>Vagus</button></div>
      <button className="new-chat-button" aria-label={i18n.t("新聊天")} disabled={m.creatingSession} onClick={() => a.onCreateSession()}><SquarePen size={17} /><span>{i18n.t("新聊天")}</span></button>
      <button className={`new-chat-button import-sessions-button${m.importingSessions ? " is-active" : ""}`} aria-label={i18n.t("导入会话")} aria-current={m.importingSessions ? "page" : undefined} onClick={a.onImportSessions}><Import size={17} /><span>{i18n.t("导入会话")}</span></button>
      <button className="new-chat-button search-sessions-button" aria-label={i18n.t("搜索")} onClick={a.onOpenSearch}><Search size={17} /><span>{i18n.t("搜索")}</span></button>
      <div className="sidebar-scroll">
        {(m.pinnedSessions.length > 0 || m.pinnedProjects.length > 0) && <>
          <div className={`section-heading pinned-heading ${m.pinnedSectionCollapsed ? "is-collapsed" : ""}`}><button className="pinned-toggle" aria-expanded={!m.pinnedSectionCollapsed} aria-label={m.pinnedSectionCollapsed ? i18n.t("展开置顶") : i18n.t("收起置顶")} onClick={() => a.onToggleSection("pinned")}><span>{i18n.t("置顶")}</span><ChevronDown size={14} /></button></div>
          <div className={`pinned-content ${m.pinnedSectionCollapsed ? "is-collapsed" : ""}`}><div className="pinned-content-inner">{!m.pinnedSectionCollapsed && <VirtualSessionList sessions={m.pinnedSessions} renderRow={(session) => renderSessionRow(session, "pinned-row")} selectedId={m.selectedSessionId} draggingId={m.draggingSessionId} />}{m.pinnedProjects.map((project) => renderProjectGroup(project, "pinned-project-group"))}</div></div>
        </>}
        {hasSessions && m.groupMode === "project" && <>
          <div ref={m.projectsHeadingRef} className={`section-heading projects-heading ${m.projectsSectionCollapsed ? "is-collapsed" : ""} ${m.menuOpen && m.menuSource === "projects" ? "has-menu" : ""}`} onContextMenu={(event) => a.onOpenSidebarSectionMenu(event, "projects")}>
            <button className="projects-toggle" aria-expanded={!m.projectsSectionCollapsed} aria-label={m.projectsSectionCollapsed ? i18n.t("展开项目") : i18n.t("收起项目")} onClick={() => a.onToggleSection("projects")}><span>{i18n.t("项目")}</span><ChevronDown size={14} /></button>
            <span className="section-tools"><button aria-label={i18n.t("侧栏选项")} onClick={(event) => a.onToggleSidebarMenu(event, "projects")}><Ellipsis size={17} /></button><button title={i18n.t("添加项目")} aria-label={i18n.t("添加项目")} onClick={a.onAddProject}><Plus size={16} /></button></span>
          </div>
          <div className={`projects-content ${m.projectsSectionCollapsed ? "is-collapsed" : ""}`}><div className="projects-content-inner">
            {m.unpinnedProjects.length === 0 && m.projects.length === 0 ? <div className="sidebar-empty"><FolderPlus size={18} /><span>{i18n.t("添加一个项目文件夹，")}<br />{i18n.t("开始与 Pi 一起工作。")}</span><button onClick={a.onAddProject}>{i18n.t("添加项目")}</button></div> : m.unpinnedProjects.map((project) => renderProjectGroup(project))}
          </div></div>
        </>}
        {hasSessions && <><div ref={m.recentHeadingRef} className={`section-heading recent-heading ${m.recentSectionCollapsed ? "is-collapsed" : ""} ${m.menuOpen && m.menuSource === "recent" ? "has-menu" : ""}`} onContextMenu={(event) => a.onOpenSidebarSectionMenu(event, "recent")}>
          <button className="recent-toggle" aria-expanded={!m.recentSectionCollapsed} aria-label={m.recentSectionCollapsed ? i18n.t("展开最近") : i18n.t("收起最近")} onClick={() => a.onToggleSection("recent")}><span>{i18n.t("最近")}</span><ChevronDown size={14} /></button>
          <span className="section-tools"><button aria-label={i18n.t("最近列表选项")} onClick={(event) => a.onToggleSidebarMenu(event, "recent")}><Ellipsis size={17} /></button><button title={i18n.t("新建会话")} aria-label={i18n.t("新建会话")} disabled={m.creatingSession} onClick={() => a.onCreateSession()}><SquarePen size={15} /></button></span>
        </div>
          <div className={`recent-content ${m.recentSectionCollapsed ? "is-collapsed" : ""}`}><div className="recent-content-inner">{!m.recentSectionCollapsed && (m.recentSessions.length === 0 ? <div className="recent-empty">{i18n.t("最近打开的会话会显示在这里")}</div> : <VirtualSessionList sessions={m.recentSessions} renderRow={(session) => renderSessionRow(session, m.groupMode === "merged" ? "merged-row" : "recent-session-row")} selectedId={m.selectedSessionId} draggingId={m.draggingSessionId} />)}</div></div></>}
      </div>
    </div></div>
    {(m.menuOpen || m.menuClosing) && <><button className="menu-dismiss" aria-label={i18n.t("关闭菜单")} onClick={a.onCloseSidebarMenu} onContextMenu={a.onHandleDismissContextMenu} /><div key={m.popupOpenVersion} className={`sidebar-menu ${m.popupEnteringVersion === m.popupOpenVersion ? "is-opening" : ""} ${m.menuClosing ? "is-closing" : ""}`} style={{ top: m.menuTop, left: m.menuLeft }}>
      <div className="menu-item menu-parent"><PanelLeft size={16} /><span>{i18n.t("整理侧边栏")}</span><ChevronRight size={14} /><div className="submenu"><button onClick={() => a.onSetGroupMode("project")}><Folder size={15} /><span>{i18n.t("分项目显示")}</span>{m.groupMode === "project" && <Check className="option-check" size={14} />}</button><button onClick={() => a.onSetGroupMode("merged")}><List size={15} /><span>{i18n.t("合并显示")}</span>{m.groupMode === "merged" && <Check className="option-check" size={14} />}</button></div></div>
      <div className="menu-item menu-parent"><ArrowDownUp size={16} /><span>{i18n.t("会话排序方式")}</span><ChevronRight size={14} /><div className="submenu"><button onClick={() => a.onSetSortMode("recent")}><span>{i18n.t("最近更新")}</span>{m.sortMode === "recent" && <Check className="option-check" size={14} />}</button><button onClick={() => a.onSetSortMode("manual")}><span>{i18n.t("手动排序")}</span>{m.sortMode === "manual" && <Check className="option-check" size={14} />}</button></div></div>
    </div></>}
  </aside>;
}, (previous, next) => previous.actions === next.actions && (Object.keys(next.model) as (keyof WorkspaceSidebarModel)[]).every((key) => Object.is(previous.model[key], next.model[key])));
