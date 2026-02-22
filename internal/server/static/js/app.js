// --- Configuration ---
const els = {
    editor: document.getElementById('editor'),
    editorContainer: document.getElementById('editor-container'),
    previewContainer: document.getElementById('preview-container'),
    markdownBody: document.getElementById('markdown-body'),
    fileTree: document.getElementById('file-tree'),
    filenameDisplay: document.getElementById('current-filename'),
    unsavedIndicator: document.getElementById('unsaved-indicator'),
    previewBtn: document.getElementById('preview-btn'),
    sidebar: document.getElementById('sidebar'),
    sidebarOverlay: document.getElementById('sidebar-overlay'),
    mobileMenuBtn: document.getElementById('mobile-menu-btn'),
    desktopSidebarToggle: document.getElementById('desktop-sidebar-toggle'),
    addBtn: document.getElementById('add-btn'),
    moveBtn: document.getElementById('move-btn'),
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

let view;
let currentPath = null;
let unsaved = false;
let previewMode = false;
let sidebarCollapsed = false;
let loadVersion = 0;

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

// --- Markdown Rendering ---
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
            return `<h${depth} id="${slug}">${text}</h${depth}>`;
        },
        image(token) {
            const alt = token.text || '';
            return `<img src="${token.href}" alt="${alt}" style="max-width:100%; border-radius:0.5rem;">`;
        },
        blockquote(token) {
            const body = this.parser.parse(token.tokens);
            const rawText = token.text;
            const match = rawText.match(/^\[!(TIP|NOTE|INFO|WARNING|DANGER)\]/i);
            if (match) {
                const type = match[1].toLowerCase();
                const iconMap = { 
                    tip: 'lightbulb', 
                    info: 'info', 
                    danger: 'triangle-alert', 
                    warning: 'alert-triangle', 
                    note: 'sticky-note' 
                };
                const cleanBody = body.replace(/<p>\s*\[!(TIP|NOTE|INFO|WARNING|DANGER)\]\s*/i, '<p>');
                return `<div class="callout ${type}"><div class="callout-icon"><i data-lucide="${iconMap[type] || 'info'}"></i></div><div class="callout-content">${cleanBody}</div></div>`;
            }
            return `<blockquote>${body}</blockquote>`;
        }
    };
    marked.use({ renderer });
}

function addCopyButtons() {
    const codeBlocks = els.markdownBody.querySelectorAll('pre');
    codeBlocks.forEach(block => {
        // Skip if already has button or is a mermaid block
        if (block.querySelector('.copy-code-btn')) return;
        if (block.querySelector('.mermaid')) return;
        
        const codeEl = block.querySelector('code');
        if (!codeEl) return;
        
        block.style.position = 'relative';
        const button = document.createElement('button');
        button.className = 'copy-code-btn';
        button.type = 'button';
        button.innerHTML = '<i data-lucide="copy" class="w-4 h-4"></i>';
        
        button.onclick = async function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            try {
                const code = codeEl.textContent;
                await navigator.clipboard.writeText(code);
                button.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i>';
                button.classList.add('copied');
                lucide.createIcons({ nodes: [button] });
                
                setTimeout(() => {
                    button.innerHTML = '<i data-lucide="copy" class="w-4 h-4"></i>';
                    button.classList.remove('copied');
                    lucide.createIcons({ nodes: [button] });
                }, 2000);
            } catch (err) {
                console.error('Copy failed:', err);
                // Fallback for non-secure contexts
                const textarea = document.createElement('textarea');
                textarea.value = codeEl.textContent;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
                
                button.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i>';
                button.classList.add('copied');
                lucide.createIcons({ nodes: [button] });
                
                setTimeout(() => {
                    button.innerHTML = '<i data-lucide="copy" class="w-4 h-4"></i>';
                    button.classList.remove('copied');
                    lucide.createIcons({ nodes: [button] });
                }, 2000);
            }
        };
        
        block.appendChild(button);
    });
    lucide.createIcons();
}

