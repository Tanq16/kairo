// khroma can't read var() at render time, so resolve the active Catppuccin hex from :root
function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function buildMermaidConfig() {
    return {
        startOnLoad: false,
        theme: 'base',
        fontFamily: 'Inter',
        themeVariables: {
            darkMode: document.documentElement.classList.contains('dark'),
            background: cssVar('--base'),
            mainBkg: cssVar('--base'),
            primaryColor: cssVar('--surface0'),
            primaryTextColor: cssVar('--text'),
            primaryBorderColor: cssVar('--blue'),
            secondaryColor: cssVar('--surface1'),
            secondaryTextColor: cssVar('--text'),
            secondaryBorderColor: cssVar('--overlay1'),
            tertiaryColor: cssVar('--surface0'),
            tertiaryTextColor: cssVar('--text'),
            tertiaryBorderColor: cssVar('--surface2'),
            lineColor: cssVar('--blue'),
            arrowheadColor: cssVar('--blue'),
            textColor: cssVar('--text'),
            titleColor: cssVar('--mauve'),
            noteBkgColor: cssVar('--surface1'),
            noteTextColor: cssVar('--yellow'),
            noteBorderColor: cssVar('--surface2'),
            nodeBkg: cssVar('--surface0'),
            nodeBorder: cssVar('--blue'),
            clusterBkg: cssVar('--mantle'),
            clusterBorder: cssVar('--surface2'),
            defaultLinkColor: cssVar('--blue'),
            edgeLabelBackground: cssVar('--surface0'),
            nodeTextColor: cssVar('--text'),
            actorBkg: cssVar('--surface0'),
            actorBorder: cssVar('--blue'),
            actorTextColor: cssVar('--text'),
            actorLineColor: cssVar('--surface2'),
            signalColor: cssVar('--pink'),
            signalTextColor: cssVar('--text'),
            labelBoxBkgColor: cssVar('--surface1'),
            labelBoxBorderColor: cssVar('--surface2'),
            labelTextColor: cssVar('--text'),
            loopTextColor: cssVar('--yellow'),
            activationBorderColor: cssVar('--mauve'),
            activationBkgColor: cssVar('--surface1'),
            sequenceNumberColor: cssVar('--base'),
            sectionBkgColor: cssVar('--mantle'),
            altSectionBkgColor: cssVar('--base'),
            sectionBkgColor2: cssVar('--crust'),
            taskBkgColor: cssVar('--blue'),
            taskBorderColor: cssVar('--lavender'),
            taskTextColor: cssVar('--base'),
            taskTextLightColor: cssVar('--base'),
            taskTextDarkColor: cssVar('--text'),
            taskTextOutsideColor: cssVar('--text'),
            taskTextClickableColor: cssVar('--sky'),
            activeTaskBkgColor: cssVar('--mauve'),
            activeTaskBorderColor: cssVar('--pink'),
            doneTaskBkgColor: cssVar('--surface1'),
            doneTaskBorderColor: cssVar('--surface2'),
            critBkgColor: cssVar('--red'),
            critBorderColor: cssVar('--maroon'),
            gridColor: cssVar('--surface0'),
            todayLineColor: cssVar('--red'),
            pie1: cssVar('--mauve'), pie2: cssVar('--blue'), pie3: cssVar('--green'), pie4: cssVar('--yellow'),
            pie5: cssVar('--red'), pie6: cssVar('--teal'), pie7: cssVar('--peach'), pie8: cssVar('--sky'),
            pie9: cssVar('--pink'), pie10: cssVar('--sapphire'), pie11: cssVar('--maroon'), pie12: cssVar('--lavender'),
            pieTitleTextColor: cssVar('--text'),
            pieSectionTextColor: cssVar('--base'),
            pieLegendTextColor: cssVar('--text'),
            pieStrokeColor: cssVar('--base'),
            pieOuterStrokeColor: cssVar('--surface0'),
            git0: cssVar('--blue'), git1: cssVar('--mauve'), git2: cssVar('--green'), git3: cssVar('--yellow'),
            git4: cssVar('--red'), git5: cssVar('--teal'), git6: cssVar('--peach'), git7: cssVar('--sapphire'),
            gitInv0: cssVar('--base'), gitInv1: cssVar('--base'), gitInv2: cssVar('--base'), gitInv3: cssVar('--base'),
            gitInv4: cssVar('--base'), gitInv5: cssVar('--base'), gitInv6: cssVar('--base'), gitInv7: cssVar('--base'),
            commitLabelColor: cssVar('--subtext1'),
            commitLabelBackground: cssVar('--base'),
            tagLabelColor: cssVar('--base'),
            tagLabelBackground: cssVar('--yellow'),
            tagLabelBorder: cssVar('--peach'),
            labelBackgroundColor: cssVar('--surface0'),
            cScale0: cssVar('--surface0'), cScale1: cssVar('--blue'), cScale2: cssVar('--mauve'), cScale3: cssVar('--green'),
            cScale4: cssVar('--yellow'), cScale5: cssVar('--red'), cScale6: cssVar('--teal'), cScale7: cssVar('--peach'),
            cScale8: cssVar('--sky'), cScale9: cssVar('--pink'), cScale10: cssVar('--sapphire'), cScale11: cssVar('--lavender'),
        }
    };
}

