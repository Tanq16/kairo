const els = {
    editor: document.getElementById('editor'),
    editorContainer: document.getElementById('editor-container'),
    previewContainer: document.getElementById('preview-container'),
    markdownBody: document.getElementById('markdown-body'),
    tocRail: document.getElementById('toc-rail'),
    tocToggle: document.getElementById('toc-toggle'),
    previewGrid: document.querySelector('#preview-container .preview-grid'),
    fileTree: document.getElementById('file-tree'),
    filenameDisplay: document.getElementById('current-filename'),
    unsavedIndicator: document.getElementById('unsaved-indicator'),
    previewBtn: document.getElementById('preview-btn'),
    printBtn: document.getElementById('print-btn'),
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
    }
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

function encPath(path) {
    if (!path) return '';
    const bytes = new TextEncoder().encode(path);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    // Use URL-safe Base64 without padding to match Go's decoder
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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

function updateBreadcrumbs(path) {
    const container = els.filenameDisplay;
    container.innerHTML = '';
    if (!path) {
        container.innerHTML = '<span class="text-subtext0">Select a note...</span>';
        return;
    }
    const parts = path.split('/');
    parts.forEach((part, i) => {
        if (i > 0) {
            const sep = document.createElement('span');
            sep.className = 'text-overlay1 mx-1';
            sep.textContent = '/';
            container.appendChild(sep);
        }
        const crumb = document.createElement('span');
        const isLast = i === parts.length - 1;
        if (isLast) {
            crumb.className = 'text-subtext1';
            crumb.textContent = part;
        } else {
            crumb.className = 'text-subtext0 hover:text-mauve cursor-pointer';
            crumb.textContent = part;
            const folderPath = parts.slice(0, i + 1).join('/');
            crumb.onclick = () => loadFile(folderPath, true);
        }
        container.appendChild(crumb);
    });
}

function goHome() {
    currentPath = null;
    editorPath = null;
    updateBreadcrumbs(null);
    window.history.replaceState(null, '', '/');
    els.moveBtn.classList.add('hidden');
    els.deleteBtn.classList.add('hidden');
    if (els.printBtn) els.printBtn.classList.add('hidden');
    els.previewBtn.classList.add('hidden');
    els.editorContainer.classList.add('hidden');
    els.previewContainer.classList.add('hidden');
    hideToc();
    refreshTree();
}

document.addEventListener('DOMContentLoaded', async () => {
    lucide.createIcons();
    initMarked();
    initEditor();
    initUploadHandlers();
    initEventListeners();
    initSidebarResize();
    initSearch();
    await refreshTree();

    const urlParams = new URLSearchParams(window.location.search);
    const encInitPath = urlParams.get('path');
    if (encInitPath) {
        const initPath = decPath(encInitPath);
        if (initPath) {
            const node = findNodeInTree(treeData, initPath);
            loadFile(initPath, node ? node.isDir : false);
        }
    }

    els.fileTree.ondragover = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        els.fileTree.classList.add('bg-crust/50');
    };
    els.fileTree.ondragleave = (e) => {
        els.fileTree.classList.remove('bg-crust/50');
    };
    els.fileTree.ondrop = async (e) => {
        e.preventDefault();
        els.fileTree.classList.remove('bg-crust/50');
        const draggedPath = e.dataTransfer.getData('text/plain');
        if (!draggedPath) return;
        await moveItem(draggedPath, draggedPath.split('/').pop());
    };
});

