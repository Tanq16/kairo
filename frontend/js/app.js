// Kairō Application Logic

// --- State ---
const state = {
    currentPath: null,
    currentContent: '',
    isDir: false,
    previewMode: true,
    tree: [],
    unsaved: false,
    saveTimeout: null,
    expandedFolders: new Set()
};

// --- DOM Elements ---
const els = {
    editor: document.getElementById('editor'),
    editorContainer: document.getElementById('editor-container'),
    previewContainer: document.getElementById('preview-container'),
    markdownBody: document.getElementById('markdown-body'),
    fileTree: document.getElementById('file-tree'),
    filenameDisplay: document.getElementById('current-filename'),
    unsavedIndicators: [document.getElementById('unsaved-indicator'), document.getElementById('unsaved-indicator-mobile')],
    toggleViewBtn: document.getElementById('toggle-view-btn'),
    deleteBtn: document.getElementById('delete-btn'),
    addBtn: document.getElementById('add-btn'),
    emptyState: document.getElementById('empty-state'),
    tocNav: document.getElementById('toc-nav'),
    tocSidebar: document.getElementById('toc-sidebar'),
    sidebar: document.getElementById('sidebar'),
    sidebarOverlay: document.getElementById('sidebar-overlay'),
    mobileMenuBtn: document.getElementById('mobile-menu-btn')
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    lucide.createIcons();
    await fetchTree();
    initEditor();
    initEventListeners();
    
    // Auto-restore view if URL has path
    const urlParams = new URLSearchParams(window.location.search);
    const path = urlParams.get('path');
    if (path) loadNote(path);
});

// --- Editor Setup (CodeJar) ---
let jar;
function initEditor() {
    const highlight = (editor) => {
        // Simple markdown highlight using highlight.js
        editor.textContent = editor.textContent;
        hljs.highlightElement(editor);
    };
    
    // Wait for CodeJar to load
    const checkJar = setInterval(() => {
        if (window.CodeJar) {
            clearInterval(checkJar);
            jar = window.CodeJar(els.editor, highlight);
            jar.onUpdate(code => {
                if (code !== state.currentContent) {
                    state.unsaved = true;
                    updateUnsavedUI();
                    clearTimeout(state.saveTimeout);
                    state.saveTimeout = setTimeout(saveNote, 1000);
                }
            });
        }
    }, 100);
}

// --- API Calls ---
async function fetchTree() {
    try {
        const res = await fetch('/api/tree');
        state.tree = await res.json();
        renderTree(state.tree, els.fileTree);
    } catch (e) {
        console.error('Failed to fetch tree', e);
    }
}

async function loadNote(path, isDir = false) {
    state.currentPath = path;
    state.isDir = isDir;
    
    // Update UI headers
    els.filenameDisplay.textContent = path;
    els.emptyState.classList.add('hidden');
    window.history.replaceState(null, '', `?path=${path}`);

    if (isDir) {
        // Folder View
        els.editorContainer.classList.add('hidden');
        els.previewContainer.classList.remove('hidden');
        
        // Ensure tree is loaded
        if (!state.tree || state.tree.length === 0) {
            // Try to fetch tree if not loaded
            await fetchTree();
        }
        
        // Find node in tree to render children as text list
        const renderFolderContent = (nodes, targetPath) => {
            if (!nodes || !Array.isArray(nodes)) {
                els.markdownBody.innerHTML = marked.parse(`# 📂 Folder\n\n_Loading..._`);
                return false;
            }
            
            for (const node of nodes) {
                if (node && node.path === targetPath) {
                    const children = node.children && Array.isArray(node.children) ? node.children : [];
                    const list = children.length > 0 
                        ? children.map(c => {
                            const name = c.name || 'Unknown';
                            const cPath = c.path || '';
                            return `- [${c.isDir ? '📂' : '📄'} ${name}](?path=${encodeURIComponent(cPath)})`;
                        }).join('\n')
                        : '_Empty folder_';
                    const folderName = node.name || path.split('/').pop() || 'Folder';
                    els.markdownBody.innerHTML = marked.parse(`# 📂 ${folderName}\n\n${list}`);
                    return true;
                }
                if (node && node.children && Array.isArray(node.children)) {
                    if (renderFolderContent(node.children, targetPath)) {
                        return true;
                    }
                }
            }
            
            return false;
        };
        
        const found = renderFolderContent(state.tree, path);
        if (!found) {
            els.markdownBody.innerHTML = marked.parse(`# 📂 ${path.split('/').pop() || 'Folder'}\n\n_Folder not found or not loaded yet_`);
        }
        return;
    }

    // File View
    try {
        const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
        if (!res.ok) {
            if (res.status === 404) {
                els.markdownBody.innerHTML = '<p class="text-red">File not found</p>';
            } else if (res.status === 500) {
                els.markdownBody.innerHTML = '<p class="text-red">Server error loading file</p>';
            } else {
                els.markdownBody.innerHTML = `<p class="text-red">Failed to load file (${res.status})</p>`;
            }
            console.error('Failed to load file:', res.status, res.statusText);
            return;
        }
        
        const content = await res.text();
        state.currentContent = content;
        
        if(jar) jar.updateCode(content);
        
        renderMarkdown(content);
        
        if (state.previewMode) {
            els.editorContainer.classList.add('hidden');
            els.previewContainer.classList.remove('hidden');
            els.tocSidebar.style.opacity = '1';
        } else {
            els.editorContainer.classList.remove('hidden');
            els.previewContainer.classList.add('hidden');
            els.tocSidebar.style.opacity = '0';
        }
    } catch (e) {
        console.error('Error loading note:', e);
        els.markdownBody.innerHTML = `<p class="text-red">Error: ${e.message}</p>`;
    }
}

