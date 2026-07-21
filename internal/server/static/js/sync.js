// Real-time viewer sync. An SSE stream carries advisory "path X changed" events; a
// viewing tab applies the change to the open note in place — a CodeMirror ChangeSet in
// edit mode, a scroll-preserving preview re-render in preview mode — so a second device
// reflects edits with no full reload or flicker. Last-write-wins: a dirty (unsaved)
// buffer is never overwritten; the local edit is left to win on its own next save.
// KAIRO_CLIENT and currentFileToken are declared in app.js (the globals module).

let kairoEvents = null;

function kairoConnect() {
    kairoEvents = new EventSource('/api/events?client=' + encodeURIComponent(KAIRO_CLIENT));
    kairoEvents.onmessage = onSyncEvent;
    kairoEvents.onopen = () => setSyncConnected(true);
    kairoEvents.onerror = () => setSyncConnected(false);
}

let treeRefreshTimer = null;
function scheduleTreeRefresh() {
    clearTimeout(treeRefreshTimer);
    treeRefreshTimer = setTimeout(() => refreshTree(), 150);
}

function onSyncEvent(e) {
    let ev;
    try { ev = JSON.parse(e.data); } catch (_) { return; }
    if (ev.origin && ev.origin === KAIRO_CLIENT) return; // ignore this tab's own writes

    // structural changes touch the tree; a plain save never does
    if (ev.op !== 'save') scheduleTreeRefresh();

    if (ev.op === 'move') {
        // the open note may be the moved item itself or live inside a moved folder
        if (currentPath && (currentPath === ev.path || currentPath.startsWith(ev.path + '/'))) {
            const rebased = ev.newPath + currentPath.slice(ev.path.length);
            rebasePendingSaves(ev.path, ev.newPath);
            // treeData still holds the pre-move node (refresh is debounced), so the open path's own type carries the move
            const node = findNodeInTree(treeData, currentPath);
            loadFile(rebased, node ? node.isDir : false);
        }
        return;
    }
    if (ev.op === 'delete') {
        // a folder delete also removes the note open inside it; drop its queued autosave so it can't resurrect the file
        discardPendingSave(ev.path);
        if (currentPath && (currentPath === ev.path || currentPath.startsWith(ev.path + '/'))) {
            showToast('This note was deleted on another device', 'warning');
            goHome(); // the open buffer is now orphaned and would silently fail to save
        }
        return;
    }
    if ((ev.op === 'save' || ev.op === 'create') && ev.path === currentPath && ev.token && ev.token !== currentFileToken) {
        applyRemote(ev.path);
    }
}

async function applyRemote(path) {
    // never clobber unsaved local edits — last-write-wins lets this tab's own save win
    if (unsaved || hasPendingSave(path)) {
        showToast('This note changed on another device', 'info');
        return;
    }
    try {
        const res = await fetch(`/api/file?path=${encPath(path)}`);
        if (!res.ok || path !== currentPath) return;
        const token = res.headers.get('X-Kairo-Version');
        const content = await res.text();
        // re-check after the awaits: a switch or a keystroke mid-fetch would otherwise clobber a now-dirty buffer
        if (path !== currentPath || unsaved || hasPendingSave(path)) return;
        applyRemoteContent(content);
        currentFileToken = token;
    } catch (e) {
        console.error('Sync apply failed:', e);
    }
}

// Apply the change to the live doc as a minimal transaction (cursor/selection/scroll/undo
// survive in edit mode) and, when viewing, re-render the preview while holding scroll.
function applyRemoteContent(newContent) {
    const old = view.state.doc.toString();
    if (old === newContent) return;
    const { from, to, insert } = diffRange(old, newContent);
    // editorLoading suppresses the autosave listener so applying a remote change never echoes back
    editorLoading = true;
    try {
        view.dispatch({ changes: { from, to, insert } });
    } finally {
        editorLoading = false;
    }
    if (previewMode) {
        const scroll = els.previewContainer.scrollTop;
        renderMarkdownBody(newContent);
        els.previewContainer.scrollTop = scroll;
        // mermaid renders async and grows the container, so restore scroll again once the queued render settles
        queueRender(() => { els.previewContainer.scrollTop = scroll; });
    }
}

// Minimal single-range diff: strip the shared prefix and suffix, the middle is the edit.
// Positions are UTF-16 code units, matching both JS string indices and CodeMirror offsets.
function diffRange(a, b) {
    const max = Math.min(a.length, b.length);
    let p = 0;
    while (p < max && a[p] === b[p]) p++;
    // clamp the suffix scan so overlapping edits (e.g. "aa" -> "aaa") can't invert the range
    const maxSuffix = max - p;
    let s = 0;
    while (s < maxSuffix && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    return { from: p, to: a.length - s, insert: b.slice(p, b.length - s) };
}

// A frozen/slept tab drops its stream and misses events (SSE has no replay), so on wake
// re-establish a dead socket and re-pull the open note's current state.
function kairoResync() {
    // only reopen a truly-closed socket; a CONNECTING one is already retrying, and a second
    // EventSource would just spawn a duplicate hub connection
    if (kairoEvents && kairoEvents.readyState === EventSource.CLOSED) {
        kairoConnect();
    }
    scheduleTreeRefresh();
    if (currentPath && !unsaved && !hasPendingSave(currentPath)) {
        applyRemote(currentPath);
    }
}

function setSyncConnected(ok) {
    const dot = document.getElementById('sync-status');
    if (!dot) return;
    dot.classList.toggle('bg-green', ok);
    dot.classList.toggle('bg-overlay0', !ok);
    dot.title = ok ? 'Live sync connected' : 'Live sync reconnecting…';
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kairoResync();
});
window.addEventListener('pageshow', (e) => {
    if (e.persisted) kairoResync(); // bfcache restore
});
window.addEventListener('resume', kairoResync); // Chrome/Edge unfreeze; a no-op elsewhere

kairoConnect();
