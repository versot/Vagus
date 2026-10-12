import type { Project } from "@vagus/client";
import { Check, Folder, FolderPlus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../../locales/i18n.js";

export function WorkspacePicker({
  projects,
  selectedProjectId,
  onSelect,
  onCreateProject,
  onSelectNoProject,
  onClose,
  placement = "composer",
}: {
  projects: Project[];
  selectedProjectId: string | null;
  onSelect(project: Project): void;
  onCreateProject(): void;
  onSelectNoProject(): void;
  onClose(): void;
  placement?: "composer" | "welcome";
}) {
  useTranslation();
  const [query, setQuery] = useState("");
  const filteredProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return projects.filter((project) => !normalizedQuery || project.name.toLocaleLowerCase().includes(normalizedQuery));
  }, [projects, query]);

  return <>
    <button className="workspace-picker-dismiss" aria-label={i18n.t("关闭工作空间菜单")} onClick={onClose} />
    <div className={`workspace-picker ${placement === "welcome" ? "is-centered" : ""}`} role="listbox" aria-label={i18n.t("选择工作空间")}>
      <label className="workspace-picker-search"><Search size={15} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={i18n.t("搜索项目")} /></label>
      <div className="workspace-picker-list">
        {filteredProjects.map((project) => <button key={project.id} role="option" aria-selected={selectedProjectId === project.id} className={selectedProjectId === project.id ? "is-selected" : ""} onClick={() => onSelect(project)}><Folder size={16} /><span>{project.name}</span>{selectedProjectId === project.id && <Check size={15} />}</button>)}
        {filteredProjects.length === 0 && <div className="workspace-picker-empty">{i18n.t("没有找到项目")}</div>}
      </div>
      <div className="workspace-picker-actions">
        <button onClick={onCreateProject}><FolderPlus size={16} /><span>{i18n.t("新建项目")}</span></button>
        <button className={selectedProjectId === null ? "is-selected" : ""} onClick={onSelectNoProject}><X size={16} /><span>{i18n.t("不在项目中工作")}</span>{selectedProjectId === null && <Check size={15} />}</button>
      </div>
    </div>
  </>;
}
