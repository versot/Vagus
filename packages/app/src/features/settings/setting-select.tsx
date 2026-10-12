import { Check, ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface SettingSelectOption<T extends string> {
  value: T;
  label: string;
}

export function SettingSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
  className,
}: {
  value: T;
  options: SettingSelectOption<T>[];
  onChange(value: T): void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(Math.max(0, options.findIndex((option) => option.value === value)));
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuLayout, setMenuLayout] = useState<{ above: boolean; maxHeight: number } | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useLayoutEffect(() => {
    if (!open) { setMenuLayout(null); return; }
    const updateLayout = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!rect || !menu) return;
      const below = Math.max(0, window.innerHeight - rect.bottom - 19);
      const above = Math.max(0, rect.top - 19);
      const desiredHeight = Math.min(menu.scrollHeight, 360, window.innerHeight * .6);
      const openAbove = below < desiredHeight && above > below;
      const maxHeight = Math.min(360, window.innerHeight * .6, openAbove ? above : below);
      setMenuLayout((current) => current?.above === openAbove && current.maxHeight === maxHeight ? current : { above: openAbove, maxHeight });
    };
    updateLayout();
    window.addEventListener("resize", updateLayout);
    window.addEventListener("scroll", updateLayout, true);
    return () => {
      window.removeEventListener("resize", updateLayout);
      window.removeEventListener("scroll", updateLayout, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      optionRefs.current[activeIndex]?.focus({ preventScroll: true });
      optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, open]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setActiveIndex(index);
    setOpen(false);
  };

  return <div className={`setting-select${className ? ` ${className}` : ""}${open ? " is-open" : ""}`} ref={rootRef}>
    <button
      type="button"
      className="setting-select-trigger"
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        const nextOpen = !open;
        setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
        setOpen(nextOpen);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          const current = options.findIndex((option) => option.value === value);
          choose((current + direction + options.length) % options.length);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setOpen((current) => !current);
        }
      }}
    >
      <span>{selected?.label}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div className="setting-select-menu" ref={menuRef} role="listbox" aria-label={label} style={menuLayout ? { maxHeight: menuLayout.maxHeight, ...(menuLayout.above ? { top: "auto", bottom: "calc(100% + 7px)", transformOrigin: "bottom right" } : {}) } : undefined}>
      {options.map((option, index) => <button
        key={option.value}
        ref={(element) => { optionRefs.current[index] = element; }}
        type="button"
        role="option"
        aria-selected={value === option.value}
        tabIndex={activeIndex === index ? 0 : -1}
        className={`setting-select-option${value === option.value ? " is-selected" : ""}`}
        onFocus={() => setActiveIndex(index)}
        onClick={() => choose(index)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const direction = event.key === "ArrowDown" ? 1 : -1;
            setActiveIndex((index + direction + options.length) % options.length);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            choose(index);
          }
        }}
      ><span>{option.label}</span>{value === option.value && <Check size={14} aria-hidden="true" />}</button>)}
    </div>}
  </div>;
}
