let view;
let editorLoading = false;
// Path the editor document belongs to; null while the doc is stale (image/folder/nothing open)
let editorPath = null;
let saveTimer = null;
// Pending saves keyed by path so a failed save is never evicted by edits to another file
const pendingSaves = new Map();
let saveFailed = false;
// One in-flight drain at a time; awaiting callers (move/load) get the live promise, not an early return
let flushPromise = null;

let sourceMode = localStorage.getItem('kairo-source-mode') === 'true';
let livePreviewCompartment = null;
let livePreviewField = null;
let mermaidIdCounter = 0;
const mermaidSvgCache = new Map();

function extractCodeBlockContent(rawText) {
    const lines = rawText.split('\n');
    if (lines.length <= 2) return '';
    return lines.slice(1, -1).join('\n');
}

async function renderMermaidWidgetContent(container, code) {
    if (typeof mermaid === 'undefined') {
        container.textContent = code;
        return;
    }
    const cached = mermaidSvgCache.get(code);
    if (cached) {
        container.innerHTML = cached;
        return;
    }
    const id = 'cm-mermaid-' + (++mermaidIdCounter);
    try {
        mermaid.initialize(buildMermaidConfig());
        const { svg } = await mermaid.render(id, code);
        mermaidSvgCache.set(code, svg);
        if (container.isConnected) {
            container.innerHTML = svg;
        }
    } catch (err) {
        const tempEl = document.getElementById(id);
        if (tempEl) tempEl.remove();
        const dtempEl = document.getElementById('d' + id);
        if (dtempEl) dtempEl.remove();
        if (container.isConnected) {
            container.innerHTML = `<div class="p-3 text-left bg-red/10 text-red rounded border border-red/30 text-xs font-mono whitespace-pre-wrap"><div class="font-bold mb-1">Mermaid syntax error (click to edit):</div>${escapeHtml(code)}</div>`;
        }
    }
}

class MermaidWidget extends CM.WidgetType {
    constructor(code, from, to) {
        super();
        this.code = code;
        this.from = from;
        this.to = to;
    }

    eq(other) {
        return this.code === other.code && this.from === other.from && this.to === other.to;
    }

    updateDOM(dom, view) {
        if (dom._code === this.code) {
            dom._from = this.from;
            dom._to = this.to;
            return true;
        }
        return false;
    }

    toDOM(view) {
        const container = document.createElement('div');
        container.className = 'cm-mermaid-widget';
        container._code = this.code;
        container._from = this.from;
        container._to = this.to;
        container.title = 'Click to edit diagram';

        container.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            let targetPos = container._from != null ? container._from : view.posAtDOM(container);
            try {
                const targetLine = view.state.doc.lineAt(targetPos);
                if (targetLine.number < view.state.doc.lines) {
                    targetPos = view.state.doc.line(targetLine.number + 1).from;
                }
            } catch (err) {}
            view.dispatch({
                selection: { anchor: targetPos },
                scrollIntoView: true
            });
            view.focus();
        });

        if (!this.code.trim()) {
            container.innerHTML = '<span class="text-xs text-subtext0 font-mono">Empty mermaid diagram (click to edit)</span>';
            return container;
        }

        renderMermaidWidgetContent(container, this.code);
        return container;
    }

    ignoreEvent(e) {
        return e.type === 'click' || e.type === 'mousedown';
    }
}

class TableWidget extends CM.WidgetType {
    constructor(markdownText, from, to) {
        super();
        this.markdownText = markdownText;
        this.from = from;
        this.to = to;
    }

    eq(other) {
        return this.markdownText === other.markdownText && this.from === other.from && this.to === other.to;
    }

    updateDOM(dom, view) {
        if (dom._text === this.markdownText) {
            dom._from = this.from;
            dom._to = this.to;
            return true;
        }
        return false;
    }

