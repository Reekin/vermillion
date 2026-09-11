import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--color-foreground)", backgroundColor: "var(--color-input)", fontSize: "var(--text-body)" },
  ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--color-strong)" },
  ".cm-gutters": { backgroundColor: "var(--color-surface)", color: "var(--color-muted-foreground)", borderColor: "var(--color-border)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--color-surface-selected)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--color-accent-soft)" },
  ".cm-cursor": { borderLeftColor: "var(--color-strong)" },
  ".cm-panels": { backgroundColor: "var(--color-surface-raised)", color: "var(--color-foreground)" },
  ".cm-textfield, .cm-button": { font: "inherit", color: "var(--color-foreground)", background: "var(--color-input)", border: "1px solid var(--color-control-border)", borderRadius: "var(--radius-sm)" },
  ".cm-searchMatch, .cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--color-accent-soft)", outline: "1px solid var(--color-control-border-hover)" }
}, { dark: true });

const highlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.heading], color: "var(--color-strong)", fontWeight: "bold" },
  { tag: [tags.string, tags.special(tags.string), tags.link], color: "var(--color-foreground)", textDecoration: "underline" },
  { tag: [tags.comment, tags.meta], color: "var(--color-muted-foreground)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.typeName, tags.tagName], color: "var(--color-strong)" }
]);

/** CodeMirror owns editing, history, line numbers and Ctrl+F search. */
export const SourceEditor = ({ path, value, onChange }: { path: string; value: string; onChange: (value: string) => void }) => {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initial = useRef(value);
  useEffect(() => {
    const language = new Compartment();
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: initial.current, extensions: [
        basicSetup, theme, syntaxHighlighting(highlighting), EditorView.lineWrapping, language.of([]),
        EditorView.contentAttributes.of({ "aria-label": "源码", spellcheck: "false" }),
        EditorView.updateListener.of((update) => { if (update.docChanged) onChangeRef.current(update.state.doc.toString()); })
      ] })
    });
    view.current = editor;
    let active = true;
    const description = LanguageDescription.matchFilename(languages, path);
    void description?.load().then((support) => { if (active) editor.dispatch({ effects: language.reconfigure(support) }); });
    return () => { active = false; editor.destroy(); view.current = undefined; };
  }, [path]);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);
  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
};