// --- Editor with CodeMirror 6 ---
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

    // Catppuccin Mocha theme
    const catppuccinTheme = EditorView.theme({
        '&': {
            backgroundColor: '#1e1e2e',
            color: '#cdd6f4',
        },
        '.cm-cursor, .cm-dropCursor': {
            borderLeftColor: '#cdd6f4',
        },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
            backgroundColor: '#45475a',
        },
        '.cm-activeLine': {
            backgroundColor: 'rgba(49, 50, 68, 0.3)',
        },
        '.cm-matchingBracket': {
            backgroundColor: 'rgba(137, 180, 250, 0.2)',
            color: '#89b4fa',
        },
    }, { dark: true });

    // Syntax highlighting colors
    const catppuccinHighlight = HighlightStyle.define([
        { tag: tags.heading1, color: '#b4befe', fontWeight: 'bold' },
        { tag: tags.heading2, color: '#cba6f7', fontWeight: 'bold' },
        { tag: tags.heading3, color: '#89b4fa', fontWeight: 'bold' },
        { tag: [tags.heading4, tags.heading5, tags.heading6], color: '#cdd6f4', fontWeight: 'bold' },
        { tag: tags.emphasis, color: '#f9e2af', fontStyle: 'italic' },
        { tag: tags.strong, color: '#f9e2af', fontWeight: 'bold' },
        { tag: tags.strikethrough, color: '#7f849c', textDecoration: 'line-through' },
        { tag: tags.link, color: '#89b4fa', textDecoration: 'underline' },
        { tag: tags.url, color: '#89b4fa' },
        { tag: [tags.processingInstruction, tags.monospace], color: '#fab387' },
        { tag: tags.quote, color: '#a6adc8', fontStyle: 'italic' },
        { tag: tags.list, color: '#a6e3a1' },
        { tag: tags.contentSeparator, color: '#45475a' },
        { tag: tags.meta, color: '#7f849c' },
        { tag: tags.labelName, color: '#89b4fa' },
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
            if (update.docChanged) {
                unsaved = true;
                els.unsavedIndicator.classList.remove('hidden');
                debounceSave(update.state.doc.toString());
            }
        }),
    ];

    view = new EditorView({
        doc: '',
        extensions,
        parent: els.editor,
    });
}

let saveTimer;
function debounceSave(content) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        if (!currentPath) return;
        try {
            await fetch('/api/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: currentPath, content: content })
            });
            unsaved = false;
            els.unsavedIndicator.classList.add('hidden');
        } catch (e) {
            console.error('Save failed:', e);
        }
    }, 1000);
}

