import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import { basicSetup, EditorView } from "codemirror";
import { useEffect, useRef } from "react";
import type { DarkCodeTheme, LightCodeTheme } from "../../features/settings/app-settings.js";
import { useAppearance } from "../../features/settings/appearance.js";
import "./filesystem-code-editor.css";

const fileHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: "var(--code-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape], color: "var(--code-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--code-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: "var(--code-title)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--code-type, var(--code-number))" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [t.propertyName, t.attributeName, t.tagName], color: "var(--code-attr)" },
  { tag: [t.operator, t.punctuation], color: "var(--code-operator, var(--code-fg))" },
  { tag: [t.invalid], color: "var(--danger)" },
]);

type Props = {
  filePath: string;
  value: string;
  readOnly: boolean;
  ariaLabel: string;
  onChange(value: string): void;
  onSave(): Promise<void>;
};

export function FilesystemCodeEditor({ filePath, value, readOnly, ariaLabel, onChange, onSave }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageRef = useRef(new Compartment());
  const wrappingRef = useRef(new Compartment());
  const editableRef = useRef(new Compartment());
  const accessibilityRef = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const appearance = useAppearance();
  const selectedTheme: LightCodeTheme | DarkCodeTheme = appearance.resolvedTheme === "light" ? appearance.lightCodeTheme : appearance.darkCodeTheme;

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const language = languageRef.current;
    const wrapping = wrappingRef.current;
    const editable = editableRef.current;
    const accessibility = accessibilityRef.current;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          language.of([]),
          wrapping.of(appearance.wrapCodeLines ? EditorView.lineWrapping : []),
          editable.of([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]),
          accessibility.of(EditorView.contentAttributes.of({ "aria-label": ariaLabel })),
          syntaxHighlighting(fileHighlightStyle),
          EditorView.updateListener.of(update => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            keydown(event) {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void onSaveRef.current();
                return true;
              }
              return false;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;

    const description = LanguageDescription.matchFilename(languages, filePath);
    if (description) {
      void description.load().then(support => {
        if (!disposed) view.dispatch({ effects: language.reconfigure(support) });
      }).catch(() => { /* Unknown or unavailable language support falls back to readable plain text. */ });
    }

    return () => {
      disposed = true;
      viewRef.current = null;
      view.destroy();
    };
    // File changes remount the editor so its document and selection never leak across files.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrappingRef.current.reconfigure(appearance.wrapCodeLines ? EditorView.lineWrapping : []) });
  }, [appearance.wrapCodeLines]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editableRef.current.reconfigure([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]) });
  }, [readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: accessibilityRef.current.reconfigure(EditorView.contentAttributes.of({ "aria-label": ariaLabel })) });
  }, [ariaLabel]);

  return <div
    ref={hostRef}
    className={`filesystem-code-editor${appearance.showCodeLineNumbers ? " has-line-numbers" : ""}`}
    data-code-theme={selectedTheme}
  />;
}
