import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Children, isValidElement, memo, useMemo, type ReactNode } from "react";
import type { DarkCodeTheme, LightCodeTheme } from "../features/settings/app-settings.js";
import { useAppearance } from "../features/settings/appearance.js";
import "./code-block.css";

for (const [name, language] of Object.entries({ javascript, typescript, json, css, xml, python, bash, sql, rust, yaml, markdown, diff })) hljs.registerLanguage(name, language);

type Token = { text: string; className: string };
function highlightLines(text: string, language: string): Token[][] {
  const plain = () => text.split("\n").map((line) => [{ text: line || "\u200b", className: "" }]);
  if (!language || !hljs.getLanguage(language) || text.length > 100_000) return plain();
  try {
    // highlight.js escapes source text; only its generated span markup is parsed.
    const root = document.createElement("div");
    root.innerHTML = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    const lines: Token[][] = [[]];
    const walk = (node: Node, classes: string) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const parts = (node.textContent ?? "").split("\n");
        parts.forEach((part, index) => {
          if (index) lines.push([]);
          if (part) lines[lines.length - 1]!.push({ text: part, className: classes });
        });
      } else {
        const next = node instanceof Element ? `${classes} ${node.className}`.trim() : classes;
        for (const child of node.childNodes) walk(child, next);
      }
    };
    walk(root, "");
    return lines.map((line) => line.length ? line : [{ text: "\u200b", className: "" }]);
  } catch { return plain(); }
}

export const codeThemeNames = { "github-light": "GitHub Light", "solarized-light": "Solarized Light", "github-dark": "GitHub Dark", monokai: "Monokai" };

export const CodeBlock = memo(function CodeBlock({ text, language = "", className = "", theme }: {
  text: string; language?: string; className?: string; theme?: LightCodeTheme | DarkCodeTheme;
}) {
  const appearance = useAppearance();
  const source = text.replace(/\n$/, "");
  const lines = useMemo(() => highlightLines(source, language.toLowerCase()), [source, language]);
  const selectedTheme = theme ?? (appearance.resolvedTheme === "light" ? appearance.lightCodeTheme : appearance.darkCodeTheme);
  return <pre className={`code-block ${className}${appearance.wrapCodeLines ? " is-wrapped" : ""}`} data-code-theme={selectedTheme}>
    <code>{lines.map((line, index) => <span className="code-line" key={index}>
      {appearance.showCodeLineNumbers && <span className="code-line-number" aria-hidden="true">{index + 1}</span>}
      <span className="code-line-content">{line.map((token, tokenIndex) => <span key={tokenIndex} className={token.className || undefined}>{token.text}</span>)}</span>
    </span>)}</code>
  </pre>;
});

function sourceFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (isValidElement<{ children?: ReactNode }>(node)) return sourceFromNode(node.props.children);
  return Children.toArray(node).map(sourceFromNode).join("");
}

export function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children).find((node) => isValidElement(node));
  const language = isValidElement<{ className?: string }>(child) ? child.props.className?.match(/language-(\S+)/)?.[1] ?? "" : "";
  return <CodeBlock text={sourceFromNode(children)} language={language} />;
}

export function languageFromPath(path: string) {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", json: "json", css: "css", html: "xml", svg: "xml", xml: "xml", py: "python", sh: "bash", sql: "sql", rs: "rust", yml: "yaml", yaml: "yaml", md: "markdown" } as Record<string, string>)[extension ?? ""] ?? "";
}
