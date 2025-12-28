// --- Configuration ---
const els = {
    editor: document.getElementById('editor'),
    editorContainer: document.getElementById('editor-container'),
    previewContainer: document.getElementById('preview-container'),
    markdownBody: document.getElementById('markdown-body'),
    fileTree: document.getElementById('file-tree'),
    filenameDisplay: document.getElementById('current-filename'),
    unsavedIndicator: document.getElementById('unsaved-indicator'),
    toggleViewBtn: document.getElementById('toggle-view-btn'),
    tocNav: document.getElementById('toc-nav'),
    tocSidebar: document.getElementById('toc-sidebar'),
    sidebar: document.getElementById('sidebar'),
    sidebarOverlay: document.getElementById('sidebar-overlay'),
    mobileMenuBtn: document.getElementById('mobile-menu-btn'),
    modal: {
        backdrop: document.getElementById('modal-backdrop'),
        input: document.getElementById('new-item-input'),
        confirm: document.getElementById('modal-confirm'),
        cancel: document.getElementById('modal-cancel')
    }
};

let jar;
let currentPath = null;
let unsaved = false;
let tocHeaders = [];

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    lucide.createIcons();
    initMarked();
    initEditor();
    initEventListeners();
    await refreshTree();

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('path')) loadFile(urlParams.get('path'));
});

// --- BLOG RENDERING LOGIC (Ported from common.js) ---
function generateId(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
}

function initMarked() {
    const renderer = {
        code(token) {
            const text = token.text;
            const language = token.lang;
            if (language === 'mermaid') {
                return `<div class="overflow-x-auto my-6"><div class="mermaid">${text}</div></div>`;
            }
            const validLang = hljs.getLanguage(language) ? language : 'plaintext';
            let highlighted = text;
            try { highlighted = hljs.highlight(text, { language: validLang }).value; } catch (e) {}
            return `<pre><code class="hljs language-${validLang}">${highlighted}</code></pre>`;
        },
        heading(token) {
            const { tokens, depth } = token;
            const text = this.parser.parseInline(tokens);
            const slug = generateId(text.replace(/<[^>]*>/g, ''));
            // Only push to TOC if rendering file (not folder view)
            if (depth > 1) tocHeaders.push({ text: text.replace(/<[^>]*>/g, ''), level: depth, slug });
            return `<h${depth} id="${slug}">${text}</h${depth}>`;
        },
        blockquote(token) {
            const body = this.parser.parse(token.tokens);
            const rawText = token.text;
            const match = rawText.match(/^\[!(TIP|NOTE|INFO|WARNING|DANGER)\]/i);
            if (match) {
                const type = match[1].toLowerCase();
                const iconMap = { tip: 'lightbulb', info: 'circle-info', danger: 'triangle-exclamation', warning: 'circle-exclamation', note: 'note-sticky' };
                const cleanBody = body.replace(/<p>\s*\[!(TIP|NOTE|INFO|WARNING|DANGER)\]\s*/i, '<p>');
                return `<div class="callout ${type}"><div class="callout-icon"><i class="fa-solid fa-${iconMap[type] || 'circle-info'}"></i></div><div class="callout-content">${cleanBody}</div></div>`;
            }
            return `<blockquote>${body}</blockquote>`;
        }
    };
    marked.use({ renderer });
}

function renderTOC() {
    if (tocHeaders.length === 0) {
        els.tocSidebar.style.opacity = '0';
        return;
    }
    els.tocNav.innerHTML = tocHeaders.map(h => {
        const padding = h.level === 3 ? 'pl-6' : 'pl-3';
        return `<a href="#${h.slug}" class="toc-link block py-1 ${padding} text-sm text-subtext1 hover:text-mauve hover:bg-surface0/50 border-l-2 border-transparent transition-all" data-target="${h.slug}">${h.text}</a>`
    }).join('');
    els.tocSidebar.style.opacity = '1';
    
    // Intersection Observer for TOC
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(e => {
            if (e.isIntersecting) {
                document.querySelectorAll('.toc-link').forEach(l => {
                    l.classList.remove('active');
                    if(l.dataset.target === e.target.id) l.classList.add('active');
                });
            }
        });
    }, { rootMargin: '-20% 0px -60% 0px' });
    document.querySelectorAll('h2[id], h3[id]').forEach(h => observer.observe(h));
}