async function saveNote() {
    if (!state.currentPath || state.isDir) return;
    const content = jar.toString();
    state.currentContent = content;

    try {
        await fetch('/api/save', {
            method: 'POST',
            body: JSON.stringify({ path: state.currentPath, content: content })
        });
        state.unsaved = false;
        updateUnsavedUI();
        // If in preview mode, re-render
        if (state.previewMode) renderMarkdown(content);
    } catch (e) {
        console.error('Save failed', e);
        alert('Failed to save!');
    }
}

async function createItem(name) {
    let parent = '';
    if (state.currentPath) {
        // If current is dir, use it. If file, use parent.
        parent = state.isDir ? state.currentPath : state.currentPath.split('/').slice(0, -1).join('/');
    }
    
    // Logic: if name ends with /, it's a dir. Else .md
    const isDir = name.endsWith('/');
    const cleanName = name.replace(/\/$/, '');
    const filename = isDir ? cleanName : (cleanName.endsWith('.md') ? cleanName : cleanName + '.md');
    const fullPath = parent ? `${parent}/${filename}` : filename;

    // Save empty file or simple create logic
    // API handleSave creates dirs recursively so we can just "save" an empty file
    // For pure folders, we might need a distinct logic, but saving a placeholder works for now
    // or we just rely on handleSave to make the dir if we save a file inside it. 
    // To strictly support empty folders, we'd need a createDir API. 
    // For now, let's assume we create a file. 
    
    if (isDir) {
        // Hack: create a .keep file to persist folder
        await fetch('/api/save', {
            method: 'POST',
            body: JSON.stringify({ path: `${fullPath}/.keep`, content: '' })
        });
    } else {
        await fetch('/api/save', {
            method: 'POST',
            body: JSON.stringify({ path: fullPath, content: '# ' + cleanName })
        });
        loadNote(fullPath);
    }
    
    await fetchTree();
}

async function deleteCurrent() {
    if (!state.currentPath || !confirm(`Delete ${state.currentPath}?`)) return;
    try {
        await fetch('/api/delete', {
            method: 'POST',
            body: JSON.stringify({ path: state.currentPath })
        });
        state.currentPath = null;
        els.emptyState.classList.remove('hidden');
        els.editorContainer.classList.add('hidden');
        els.previewContainer.classList.add('hidden');
        await fetchTree();
    } catch (e) {
        alert('Delete failed');
    }
}

async function moveItem(oldPath, newPath) {
    try {
        await fetch('/api/move', {
            method: 'POST',
            body: JSON.stringify({ path: oldPath, newPath: newPath })
        });
        await fetchTree();
        if (state.currentPath === oldPath) loadNote(newPath, state.isDir);
    } catch (e) {
        console.error('Move failed', e);
    }
}

