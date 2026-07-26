// Resolves note-relative markdown link and image targets into note-root paths for ?path= navigation and the file API; globals come from app.js (no imports in this file)

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
const NOTE_EXTS = ['.md', '.markdown', '.txt'];

function hasExt(path, exts) {
    const lower = path.toLowerCase();
    return exts.some(ext => lower.endsWith(ext));
}

function isExternalHref(href) {
    return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

function splitHash(href) {
    const i = href.indexOf('#');
    return i === -1 ? { target: href, hash: '' } : { target: href.slice(0, i), hash: href.slice(i + 1) };
}

// null when the path climbs above the note root, which the API rejects outright
function normalizePath(path) {
    const parts = [];
    for (const seg of path.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') {
            if (!parts.length) return null;
            parts.pop();
            continue;
        }
        parts.push(seg);
    }
    return parts.join('/');
}

function basename(path) {
    return path.slice(path.lastIndexOf('/') + 1);
}

function linkCandidates(basePath, target) {
    if (!target || isExternalHref(target)) return [];
    let decoded = target;
    // Links are percent-encoded but files are stored raw (literal-% legacy links keep their raw form)
    try { decoded = decodeURIComponent(target); } catch (e) {}

    let joined;
    if (decoded.startsWith('/')) {
        joined = decoded.slice(1);
    } else {
        const baseDir = basePath ? basePath.slice(0, basePath.lastIndexOf('/') + 1) : '';
        joined = baseDir + decoded;
    }

    const primary = normalizePath(joined);
    if (!primary) return [];

    const candidates = [primary];
    // Obsidian vaults link to notes without the extension
    if (!basename(primary).includes('.')) candidates.push(primary + '.md');
    // legacy Kairo attachment links are absolute against the data dir, which is itself the note root
    if (primary.startsWith('data/')) candidates.push(primary.slice(5));
    return candidates;
}

function resolveLink(basePath, target) {
    const candidates = linkCandidates(basePath, target);
    for (const path of candidates) {
        const node = findNodeInTree(treeData, path);
        if (node) return { path, node };
    }
    return candidates.length ? { path: candidates[0], node: null } : null;
}

function fileApiUrl(path) {
    return `/api/file?path=${encPath(path)}`;
}

// anything the editor and the image viewer don't cover is served raw, so a PDF opens in the browser instead of landing in CodeMirror as bytes
function opensInApp(path, isDir) {
    if (isDir) return true;
    const name = basename(path);
    return !name.includes('.') || hasExt(name, NOTE_EXTS) || hasExt(name, IMAGE_EXTS);
}

function fixImagePaths() {
    els.markdownBody.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src');
        if (!src || isExternalHref(src)) return;
        const resolved = resolveLink(currentPath, src);
        if (resolved) img.src = fileApiUrl(resolved.path);
    });
}

function fixLinks() {
    els.markdownBody.querySelectorAll('a[href]').forEach(a => {
        const href = a.getAttribute('href');
        if (!href || isExternalHref(href)) return;

        const { target, hash } = splitHash(href);
        if (hash) a.dataset.kairoHash = hash;
        if (!target) return;

        const resolved = resolveLink(currentPath, target);
        // a target that climbs out of the note root is still claimed, so the click reports a dead link instead of navigating away from the app
        a.dataset.kairoPath = resolved ? resolved.path : target;
        a.classList.toggle('kairo-missing', !resolved?.node);
        if (resolved) a.href = `?path=${encPath(resolved.path)}${hash ? '#' + hash : ''}`;
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
    await loadFile(path, node.isDir);
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
