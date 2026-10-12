import { Check, ChevronDown, Globe2, LocateFixed, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import i18n from "../../locales/i18n.js";
import "./time-zone-picker.css";

type Props = { value: string; localTimeZone: string; onChange(value: string): void };

const commonTimeZones = [
  "Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore", "Asia/Hong_Kong", "Asia/Seoul",
  "America/Los_Angeles", "America/New_York", "America/Chicago", "Europe/London",
  "Europe/Paris", "Europe/Berlin", "Australia/Sydney", "UTC",
];
const commonCityKeys: Record<string, string> = {
  "Asia/Shanghai": "上海", "Asia/Tokyo": "东京", "Asia/Singapore": "新加坡", "Asia/Hong_Kong": "香港",
  "Asia/Seoul": "首尔", "America/Los_Angeles": "洛杉矶", "America/New_York": "纽约",
  "America/Chicago": "芝加哥", "Europe/London": "伦敦", "Europe/Paris": "巴黎", "Europe/Berlin": "柏林",
  "Australia/Sydney": "悉尼", UTC: "协调世界时",
};

function supportedTimeZones() {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
  const zones = typeof intl.supportedValuesOf === "function" ? intl.supportedValuesOf("timeZone") : commonTimeZones;
  return [...new Set(["UTC", ...zones, Intl.DateTimeFormat().resolvedOptions().timeZone].filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function cityName(zone: string) {
  if (commonCityKeys[zone]) return i18n.t(commonCityKeys[zone]!);
  if (zone === "UTC") return i18n.t("协调世界时");
  return (zone.split("/").at(-1) ?? zone).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function timeZoneOffsetLabel(zone: string) {
  try {
    const label = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    return label.replace("GMT", "UTC").replace("UTC-", "UTC−").replace("UTC+", "UTC+");
  } catch { return "UTC"; }
}

export function timeZoneCityLabel(zone: string) { return cityName(zone); }

export function TimeZonePicker({ value, localTimeZone, onChange }: Props) {
  useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const zones = useMemo(supportedTimeZones, []);
  const entries = useMemo(() => zones.map((zone) => ({ zone, city: cityName(zone), offset: timeZoneOffsetLabel(zone) })), [zones, open, i18n.resolvedLanguage]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = normalizedQuery
    ? entries.filter(({ zone, city }) => `${zone} ${city}`.toLocaleLowerCase().includes(normalizedQuery))
    : entries;
  const popular = new Set(commonTimeZones);
  const common = filtered.filter(({ zone }) => popular.has(zone));
  const others = filtered.filter(({ zone }) => !popular.has(zone));
  const selected = entries.find((entry) => entry.zone === value) ?? { zone: value, city: cityName(value), offset: timeZoneOffsetLabel(value) };

  function updatePosition() {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 12;
    const width = Math.min(360, window.innerWidth - margin * 2);
    const availableHeight = Math.min(380, window.innerHeight - margin * 2);
    const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
    const below = window.innerHeight - rect.bottom - margin;
    const above = rect.top - margin;
    const placeBelow = below >= Math.min(300, availableHeight) || below >= above;
    const maxHeight = Math.max(180, Math.min(availableHeight, (placeBelow ? below : above) - 8));
    const top = placeBelow ? Math.max(margin, rect.bottom + 8) : Math.max(margin, rect.top - maxHeight - 8);
    setPosition({ top, left, width, maxHeight });
  }

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handlePointer = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      const menu = document.querySelector(".scheduled-time-zone-menu");
      if (!menu?.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); rootRef.current?.querySelector("button")?.focus(); }
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const menu = open && position ? createPortal(<div className="scheduled-time-zone-menu" role="dialog" aria-label={i18n.t("选择时区")} style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}>
    <div className="scheduled-time-zone-menu-heading"><div><Globe2 size={15} /><strong>{i18n.t("选择时区")}</strong></div><button type="button" onClick={() => { onChange(localTimeZone); setOpen(false); setQuery(""); }}><LocateFixed size={13} />{i18n.t("恢复本机时区")}</button></div>
    <label className="scheduled-time-zone-search"><Search size={15} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={i18n.t("搜索时区或城市…")} aria-label={i18n.t("搜索时区或城市…")} /></label>
    <div className="scheduled-time-zone-results" role="listbox" aria-label={i18n.t("时区列表")}>
      {common.length > 0 && <><p className="scheduled-time-zone-group-title">{normalizedQuery ? i18n.t("匹配的常用时区") : i18n.t("常用时区")}</p>{common.map((item) => <ZoneOption key={item.zone} {...item} selected={item.zone === value} onSelect={() => { onChange(item.zone); setOpen(false); setQuery(""); }} />)}</>}
      {others.length > 0 && <><p className="scheduled-time-zone-group-title">{normalizedQuery ? i18n.t("更多匹配结果") : i18n.t("所有时区")}</p>{others.map((item) => <ZoneOption key={item.zone} {...item} selected={item.zone === value} onSelect={() => { onChange(item.zone); setOpen(false); setQuery(""); }} />)}</>}
      {!filtered.length && <p className="scheduled-time-zone-no-results">{i18n.t("没有找到匹配的时区")}</p>}
    </div>
  </div>, document.body) : null;

  return <div className={`scheduled-time-zone${open ? " is-open" : ""}`} ref={rootRef}>
    <button type="button" className="scheduled-time-zone-trigger" aria-haspopup="dialog" aria-expanded={open} title={`${selected.zone} · ${selected.offset}`} onClick={() => { setOpen((wasOpen) => !wasOpen); setQuery(""); }}>
      <Globe2 size={14} /><span className="scheduled-time-zone-city">{selected.city}</span><span className="scheduled-time-zone-offset">{selected.offset}</span><ChevronDown size={13} className="scheduled-time-zone-chevron" />
    </button>
    {menu}
  </div>;
}

function ZoneOption({ zone, city, offset, selected, onSelect }: { zone: string; city: string; offset: string; selected: boolean; onSelect(): void }) {
  return <button type="button" role="option" aria-selected={selected} className={`scheduled-time-zone-option${selected ? " is-selected" : ""}`} onClick={onSelect}>
    <span className="scheduled-time-zone-option-copy"><strong>{city}</strong><small>{zone}</small></span><span className="scheduled-time-zone-option-offset">{offset}</span>{selected && <Check size={14} />}
  </button>;
}