// --- Tree Rendering ---
function renderTree(nodes, container, padding = 0) {
    container.innerHTML = '';
    nodes.forEach(node => {
        const el = document.createElement('div');
        el.className = 'select-none';
        
        // Item Row
        const row = document.createElement('div');
        row.className = `flex items-center gap-1.5 py-1 px-2 cursor-pointer hover:bg-surface0 text-sm rounded mx-1 text-subtext0 transition-colors ${state.currentPath === node.path ? 'bg-surface1 text-mauve font-medium' : ''}`;
        row.style.paddingLeft = `${padding * 12 + 8}px`;
        row.draggable = true;
        
        // Icon
        const icon = document.createElement('i');
        icon.dataset.lucide = node.isDir ? (state.expandedFolders.has(node.path) ? 'folder-open' : 'folder') : 'file-text';
        icon.className = `w-4 h-4 ${node.isDir ? 'text-blue' : 'text-overlay2'}`;
        
        // Name
        const span = document.createElement('span');
        span.textContent = node.name;
        span.className = 'truncate';

        row.appendChild(icon);
        row.appendChild(span);
        el.appendChild(row);

        // Click Handler
        row.onclick = (e) => {
            e.stopPropagation();
            if (node.isDir) {
                if (state.expandedFolders.has(node.path)) {
                    state.expandedFolders.delete(node.path);
                } else {
                    state.expandedFolders.add(node.path);
                }
                fetchTree(); // Re-render to update icons/children
                // Also show folder view
                loadNote(node.path, true);
            } else {
                loadNote(node.path, false);
            }
        };

        // Drag & Drop
        row.ondragstart = (e) => {
            e.dataTransfer.setData('text/plain', node.path);
            row.classList.add('opacity-50');
        };
        row.ondragend = () => row.classList.remove('opacity-50');
        
        row.ondragover = (e) => {
            e.preventDefault();
            row.classList.add('bg-surface1');
        };
        row.ondragleave = () => row.classList.remove('bg-surface1');
        
        row.ondrop = async (e) => {
            e.preventDefault();
            row.classList.remove('bg-surface1');
            const draggedPath = e.dataTransfer.getData('text/plain');
            if (draggedPath === node.path) return;
            
            // Logic: if dropping on a dir, move inside. If on file, move to same dir as file.
            let targetDir = node.isDir ? node.path : node.path.split('/').slice(0, -1).join('/');
            const newPath = (targetDir ? targetDir + '/' : '') + draggedPath.split('/').pop();
            
            if (confirm(`Move ${draggedPath} to ${targetDir || 'root'}?`)) {
                await moveItem(draggedPath, newPath);
            }
        };

        container.appendChild(el);

        // Children
        if (node.isDir && state.expandedFolders.has(node.path) && node.children) {
            const childrenContainer = document.createElement('div');
            renderTree(node.children, childrenContainer, padding + 1);
            container.appendChild(childrenContainer);
        }
    });
    lucide.createIcons();
}


