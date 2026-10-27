// CodeMirror 6 SQL editor with DuckDB-aware autocomplete, run shortcuts and error-line highlighting.
import {
  EditorView, keymap, Decoration, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor,
  rectangularSelection, highlightSpecialChars, placeholder, EditorState, Compartment, StateField, StateEffect,
  defaultKeymap, history, historyKeymap, indentWithTab, syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching,
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, searchKeymap, highlightSelectionMatches,
  sql, SQLDialect, PostgreSQL, tags, toggleComment,
} from './vendor/lib.js';

const EXTRA_KW = 'qualify pivot unpivot summarize describe asof anti semi positional exclude replace columns struct map list union_by_name attach detach install load pragma copy export import macro sequence returning using sample tablesample filter window materialized recursive ilike glob similar any_value arg_max arg_min list_agg';
export const DuckDB = SQLDialect.define({ ...PostgreSQL.spec, keywords: PostgreSQL.spec.keywords + ' ' + EXTRA_KW, types: PostgreSQL.spec.types + ' hugeint uhugeint ubigint uinteger usmallint utinyint tinyint blob varchar struct map union list uuid json timestamptz interval' });

const hl = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syn-kw)', fontWeight: '600' },
  { tag: tags.string, color: 'var(--syn-str)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syn-num)' },
  { tag: [tags.lineComment, tags.blockComment, tags.comment], color: 'var(--syn-com)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--syn-type)' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--syn-op)' },
  { tag: [tags.special(tags.name), tags.special(tags.string)], color: 'var(--syn-id)' },
]);
const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-font, 14px)', backgroundColor: 'var(--editor-bg)', color: 'var(--fg)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' }, '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--fg)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent)', color: '#fff' },
  '.cm-errorLine': { backgroundColor: 'var(--error-bg)' }, '.cm-errorMark': { textDecoration: 'underline wavy var(--error)' },
  '.cm-runFlash': { backgroundColor: 'var(--flash)' },
});

// Error line decorations
const setErr = StateEffect.define();
const errField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setErr)) return e.value;
    return tr.docChanged ? Decoration.none : deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
const flashEffect = StateEffect.define();
const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) { for (const e of tr.effects) if (e.is(flashEffect)) return e.value; return deco.map(tr.changes); },
  provide: (f) => EditorView.decorations.from(f),
});

export function createEditor(parent, { doc = '', onRun, onRunAll, onFormat, onChange, onSave, onExplain }) {
  const sqlConf = new Compartment(); const fnConf = new Compartment();
  let functions = [];
  const fnSource = (ctx) => {
    const w = ctx.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/); if (!w || (w.from === w.to && !ctx.explicit)) return null;
    const before = ctx.state.sliceDoc(Math.max(0, w.from - 1), w.from); if (before === '.') return null;
    return { from: w.from, options: functions, validFor: /^[A-Za-z0-9_]*$/ };
  };
  const keys = keymap.of([
    { key: 'Mod-Enter', preventDefault: true, run: () => (onRun && onRun(), true) },
    { key: 'Shift-Mod-Enter', preventDefault: true, run: () => (onRunAll && onRunAll(), true) },
    { key: 'Shift-Alt-f', preventDefault: true, run: () => (onFormat && onFormat(), true) },
    { key: 'Mod-Shift-f', preventDefault: true, run: () => (onFormat && onFormat(), true) },
    { key: 'Mod-s', preventDefault: true, run: () => (onSave && onSave(), true) },
    { key: 'Mod-e', preventDefault: true, run: () => (onExplain && onExplain(), true) },
    { key: 'Mod-/', run: toggleComment },
  ]);
  const extensions = [
    keys, lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), dropCursor(),
    EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(), rectangularSelection(),
    highlightActiveLine(), highlightSelectionMatches(), syntaxHighlighting(hl), theme, errField, flashField,
    autocompletion({ activateOnTyping: true, maxRenderedOptions: 80, icons: true }),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
    sqlConf.of(sql({ dialect: DuckDB, upperCaseKeywords: false })),
    fnConf.of(DuckDB.language.data.of({ autocomplete: fnSource })),
    placeholder('Write SQL here… e.g. SELECT * FROM taxi_trips LIMIT 10'),
    EditorView.updateListener.of((u) => { if (u.docChanged && onChange) onChange(u.state.doc.toString()); }),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
  const states = new Map(); // tab id -> EditorState (kept per tab so undo history survives tab switches)
  return {
    view,
    get doc() { return view.state.doc.toString(); },
    setDoc(text) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); },
    swap(oldId, newId, text) {
      if (oldId != null) states.set(oldId, view.state);
      const st = states.get(newId);
      if (st && st.doc.toString() === text) view.setState(st);
      else view.setState(EditorState.create({ doc: text, extensions }));
      this.applySchema();
    },
    forget(id) { states.delete(id); },
    selection() { const r = view.state.selection.main; return { from: r.from, to: r.to, text: view.state.sliceDoc(r.from, r.to), head: r.head }; },
    insert(text) { const r = view.state.selection.main; view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length } }); view.focus(); },
    focus() { view.focus(); },
    schema: {}, fns: [],
    setSchema(schema, fnList) { this.schema = schema; if (fnList) this.fns = fnList; this.applySchema(); },
    applySchema() {
      functions = this.fns; const sc = this.schema;
      view.dispatch({ effects: sqlConf.reconfigure(sql({ dialect: DuckDB, schema: sc, upperCaseKeywords: false })) });
    },
    markError(from, to, markFrom, markTo) {
      const doc = view.state.doc; const ranges = [];
      const l1 = doc.lineAt(Math.min(from, doc.length)), l2 = doc.lineAt(Math.min(to, doc.length));
      for (let n = l1.number; n <= l2.number; n++) ranges.push(Decoration.line({ class: 'cm-errorLine' }).range(doc.line(n).from));
      if (markFrom != null && markTo > markFrom) ranges.push(Decoration.mark({ class: 'cm-errorMark' }).range(markFrom, Math.min(markTo, doc.length)));
      ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
      view.dispatch({ effects: setErr.of(Decoration.set(ranges, true)), selection: { anchor: Math.min(markFrom ?? from, doc.length) }, scrollIntoView: true });
    },
    clearError() { view.dispatch({ effects: setErr.of(Decoration.none) }); },
    flash(from, to) {
      if (to <= from) return; const d = Decoration.set([Decoration.mark({ class: 'cm-runFlash' }).range(from, Math.min(to, view.state.doc.length))]);
      view.dispatch({ effects: flashEffect.of(d) }); setTimeout(() => view.dispatch({ effects: flashEffect.of(Decoration.none) }), 350);
    },
  };
}
