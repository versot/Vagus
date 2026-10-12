import { useLayoutEffect, useRef, useState } from "react";

export function countWrappedTitleLines(text: string, width: number, font: string): number {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context || width <= 0) return Number.POSITIVE_INFINITY;
  context.font = font;
  let lines = 1;
  let line = "";
  for (const character of Array.from(text)) {
    if (character === "\n") { lines += 1; line = ""; continue; }
    const nextLine = line + character;
    if (line && context.measureText(nextLine).width > width) { lines += 1; line = character; }
    else line = nextLine;
  }
  return lines;
}

export function SessionHoverCardTitle({ title }: { title: string }) {
  const titleRef = useRef<HTMLElement>(null);
  const [displayTitle, setDisplayTitle] = useState(title);

  useLayoutEffect(() => {
    const element = titleRef.current;
    if (!element) return;
    const updateTitle = () => {
      const suffixMatch = title.match(/(\s*[（(]\d+[）)])$/u);
      if (!suffixMatch) { setDisplayTitle((current) => current === title ? current : title); return; }
      const width = element.clientWidth;
      if (!width) return;
      const style = window.getComputedStyle(element);
      const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      if (countWrappedTitleLines(title, width, font) <= 3) { setDisplayTitle((current) => current === title ? current : title); return; }
      const suffix = suffixMatch[1] ?? "";
      const prefix = Array.from(title.slice(0, title.length - suffix.length));
      let shortened = `…${suffix}`;
      for (let length = prefix.length; length >= 0; length -= 1) {
        const candidate = `${prefix.slice(0, length).join("").trimEnd()}…${suffix}`;
        if (countWrappedTitleLines(candidate, width, font) <= 3) { shortened = candidate; break; }
      }
      setDisplayTitle((current) => current === shortened ? current : shortened);
    };
    updateTitle();
    const observer = new ResizeObserver(updateTitle);
    observer.observe(element);
    return () => observer.disconnect();
  }, [title]);

  return <strong ref={titleRef}>{displayTitle}</strong>;
}