// --- Markdown Rendering (Mimicking Blog) ---
function renderMarkdown(content) {
    const renderer = new marked.Renderer();
    
    // Code renderer
    // marked.js v15 signature: renderer.code(code, infostring, escaped)
    renderer.code = (code, infostring, escaped) => {
        // Ensure code is a string
        const codeStr = typeof code === 'string' ? code : String(code || '');
        
        // Extract language from infostring (infostring can be language or "language:meta" or undefined)
        let language = '';
        if (infostring && typeof infostring === 'string') {
            // infostring might be just language or "language:meta"
            language = infostring.split(':')[0].trim().toLowerCase();
        }
        
        // Handle mermaid diagrams
        if (language === 'mermaid') {
            return `<div class="mermaid">${codeStr}</div>`;
        }
        
        // Determine valid language for highlighting
        let validLang = 'plaintext';
        if (language) {
            // Check if highlight.js supports this language
            if (typeof hljs !== 'undefined' && typeof hljs.getLanguage === 'function') {
                try {
                    if (hljs.getLanguage(language)) {
                        validLang = language;
                    }
                } catch (e) {
                    // Language not supported, use plaintext
                }
            }
        }
        
        // Highlight the code
        if (typeof hljs !== 'undefined' && typeof hljs.highlight === 'function') {
            try {
                // hljs.highlight expects (code: string, options: { language: string })
                const result = hljs.highlight(codeStr, { language: validLang });
                if (result && typeof result.value === 'string') {
                    return `<pre><code class="hljs language-${validLang}">${result.value}</code></pre>`;
                }
            } catch (e) {
                // If highlighting fails, fall through to plain code
                console.warn('Code highlighting failed:', e);
            }
        }
        
        // Fallback: escape HTML and return plain code
        const escapedCode = codeStr
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        return `<pre><code class="hljs language-${validLang}">${escapedCode}</code></pre>`;
    };

    // TOC Extraction
    const toc = [];
    // Helper function to create slugs
    const createSlug = (text) => {
        // Ensure text is a string
        let textStr = String(text || '');
        
        // Remove HTML tags if present
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = textStr;
        textStr = tempDiv.textContent || tempDiv.innerText || textStr;
        
        return textStr
            .toLowerCase()
            .trim()
            .replace(/[^\w\s-]/g, '') // Remove special characters
            .replace(/[\s_-]+/g, '-') // Replace spaces and underscores with hyphens
            .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
    };
    
    renderer.heading = (text, level, raw, slugger) => {
        // In marked.js v15, text can be a string, HTML string, or array of tokens
        // We need to extract the actual text content properly
        let textContent = '';
        
        if (typeof text === 'string') {
            // It's already a string, but might be HTML
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = text;
            textContent = tempDiv.textContent || tempDiv.innerText || text;
        } else if (Array.isArray(text)) {
            // It's an array of tokens - extract text from each token
            textContent = text.map(token => {
                if (typeof token === 'string') return token;
                if (token && typeof token === 'object') {
                    return token.text || token.raw || token.content || '';
                }
                return String(token || '');
            }).join('');
        } else if (text && typeof text === 'object') {
            // It's an object - try to get text property or render it
            if (text.text) {
                textContent = text.text;
            } else if (text.raw) {
                textContent = text.raw;
            } else {
                // Last resort: try to extract from HTML if it has innerHTML-like structure
                const tempDiv = document.createElement('div');
                try {
                    // If it's a DOM-like object, try to get text
                    if (text.textContent) {
                        textContent = text.textContent;
                    } else if (text.innerText) {
                        textContent = text.innerText;
                    } else {
                        // Convert to string and extract text
                        tempDiv.innerHTML = JSON.stringify(text);
                        textContent = tempDiv.textContent || '';
                    }
                } catch (e) {
                    textContent = '';
                }
            }
        } else {
            textContent = String(text || '');
        }
        
        // Clean up the text content
        textContent = textContent.trim();
        
        // Generate slug for ID
        let id;
        if (slugger && typeof slugger.slug === 'function') {
            try {
                id = slugger.slug(textContent);
            } catch (e) {
                id = createSlug(textContent);
            }
        } else {
            id = createSlug(textContent);
        }
        
        // Add to TOC
        if (level > 1 && level < 4) {
            toc.push({ text: textContent, level, id });
        }
        
        // Return the heading HTML with the text content (not the original text parameter)
        return `<h${level} id="${id}">${textContent}</h${level}>`;
    };

    // Blog Callouts
    renderer.blockquote = (quote) => {
        const match = quote.match(/^<p>\[!(TIP|NOTE|INFO|WARNING|DANGER)\]/i);
        if (match) {
            const type = match[1].toLowerCase();
            const clean = quote.replace(/<p>\[!.*?\]\s*/i, '<p>');
            return `<div class="callout ${type}">${clean}</div>`;
        }
        return `<blockquote>${quote}</blockquote>`;
    };

    marked.setOptions({ renderer });
    
    try {
        const html = marked.parse(content);
        if (typeof html !== 'string') {
            console.error('marked.parse returned non-string:', typeof html, html);
            els.markdownBody.innerHTML = '<p class="text-red">Error: Markdown parsing failed</p>';
            return;
        }
        els.markdownBody.innerHTML = html;
    } catch (e) {
        console.error('Error parsing markdown:', e);
        els.markdownBody.innerHTML = `<p class="text-red">Error parsing markdown: ${e.message}</p>`;
        return;
    }
    
    // Render Mermaid
    try {
        if (typeof mermaid !== 'undefined' && mermaid.run) {
            mermaid.run({ nodes: els.markdownBody.querySelectorAll('.mermaid') });
        }
    } catch (e) {
        console.error('Error rendering Mermaid:', e);
    }
    
    // Render TOC
    els.tocNav.innerHTML = toc.map(h => 
        `<a href="#${h.id}" class="block py-1 hover:text-mauve transition-colors ${h.level === 3 ? 'pl-3 text-overlay1' : 'text-subtext0'}">${h.text}</a>`
    ).join('');
}