function addCopyButtons() {
    // Ported EXACTLY from blog
    const codeBlocks = document.querySelectorAll('pre:has(code):not(:has(.mermaid))');
    codeBlocks.forEach(block => {
        if (block.querySelector('.copy-code-btn')) return;
        block.style.position = 'relative';
        const button = document.createElement('button');
        button.className = 'copy-code-btn';
        button.innerHTML = '<i data-lucide="copy" class="w-4 h-4"></i>';
        button.addEventListener('click', async (e) => {
            e.preventDefault();
            const code = block.querySelector('code').textContent;
            await navigator.clipboard.writeText(code);
            button.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i>';
            button.classList.add('copied');
            lucide.createIcons();
            setTimeout(() => {
                button.innerHTML = '<i data-lucide="copy" class="w-4 h-4"></i>';
                button.classList.remove('copied');
                lucide.createIcons();
            }, 2000);
        });
        block.appendChild(button);
    });
    lucide.createIcons();
}

// --- APP LOGIC ---

async function loadFile(path, isDir = false) {
    currentPath = path;
    tocHeaders = []; // Reset TOC
    els.filenameDisplay.textContent = path;
    window.history.replaceState(null, '', `?path=${path}`);

    if (isDir) {
        // Folder Listing
        els.tocSidebar.style.opacity = '0';
        els.editorContainer.classList.add('hidden');
        els.previewContainer.classList.remove('hidden');
        
        // Fetch tree to find children
        const findNode = (nodes) => {
            for (const n of nodes) {
                if (n.path === path) return n;
                if (n.children) { const f = findNode(n.children); if (f) return f; }
            }
            return null;
        };
        const node = await findNode(await (await fetch('/api/tree')).json());
        
        let md = `# ${path.split('/').pop() || 'Root'}\n\n`;
        if (node && node.children) {
            node.children.forEach(c => {
                // Lucide icon markup for markdown link (simulated)
                md += `- [${c.name}](?path=${c.path})\n`;
            });
        }
        els.markdownBody.innerHTML = marked.parse(md);
        
        // Hijack links to stay in SPA
        els.markdownBody.querySelectorAll('a').forEach(a => {
            a.addEventListener('click', e => {
                e.preventDefault();
                const p = new URL(a.href).searchParams.get('path');
                if(p) loadFile(p);
            });
        });
        return;
    }

    // File Loading
    try {
        const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
        if (!res.ok) throw new Error('Failed to load');
        const content = await res.text();
        
        // Set Editor
        if(jar) jar.updateCode(content);
        
        // Render
        els.markdownBody.innerHTML = marked.parse(content);
        
        // Post-Render Hooks (Blog Logic)
        renderTOC();
        addCopyButtons();
        if (typeof mermaid !== 'undefined') {
            mermaid.initialize({ startOnLoad: false, theme: 'dark', fontFamily: 'Inter' });
            mermaid.run({ nodes: els.markdownBody.querySelectorAll('.mermaid') });
        }
        lucide.createIcons();

        // Default to Preview
        toggleView(true);
    } catch(e) {
        console.error(e);
        els.markdownBody.innerHTML = `<p style="color:#f38ba8">Error loading file</p>`;
    }
}

// --- EDITOR & UI ---

function initEditor() {
    // Simple highlight for editor (Edit Mode)
    jar = CodeJar(els.editor, (editor) => {
        editor.textContent = editor.textContent;
        hljs.highlightElement(editor);
    });
    jar.onUpdate(code => {
        unsaved = true;
        els.unsavedIndicator.classList.remove('hidden');
        // Auto-save logic could go here
        debounceSave(code);
    });
}

let saveTimer;
function debounceSave(content) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        if (!currentPath) return;
        await fetch('/api/save', {
            method: 'POST',
            body: JSON.stringify({ path: currentPath, content: content })
        });
        unsaved = false;
        els.unsavedIndicator.classList.add('hidden');
        // Re-render if in preview mode? No, better to wait for switch.
    }, 1000);
}

function toggleView(forcePreview) {
    const isPreview = forcePreview !== undefined ? forcePreview : els.editorContainer.classList.contains('hidden');
    
    if (isPreview) {
        // Switch to Edit
        els.editorContainer.classList.remove('hidden');
        els.previewContainer.classList.add('hidden');
        els.tocSidebar.style.opacity = '0';
    } else {
        // Switch to Preview
        // Update content from editor first
        const code = jar.toString();
        els.markdownBody.innerHTML = marked.parse(code);
        renderTOC();
        addCopyButtons();
        mermaid.run({ nodes: els.markdownBody.querySelectorAll('.mermaid') });
        lucide.createIcons();
        
        els.editorContainer.classList.add('hidden');
        els.previewContainer.classList.remove('hidden');
    }
}