    toDOM(view) {
        const container = document.createElement('div');
        container.className = 'cm-table-widget';
        container._text = this.markdownText;
        container._from = this.from;
        container._to = this.to;
        container.title = 'Click to edit table';

        container.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            let targetPos = container._from != null ? container._from : view.posAtDOM(container);
            try {
                const tr = e.target.closest('tr');
                if (tr) {
                    const tbody = tr.closest('tbody');
                    const thead = tr.closest('thead');
                    let lineOffset = 0;
                    if (thead) {
                        lineOffset = 0;
                    } else if (tbody) {
                        const rowIndex = Array.from(tbody.children).indexOf(tr);
                        lineOffset = rowIndex >= 0 ? 2 + rowIndex : 2;
                    }
                    const startLine = view.state.doc.lineAt(targetPos);
                    const targetLineNum = Math.min(view.state.doc.lines, startLine.number + lineOffset);
                    targetPos = view.state.doc.line(targetLineNum).from;
                }
            } catch (err) {}
            view.dispatch({
                selection: { anchor: targetPos },
                scrollIntoView: true
            });
            view.focus();
        });

        if (typeof marked !== 'undefined') {
            const parsed = marked.parse(this.markdownText);
            container.innerHTML = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(parsed) : parsed;
            container.querySelectorAll('img').forEach(img => {
                if (typeof linkTarget === 'function') {
                    const target = linkTarget(img.getAttribute('src'));
                    if (target && target.path && typeof fileApiUrl === 'function' && typeof resolveLink === 'function') {
                        img.src = fileApiUrl(resolveLink(target.path).path);
                    }
                }
            });
        } else {
            container.textContent = this.markdownText;
        }
        return container;
    }

    ignoreEvent(e) {
        return e.type === 'click' || e.type === 'mousedown';
    }
}

function buildLivePreviewDecorations(state) {
    const builder = new CM.RangeSetBuilder();
    const tree = CM.syntaxTree(state);
    const ranges = state.selection.ranges;
    let lastFrom = -1;

    tree.iterate({
        enter(node) {
            if (node.name.startsWith('ATXHeading')) {
                const level = node.name.slice(10);
                const line = state.doc.lineAt(node.from);
                if (line.from > lastFrom) {
                    builder.add(line.from, line.from, CM.Decoration.line({ class: 'cm-heading-' + level }));
                    lastFrom = line.from;
                }
                return false;
            }
            if (node.name === 'SetextHeading1') {
                const line = state.doc.lineAt(node.from);
                if (line.from > lastFrom) {
                    builder.add(line.from, line.from, CM.Decoration.line({ class: 'cm-heading-1' }));
                    lastFrom = line.from;
                }
                return false;
            }
            if (node.name === 'SetextHeading2') {
                const line = state.doc.lineAt(node.from);
                if (line.from > lastFrom) {
                    builder.add(line.from, line.from, CM.Decoration.line({ class: 'cm-heading-2' }));
                    lastFrom = line.from;
                }
                return false;
            }
            if (node.name === 'FencedCode') {
                const infoNode = node.node.getChild('CodeInfo');
                const info = infoNode ? state.sliceDoc(infoNode.from, infoNode.to).trim().toLowerCase() : '';
                if (info === 'mermaid') {
                    let markCount = 0;
                    let child = node.node.firstChild;
                    while (child) {
                        if (child.name === 'CodeMark') markCount++;
                        child = child.nextSibling;
                    }
                    if (markCount >= 2) {
                        const lineFrom = state.doc.lineAt(node.from).from;
                        const lineTo = state.doc.lineAt(node.to).to;
                        const overlaps = ranges.some(r => r.from <= lineTo && r.to >= lineFrom);
                        if (!overlaps && lineFrom > lastFrom && lineFrom < lineTo) {
                            const rawText = state.sliceDoc(node.from, node.to);
                            const code = extractCodeBlockContent(rawText);
                            builder.add(lineFrom, lineTo, CM.Decoration.replace({
                                widget: new MermaidWidget(code, lineFrom, lineTo),
                                block: true
                            }));
                            lastFrom = lineTo;
                        }
                    }
                }
                return false;
            }
            if (node.name === 'Table') {
                const lineFrom = state.doc.lineAt(node.from).from;
                const lineTo = state.doc.lineAt(node.to).to;
                const overlaps = ranges.some(r => r.from <= lineTo && r.to >= lineFrom);
                if (!overlaps && lineFrom > lastFrom && lineFrom < lineTo) {
                    const rawText = state.sliceDoc(lineFrom, lineTo);
                    builder.add(lineFrom, lineTo, CM.Decoration.replace({
                        widget: new TableWidget(rawText, lineFrom, lineTo),
                        block: true
                    }));
                    lastFrom = lineTo;
                }
                return false;
            }
        }
    });

    return builder.finish();
}