// --- Event Listeners ---
function initEventListeners() {
    // Toggle View
    els.toggleViewBtn.addEventListener('click', () => {
        // Check if jar is initialized
        if (!jar) {
            console.error('Editor not initialized');
            return;
        }
        
        state.previewMode = !state.previewMode;
        
        // Save before switching if unsaved
        if (state.unsaved) {
            saveNote();
        }

        if (state.previewMode) {
            // Switch to preview mode
            const content = jar.toString();
            renderMarkdown(content);
            els.editorContainer.classList.add('hidden');
            els.previewContainer.classList.remove('hidden');
            els.tocSidebar.style.opacity = '1';
            els.toggleViewBtn.innerHTML = `<i data-lucide="edit-3" class="w-4 h-4"></i><span>Edit</span>`;
        } else {
            // Switch to edit mode
            els.editorContainer.classList.remove('hidden');
            els.previewContainer.classList.add('hidden');
            els.tocSidebar.style.opacity = '0';
            els.toggleViewBtn.innerHTML = `<i data-lucide="eye" class="w-4 h-4"></i><span>Preview</span>`;
        }
        lucide.createIcons();
    });

    els.deleteBtn.addEventListener('click', deleteCurrent);

    // Modal Logic
    const modal = document.getElementById('modal-backdrop');
    const input = document.getElementById('new-item-input');
    els.addBtn.addEventListener('click', () => {
        modal.classList.remove('hidden');
        input.value = '';
        input.focus();
    });
    
    document.getElementById('modal-cancel').addEventListener('click', () => modal.classList.add('hidden'));
    document.getElementById('modal-confirm').addEventListener('click', () => {
        if (input.value) createItem(input.value);
        modal.classList.add('hidden');
    });

    // Mobile Sidebar (hamburger menu only on mobile)
    els.mobileMenuBtn.addEventListener('click', () => {
        els.sidebar.classList.add('sidebar-mobile-open');
        els.sidebarOverlay.classList.remove('hidden');
    });
    els.sidebarOverlay.addEventListener('click', () => {
        els.sidebar.classList.remove('sidebar-mobile-open');
        els.sidebarOverlay.classList.add('hidden');
    });

    // Paste Image Handler
    document.addEventListener('paste', async (e) => {
        if (!state.currentPath || state.previewMode) return;
        
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        for (const item of items) {
            if (item.type.indexOf('image') === 0) {
                e.preventDefault();
                const blob = item.getAsFile();
                const formData = new FormData();
                formData.append('file', blob);
                formData.append('notePath', state.currentPath);

                try {
                    const res = await fetch('/api/upload', { method: 'POST', body: formData });
                    if (!res.ok) throw new Error('Upload failed');
                    const relPath = await res.text();
                    
                    // Insert markdown image
                    const md = `![Image](${relPath})`;
                    // CodeJar insert logic
                    const pos = window.getSelection().getRangeAt(0).startOffset;
                    // This is simple append, specific cursor insertion with CodeJar requires api
                    // jar.updateCode does full replace.
                    // Simple hack: append to end if cursor tracking is hard, 
                    // or better: let user handle insertion.
                    // CodeJar doesn't expose easy insertAtCursor without replacement.
                    // We will just append for now to be safe.
                    const current = jar.toString();
                    jar.updateCode(current + '\n' + md);
                    saveNote();
                } catch (err) {
                    console.error(err);
                    alert('Failed to upload image');
                }
            }
        }
    });
}

function updateUnsavedUI() {
    els.unsavedIndicators.forEach(el => {
        if (state.unsaved) el.classList.remove('hidden');
        else el.classList.add('hidden');
    });
}
