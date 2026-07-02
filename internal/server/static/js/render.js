const mermaidConfig = {
    startOnLoad: false,
    theme: 'base',
    fontFamily: 'Inter',
    themeVariables: {
        darkMode: true,
        background: '#1e1e2e',
        mainBkg: '#1e1e2e',
        primaryColor: '#313244',
        primaryTextColor: '#cdd6f4',
        primaryBorderColor: '#89b4fa',
        secondaryColor: '#45475a',
        secondaryTextColor: '#cdd6f4',
        secondaryBorderColor: '#7f849c',
        tertiaryColor: '#313244',
        tertiaryTextColor: '#cdd6f4',
        tertiaryBorderColor: '#585b70',
        lineColor: '#89b4fa',
        arrowheadColor: '#89b4fa',
        textColor: '#cdd6f4',
        titleColor: '#cba6f7',
        noteBkgColor: '#45475a',
        noteTextColor: '#f9e2af',
        noteBorderColor: '#585b70',
        nodeBkg: '#313244',
        nodeBorder: '#89b4fa',
        clusterBkg: '#181825',
        clusterBorder: '#585b70',
        defaultLinkColor: '#89b4fa',
        edgeLabelBackground: '#313244',
        nodeTextColor: '#cdd6f4',
        actorBkg: '#313244',
        actorBorder: '#89b4fa',
        actorTextColor: '#cdd6f4',
        actorLineColor: '#585b70',
        signalColor: '#f5c2e7',
        signalTextColor: '#cdd6f4',
        labelBoxBkgColor: '#45475a',
        labelBoxBorderColor: '#585b70',
        labelTextColor: '#cdd6f4',
        loopTextColor: '#f9e2af',
        activationBorderColor: '#cba6f7',
        activationBkgColor: '#45475a',
        sequenceNumberColor: '#1e1e2e',
        sectionBkgColor: '#181825',
        altSectionBkgColor: '#1e1e2e',
        sectionBkgColor2: '#11111b',
        taskBkgColor: '#89b4fa',
        taskBorderColor: '#b4befe',
        taskTextColor: '#1e1e2e',
        taskTextLightColor: '#1e1e2e',
        taskTextDarkColor: '#cdd6f4',
        taskTextOutsideColor: '#cdd6f4',
        taskTextClickableColor: '#89dceb',
        activeTaskBkgColor: '#cba6f7',
        activeTaskBorderColor: '#f5c2e7',
        doneTaskBkgColor: '#45475a',
        doneTaskBorderColor: '#585b70',
        critBkgColor: '#f38ba8',
        critBorderColor: '#eba0ac',
        gridColor: '#313244',
        todayLineColor: '#f38ba8',
        pie1: '#cba6f7', pie2: '#89b4fa', pie3: '#a6e3a1', pie4: '#f9e2af',
        pie5: '#f38ba8', pie6: '#94e2d5', pie7: '#fab387', pie8: '#89dceb',
        pie9: '#f5c2e7', pie10: '#74c7ec', pie11: '#eba0ac', pie12: '#b4befe',
        pieTitleTextColor: '#cdd6f4',
        pieSectionTextColor: '#1e1e2e',
        pieLegendTextColor: '#cdd6f4',
        pieStrokeColor: '#1e1e2e',
        pieOuterStrokeColor: '#313244',
        git0: '#89b4fa', git1: '#cba6f7', git2: '#a6e3a1', git3: '#f9e2af',
        git4: '#f38ba8', git5: '#94e2d5', git6: '#fab387', git7: '#74c7ec',
        gitInv0: '#1e1e2e', gitInv1: '#1e1e2e', gitInv2: '#1e1e2e', gitInv3: '#1e1e2e',
        gitInv4: '#1e1e2e', gitInv5: '#1e1e2e', gitInv6: '#1e1e2e', gitInv7: '#1e1e2e',
        commitLabelColor: '#bac2de',
        commitLabelBackground: '#1e1e2e',
        tagLabelColor: '#1e1e2e',
        tagLabelBackground: '#f9e2af',
        tagLabelBorder: '#fab387',
        labelBackgroundColor: '#313244',
        cScale0: '#313244', cScale1: '#89b4fa', cScale2: '#cba6f7', cScale3: '#a6e3a1',
        cScale4: '#f9e2af', cScale5: '#f38ba8', cScale6: '#94e2d5', cScale7: '#fab387',
        cScale8: '#89dceb', cScale9: '#f5c2e7', cScale10: '#74c7ec', cScale11: '#b4befe',
    }
};

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

function togglePreview(force = null) {
    previewMode = force !== null ? force : !previewMode;

    if (previewMode) {
        const code = view.state.doc.toString();
        els.markdownBody.innerHTML = DOMPurify.sanitize(marked.parse(code));
        fixImagePaths();
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
