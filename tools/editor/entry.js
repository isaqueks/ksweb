/*
 * entry.js — o que o ksweb usa do CodeMirror 6. tools/build_editor.sh
 * empacota isto com o esbuild num IIFE que define o global CM
 * (web/vendor/codemirror.bundle.js).
 */
export {
  EditorState, EditorSelection, StateField, StateEffect, RangeSet, RangeSetBuilder, Compartment,
  Transaction, Annotation, Prec, Facet, Text
} from '@codemirror/state';
export {
  EditorView, keymap, lineNumbers, gutter, GutterMarker, Decoration, ViewPlugin, WidgetType,
  hoverTooltip, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightSpecialChars, showPanel, gutterLineClass,
  scrollPastEnd, placeholder, tooltips
} from '@codemirror/view';
export {
  StreamLanguage, syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, indentUnit,
  LanguageSupport, defaultHighlightStyle
} from '@codemirror/language';
export {
  defaultKeymap, history, historyKeymap, indentWithTab, toggleComment, toggleLineComment, undo, redo,
  selectAll, cursorLineDown, cursorLineUp
} from '@codemirror/commands';
export {
  search, searchKeymap, openSearchPanel, closeSearchPanel, highlightSelectionMatches, gotoLine
} from '@codemirror/search';
export {
  autocompletion, completionKeymap, snippetCompletion, closeBrackets, closeBracketsKeymap,
  startCompletion, acceptCompletion, snippet, completionStatus
} from '@codemirror/autocomplete';
export { linter, lintGutter, setDiagnostics, lintKeymap, forceLinting, diagnosticCount } from '@codemirror/lint';
export { tags, Tag } from '@lezer/highlight';