function setLivePreviewEnabled(enabled) {
    if (!view || !livePreviewCompartment || !livePreviewField) return;
    view.dispatch({
        effects: livePreviewCompartment.reconfigure(enabled ? [livePreviewField] : [])
    });
}

function toggleSourceMode(force = null) {
    sourceMode = force !== null ? force : !sourceMode;
    localStorage.setItem('kairo-source-mode', String(sourceMode));
    updateSourceModeBtn();
    if (previewMode) {
        togglePreview(false);
    }
    setLivePreviewEnabled(!sourceMode);
}

function updateSourceModeBtn() {
    if (!els.sourceModeBtn) return;
    if (sourceMode) {
        els.sourceModeBtn.classList.add('text-mauve', 'bg-surface0');
        els.sourceModeBtn.title = 'Source mode (active) - click for Live Preview';
    } else {
        els.sourceModeBtn.classList.remove('text-mauve', 'bg-surface0');
        els.sourceModeBtn.title = 'Toggle source mode (plain text)';
    }
}

function initEditor() {
    const {
        EditorView, keymap, drawSelection, highlightActiveLine, highlightSpecialChars,
        EditorState, StateField, Compartment,
        markdown, markdownLanguage, markdownKeymap, GFM,
        defaultKeymap, indentWithTab, history, historyKeymap,
        closeBrackets, closeBracketsKeymap,
        syntaxHighlighting, HighlightStyle, bracketMatching, indentUnit,
        tags
    } = CM;

    livePreviewField = StateField.define({
        create(state) {
            return buildLivePreviewDecorations(state);
        },
        update(decorations, tr) {
            if (tr.docChanged || tr.selection) {
                return buildLivePreviewDecorations(tr.state);
            }
            return decorations;
        },
        provide: f => EditorView.decorations.from(f)
    });

    livePreviewCompartment = new Compartment();

    const catppuccinTheme = EditorView.theme({
        '&': {
            backgroundColor: 'var(--base)',
            color: 'var(--text)',
        },
        '.cm-cursor, .cm-dropCursor': {
            borderLeftColor: 'var(--text)',
        },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
            backgroundColor: 'var(--surface1)',
        },
        '.cm-activeLine': {
            backgroundColor: 'rgb(from var(--surface0) r g b / 0.3)',
        },
        '.cm-matchingBracket': {
            backgroundColor: 'rgb(from var(--blue) r g b / 0.2)',
            color: 'var(--blue)',
        },
    }, { dark: true });

    const catppuccinHighlight = HighlightStyle.define([
        { tag: tags.heading1, color: 'var(--lavender)', fontWeight: 'bold' },
        { tag: tags.heading2, color: 'var(--mauve)', fontWeight: 'bold' },
        { tag: tags.heading3, color: 'var(--blue)', fontWeight: 'bold' },
        { tag: [tags.heading4, tags.heading5, tags.heading6], color: 'var(--text)', fontWeight: 'bold' },
        { tag: tags.emphasis, color: 'var(--yellow)', fontStyle: 'italic' },
        { tag: tags.strong, color: 'var(--yellow)', fontWeight: 'bold' },
        { tag: tags.strikethrough, color: 'var(--overlay1)', textDecoration: 'line-through' },
        { tag: tags.link, color: 'var(--blue)', textDecoration: 'underline' },
        { tag: tags.url, color: 'var(--blue)' },
        { tag: [tags.processingInstruction, tags.monospace], color: 'var(--peach)' },
        { tag: tags.quote, color: 'var(--subtext0)', fontStyle: 'italic' },
        { tag: tags.list, color: 'var(--green)' },
        { tag: tags.contentSeparator, color: 'var(--surface1)' },
        { tag: tags.meta, color: 'var(--overlay1)' },
        { tag: tags.labelName, color: 'var(--blue)' },
    ]);

    const extensions = [
        catppuccinTheme,
        syntaxHighlighting(catppuccinHighlight),
        markdown({ base: markdownLanguage, extensions: [GFM] }),
        livePreviewCompartment.of(sourceMode ? [] : [livePreviewField]),
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightSpecialChars(),
        bracketMatching(),
        closeBrackets({ brackets: ['(', '[', '{', '"', '`'] }),
        indentUnit.of('  '),
        EditorState.tabSize.of(2),
        keymap.of([
            { key: 'Mod-e', run: () => { togglePreview(); return true; } },
            ...closeBracketsKeymap,
            ...markdownKeymap,
            ...historyKeymap,
            indentWithTab,
            ...defaultKeymap,
        ]),
        EditorView.lineWrapping,
        EditorView.updateListener.of(update => {
            // editorLoading suppresses the programmatic dispatch done when opening a file
            if (update.docChanged && !editorLoading && editorPath) {
                unsaved = true;
                els.unsavedIndicator.classList.remove('hidden');
                debounceSave(editorPath, update.state.doc.toString());
            }
        }),
    ];

    view = new EditorView({
        doc: '',
        extensions,
        parent: els.editor,
    });
}