const plainMermaidConfig = { startOnLoad: false, theme: 'default' };

// mermaid.run() overwrites a node's innerHTML, so the source is stashed once to survive a re-render
function renderMermaid(root, config) {
    if (typeof mermaid === 'undefined') return Promise.resolve();
    const nodes = root.querySelectorAll('.mermaid');
    nodes.forEach(node => {
        if (node.dataset.mermaidSrc === undefined) {
            node.dataset.mermaidSrc = node.textContent;
        } else {
            node.textContent = node.dataset.mermaidSrc;
            node.removeAttribute('data-processed');
        }
    });
    mermaid.initialize(config);
    return mermaid.run({ nodes }).catch(() => {});
}

function generateId(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
            return `<img src="${escapeHtml(token.href || '')}" alt="${escapeHtml(alt)}" style="max-width:100%; border-radius:0.5rem;">`;
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

function flashCopied(button) {
    button.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i>';
    button.classList.add('copied');
    lucide.createIcons({ nodes: [button] });

    setTimeout(() => {
        button.innerHTML = '<i data-lucide="copy" class="w-4 h-4"></i>';
        button.classList.remove('copied');
        lucide.createIcons({ nodes: [button] });
    }, 2000);
}

function addCopyButtons() {
    const codeBlocks = els.markdownBody.querySelectorAll('pre');
    codeBlocks.forEach(block => {
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
                await navigator.clipboard.writeText(codeEl.textContent);
            } catch (err) {
                // Fallback for non-secure contexts
                const textarea = document.createElement('textarea');
                textarea.value = codeEl.textContent;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
            }
            flashCopied(button);
        };

        block.appendChild(button);
    });
    lucide.createIcons();
}

// A table wider than the pane scrolls inside its own container instead of overlapping the TOC rail
function wrapTables() {
    els.markdownBody.querySelectorAll('table').forEach(table => {
        if (table.parentElement.classList.contains('table-scroll')) return;
        const wrap = document.createElement('div');
        wrap.className = 'table-scroll';
        table.parentNode.insertBefore(wrap, table);
        wrap.appendChild(table);
    });
}

function fixImagePaths() {
    els.markdownBody.querySelectorAll('img').forEach(img => {
        let src = img.getAttribute('src');
        if (src && !src.startsWith('http') && !src.startsWith('data:')) {
            // Links are percent-encoded but files are stored raw, so decode before the API (literal-% legacy links keep their raw form)
            try { src = decodeURIComponent(src); } catch (e) {}
            // Relative markdown paths resolve against the note's directory, served via the file API
            const currentDir = currentPath ? currentPath.substring(0, currentPath.lastIndexOf('/')) : '';
            const fullPath = currentDir ? (currentDir + '/' + src) : src;
            img.src = `/api/file?path=${encPath(fullPath)}`;
        }
    });
}

function renderMarkdownBody(content) {
    els.markdownBody.innerHTML = DOMPurify.sanitize(marked.parse(content));
    fixImagePaths();
    wrapTables();
    addCopyButtons();
    queueRender(() => renderMermaid(els.markdownBody, buildMermaidConfig()));
    lucide.createIcons();
    buildToc();
}

function togglePreview(force = null) {
    previewMode = force !== null ? force : !previewMode;

    if (previewMode) {
        renderMarkdownBody(view.state.doc.toString());

        els.editorContainer.classList.add('hidden');
        els.previewContainer.classList.remove('hidden');
        els.previewBtn.innerHTML = '<i data-lucide="edit" class="w-4 h-4"></i><span>Edit</span>';
    } else {
        hideToc();
        els.editorContainer.classList.remove('hidden');
        els.previewContainer.classList.add('hidden');
        els.previewBtn.innerHTML = '<i data-lucide="eye" class="w-4 h-4"></i><span>Preview</span>';
    }
    lucide.createIcons();
}
