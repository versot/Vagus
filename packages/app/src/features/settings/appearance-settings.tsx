import { ALargeSmall, Braces, Hash, Moon, Palette, WrapText } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { CodeBlock, codeThemeNames } from "../../components/code-block.js";
import i18n from "../../locales/i18n.js";
import type { AppSettings } from "./app-settings.js";
import { useAppearance } from "./appearance.js";
import { SettingSelect } from "./setting-select.js";

const preview = `// Appearance preview
type ThemeConfig = { surface: string; accent: string; contrast: number };
const themePreview: ThemeConfig = {
  surface: "sidebar",
  accent: "#4788FA",
  contrast: 45,
};
console.log("This longer line shows how code wrapping works in a narrow preview.", themePreview);`;

function FontSize({ value, min, label, onChange }: { value: number; min: number; label: string; onChange(value: number): void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <label className="appearance-font-control"><input type="number" min={min} max={20} step={1} value={draft} aria-label={label}
    onChange={(event) => {
      setDraft(event.target.value);
      const next = Number(event.target.value);
      if (event.target.value && Number.isInteger(next) && next >= min && next <= 20) onChange(next);
    }} onBlur={() => {
      const next = draft.trim() ? Number(draft) : value;
      const normalized = Number.isFinite(next) ? Math.max(min, Math.min(20, Math.round(next))) : value;
      setDraft(String(normalized)); onChange(normalized);
    }} /><span>px</span></label>;
}

function Row({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return <div className="general-setting-row"><span className="general-setting-icon">{icon}</span><span className="general-setting-copy"><strong>{title}</strong><small>{description}</small></span>{children}</div>;
}

export function AppearanceSettingsPanel({ settings, onChange }: { settings: AppSettings; onChange<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void }) {
  const { resolvedTheme } = useAppearance();
  return <>
    <section className="general-settings-section">
      <header>{i18n.t("界面设置")}</header>
      <Row icon={<Palette size={17} />} title={i18n.t("界面主题")} description={i18n.t("选择浅色、深色或跟随系统主题。")}>
        <SettingSelect label={i18n.t("界面主题")} value={settings.interfaceTheme} onChange={(value) => onChange("interfaceTheme", value)} options={[{ value: "system", label: i18n.t("跟随系统") }, { value: "light", label: i18n.t("浅色") }, { value: "dark", label: i18n.t("深色") }]} />
      </Row>
      <Row icon={<ALargeSmall size={17} />} title={i18n.t("界面字号")} description={i18n.t("调整界面文字大小，图标和布局尺寸保持不变。")}>
        <FontSize value={settings.uiFontSize} min={12} label={i18n.t("界面字号")} onChange={(value) => onChange("uiFontSize", value)} />
      </Row>
    </section>
    <section className="general-settings-section">
      <header>{i18n.t("代码设置")}</header>
      <Row icon={<Braces size={17} />} title={i18n.t("浅色代码主题")} description={i18n.t("浅色界面下代码内容使用的高亮主题。")}>
        <SettingSelect label={i18n.t("浅色代码主题")} value={settings.lightCodeTheme} onChange={(value) => onChange("lightCodeTheme", value)} options={[{ value: "github-light", label: "GitHub Light" }, { value: "solarized-light", label: "Solarized Light" }]} />
      </Row>
      <Row icon={<Moon size={17} />} title={i18n.t("深色代码主题")} description={i18n.t("深色界面下代码内容使用的高亮主题。")}>
        <SettingSelect label={i18n.t("深色代码主题")} value={settings.darkCodeTheme} onChange={(value) => onChange("darkCodeTheme", value)} options={[{ value: "github-dark", label: "GitHub Dark" }, { value: "monokai", label: "Monokai" }]} />
      </Row>
      <Row icon={<Hash size={17} />} title={i18n.t("显示行号")} description={i18n.t("在对话代码块和工具代码内容中显示行号。")}>
        <button type="button" role="switch" aria-label={i18n.t("显示行号")} aria-checked={settings.showCodeLineNumbers} className={`general-setting-toggle ${settings.showCodeLineNumbers ? "is-enabled" : ""}`} onClick={() => onChange("showCodeLineNumbers", !settings.showCodeLineNumbers)}><span /></button>
      </Row>
      <Row icon={<WrapText size={17} />} title={i18n.t("长行自动换行")} description={i18n.t("代码内容过长时自动换行。")}>
        <button type="button" role="switch" aria-label={i18n.t("长行自动换行")} aria-checked={settings.wrapCodeLines} className={`general-setting-toggle ${settings.wrapCodeLines ? "is-enabled" : ""}`} onClick={() => onChange("wrapCodeLines", !settings.wrapCodeLines)}><span /></button>
      </Row>
      <Row icon={<ALargeSmall size={17} />} title={i18n.t("代码字号")} description={i18n.t("独立调整代码文字大小，不受界面字号影响。")}>
        <FontSize value={settings.codeFontSize} min={10} label={i18n.t("代码字号")} onChange={(value) => onChange("codeFontSize", value)} />
      </Row>
    </section>
    <section className="appearance-previews" aria-label={i18n.t("代码预览")}>
      <div className="appearance-preview-heading"><h3>{i18n.t("代码预览")}</h3><p>{i18n.t("即时预览两种代码主题，当前界面使用的主题会标记为“当前生效”。")}</p></div>
      <div className="appearance-preview-grid">{(["light", "dark"] as const).map((mode) => {
        const theme = mode === "light" ? settings.lightCodeTheme : settings.darkCodeTheme;
        return <article className="appearance-preview-card" key={mode}><header><div><strong>{i18n.t(mode === "light" ? "浅色预览" : "深色预览")}</strong><small>{codeThemeNames[theme]}</small></div><span className={`appearance-preview-badge ${resolvedTheme === mode ? "is-current" : ""}`}>{i18n.t(resolvedTheme === mode ? "当前生效" : mode === "light" ? "浅色" : "深色")}</span></header><CodeBlock text={preview} language="typescript" theme={theme} /></article>;
      })}</div>
    </section>
  </>;
}
