// Measurement-driven pagination: carve blocks across fixed-size .print-page boxes. Measured on the live DOM, so layout-affecting print CSS lives outside @media print (see index.html).

const KEPT_NOTHING = Symbol('keptNothing');
const INLINE_TAGS = new Set(['A', 'ABBR', 'B', 'BR', 'CODE', 'DEL', 'EM', 'I', 'IMG', 'INPUT', 'KBD', 'MARK', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'U']);

function clearPrintPages() {
    document.getElementById('print-pages')?.remove();
}

function buildPrintPages() {
    clearPrintPages();
    const host = document.createElement('div');
    host.id = 'print-pages';
    document.body.appendChild(host);
    const ctx = { host, page: null, inner: null };
    newPage(ctx);
    for (const src of [...els.markdownBody.children]) {
        placeBlock(ctx, prepareBlock(src));
    }
    if (!ctx.inner.children.length) ctx.page.remove();
    return host;
}

function newPage(ctx) {
    ctx.page = document.createElement('div');
    ctx.page.className = 'print-page';
    ctx.inner = document.createElement('div');
    ctx.inner.className = 'markdown-body';
    ctx.page.appendChild(ctx.inner);
    ctx.host.appendChild(ctx.page);
}

const isHeading = el => /^H[1-6]$/.test(el.tagName);

// A heading stranded at a page bottom moves forward with the content it introduces.
function newPageWithHeadings(ctx) {
    const pulled = [];
    while (ctx.inner.lastElementChild && isHeading(ctx.inner.lastElementChild)) {
        pulled.unshift(ctx.inner.lastElementChild);
        ctx.inner.lastElementChild.remove();
    }
    const emptied = ctx.inner.children.length === 0 ? ctx.page : null;
    newPage(ctx);
    emptied?.remove();
    pulled.forEach(h => ctx.inner.appendChild(h));
}

function fits(ctx) {
    return ctx.page.scrollHeight <= ctx.page.clientHeight;
}

function pagePadding(page) {
    const cs = getComputedStyle(page);
    return { top: parseFloat(cs.paddingTop), bottom: parseFloat(cs.paddingBottom) };
}

function contentBottom(page) {
    return page.getBoundingClientRect().top + page.clientHeight - pagePadding(page).bottom;
}

function contentHeight(page) {
    const pad = pagePadding(page);
    return page.clientHeight - pad.top - pad.bottom;
}

function prepareBlock(src) {
    // Preview wraps tables in a scroll container; print carves the bare table
    if (src.classList.contains('table-scroll')) src = src.querySelector('table') || src;
    const block = src.cloneNode(true);
    block.querySelectorAll('.copy-code-btn').forEach(b => b.remove());
    return block;
}

function placeBlock(ctx, block) {
    ctx.inner.appendChild(block);
    fitMedia(ctx, block, false);
    if (fits(ctx)) return;

    // null and KEPT_NOTHING leave the block unmutated, so only a real continuation ends placement here
    if (isSplittable(block)) {
        const cont = carve(ctx, block, false);
        if (cont !== KEPT_NOTHING && cont !== null) {
            spillContinuations(ctx, cont);
            return;
        }
    }
    block.remove();
    newPageWithHeadings(ctx);
    ctx.inner.appendChild(block);
    if (fits(ctx)) return;
    if (isSplittable(block)) {
        const cont = carve(ctx, block, true);
        if (cont !== KEPT_NOTHING && cont !== null) {
            spillContinuations(ctx, cont);
            return;
        }
    }
    // Nothing left to split off (e.g. an image under a pulled heading): squeeze media into the space that remains
    fitMedia(ctx, block, true);
}

function spillContinuations(ctx, cont) {
    while (cont) {
        newPage(ctx);
        ctx.inner.appendChild(cont);
        if (fits(ctx)) return;
        const next = carve(ctx, cont, true);
        if (next === KEPT_NOTHING) return;
        cont = next;
    }
}

function isSplittable(el) {
    switch (el.tagName) {
        case 'UL': case 'OL': case 'P': case 'PRE': case 'BLOCKQUOTE': return true;
        case 'TABLE': return !!el.tBodies[0];
        case 'DIV': return el.classList.contains('callout') && !!el.querySelector(':scope > .callout-content');
        default: return false;
    }
}