function debounceSave(path, content) {
    if (!path) return;
    clearTimeout(saveTimer);
    pendingSaves.set(path, content);
    saveTimer = setTimeout(flushPendingSave, 1000);
}

function hasPendingSave(path) {
    return pendingSaves.has(path);
}

// Badge tracks whether any real save is still queued (pending or failed), not just the live doc
function updateUnsavedIndicator() {
    unsaved = pendingSaves.size > 0;
    els.unsavedIndicator.classList.toggle('hidden', !unsaved);
}

function flushPendingSave() {
    if (!flushPromise) {
        flushPromise = drainPendingSaves().finally(() => { flushPromise = null; });
    }
    return flushPromise;
}

async function drainPendingSaves() {
    clearTimeout(saveTimer);
    saveTimer = null;
    // Drain to empty so awaiting callers see edits persisted; re-snapshot each pass so a failing save skips ahead, not starves the rest
    while (pendingSaves.size) {
        let progressed = false;
        let failed = false;
        for (const path of [...pendingSaves.keys()]) {
            const content = pendingSaves.get(path);
            if (content === undefined) continue; // dropped by a concurrent move/discard
            try {
                const res = await fetch(`${KAIRO_ROUTES}/api/save`, {
                    method: 'POST',
                    headers: writeHeaders,
                    body: JSON.stringify({ path, content })
                });
                if (!res.ok) throw new Error('save failed: ' + res.status);
                saveFailed = false;
                // Keep the entry if a newer edit landed mid-flight so it gets re-saved next pass
                if (pendingSaves.get(path) === content) {
                    pendingSaves.delete(path);
                    progressed = true;
                }
            } catch (e) {
                console.error('Save failed:', e);
                // Toast once on entering the failed state; leave the entry queued for the next debounce/beforeunload
                if (!saveFailed) showToast('Failed to save', 'error');
                saveFailed = true;
                failed = true;
            }
        }
        // Stop on a failure or a no-progress pass; re-arm the timer to retry rather than hot-spin
        if (failed || !progressed) {
            if (pendingSaves.size) saveTimer = setTimeout(flushPendingSave, 1000);
            break;
        }
    }
    updateUnsavedIndicator();
}

