const els = {
    editor: document.getElementById('editor'),
    editorContainer: document.getElementById('editor-container'),
    previewContainer: document.getElementById('preview-container'),
    markdownBody: document.getElementById('markdown-body'),
    tocRail: document.getElementById('toc-rail'),
    tocToggle: document.getElementById('toc-toggle'),
    widthToggle: document.getElementById('width-toggle'),
    previewGrid: document.querySelector('#preview-container .preview-grid'),
    fileTree: document.getElementById('file-tree'),
    filenameDisplay: document.getElementById('current-filename'),
    unsavedIndicator: document.getElementById('unsaved-indicator'),
    previewBtn: document.getElementById('preview-btn'),
    printBtn: document.getElementById('print-btn'),
    themeToggle: document.getElementById('theme-toggle'),
    deleteBtn: document.getElementById('delete-btn'),
    sidebar: document.getElementById('sidebar'),
    sidebarOverlay: document.getElementById('sidebar-overlay'),
    mobileMenuBtn: document.getElementById('mobile-menu-btn'),
    desktopSidebarToggle: document.getElementById('desktop-sidebar-toggle'),
    sidebarResizer: document.getElementById('sidebar-resizer'),
    addFileBtn: document.getElementById('add-file-btn'),
    addFolderBtn: document.getElementById('add-folder-btn'),
    moveBtn: document.getElementById('move-btn'),
    searchBtn: document.getElementById('search-btn'),
    searchModal: {
        backdrop: document.getElementById('search-modal'),
        input: document.getElementById('search-input'),
        results: document.getElementById('search-results')
    },
    createModal: {
        backdrop: document.getElementById('create-modal'),
        input: document.getElementById('create-input'),
        confirm: document.getElementById('create-confirm'),
        cancel: document.getElementById('create-cancel')
    },
    moveModal: {
        backdrop: document.getElementById('move-modal'),
        current: document.getElementById('move-current'),
        new: document.getElementById('move-new'),
        confirm: document.getElementById('move-confirm'),
        cancel: document.getElementById('move-cancel')
    },
    deleteModal: {
        backdrop: document.getElementById('delete-modal'),
        path: document.getElementById('delete-path'),
        confirm: document.getElementById('delete-confirm'),
        cancel: document.getElementById('delete-cancel')
    },
    printModal: {
        backdrop: document.getElementById('print-modal'),
        styled100: document.getElementById('print-styled-100'),
        plain100: document.getElementById('print-plain-100'),
        styledScaled: document.getElementById('print-styled-scaled'),
        plainScaled: document.getElementById('print-plain-scaled'),
        scaleInput: document.getElementById('print-scale-input'),
        cancel: document.getElementById('print-cancel')
    },
    pdfContainer: document.getElementById('pdf-container'),
    pdfFrame: document.getElementById('pdf-frame')
};

let currentPath = null;
let unsaved = false;
let previewMode = false;
let sidebarCollapsed = localStorage.getItem('kairo-sidebar-collapsed') === 'true';
let tocVisible = localStorage.getItem('kairo-toc-visible') !== 'false';
let loadVersion = 0;
let treeData = [];
let createMode = 'file';
let expandedFolders = new Set(JSON.parse(localStorage.getItem('kairo-expanded-folders') || '[]'));

