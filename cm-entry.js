// CodeMirror 6 entry point — bundled into a single IIFE for the browser.
// Run: npx esbuild cm-entry.js --bundle --format=iife --global-name=CM --minify --outfile=internal/server/static/js/codemirror-bundle.min.js

export { EditorView, keymap, drawSelection, highlightActiveLine, highlightSpecialChars } from '@codemirror/view';
export { EditorState } from '@codemirror/state';
export { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
export { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
export { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
export { syntaxHighlighting, HighlightStyle, bracketMatching, indentUnit } from '@codemirror/language';
export { tags } from '@lezer/highlight';