function discardPendingSave(path) {
    for (const p of [...pendingSaves.keys()]) {
        if (p === path || p.startsWith(path + '/')) pendingSaves.delete(p);
    }
    if (pendingSaves.size === 0) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
}

// A move must retarget queued edits and the live doc, else the next flush recreates the old path
function rebasePendingSaves(oldPath, newPath) {
    if (editorPath && (editorPath === oldPath || editorPath.startsWith(oldPath + '/'))) {
        editorPath = newPath + editorPath.slice(oldPath.length);
    }
    for (const p of [...pendingSaves.keys()]) {
        if (p === oldPath || p.startsWith(oldPath + '/')) {
            const content = pendingSaves.get(p);
            pendingSaves.delete(p);
            pendingSaves.set(newPath + p.slice(oldPath.length), content);
        }
    }
}

window.addEventListener('beforeunload', () => {
    if (pendingSaves.size === 0) return;
    clearTimeout(saveTimer);
    for (const [path, content] of pendingSaves) {
        const body = JSON.stringify({ path, content });
        // sendBeacon survives page unload; keepalive fetch is the fallback
        if (navigator.sendBeacon) {
            // sendBeacon can't set headers, so the client id rides as a query param for echo suppression
            navigator.sendBeacon(`${KAIRO_ROUTES}/api/save?client=${encodeURIComponent(KAIRO_CLIENT)}&wire=${KAIRO_WIRE}`, new Blob([body], { type: 'application/json' }));
        } else {
            fetch(`${KAIRO_ROUTES}/api/save`, { method: 'POST', headers: writeHeaders, body, keepalive: true });
        }
    }
    pendingSaves.clear();
});

function initUploadHandlers() {
    document.addEventListener('paste', async (e) => {
        if (!currentPath || previewMode) return;
        const items = e.clipboardData.items;
        for (const item of items) {
            if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file) {
                    e.preventDefault();
                    await uploadAndInsertFile(file);
                }
            }
        }
    });

    els.editorContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
    });
    els.editorContainer.addEventListener('drop', async (e) => {
        if (!currentPath || previewMode) return;
        const files = [...e.dataTransfer.files];
        if (!files.length) return;
        e.preventDefault();
        // posAtCoords is null when dropped outside the text; then fall back to the existing caret
        const dropPos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (dropPos != null) view.dispatch({ selection: { anchor: dropPos } });
        for (const file of files) {
            await uploadAndInsertFile(file);
        }
    });
}

async function uploadAndInsertFile(file) {
    const targetPath = currentPath;
    const formData = new FormData();
    formData.append('file', file);
    try {
        // notePath rides in the query string because FormData normalizes newlines in a field value; no Content-Type header, so the browser sets the multipart boundary
        const res = await fetch(`${KAIRO_ROUTES}/api/upload?notePath=${encodeURIComponent(targetPath)}`, { method: 'POST', headers: { 'X-Kairo-Client': KAIRO_CLIENT, 'X-Kairo-Wire': KAIRO_WIRE }, body: formData });
        if (!res.ok) throw new Error('upload failed: ' + res.status);
        const relPath = await res.text();
        await refreshTree();
        if (currentPath !== targetPath) return;
        const isImage = file.type.startsWith('image/') || hasExt(file.name, IMAGE_EXTS);
        const snippet = isImage ? `![${file.name}](${encodeMdDest(relPath)})` : `[${file.name}](${encodeMdDest(relPath)})`;
        view.dispatch(view.state.replaceSelection(snippet));
        view.focus();
    } catch (e) {
        console.error('Upload failed:', e);
        showToast(`Failed to upload ${file.name}`, 'error');
    }
}
