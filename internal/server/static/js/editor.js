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

function initEditor() {
    const {
        EditorView, keymap, drawSelection, highlightActiveLine, highlightSpecialChars,
        EditorState,
        markdown, markdownLanguage, markdownKeymap,
        defaultKeymap, indentWithTab, history, historyKeymap,
        closeBrackets, closeBracketsKeymap,
        syntaxHighlighting, HighlightStyle, bracketMatching, indentUnit,
        tags
    } = CM;

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
        markdown({ base: markdownLanguage }),
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightSpecialChars(),
        bracketMatching(),
        closeBrackets({ brackets: ['(', '[', '{', '"', '`'] }),
        indentUnit.of('  '),
        EditorState.tabSize.of(2),
        keymap.of([
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

// sync.js consults this before applying a remote change, so a queued save is never clobbered
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
                const res = await fetch('/api/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Kairo-Client': KAIRO_CLIENT },
                    body: JSON.stringify({ path: encPath(path), content })
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
        const body = JSON.stringify({ path: encPath(path), content });
        // sendBeacon survives page unload; keepalive fetch is the fallback
        if (navigator.sendBeacon) {
            // sendBeacon can't set headers, so the client id rides as a query param for echo suppression
            navigator.sendBeacon('/api/save?client=' + encodeURIComponent(KAIRO_CLIENT), new Blob([body], { type: 'application/json' }));
        } else {
            fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kairo-Client': KAIRO_CLIENT }, body, keepalive: true });
        }
    }
    pendingSaves.clear();
});

function initUploadHandlers() {
    document.addEventListener('paste', async (e) => {
        if (!currentPath || previewMode) return;
        const items = e.clipboardData.items;
        for (const item of items) {
            if (item.type.startsWith('image')) {
                e.preventDefault();
                await uploadAndInsertImage(item.getAsFile());
            }
        }
    });

    els.editorContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
    });
    els.editorContainer.addEventListener('drop', async (e) => {
        if (!currentPath || previewMode) return;
        const images = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
        if (!images.length) return;
        e.preventDefault();
        // posAtCoords is null when dropped outside the text; then fall back to the existing caret
        const dropPos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (dropPos != null) view.dispatch({ selection: { anchor: dropPos } });
        for (const file of images) {
            await uploadAndInsertImage(file);
        }
    });
}

async function uploadAndInsertImage(file) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('notePath', encPath(currentPath));
    try {
        // No Content-Type: the browser sets the multipart boundary; only tag the writer for echo suppression
        const res = await fetch('/api/upload', { method: 'POST', headers: { 'X-Kairo-Client': KAIRO_CLIENT }, body: formData });
        if (!res.ok) throw new Error('upload failed: ' + res.status);
        const imgPath = await res.text();
        view.dispatch(view.state.replaceSelection(`![Attachment](${encodeURI(imgPath)})`));
        view.focus();
        await refreshTree();
    } catch (e) {
        console.error('Upload failed:', e);
        showToast('Failed to upload image', 'error');
    }
}