function initEventListeners() {
    els.toggleViewBtn.addEventListener('click', () => toggleView());
    
    // Sidebar
    els.mobileMenuBtn.addEventListener('click', () => {
        els.sidebar.style.transform = 'translateX(0)';
        els.sidebarOverlay.classList.remove('hidden');
    });
    els.sidebarOverlay.addEventListener('click', () => {
        els.sidebar.style.transform = 'translateX(-100%)';
        els.sidebarOverlay.classList.add('hidden');
    });

    // Modals
    els.modal.cancel.addEventListener('click', () => els.modal.backdrop.classList.add('hidden'));
    document.getElementById('add-btn').addEventListener('click', () => {
        els.modal.backdrop.classList.remove('hidden');
        els.modal.input.focus();
    });
    els.modal.confirm.addEventListener('click', async () => {
        const val = els.modal.input.value;
        if (!val) return;
        
        let path = currentPath ? (currentPath.endsWith('.md') ? currentPath.split('/').slice(0,-1).join('/') : currentPath) : '';
        if (path) path += '/';
        path += val;

        if (val.endsWith('/')) {
            await fetch('/api/create-dir', { method: 'POST', body: JSON.stringify({ path: path.slice(0, -1) }) });
        } else {
            if(!path.endsWith('.md')) path += '.md';
            await fetch('/api/save', { method: 'POST', body: JSON.stringify({ path, content: '# ' + val }) });
        }
        els.modal.backdrop.classList.add('hidden');
        refreshTree();
    });

    // Delete
    document.getElementById('delete-btn').addEventListener('click', async () => {
        if(confirm('Delete ' + currentPath + '?')) {
            await fetch('/api/delete', { method: 'POST', body: JSON.stringify({ path: currentPath }) });
            refreshTree();
            loadFile(''); // Reset
        }
    });
    
    // Image Paste
    document.addEventListener('paste', async (e) => {
        if (!currentPath || els.editorContainer.classList.contains('hidden')) return;
        const items = (e.clipboardData).items;
        for (const item of items) {
            if (item.type.startsWith('image')) {
                const formData = new FormData();
                formData.append('file', item.getAsFile());
                formData.append('notePath', currentPath);
                const res = await fetch('/api/upload', { method: 'POST', body: formData });
                const relPath = await res.text();
                jar.updateCode(jar.toString() + `\n![Attachment](${relPath})`);
            }
        }
    });
}

// --- FILE TREE ---
async function refreshTree() {
    const data = await (await fetch('/api/tree')).json();
    els.fileTree.innerHTML = '';
    renderTree(data, els.fileTree);
    lucide.createIcons();
}

function renderTree(nodes, container) {
    nodes.sort((a,b) => (a.isDir === b.isDir) ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1));
    
    nodes.forEach(node => {
        const div = document.createElement('div');
        div.className = 'pl-3';
        
        const row = document.createElement('div');
        row.className = 'flex items-center gap-2 py-1 cursor-pointer text-subtext0 hover:text-mauve text-sm truncate';
        // Icon logic: Lucide only
        const iconName = node.isDir ? 'folder' : 'file';
        row.innerHTML = `<i data-lucide="${iconName}" class="w-4 h-4"></i> <span>${node.name}</span>`;
        
        row.onclick = (e) => {
            e.stopPropagation();
            if (node.isDir) {
                // Toggle children
                let childDiv = div.querySelector('.children');
                if (!childDiv) {
                    childDiv = document.createElement('div');
                    childDiv.className = 'children border-l border-surface1 ml-2';
                    div.appendChild(childDiv);
                    renderTree(node.children || [], childDiv);
                    lucide.createIcons();
                } else {
                    childDiv.classList.toggle('hidden');
                }
                loadFile(node.path, true);
            } else {
                loadFile(node.path);
            }
        };
        
        // Drag Drop (Simplified)
        row.draggable = true;
        row.ondragstart = e => e.dataTransfer.setData('text/plain', node.path);
        row.ondragover = e => e.preventDefault();
        row.ondrop = async e => {
            e.preventDefault();
            const src = e.dataTransfer.getData('text/plain');
            if (src !== node.path) {
                // Determine target dir
                const dest = node.isDir ? node.path + '/' + src.split('/').pop() : node.path.split('/').slice(0,-1).join('/') + '/' + src.split('/').pop();
                if(confirm(`Move ${src} to ${dest}?`)) {
                    await fetch('/api/move', { method: 'POST', body: JSON.stringify({ path: src, newPath: dest }) });
                    refreshTree();
                }
            }
        };

        div.appendChild(row);
        container.appendChild(div);
    });
}