let currentFileToken = null;
// per-tab id for echo suppression; crypto.randomUUID is secure-context-only (undefined over plain-HTTP LAN), hence the manual fallback
const KAIRO_CLIENT = (() => {
    if (crypto.randomUUID) { try { return crypto.randomUUID(); } catch (e) {} }
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0'));
    return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h.slice(10).join('')}`;
})();

// Lets the server reject a tab still running the pre-plain-path client instead of writing its base64 path verbatim
const KAIRO_WIRE = '2';
const writeHeaders = { 'Content-Type': 'application/json', 'X-Kairo-Client': KAIRO_CLIENT, 'X-Kairo-Wire': KAIRO_WIRE };

// The same literal as routePrefix in server.go and the asset tags in index.html; nothing but TestClientUsesRoutePrefix holds the three together
const KAIRO_ROUTES = '/_kairo-21b89d9a-af98-4aae-b036-4c9a08a216aa';

function encodeSegments(path) {
    return path.split('/').map(encodeURIComponent).join('/');
}

// Parentheses are legal in a filename but are destination syntax inside a markdown link, so they are escaped here and nowhere else — an address bar keeps them readable
function encodeMdDest(path) {
    return encodeSegments(path).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

// The wire carries plain paths now; this only reads a legacy /?path=<base64> browser URL
function decPath(encoded) {
    if (!encoded) return '';
    try {
        let str = encoded.replace(/-/g, '+').replace(/_/g, '/');
        while (str.length % 4) str += '=';
        const bin = atob(str);
        return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
    } catch (e) {
        // A mangled shared URL must not abort initialization
        return '';
    }
}

function decodeSegment(seg) {
    // A '%' that isn't an escape is a legal filename character, so it is escaped rather than allowed to abort the decode
    try { return decodeURIComponent(seg.replace(/%(?![0-9A-Fa-f]{2})/g, '%25')); } catch (e) { return seg; }
}

function pathUrl(path, hash = '') {
    const url = path ? '/' + encodeSegments(path) : '/';
    return hash ? url + '#' + encodeURIComponent(hash) : url;
}

function urlPath(pathname) {
    return pathname.split('/').filter(Boolean).map(decodeSegment).join('/');
}

function urlHash() {
    return decodeSegment(window.location.hash.slice(1));
}

let toastTimer;
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    const msg = document.getElementById('toast-message');
    msg.textContent = message;

    const colors = {
        info: 'text-blue',
        success: 'text-green',
        error: 'text-red',
        warning: 'text-yellow'
    };
    msg.className = colors[type] || colors.info;

    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

// writeServiceError sends a specific reason (destination exists) that a bare status code cannot carry
async function toastServerError(res, fallback) {
    showToast((await res.text()).trim() || fallback, 'error');
}

function saveExpandedFolders() {
    localStorage.setItem('kairo-expanded-folders', JSON.stringify([...expandedFolders]));
}

function applySidebarCollapsed() {
    els.sidebar.classList.toggle('collapsed', sidebarCollapsed);
    els.desktopSidebarToggle.classList.toggle('sidebar-collapsed', sidebarCollapsed);
}

const SIDEBAR_MIN = 224, SIDEBAR_MAX = 560;
function initSidebarResize() {
    const saved = parseInt(localStorage.getItem('kairo-sidebar-width'), 10);
    if (saved) els.sidebar.style.setProperty('--sidebar-width', Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, saved)) + 'px');
    if (!els.sidebarResizer) return;
    let startX, startW, curW;
    const onMove = e => {
        curW = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + e.clientX - startX));
        els.sidebar.style.setProperty('--sidebar-width', curW + 'px');
    };
    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        els.sidebar.classList.remove('resizing');
        document.body.style.userSelect = '';
        if (curW) localStorage.setItem('kairo-sidebar-width', String(Math.round(curW)));
    };
    els.sidebarResizer.addEventListener('mousedown', e => {
        if (sidebarCollapsed) return;
        e.preventDefault();
        startX = e.clientX;
        startW = els.sidebar.getBoundingClientRect().width;
        curW = startW;
        els.sidebar.classList.add('resizing');
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

let breadcrumbsExpanded = false;
let activeBreadcrumbDropdown = null;

function closeBreadcrumbDropdown() {
    if (activeBreadcrumbDropdown) {
        activeBreadcrumbDropdown.remove();
        activeBreadcrumbDropdown = null;
    }
}

document.addEventListener('click', (e) => {
    if (activeBreadcrumbDropdown && !activeBreadcrumbDropdown.contains(e.target) && !e.target.closest('#breadcrumb-ellipsis-btn')) {
        closeBreadcrumbDropdown();
    }
});
window.addEventListener('resize', closeBreadcrumbDropdown);
window.addEventListener('scroll', closeBreadcrumbDropdown, true);
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeBreadcrumbDropdown();
});

function updateBreadcrumbs(path) {
    const container = els.filenameDisplay;
    container.innerHTML = '';
    closeBreadcrumbDropdown();
    if (!path) {
        container.innerHTML = '<span class="text-subtext0">Select a note...</span>';
        return;
    }
    const parts = path.split('/');
    const shouldSkip = !breadcrumbsExpanded && (parts.length > 3 || (parts.length === 3 && path.length > 40));

    if (shouldSkip) {
        const rootCrumb = document.createElement('span');
        rootCrumb.className = 'text-subtext0 hover:text-mauve cursor-pointer truncate max-w-[120px] md:max-w-[180px] shrink-0';
        rootCrumb.textContent = parts[0];
        rootCrumb.title = parts[0];
        rootCrumb.onclick = () => loadFile(parts[0], true);
        container.appendChild(rootCrumb);

        const sep1 = document.createElement('span');
        sep1.className = 'text-overlay1 mx-1 shrink-0';
        sep1.textContent = '/';
        container.appendChild(sep1);

        const middleParts = parts.slice(1, -1);
        const ellipsisBtn = document.createElement('button');
        ellipsisBtn.id = 'breadcrumb-ellipsis-btn';
        ellipsisBtn.type = 'button';
        ellipsisBtn.className = 'text-subtext0 hover:text-mauve hover:bg-surface0 px-1.5 py-0.5 rounded text-xs font-semibold tracking-wider transition-colors shrink-0';
        ellipsisBtn.textContent = '…';
        ellipsisBtn.title = `Hidden folders: ${middleParts.join(' / ')}\nClick to view options`;
        ellipsisBtn.onclick = (e) => {
            e.stopPropagation();
            if (activeBreadcrumbDropdown) {
                closeBreadcrumbDropdown();
                return;
            }
            const dropdown = document.createElement('div');
            dropdown.id = 'breadcrumb-dropdown';
            dropdown.className = 'fixed bg-mantle border border-surface0 rounded-lg shadow-xl py-1 z-50 min-w-[200px] max-w-[320px] text-left';
            const rect = ellipsisBtn.getBoundingClientRect();
            dropdown.style.top = `${rect.bottom + 6}px`;
            dropdown.style.left = `${Math.max(8, rect.left)}px`;

            const header = document.createElement('div');
            header.className = 'px-3 py-1 text-[11px] font-semibold text-overlay1 uppercase tracking-wider';
            header.textContent = 'Intermediate folders';
            dropdown.appendChild(header);

            middleParts.forEach((part, idx) => {
                const folderIdx = idx + 1;
                const folderPath = parts.slice(0, folderIdx + 1).join('/');
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'w-full text-left flex items-center gap-2 px-3 py-1.5 text-xs md:text-sm text-subtext0 hover:text-text hover:bg-surface0 transition-colors';

                const icon = document.createElement('i');
                icon.setAttribute('data-lucide', 'folder');
                icon.className = 'w-3.5 h-3.5 text-yellow shrink-0';

                const label = document.createElement('span');
                label.className = 'truncate';
                label.textContent = part;

                item.appendChild(icon);
                item.appendChild(label);
                item.onclick = (ev) => {
                    ev.stopPropagation();
                    closeBreadcrumbDropdown();
                    loadFile(folderPath, true);
                };
                dropdown.appendChild(item);
            });

            const divider = document.createElement('div');
            divider.className = 'my-1 border-t border-surface0';
            dropdown.appendChild(divider);

            const expandItem = document.createElement('button');
            expandItem.type = 'button';
            expandItem.className = 'w-full text-left flex items-center gap-2 px-3 py-1.5 text-xs text-subtext0 hover:text-mauve hover:bg-surface0 transition-colors';

            const expandIcon = document.createElement('i');
            expandIcon.setAttribute('data-lucide', 'unfold-horizontal');
            expandIcon.className = 'w-3.5 h-3.5 text-mauve shrink-0';

            const expandLabel = document.createElement('span');
            expandLabel.textContent = 'Expand in breadcrumb';

            expandItem.appendChild(expandIcon);
            expandItem.appendChild(expandLabel);
            expandItem.onclick = (ev) => {
                ev.stopPropagation();
                closeBreadcrumbDropdown();
                breadcrumbsExpanded = true;
                updateBreadcrumbs(path);
            };
            dropdown.appendChild(expandItem);

            document.body.appendChild(dropdown);
            activeBreadcrumbDropdown = dropdown;
            lucide.createIcons();
        };
        container.appendChild(ellipsisBtn);

        const sep2 = document.createElement('span');
        sep2.className = 'text-overlay1 mx-1 shrink-0';
        sep2.textContent = '/';
        container.appendChild(sep2);

        const lastCrumb = document.createElement('span');
        lastCrumb.className = 'text-subtext1 truncate min-w-0';
        lastCrumb.textContent = parts[parts.length - 1];
        lastCrumb.title = path;
        container.appendChild(lastCrumb);
        return;
    }

    parts.forEach((part, i) => {
        if (i > 0) {
            const sep = document.createElement('span');
            sep.className = 'text-overlay1 mx-1 shrink-0';
            sep.textContent = '/';
            container.appendChild(sep);
        }
        const crumb = document.createElement('span');
        const isLast = i === parts.length - 1;
        if (isLast) {
            crumb.className = 'text-subtext1 truncate min-w-0';
            crumb.textContent = part;
            crumb.title = path;
        } else {
            crumb.className = 'text-subtext0 hover:text-mauve cursor-pointer truncate max-w-[140px] md:max-w-[200px] shrink-0';
            crumb.textContent = part;
            crumb.title = part;
            const folderPath = parts.slice(0, i + 1).join('/');
            crumb.onclick = () => loadFile(folderPath, true);
        }
        container.appendChild(crumb);
    });

    if (breadcrumbsExpanded) {
        const collapseBtn = document.createElement('button');
        collapseBtn.type = 'button';
        collapseBtn.className = 'text-subtext0 hover:text-mauve hover:bg-surface0 p-1 ml-1 rounded transition-colors shrink-0';
        collapseBtn.title = 'Collapse breadcrumb';
        collapseBtn.innerHTML = '<i data-lucide="fold-horizontal" class="w-3.5 h-3.5"></i>';
        collapseBtn.onclick = (e) => {
            e.stopPropagation();
            breadcrumbsExpanded = false;
            updateBreadcrumbs(path);
        };
        container.appendChild(collapseBtn);
        lucide.createIcons();
    }
}

async function goHome(nav = 'push') {
    await loadFile('', false, { nav });
    refreshTree();
}

const THEME_KEY = 'kairo-theme';

function setThemeIcon() {
    els.themeToggle.innerHTML = `<i data-lucide="${document.documentElement.classList.contains('dark') ? 'sun' : 'moon'}" class="w-4 h-4"></i>`;
}

function toggleTheme() {
    const dark = document.documentElement.classList.toggle('dark');
    localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    document.getElementById('hljs-dark').disabled = !dark;
    document.getElementById('hljs-light').disabled = dark;
    setThemeIcon();
    lucide.createIcons();
    queueRender(() => renderMermaid(els.markdownBody, buildMermaidConfig()));
}

const WIDE_KEY = 'kairo-wide-preview';
let wideMode = localStorage.getItem(WIDE_KEY) === 'true';

function applyWideMode() {
    els.markdownBody.classList.toggle('wide', wideMode);
    els.widthToggle.classList.toggle('active', wideMode);
    els.widthToggle.innerHTML = `<i data-lucide="${wideMode ? 'fold-horizontal' : 'unfold-horizontal'}" class="w-4 h-4"></i>`;
}

let renderChain = Promise.resolve();
function queueRender(fn) {
    renderChain = renderChain.then(fn).catch(() => {});
    return renderChain;
}

function printScale() {
    const v = parseFloat(els.printModal.scaleInput.value);
    return v > 0 ? v / 100 : 0.75;
}

function runPrint(theme, scale) {
    els.printModal.backdrop.classList.add('hidden');
    if (!previewMode) togglePreview(true);
    const plain = theme === 'plain';
    const originalTitle = document.title;

    const restore = () => {
        document.body.classList.remove('print-plain');
        document.body.style.removeProperty('--print-scale');
        document.title = originalTitle;
        clearPrintPages();
        if (plain) queueRender(() => renderMermaid(els.markdownBody, buildMermaidConfig()));
    };

    queueRender(async () => {
        // Browsers seed the Save-as-PDF filename from document.title
        if (currentPath) document.title = currentPath.split('/').pop();
        document.body.style.setProperty('--print-scale', String(scale));
        if (plain) {
            document.body.classList.add('print-plain');
            await renderMermaid(els.markdownBody, plainMermaidConfig);
        }
        buildPrintPages();
        window.addEventListener('afterprint', restore, { once: true });
        setTimeout(() => window.print(), 100);
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    setThemeIcon();
    applyWideMode();
    lucide.createIcons();
    initMarked();
    initEditor();
    initUploadHandlers();
    initEventListeners();
    initSidebarResize();
    initSearch();
    await refreshTree();

    els.fileTree.ondragover = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        els.fileTree.classList.add('bg-surface0/50');
    };
    els.fileTree.ondragleave = (e) => {
        els.fileTree.classList.remove('bg-surface0/50');
    };
    els.fileTree.ondrop = async (e) => {
        e.preventDefault();
        els.fileTree.classList.remove('bg-surface0/50');
        const draggedPath = e.dataTransfer.getData('text/plain');
        if (!draggedPath) return;
        await moveItem(draggedPath, draggedPath.split('/').pop());
    };

    // Only the pre-path-URL app root carried ?path=; anywhere else the query belongs to a URL that is not this app's
    const legacy = window.location.pathname === '/' ? new URLSearchParams(window.location.search).get('path') : null;
    const initPath = legacy ? decPath(legacy) : urlPath(window.location.pathname);
    if (initPath) {
        const initHash = urlHash();
        const node = findNodeInTree(treeData, initPath);
        await loadFile(initPath, node ? node.isDir : false, { nav: 'replace', hash: initHash });
        scrollToAnchor(initHash);
    }
});

function showPreviewPane() {
    els.editorContainer.classList.add('hidden');
    els.previewContainer.classList.remove('hidden');
    els.previewBtn.classList.add('hidden');
    previewMode = true;
    hideToc();
}

function showPdfPane(path, hash = '') {
    els.editorContainer.classList.add('hidden');
    els.previewContainer.classList.add('hidden');
    els.pdfContainer.classList.remove('hidden');
    els.pdfFrame.src = fileApiUrl(path) + (hash ? '#' + hash : '');
    els.previewBtn.classList.add('hidden');
    if (els.printBtn) els.printBtn.classList.add('hidden');
    if (els.widthToggle) els.widthToggle.classList.add('hidden');
    hideToc();
}

function hidePdfPane() {
    if (els.pdfContainer && !els.pdfContainer.classList.contains('hidden')) {
        els.pdfContainer.classList.add('hidden');
        els.pdfFrame.src = 'about:blank';
        if (els.widthToggle) els.widthToggle.classList.remove('hidden');
    }
}

function renderNotice(message) {
    els.markdownBody.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'text-subtext0';
    p.textContent = message;
    els.markdownBody.appendChild(p);
}

async function loadFile(path, isDir = false, { nav = 'push', hash = '' } = {}) {
    // Both null and '' mean "no note open", so re-entering the home state must not stack a second identical entry
    const samePath = (currentPath || '') === (path || '');
    // The history write stays above the await: a popstate landing mid-flush would otherwise be overwritten by this navigation
    if (nav === 'push' && !samePath) window.history.pushState(null, '', pathUrl(path, hash));
    else if (nav !== 'none') window.history.replaceState(null, '', pathUrl(path, hash));

    // Persist the previous file before the fetch below, so a switch can't load stale content over an in-flight save
    await flushPendingSave();

    const thisLoad = ++loadVersion;
    if (currentPath !== path) {
        breadcrumbsExpanded = false;
    }
    currentPath = path;
    // Null while the editor still holds the previous note, so its doc can't autosave under the new path
    editorPath = null;
    updateBreadcrumbs(path);

    els.moveBtn.classList.toggle('hidden', !path);
    els.deleteBtn.classList.toggle('hidden', !path);
    if (els.printBtn) els.printBtn.classList.toggle('hidden', !path || isDir || hasExt(path, PDF_EXTS));

    hidePdfPane();

    if (isDir) {
        showPreviewPane();
        renderDirListing(path);
        els.previewContainer.scrollTop = 0;
        return;
    }

    if (!path) {
        els.editorContainer.classList.add('hidden');
        els.previewContainer.classList.add('hidden');
        els.previewBtn.classList.add('hidden');
        hideToc();
        return;
    }

    if (hasExt(path, PDF_EXTS)) {
        showPdfPane(path, hash);
        return;
    }

    if (hasExt(path, IMAGE_EXTS)) {
        showPreviewPane();
        els.markdownBody.innerHTML = `<img src="${fileApiUrl(path)}" alt="${escapeHtml(path.split('/').pop())}" style="max-width:100%; border-radius:0.5rem;">`;
        els.previewContainer.scrollTop = 0;
        return;
    }

    try {
        const res = await fetch(fileApiUrl(path));
        if (thisLoad !== loadVersion) return;
        if (!res.ok) throw new Error('Failed to load');
        currentFileToken = res.headers.get('X-Kairo-Version');
        const content = await res.text();
        if (thisLoad !== loadVersion) return;

        // Suppress autosave for the programmatic load; finally resets the flag even if dispatch throws
        editorLoading = true;
        try {
            view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: content },
                selection: { anchor: 0 },
                scrollIntoView: true
            });
        } finally {
            editorLoading = false;
        }
        editorPath = path;
        els.previewBtn.classList.remove('hidden');
        // Keep the badge if the outgoing file still has a queued or failed save
        updateUnsavedIndicator();

        togglePreview(true);
        els.previewContainer.scrollTop = 0;
    } catch(e) {
        if (thisLoad !== loadVersion) return;
        console.error(e);
        // A bookmark or a back-navigation can address a note that no longer exists, so the failure needs its own state instead of leaving the previous note on screen
        showPreviewPane();
        els.moveBtn.classList.add('hidden');
        els.deleteBtn.classList.add('hidden');
        if (els.printBtn) els.printBtn.classList.add('hidden');
        renderNotice(`Could not load ${path}`);
        els.previewContainer.scrollTop = 0;
    }
}

function renderDirListing(path) {
    const node = findNodeInTree(treeData, path);
    els.markdownBody.innerHTML = '';

    const h1 = document.createElement('h1');
    h1.textContent = path.split('/').pop() || 'Root';
    els.markdownBody.appendChild(h1);

    const ul = document.createElement('ul');
    ((node && node.children) || []).forEach(c => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = pathUrl(c.path);
        a.dataset.kairoPath = c.path;
        a.textContent = c.name;
        li.appendChild(a);
        ul.appendChild(li);
    });
    els.markdownBody.appendChild(ul);
}

let tocScrollHandler = null;
let tocScrollTarget = null;

function buildToc() {
    const headings = [...els.markdownBody.querySelectorAll('h1, h2, h3')];
    if (headings.length < 2) {
        hideToc();
        return;
    }
    els.tocRail.innerHTML = '';
    const linkFor = new Map();
    headings.forEach(h => {
        const a = document.createElement('a');
        a.className = 'toc-link toc-h' + h.tagName[1];
        // Heading text is untrusted note content
        a.textContent = h.textContent;
        a.href = '#' + h.id;
        a.addEventListener('click', e => {
            // Scroll within the preview pane without pushing a hash onto the URL
            e.preventDefault();
            h.scrollIntoView({ block: 'start' });
        });
        els.tocRail.appendChild(a);
        linkFor.set(h, a);
    });

    const setActive = () => {
        const top = els.previewContainer.getBoundingClientRect().top;
        // Active = the last heading scrolled above the marker, so a section stays lit once its heading passes off the top
        let current = headings[0];
        for (const h of headings) {
            if (h.getBoundingClientRect().top - top <= 96) current = h;
            else break;
        }
        let active = null;
        linkFor.forEach((a, h) => { a.classList.toggle('active', h === current); if (h === current) active = a; });
        if (active && !els.tocRail.classList.contains('collapsed')) keepTocLinkInView(active);
    };

    tocScrollTarget?.removeEventListener('scroll', tocScrollHandler);
    let ticking = false;
    tocScrollHandler = () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => { setActive(); ticking = false; });
    };
    tocScrollTarget = els.previewContainer;
    tocScrollTarget.addEventListener('scroll', tocScrollHandler, { passive: true });
    setActive();

    els.tocToggle?.classList.remove('hidden');
    applyTocVisible();
}

function keepTocLinkInView(link) {
    const lr = link.getBoundingClientRect(), rr = els.tocRail.getBoundingClientRect();
    if (lr.top < rr.top) els.tocRail.scrollTop -= rr.top - lr.top + 8;
    else if (lr.bottom > rr.bottom) els.tocRail.scrollTop += lr.bottom - rr.bottom + 8;
}

function hideToc() {
    tocScrollTarget?.removeEventListener('scroll', tocScrollHandler);
    tocScrollHandler = null;
    tocScrollTarget = null;
    els.tocRail.innerHTML = '';
    els.tocRail.classList.add('collapsed');
    els.previewGrid?.classList.add('toc-hidden');
    els.tocToggle?.classList.add('hidden');
}

function applyTocVisible() {
    const show = els.tocRail.children.length > 0 && tocVisible;
    els.tocRail.classList.toggle('collapsed', !show);
    els.previewGrid?.classList.toggle('toc-hidden', !show);
    els.tocToggle?.classList.toggle('active', show);
    if (show) tocScrollHandler?.();
}

const NARROW_WIDTH = 1200;
function autoHintSidePanels(opened) {
    if (window.innerWidth >= NARROW_WIDTH) return;
    if (opened === 'nav' && tocVisible) {
        tocVisible = false;
        localStorage.setItem('kairo-toc-visible', 'false');
        applyTocVisible();
    } else if (opened === 'toc' && !sidebarCollapsed) {
        sidebarCollapsed = true;
        localStorage.setItem('kairo-sidebar-collapsed', 'true');
        applySidebarCollapsed();
    }
}

async function moveItem(oldPath, newPath) {
    if (!oldPath || !newPath || oldPath === newPath) return false;
    if (newPath.startsWith(oldPath + '/')) {
        showToast('Cannot move an item into itself', 'warning');
        return false;
    }
    // Edits must land at the old path before it disappears
    await flushPendingSave();
    try {
        const res = await fetch(`${KAIRO_ROUTES}/api/move`, {
            method: 'POST',
            headers: writeHeaders,
            body: JSON.stringify({ path: oldPath, newPath })
        });
        if (!res.ok) {
            await toastServerError(res, 'Failed to move');
            return false;
        }
        rebasePendingSaves(oldPath, newPath);
        await refreshTree();
        // The open note may live inside the moved folder, not just be the moved item itself
        if (currentPath === oldPath || (currentPath && currentPath.startsWith(oldPath + '/'))) {
            const rebased = newPath + currentPath.slice(oldPath.length);
            const moved = findNodeInTree(treeData, rebased);
            loadFile(rebased, moved ? moved.isDir : false, { nav: 'replace' });
        }
        return true;
    } catch (e) {
        console.error('Move failed:', e);
        showToast('Failed to move', 'error');
        return false;
    }
}

function initEventListeners() {
    initLinkNavigation();

    window.addEventListener('popstate', async () => {
        const path = urlPath(window.location.pathname);
        const hash = urlHash();
        // A bfcache restore replays popstate for the entry already on screen; reloading it would discard the restored scroll position
        if (path === currentPath) {
            scrollToAnchor(hash);
            return;
        }
        const node = findNodeInTree(treeData, path);
        await loadFile(path, node ? node.isDir : false, { nav: 'none' });
        scrollToAnchor(hash);
    });

    els.previewBtn.addEventListener('click', () => togglePreview());
    els.themeToggle.addEventListener('click', toggleTheme);
    els.widthToggle.addEventListener('click', () => {
        wideMode = !wideMode;
        localStorage.setItem(WIDE_KEY, String(wideMode));
        applyWideMode();
        lucide.createIcons();
    });
    if (els.printBtn) {
        els.printBtn.addEventListener('click', () => els.printModal.backdrop.classList.remove('hidden'));
        els.printModal.cancel.addEventListener('click', () => els.printModal.backdrop.classList.add('hidden'));
        els.printModal.backdrop.addEventListener('click', (e) => {
            if (e.target === els.printModal.backdrop) els.printModal.backdrop.classList.add('hidden');
        });
        els.printModal.styled100.addEventListener('click', () => runPrint('styled', 1));
        els.printModal.plain100.addEventListener('click', () => runPrint('plain', 1));
        els.printModal.styledScaled.addEventListener('click', () => runPrint('styled', printScale()));
        els.printModal.plainScaled.addEventListener('click', () => runPrint('plain', printScale()));
    }

    els.mobileMenuBtn.addEventListener('click', () => {
        els.sidebar.style.transform = 'translateX(0)';
        els.sidebarOverlay.classList.remove('hidden');
    });
    els.sidebarOverlay.addEventListener('click', () => {
        els.sidebar.style.transform = 'translateX(-100%)';
        els.sidebarOverlay.classList.add('hidden');
    });

    document.getElementById('kairo-home')?.addEventListener('click', () => goHome());
    document.getElementById('kairo-home-mobile')?.addEventListener('click', () => goHome());

    if (window.innerWidth < NARROW_WIDTH && !sidebarCollapsed && tocVisible) {
        tocVisible = false;
        localStorage.setItem('kairo-toc-visible', 'false');
    }

    applySidebarCollapsed();
    els.desktopSidebarToggle.addEventListener('click', () => {
        sidebarCollapsed = !sidebarCollapsed;
        applySidebarCollapsed();
        localStorage.setItem('kairo-sidebar-collapsed', String(sidebarCollapsed));
        if (!sidebarCollapsed) autoHintSidePanels('nav');
    });

    els.tocToggle?.addEventListener('click', () => {
        tocVisible = !tocVisible;
        localStorage.setItem('kairo-toc-visible', String(tocVisible));
        applyTocVisible();
        if (tocVisible) autoHintSidePanels('toc');
    });

    if(els.addFileBtn) {
        els.addFileBtn.addEventListener('click', () => {
            createMode = 'file';
            document.getElementById('create-modal-title').innerHTML = '<i data-lucide="file-plus" class="w-5 h-5"></i> Create New File';
            lucide.createIcons();
            els.createModal.backdrop.classList.remove('hidden');
            els.createModal.input.value = '';
            els.createModal.input.focus();
        });
    }
    if(els.addFolderBtn) {
        els.addFolderBtn.addEventListener('click', () => {
            createMode = 'folder';
            document.getElementById('create-modal-title').innerHTML = '<i data-lucide="folder-plus" class="w-5 h-5"></i> Create New Folder';
            lucide.createIcons();
            els.createModal.backdrop.classList.remove('hidden');
            els.createModal.input.value = '';
            els.createModal.input.focus();
        });
    }
    els.createModal.cancel.addEventListener('click', () => {
        els.createModal.backdrop.classList.add('hidden');
    });

    async function handleCreateConfirm() {
        const val = els.createModal.input.value.trim();
        if (!val) return;

        let path = val;

        try {
            if (createMode === 'folder') {
                const res = await fetch(`${KAIRO_ROUTES}/api/create-dir`, {
                    method: 'POST',
                    headers: writeHeaders,
                    body: JSON.stringify({ path })
                });
                if (!res.ok) return await toastServerError(res, 'Failed to create');
                els.createModal.backdrop.classList.add('hidden');
                await refreshTree();
            } else {
                if(!path.endsWith('.md')) path += '.md';
                const res = await fetch(`${KAIRO_ROUTES}/api/create-file`, {
                    method: 'POST',
                    headers: writeHeaders,
                    body: JSON.stringify({ path, content: '# ' + val.replace(/\.md$/, '') })
                });
                if (!res.ok) return await toastServerError(res, 'Failed to create');
                // Server may suffix the name on collision, so open whatever path it actually created
                const finalPath = await res.text();
                els.createModal.backdrop.classList.add('hidden');
                await refreshTree();
                loadFile(finalPath);
            }
        } catch (e) {
            console.error('Create failed:', e);
            showToast('Failed to create', 'error');
        }
    }

    els.createModal.confirm.addEventListener('click', handleCreateConfirm);
    els.createModal.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleCreateConfirm();
        } else if (e.key === 'Escape') {
            els.createModal.backdrop.classList.add('hidden');
        }
    });

    els.moveBtn.addEventListener('click', () => {
        if (!currentPath) return;
        els.moveModal.current.value = currentPath;
        els.moveModal.new.value = currentPath;
        els.moveModal.backdrop.classList.remove('hidden');
        els.moveModal.new.focus();
        els.moveModal.new.select();
    });
    els.moveModal.cancel.addEventListener('click', () => {
        els.moveModal.backdrop.classList.add('hidden');
    });

    async function handleMoveConfirm() {
        const newPath = els.moveModal.new.value.trim();
        if (!newPath || newPath === currentPath) {
            els.moveModal.backdrop.classList.add('hidden');
            return;
        }
        if (await moveItem(currentPath, newPath)) {
            els.moveModal.backdrop.classList.add('hidden');
        }
    }

    els.moveModal.confirm.addEventListener('click', handleMoveConfirm);
    els.moveModal.new.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleMoveConfirm();
        } else if (e.key === 'Escape') {
            els.moveModal.backdrop.classList.add('hidden');
        }
    });

    els.deleteBtn.addEventListener('click', () => {
        if (!currentPath) return;
        els.deleteModal.path.textContent = currentPath;
        els.deleteModal.backdrop.classList.remove('hidden');
        els.deleteModal.confirm.focus();
    });
    els.deleteModal.cancel.addEventListener('click', () => {
        els.deleteModal.backdrop.classList.add('hidden');
    });

    async function handleDeleteConfirm() {
        if (!currentPath) return;
        // Drop any queued autosave so it cannot recreate the file after deletion
        discardPendingSave(currentPath);
        try {
            const res = await fetch(`${KAIRO_ROUTES}/api/delete`, {
                method: 'POST',
                headers: writeHeaders,
                body: JSON.stringify({ path: currentPath })
            });
            if (!res.ok) throw new Error('delete failed: ' + res.status);
            els.deleteModal.backdrop.classList.add('hidden');
            await refreshTree();
            loadFile('', false, { nav: 'replace' });
        } catch (e) {
            console.error('Delete failed:', e);
            showToast('Failed to delete', 'error');
        }
    }

    els.deleteModal.confirm.addEventListener('click', handleDeleteConfirm);
    els.deleteModal.backdrop.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleDeleteConfirm();
        } else if (e.key === 'Escape') {
            els.deleteModal.backdrop.classList.add('hidden');
        }
    });
}

async function refreshTree() {
    try {
        const res = await fetch(`${KAIRO_ROUTES}/api/tree`);
        if (!res.ok) throw new Error('tree fetch failed: ' + res.status);
        treeData = await res.json();
        els.fileTree.innerHTML = '';
        renderTree(treeData, els.fileTree);
        lucide.createIcons();
    } catch (e) {
        console.error('Failed to refresh tree:', e);
        showToast('Failed to load file tree', 'error');
    }
}

function findNodeInTree(nodes, path) {
    for (const n of nodes) {
        if (n.path === path) return n;
        if (n.children) { const f = findNodeInTree(n.children, path); if (f) return f; }
    }
    return null;
}

function renderTree(nodes, container) {
    nodes.sort((a,b) => (a.isDir === b.isDir) ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1));

    nodes.forEach(node => {
        const div = document.createElement('div');
        div.className = 'pl-3';

        const row = document.createElement('div');
        row.className = 'flex items-center gap-2 py-1 cursor-pointer text-subtext0 hover:text-mauve text-sm truncate group';
        const icon = document.createElement('i');
        icon.setAttribute('data-lucide', node.isDir ? 'folder' : 'file-text');
        icon.className = 'w-4 h-4';
        const name = document.createElement('span');
        name.textContent = node.name;
        row.appendChild(icon);
        row.appendChild(name);

        row.draggable = true;
        row.ondragstart = (e) => {
            e.stopPropagation();
            e.dataTransfer.setData('text/plain', node.path);
            e.dataTransfer.effectAllowed = 'move';
            row.classList.add('opacity-50');
        };
        row.ondragend = (e) => {
            row.classList.remove('opacity-50');
        };

        if (node.isDir) {
            row.ondragover = (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'move';
                row.classList.add('bg-surface0');
            };
            row.ondragleave = (e) => {
                e.stopPropagation();
                row.classList.remove('bg-surface0');
            };
            row.ondrop = async (e) => {
                e.preventDefault();
                e.stopPropagation();
                row.classList.remove('bg-surface0');
                const draggedPath = e.dataTransfer.getData('text/plain');
                if (!draggedPath) return;
                const itemName = draggedPath.split('/').pop();
                await moveItem(draggedPath, node.path ? node.path + '/' + itemName : itemName);
            };
        }

        row.onclick = (e) => {
            e.stopPropagation();
            if (node.isDir) {
                let childDiv = div.querySelector('.children');
                if (!childDiv) {
                    childDiv = document.createElement('div');
                    childDiv.className = 'children border-l border-surface1 ml-2';
                    div.appendChild(childDiv);
                    renderTree(node.children || [], childDiv);
                    lucide.createIcons();
                    expandedFolders.add(node.path);
                } else {
                    const isHidden = childDiv.classList.toggle('hidden');
                    if (isHidden) {
                        expandedFolders.delete(node.path);
                    } else {
                        expandedFolders.add(node.path);
                    }
                }
                saveExpandedFolders();
                // Select the folder so toolbar actions (move/delete) can target it
                loadFile(node.path, true);
            } else {
                loadFile(node.path);
            }
        };

        div.appendChild(row);

        if (node.isDir && expandedFolders.has(node.path)) {
            const childDiv = document.createElement('div');
            childDiv.className = 'children border-l border-surface1 ml-2';
            div.appendChild(childDiv);
            renderTree(node.children || [], childDiv);
        }

        container.appendChild(div);
    });
}

let searchTimer;
let searchRows = [];
let searchSelectedIndex = -1;

function isSearchOpen() {
    return !els.searchModal.backdrop.classList.contains('hidden');
}

function openSearch() {
    els.searchModal.backdrop.classList.remove('hidden');
    els.searchModal.input.value = '';
    renderSearchResults([]);
    els.searchModal.input.focus();
}

function closeSearch() {
    els.searchModal.backdrop.classList.add('hidden');
}

function highlightSearchRow(index) {
    searchRows.forEach((row, i) => row.classList.toggle('bg-surface0', i === index));
    searchSelectedIndex = index;
    if (index >= 0 && searchRows[index]) searchRows[index].scrollIntoView({ block: 'nearest' });
}

function renderSearchResults(results) {
    els.searchModal.results.innerHTML = '';
    searchRows = [];
    searchSelectedIndex = -1;

    results.forEach(r => {
        const row = document.createElement('div');
        row.className = 'px-3 py-2 cursor-pointer hover:bg-surface0';

        const name = document.createElement('div');
        name.className = 'text-subtext1 text-sm font-medium';
        name.textContent = r.name;
        row.appendChild(name);

        const sub = document.createElement('div');
        sub.className = 'text-overlay1 text-xs truncate';
        sub.textContent = r.snippet ? `${r.path} — ${r.snippet}` : r.path;
        row.appendChild(sub);

        row.addEventListener('click', () => {
            closeSearch();
            loadFile(r.path);
        });
        els.searchModal.results.appendChild(row);
        searchRows.push(row);
    });
}

async function runSearch(q) {
    try {
        const res = await fetch(`${KAIRO_ROUTES}/api/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error('search failed: ' + res.status);
        renderSearchResults((await res.json()) || []);
    } catch (e) {
        console.error('Search failed:', e);
        showToast('Search failed', 'error');
    }
}

function initSearch() {
    els.searchBtn.addEventListener('click', openSearch);

    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            openSearch();
        } else if (e.key === 'Escape' && isSearchOpen()) {
            closeSearch();
        }
    });

    els.searchModal.backdrop.addEventListener('click', (e) => {
        if (e.target === els.searchModal.backdrop) closeSearch();
    });

    els.searchModal.input.addEventListener('input', () => {
        clearTimeout(searchTimer);
        const q = els.searchModal.input.value.trim();
        if (q.length < 2) {
            renderSearchResults([]);
            return;
        }
        searchTimer = setTimeout(() => runSearch(q), 150);
    });

    els.searchModal.input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (searchRows.length) highlightSearchRow(Math.min(searchSelectedIndex + 1, searchRows.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (searchRows.length) highlightSearchRow(Math.max(searchSelectedIndex - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const row = searchRows[searchSelectedIndex >= 0 ? searchSelectedIndex : 0];
            if (row) row.click();
        }
    });
}
