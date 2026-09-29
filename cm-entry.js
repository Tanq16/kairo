// CodeMirror 6 entry point — bundled into a single IIFE for the browser.
// Run: npx esbuild cm-entry.js --bundle --format=iife --global-name=CM --minify --outfile=internal/server/static/js/codemirror-bundle.min.js

export { EditorView, keymap, drawSelection, highlightActiveLine, highlightSpecialChars, Decoration, WidgetType, ViewPlugin } from '@codemirror/view';
export { EditorState, RangeSetBuilder, StateField, StateEffect, Compartment } from '@codemirror/state';
export { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
export { GFM } from '@lezer/markdown';
export { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
export { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
export { syntaxHighlighting, HighlightStyle, bracketMatching, indentUnit, syntaxTree } from '@codemirror/language';
export { tags } from '@lezer/highlight';