// --- File Operations ---
async function loadFile(path, isDir = false) {
    const thisLoad = ++loadVersion;
    currentPath = path;
    els.filenameDisplay.textContent = path || 'Select a note...';
    window.history.replaceState(null, '', path ? `?path=${path}` : '/');

    // Show/hide move button
    els.moveBtn.classList.toggle('hidden', !path);

    if (isDir) {
        els.editorContainer.classList.add('hidden');
        els.previewContainer.classList.remove('hidden');
        previewMode = true;

        const findNode = (nodes) => {
            for (const n of nodes) {
                if (n.path === path) return n;
                if (n.children) { const f = findNode(n.children); if (f) return f; }
            }
            return null;
        };
        const node = await findNode(await (await fetch('/api/tree')).json());
        if (thisLoad !== loadVersion) return;

        let md = `# ${path.split('/').pop() || 'Root'}\n\n`;
        if (node && node.children) {
            node.children.forEach(c => {
                md += `- [${c.name}](?path=${c.path})\n`;
            });
        }
        els.markdownBody.innerHTML = marked.parse(md);

        els.markdownBody.querySelectorAll('a').forEach(a => {
            a.addEventListener('click', e => {
                e.preventDefault();
                const p = new URL(a.href).searchParams.get('path');
                if(p) loadFile(p);
            });
        });
        return;
    }

    if (!path) {
        els.editorContainer.classList.add('hidden');
        els.previewContainer.classList.add('hidden');
        return;
    }

    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
    if (imageExts.some(ext => path.toLowerCase().endsWith(ext))) {
        els.editorContainer.classList.add('hidden');
        els.previewContainer.classList.remove('hidden');
        previewMode = true;
        els.markdownBody.innerHTML = `<img src="/data/${path}" alt="${path.split('/').pop()}" style="max-width:100%; border-radius:0.5rem;">`;
        els.previewBtn.innerHTML = '<i data-lucide="eye" class="w-4 h-4"></i><span>Preview</span>';
        lucide.createIcons();
        return;
    }

    try {
        const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
        if (thisLoad !== loadVersion) return;
        if (!res.ok) throw new Error('Failed to load');
        const content = await res.text();

        view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: content }
        });
        els.markdownBody.innerHTML = marked.parse(content);

        addCopyButtons();
        if (typeof mermaid !== 'undefined') {
            mermaid.initialize({ startOnLoad: false, theme: 'dark', fontFamily: 'Inter' });
            mermaid.run({ nodes: els.markdownBody.querySelectorAll('.mermaid') });
        }
        lucide.createIcons();

        // Default to preview mode
        togglePreview(true);
    } catch(e) {
        if (thisLoad !== loadVersion) return;
        console.error(e);
        els.markdownBody.innerHTML = `<p style="color:#f38ba8">Error loading file</p>`;
    }
}

function togglePreview(force = null) {
    previewMode = force !== null ? force : !previewMode;
    
    if (previewMode) {
        // Update preview from editor
        const code = view.state.doc.toString();
        els.markdownBody.innerHTML = marked.parse(code);
        addCopyButtons();
        if (typeof mermaid !== 'undefined') {
            mermaid.run({ nodes: els.markdownBody.querySelectorAll('.mermaid') });
        }
        lucide.createIcons();
        
        els.editorContainer.classList.add('hidden');
        els.previewContainer.classList.remove('hidden');
        els.previewBtn.innerHTML = '<i data-lucide="edit" class="w-4 h-4"></i><span>Edit</span>';
    } else {
        els.editorContainer.classList.remove('hidden');
        els.previewContainer.classList.add('hidden');
        els.previewBtn.innerHTML = '<i data-lucide="eye" class="w-4 h-4"></i><span>Preview</span>';
    }
    lucide.createIcons();
}

