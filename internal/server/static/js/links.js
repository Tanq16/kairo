// Classifies markdown link and image targets the browser has already resolved against the note's URL; globals come from app.js (no imports in this file)

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
const NOTE_EXTS = ['.md', '.markdown', '.txt'];

function hasExt(path, exts) {
    const lower = path.toLowerCase();
    return exts.some(ext => lower.endsWith(ext));
}

function basename(path) {
    return path.slice(path.lastIndexOf('/') + 1);
}

// The document URL is the note path, so relative, root-absolute and percent-encoded targets all normalize here for free
function linkTarget(href) {
    if (!href || !href.trim()) return null;
    let url;
    try { url = new URL(href, document.baseURI); } catch (e) { return null; }
    if (url.origin !== window.location.origin) return null;
    // A same-origin URL carrying a query is a raw-file link, not a note path, and there is nowhere in the return value to carry the query onward
    if (url.search) return null;
    return { path: urlPath(url.pathname), hash: decodeSegment(url.hash.slice(1)) };
}

function resolveLink(path) {
    const candidates = [path];
    // Obsidian vaults link to notes without the extension
    if (!basename(path).includes('.')) candidates.push(path + '.md');
    // legacy Kairo attachment links are absolute against the data dir, which is itself the note root
    if (path.startsWith('data/')) candidates.push(path.slice(5));
    for (const p of candidates) {
        const node = findNodeInTree(treeData, p);
        if (node) return { path: p, node };
    }
    return { path, node: null };
}

function fileApiUrl(path) {
    return `${KAIRO_ROUTES}/api/file?path=${encodeURIComponent(path)}`;
}

// anything the editor and the image viewer don't cover is served raw, so a PDF opens in the browser instead of landing in CodeMirror as bytes
function opensInApp(path, isDir) {
    if (isDir) return true;
    const name = basename(path);
    return !name.includes('.') || hasExt(name, NOTE_EXTS) || hasExt(name, IMAGE_EXTS);
}

function fixImagePaths() {
    els.markdownBody.querySelectorAll('img').forEach(img => {
        const target = linkTarget(img.getAttribute('src'));
        if (!target || !target.path) return;
        img.src = fileApiUrl(resolveLink(target.path).path);
    });
}

function fixLinks() {
    els.markdownBody.querySelectorAll('a[href]').forEach(a => {
        const target = linkTarget(a.getAttribute('href'));
        if (!target) return;
        if (target.hash) a.dataset.kairoHash = target.hash;
        // an empty path is a link to the app root, which the browser can follow natively
        if (!target.path) return;

        const resolved = resolveLink(target.path);
        a.dataset.kairoPath = resolved.path;
        a.classList.toggle('kairo-missing', !resolved.node);
        a.href = pathUrl(resolved.path, target.hash);
    });
}

function scrollToAnchor(hash) {
    if (!hash) return;
    // mermaid renders async and grows the container, so scroll only once the queued render settles
    queueRender(() => {
        const heading = els.markdownBody.querySelector(`#${CSS.escape(hash)}`);
        if (heading) heading.scrollIntoView({ block: 'start' });
    });
}

async function openLinkTarget(path, hash) {
    if (!path || path === currentPath) {
        scrollToAnchor(hash);
        return;
    }
    const node = findNodeInTree(treeData, path);
    if (!node) {
        showToast(`Linked file not found: ${path}`, 'warning');
        return;
    }
    if (!opensInApp(path, node.isDir)) {
        window.open(fileApiUrl(path), '_blank', 'noopener');
        return;
    }
    await loadFile(path, node.isDir, { hash });
    scrollToAnchor(hash);
}

function initLinkNavigation() {
    els.markdownBody.addEventListener('click', e => {
        // modified clicks keep their native meaning (new tab, new window, download)
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const a = e.target.closest('a');
        if (!a) return;
        const path = a.dataset.kairoPath;
        const hash = a.dataset.kairoHash;
        if (!path && !hash) return;
        e.preventDefault();
        openLinkTarget(path, hash);
    });
}