// Carves trailing overflow into a returned continuation; null = nothing to move, KEPT_NOTHING = too little fits (block restored), unless force guarantees progress on a fresh page.
function carve(ctx, el, force) {
    switch (el.tagName) {
        case 'P': case 'PRE': return carveText(ctx, el, force);
        // Lists keep at least two items before a break so no single-item widows
        case 'UL': case 'OL': return carveUnits(ctx, el, el, force, listShell, force ? 1 : 2);
        case 'TABLE': return carveUnits(ctx, el, el.tBodies[0], force, tableShell, 1);
        case 'BLOCKQUOTE': return carveUnits(ctx, el, el, force, cloneShell, 1);
        case 'DIV': return carveUnits(ctx, el, el.querySelector(':scope > .callout-content'), force, calloutShell, 1);
        default: return KEPT_NOTHING;
    }
}

function isTextish(el) {
    if (el.tagName === 'P' || el.tagName === 'PRE') return true;
    if (el.tagName === 'LI') return [...el.children].every(c => INLINE_TAGS.has(c.tagName));
    return false;
}

function carveUnits(ctx, el, unitsParent, force, makeShell, minKeep) {
    const moved = [];
    while (unitsParent.children.length > minKeep && !fits(ctx)) {
        const u = unitsParent.lastElementChild;
        moved.unshift(u);
        u.remove();
    }
    let boundaryCont = null;
    if (!fits(ctx)) {
        const b = unitsParent.lastElementChild;
        if (b && isTextish(b)) {
            const r = carveText(ctx, b, false);
            if (r !== KEPT_NOTHING && r !== null) boundaryCont = r;
        }
    }
    if (!fits(ctx) && !force) {
        moved.forEach(u => unitsParent.appendChild(u));
        return KEPT_NOTHING;
    }
    if (!moved.length && !boundaryCont) return force ? KEPT_NOTHING : null;
    const { shell, into } = makeShell(el, unitsParent.children.length, !!boundaryCont);
    if (boundaryCont) into.appendChild(boundaryCont);
    moved.forEach(u => into.appendChild(u));
    return shell;
}

function listShell(el, keptCount, hasBoundary) {
    const shell = el.cloneNode(false);
    if (el.tagName === 'OL') {
        const start = parseInt(el.getAttribute('start') || '1', 10);
        // A split boundary item repeats its number slot but hides the marker
        shell.setAttribute('start', String(start + keptCount - (hasBoundary ? 1 : 0)));
    }
    return { shell, into: shell };
}

function tableShell(el) {
    const shell = el.cloneNode(false);
    if (el.tHead) shell.appendChild(el.tHead.cloneNode(true));
    const tbody = el.tBodies[0].cloneNode(false);
    shell.appendChild(tbody);
    return { shell, into: tbody };
}

function cloneShell(el) {
    const shell = el.cloneNode(false);
    return { shell, into: shell };
}

// Continuation callouts keep the tinted box but drop the icon so they read as a continuation, not a new callout
function calloutShell(el) {
    const shell = el.cloneNode(false);
    const content = el.querySelector(':scope > .callout-content').cloneNode(false);
    shell.appendChild(content);
    return { shell, into: content };
}

function textPosition(root, index) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n, acc = 0;
    while ((n = walker.nextNode())) {
        if (acc + n.data.length >= index) return { node: n, offset: index - acc };
        acc += n.data.length;
    }
    return null;
}

function lineHeightOf(el) {
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight);
    return Number.isNaN(lh) ? parseFloat(cs.fontSize) * 1.6 : lh;
}