// --- Event Listeners ---
function initEventListeners() {
    els.previewBtn.addEventListener('click', () => togglePreview());
    
    // Sidebar toggles
    els.mobileMenuBtn.addEventListener('click', () => {
        els.sidebar.style.transform = 'translateX(0)';
        els.sidebarOverlay.classList.remove('hidden');
    });
    els.sidebarOverlay.addEventListener('click', () => {
        els.sidebar.style.transform = 'translateX(-100%)';
        els.sidebarOverlay.classList.add('hidden');
    });
    
    // Desktop sidebar toggle
    els.desktopSidebarToggle.addEventListener('click', () => {
        sidebarCollapsed = !sidebarCollapsed;
        if (sidebarCollapsed) {
            els.sidebar.classList.add('collapsed');
            els.desktopSidebarToggle.classList.add('sidebar-collapsed');
        } else {
            els.sidebar.classList.remove('collapsed');
            els.desktopSidebarToggle.classList.remove('sidebar-collapsed');
        }
    });

    // Create Modal
    els.addBtn.addEventListener('click', () => {
        els.createModal.backdrop.classList.remove('hidden');
        els.createModal.input.value = '';
        els.createModal.input.focus();
    });
    els.createModal.cancel.addEventListener('click', () => {
        els.createModal.backdrop.classList.add('hidden');
    });
    
    async function handleCreateConfirm() {
        const val = els.createModal.input.value.trim();
        if (!val) return;
        
        let path = currentPath ? (currentPath.endsWith('.md') ? currentPath.split('/').slice(0,-1).join('/') : currentPath) : '';
        if (path) path += '/';
        path += val;

        try {
            if (val.endsWith('/')) {
                await fetch('/api/create-dir', { 
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: path.slice(0, -1) }) 
                });
            } else {
                if(!path.endsWith('.md')) path += '.md';
                await fetch('/api/save', { 
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path, content: '# ' + val.replace('.md', '') }) 
                });
            }
            els.createModal.backdrop.classList.add('hidden');
            await refreshTree();
            if (!val.endsWith('/')) loadFile(path);
        } catch (e) {
            console.error('Create failed:', e);
            alert('Failed to create: ' + e.message);
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

    // Move Modal
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
        
        try {
            await fetch('/api/move', { 
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: currentPath, newPath: newPath }) 
            });
            els.moveModal.backdrop.classList.add('hidden');
            await refreshTree();
            loadFile(newPath);
        } catch (e) {
            console.error('Move failed:', e);
            alert('Failed to move: ' + e.message);
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

    // Delete Modal
    document.getElementById('delete-btn').addEventListener('click', () => {
        if (!currentPath) return;
        els.deleteModal.path.textContent = currentPath;
        els.deleteModal.backdrop.classList.remove('hidden');
        els.deleteModal.confirm.focus();
    });
    els.deleteModal.cancel.addEventListener('click', () => {
        els.deleteModal.backdrop.classList.add('hidden');
    });
    
    async function handleDeleteConfirm() {
        try {
            await fetch('/api/delete', { 
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: currentPath }) 
            });
            els.deleteModal.backdrop.classList.add('hidden');
            await refreshTree();
            loadFile('');
        } catch (e) {
            console.error('Delete failed:', e);
            alert('Failed to delete: ' + e.message);
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
    
    // Image Paste
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

    // Image Drag & Drop
    els.editorContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
    });
    els.editorContainer.addEventListener('drop', async (e) => {
        if (!currentPath || previewMode) return;
        const files = e.dataTransfer.files;
        for (const file of files) {
            if (file.type.startsWith('image/')) {
                e.preventDefault();
                await uploadAndInsertImage(file);
            }
        }
    });
}

async function uploadAndInsertImage(file) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('notePath', currentPath);
    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const imgPath = await res.text();
        const insertText = `\n![Attachment](${imgPath})\n`;
        view.dispatch({
            changes: { from: view.state.doc.length, insert: insertText }
        });
        await refreshTree();
    } catch (e) {
        console.error('Upload failed:', e);
    }
}

// --- File Tree ---
async function refreshTree() {
    try {
        const data = await (await fetch('/api/tree')).json();
        els.fileTree.innerHTML = '';
        renderTree(data, els.fileTree);
        lucide.createIcons();
    } catch (e) {
        console.error('Failed to refresh tree:', e);
    }
}

function renderTree(nodes, container) {
    nodes.sort((a,b) => (a.isDir === b.isDir) ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1));
    
    nodes.forEach(node => {
        const div = document.createElement('div');
        div.className = 'pl-3';
        
        const row = document.createElement('div');
        row.className = 'flex items-center gap-2 py-1 cursor-pointer text-subtext0 hover:text-mauve text-sm truncate group';
        const iconName = node.isDir ? 'folder' : 'file-text';
        row.innerHTML = `<i data-lucide="${iconName}" class="w-4 h-4"></i> <span>${node.name}</span>`;
        
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
                } else {
                    childDiv.classList.toggle('hidden');
                }
                loadFile(node.path, true);
            } else {
                loadFile(node.path);
            }
        };
        
        div.appendChild(row);
        container.appendChild(div);
    });
}