async function loadFile(path, isDir = false) {
    // Persist the previous file before the fetch below, so a switch can't load stale content over an in-flight save
    await flushPendingSave();

    const thisLoad = ++loadVersion;
    currentPath = path;
    // Null while the editor still holds the previous note, so its doc can't autosave under the new path
    editorPath = null;
    updateBreadcrumbs(path);
    window.history.replaceState(null, '', path ? `?path=${encPath(path)}` : '/');

    els.moveBtn.classList.toggle('hidden', !path);
    els.deleteBtn.classList.toggle('hidden', !path);
    if (els.printBtn) els.printBtn.classList.toggle('hidden', !path || isDir);

    if (isDir) {
        els.editorContainer.classList.add('hidden');
        els.previewContainer.classList.remove('hidden');
        els.previewBtn.classList.add('hidden');
        previewMode = true;
        hideToc();
        renderDirListing(path);
        return;
    }

    if (!path) {
        els.editorContainer.classList.add('hidden');
        els.previewContainer.classList.add('hidden');
        els.previewBtn.classList.add('hidden');
        return;
    }

    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
    if (imageExts.some(ext => path.toLowerCase().endsWith(ext))) {
        els.editorContainer.classList.add('hidden');
        els.previewContainer.classList.remove('hidden');
        els.previewBtn.classList.add('hidden');
        previewMode = true;
        hideToc();
        els.markdownBody.innerHTML = `<img src="/api/file?path=${encPath(path)}" alt="${escapeHtml(path.split('/').pop())}" style="max-width:100%; border-radius:0.5rem;">`;
        return;
    }

    try {
        const res = await fetch(`/api/file?path=${encPath(path)}`);
        if (thisLoad !== loadVersion) return;
        if (!res.ok) throw new Error('Failed to load');
        const content = await res.text();
        if (thisLoad !== loadVersion) return;

        // Suppress autosave for the programmatic load; finally resets the flag even if dispatch throws
        editorLoading = true;
        try {
            view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: content }
            });
        } finally {
            editorLoading = false;
        }
        editorPath = path;
        els.previewBtn.classList.remove('hidden');
        // Keep the badge if the outgoing file still has a queued or failed save
        updateUnsavedIndicator();

        els.markdownBody.innerHTML = DOMPurify.sanitize(marked.parse(content));
        fixImagePaths();

        addCopyButtons();
        if (typeof mermaid !== 'undefined') {
            mermaid.initialize(mermaidConfig);
            mermaid.run({ nodes: els.markdownBody.querySelectorAll('.mermaid') });
        }
        lucide.createIcons();

        togglePreview(true);
    } catch(e) {
        if (thisLoad !== loadVersion) return;
        console.error(e);
        els.markdownBody.innerHTML = `<p style="color:#f38ba8">Error loading file</p>`;
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
        a.href = `?path=${encPath(c.path)}${c.isDir ? '&dir=1' : ''}`;
        a.textContent = c.name;
        a.addEventListener('click', e => {
            e.preventDefault();
            loadFile(c.path, c.isDir);
        });
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
        if (active && !els.tocRail.classList.contains('hidden')) keepTocLinkInView(active);
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
    els.tocRail.classList.add('hidden');
    els.previewGrid?.classList.add('toc-hidden');
    els.tocToggle?.classList.add('hidden');
}

function applyTocVisible() {
    const show = els.tocRail.children.length > 0 && tocVisible;
    els.tocRail.classList.toggle('hidden', !show);
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
        const res = await fetch('/api/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: encPath(oldPath), newPath: encPath(newPath) })
        });
        if (!res.ok) {
            showToast(res.status === 409 ? 'Destination already exists' : 'Failed to move', 'error');
            return false;
        }
        rebasePendingSaves(oldPath, newPath);
        await refreshTree();
        // The open note may live inside the moved folder, not just be the moved item itself
        if (currentPath === oldPath || (currentPath && currentPath.startsWith(oldPath + '/'))) {
            const rebased = newPath + currentPath.slice(oldPath.length);
            const moved = findNodeInTree(treeData, rebased);
            loadFile(rebased, moved ? moved.isDir : false);
        }
        return true;
    } catch (e) {
        console.error('Move failed:', e);
        showToast('Failed to move', 'error');
        return false;
    }
}

function initEventListeners() {
    els.previewBtn.addEventListener('click', () => togglePreview());
    if (els.printBtn) {
        els.printBtn.addEventListener('click', () => {
            if (!previewMode) togglePreview(true);
            // Browsers seed the Save-as-PDF filename from document.title
            const originalTitle = document.title;
            if (currentPath) document.title = currentPath.split('/').pop();
            buildPrintPages();
            window.addEventListener('afterprint', () => {
                document.title = originalTitle;
                clearPrintPages();
            }, { once: true });
            setTimeout(() => window.print(), 100);
        });
    }

    els.mobileMenuBtn.addEventListener('click', () => {
        els.sidebar.style.transform = 'translateX(0)';
        els.sidebarOverlay.classList.remove('hidden');
    });
    els.sidebarOverlay.addEventListener('click', () => {
        els.sidebar.style.transform = 'translateX(-100%)';
        els.sidebarOverlay.classList.add('hidden');
    });

    document.getElementById('kairo-home')?.addEventListener('click', goHome);
    document.getElementById('kairo-home-mobile')?.addEventListener('click', goHome);

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
                const res = await fetch('/api/create-dir', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: encPath(path) })
                });
                if (!res.ok) throw new Error('create failed: ' + res.status);
                els.createModal.backdrop.classList.add('hidden');
                await refreshTree();
            } else {
                if(!path.endsWith('.md')) path += '.md';
                const res = await fetch('/api/create-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: encPath(path), content: '# ' + val.replace(/\.md$/, '') })
                });
                if (!res.ok) throw new Error('create failed: ' + res.status);
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
            const res = await fetch('/api/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: encPath(currentPath) })
            });
            if (!res.ok) throw new Error('delete failed: ' + res.status);
            els.deleteModal.backdrop.classList.add('hidden');
            await refreshTree();
            loadFile('');
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
        const res = await fetch('/api/tree');
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
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
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