// Padding/borders of ancestors below the kept text (pre box, callout shell) — the split must leave room for them
function belowChrome(ctx, target) {
    let sum = 0, n = target;
    while (n && n !== ctx.inner) {
        const cs = getComputedStyle(n);
        sum += (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
        n = n.parentElement;
    }
    return sum;
}

function carveText(ctx, el, force) {
    const target = el.tagName === 'PRE' ? (el.querySelector('code') || el) : el;
    const text = target.textContent;
    if (text.length < 2) return force ? null : KEPT_NOTHING;

    const limit = contentBottom(ctx.page) - belowChrome(ctx, target) - 0.5;
    const range = document.createRange();
    const bottomAt = i => {
        const pos = textPosition(target, i);
        if (!pos) return -Infinity;
        range.setStart(target, 0);
        range.setEnd(pos.node, pos.offset);
        return range.getBoundingClientRect().bottom;
    };

    if (bottomAt(1) > limit) return force ? null : KEPT_NOTHING;
    let lo = 1, hi = text.length;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (bottomAt(mid) <= limit) lo = mid; else hi = mid;
    }
    if (lo >= text.length) return null;

    // Break at a newline (code) or word boundary (prose) so the continuation starts cleanly
    let split = lo;
    if (el.tagName === 'PRE') {
        const nl = text.lastIndexOf('\n', split - 1);
        if (nl > 0) split = nl + 1;
    } else {
        let k = split;
        while (k > 0 && !/\s/.test(text[k])) k--;
        if (k > 0) split = k + 1;
    }

    // Widow/orphan control: don't leave fewer than two kept lines behind
    const keptHeight = bottomAt(split) - el.getBoundingClientRect().top;
    if (!force && keptHeight < lineHeightOf(target) * 1.8) return KEPT_NOTHING;
    if (split <= 0) split = Math.max(1, lo);
    if (split >= text.length) return null;

    const pos = textPosition(target, split);
    range.setStart(pos.node, pos.offset);
    range.setEnd(target, target.childNodes.length);
    const frag = range.extractContents();

    // Sub-pixel rounding can leave the kept part a hair too tall; retreat line by line until it fits
    const retreat = t => {
        if (el.tagName === 'PRE') return t.lastIndexOf('\n', t.length - 2) + 1;
        for (let k = Math.max(2, t.length - 50); k > 1; k--) if (/\s/.test(t[k])) return k + 1;
        return 0;
    };
    let guard = 0;
    while (!fits(ctx) && guard++ < 6) {
        const t = target.textContent;
        const back = retreat(t);
        if (back <= 1) break;
        const p2 = textPosition(target, back);
        if (!p2) break;
        range.setStart(p2.node, p2.offset);
        range.setEnd(target, target.childNodes.length);
        frag.insertBefore(range.extractContents(), frag.firstChild);
    }

    // A kept trailing newline would render as a blank last line in <pre>
    if (el.tagName === 'PRE') {
        const w = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
        let last = null, t;
        while ((t = w.nextNode())) last = t;
        if (last && last.data.endsWith('\n')) last.data = last.data.slice(0, -1);
    }

    let cont;
    if (el.tagName === 'PRE') {
        cont = el.cloneNode(false);
        if (target === el) {
            cont.appendChild(frag);
        } else {
            const code = target.cloneNode(false);
            code.appendChild(frag);
            cont.appendChild(code);
        }
    } else {
        cont = el.cloneNode(false);
        cont.appendChild(frag);
        if (el.tagName === 'LI') cont.style.listStyleType = 'none';
    }
    return cont;
}

// Scale a wide table down whole while readable; past that, shrink only enough for unbreakable tokens to fit (wrapping absorbs the rest)
function fitTableWidth(ctx, table, availW) {
    const probe = table.cloneNode(true);
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.setProperty('max-width', 'none', 'important');
    probe.style.setProperty('width', 'max-content', 'important');
    ctx.inner.appendChild(probe);
    const maxC = probe.getBoundingClientRect().width;
    probe.style.setProperty('width', 'min-content', 'important');
    const minC = probe.getBoundingClientRect().width;
    probe.remove();
    if (maxC <= availW) return;
    const fitAll = availW / maxC;
    if (fitAll >= 0.6) table.style.zoom = String(fitAll);
    // Below the readability cutoff, wrapping absorbs the excess but unbreakable tokens must still fit the margin exactly
    else if (minC > availW) table.style.zoom = String((availW - 1) / minC);
}

// tight fits media below the current position (block already mid-page) rather than onto a full page
function fitMedia(ctx, block, tight) {
    const availW = ctx.inner.clientWidth;
    if (block.tagName === 'TABLE' && !tight) fitTableWidth(ctx, block, availW);
    block.querySelectorAll('svg, img').forEach(node => {
        const r = node.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const box = node.closest('.mermaid') || block;
        const boxCs = getComputedStyle(box);
        const padX = (parseFloat(boxCs.paddingLeft) || 0) + (parseFloat(boxCs.paddingRight) || 0);
        const cs = getComputedStyle(block);
        const blockRect = block.getBoundingClientRect();
        const chrome = blockRect.height - r.height + (parseFloat(cs.marginBottom) || 0);
        const budgetH = (tight
            ? contentBottom(ctx.page) - blockRect.top
            : contentHeight(ctx.page) - (parseFloat(cs.marginTop) || 0)) - chrome - 2;
        const s = Math.min(1, (availW - padX - 2) / r.width, budgetH / r.height);
        if (s < 1 && s > 0) {
            node.style.maxWidth = 'none';
            node.style.maxHeight = 'none';
            node.style.width = (r.width * s) + 'px';
            node.style.height = (r.height * s) + 'px';
            if (node.tagName.toLowerCase() === 'svg') {
                // Keep scaled diagrams centered like the preview
                node.style.display = 'block';
                node.style.marginLeft = 'auto';
                node.style.marginRight = 'auto';
            }
        }
    });
}
