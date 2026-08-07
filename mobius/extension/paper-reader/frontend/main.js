import { marked } from 'https://esm.sh/marked@12';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const state = {
  channels: [], model: '', recent: [], paper: null, notes: [], comments: [], commentCounts: {}, runs: [],
  conversation: [], conversationHasMore: false,
  anchor: null, selectedQuote: '', activeParagraph: null, editingNote: null, noteKind: 'insight',
  pdfUrl: null, currentView: 'text', activeSideTab: 'chat', headingObserver: null, saveScrollTimer: null,
  panelSizes: { outline: 232, side: 480 }
};
const SUGGESTIONS = [
  '提炼这篇论文真正新增的算法机制',
  '对比它与最接近方法的关键差异',
  '检查实验是否足以支持核心结论',
  '给出可继续推进的研究问题'
];
const NOTE_LABELS = { insight: '核心判断', evidence: '关键证据', question: '开放问题' };
const PANEL_SIZES = {
  outline: { css: '--outline-w', storage: 'pr-layout:outline', min: 184, max: 340, default: 232 },
  side: { css: '--side-w', storage: 'pr-layout:side', min: 340, max: 680, default: 480 }
};

function refreshIcons(root = document) {
  requestAnimationFrame(() => {
    try { window.lucide?.createIcons({ root, attrs: { 'aria-hidden': 'true' } }); } catch {}
  });
}

function sanitizeFragment(input) {
  const doc = new DOMParser().parseFromString(String(input || ''), 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,form,base,meta,link').forEach((node) => node.remove());
  doc.querySelectorAll('*').forEach((node) => {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || ((name === 'href' || name === 'src') && value.startsWith('javascript:'))) {
        node.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}

function protectMath(value) {
  const code = [];
  const math = [];
  let source = String(value || '').replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
    const token = `PRCODETOKEN${code.length}END`;
    code.push(match);
    return token;
  });
  source = source.split('\n').map((line) => {
    const formula = line.trim();
    const isBareFormula = formula.length > 4 && formula.length < 500
      && !/[\u3400-\u9fff]/u.test(formula)
      && !/^(?:[#>|$]|\\\[|\\\(|\\begin\{|[-*+]\s|\d+\.\s|PRCODETOKEN)/.test(formula)
      && formula.includes('=')
      && /(?:_\{|\^\{|\\[A-Za-z]+|[ℓπθ∇∑]|\b(?:log|exp|KL|E)\b)/u.test(formula);
    if (!isBareFormula) return line;
    const token = `PRMATHTOKEN${math.length}END`;
    math.push({ tex: formula, display: true });
    return token;
  }).join('\n');
  const patterns = [
    { re: /\\begin\{(equation\*?|align\*?|aligned|gather\*?|cases|split|multline\*?)\}[\s\S]*?\\end\{\1\}/g, display: true, unwrap: (match) => match },
    { re: /\$\$([\s\S]+?)\$\$/g, display: true, unwrap: (_match, body) => body },
    { re: /\\\[([\s\S]+?)\\\]/g, display: true, unwrap: (_match, body) => body },
    { re: /\\\(([\s\S]+?)\\\)/g, display: false, unwrap: (_match, body) => body },
    { re: /(^|[^\\$])\$(?![\s$])([^$\n]*?\S)\$(?!\$)/gm, display: false, unwrap: (_match, prefix, body) => ({ prefix, body }) }
  ];
  for (const pattern of patterns) {
    source = source.replace(pattern.re, (...args) => {
      const unwrapped = pattern.unwrap(...args);
      const prefix = typeof unwrapped === 'object' ? unwrapped.prefix : '';
      const tex = typeof unwrapped === 'object' ? unwrapped.body : unwrapped;
      const token = `PRMATHTOKEN${math.length}END`;
      math.push({ tex: String(tex || '').trim(), display: pattern.display });
      return `${prefix}${token}`;
    });
  }
  source = source.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  source = source.replace(/([A-Za-z}\]ℓπθ])_([A-Za-z{ℓπθ])/gu, '$1\\_$2');
  source = source.replace(/PRCODETOKEN(\d+)END/g, (_match, index) => code[Number(index)] || '');
  math.forEach((item) => {
    item.tex = item.tex
      .replace(/\t(?=(?:frac|ext|heta)\b)/g, '\\t')
      .replace(/\f(?=rac\b)/g, '\\f')
      .replace(/\n(?=abla\b)/g, '\\n')
      .replace(/\r(?=(?:angle|ho|ight)\b)/g, '\\r')
      .replace(/\u0008(?=eta\b)/g, '\\b');
  });
  return { source, math };
}

function renderMd(value) {
  const protectedContent = protectMath(value);
  let html;
  try { html = marked.parse(protectedContent.source, { breaks: true, gfm: true }); }
  catch { html = `<p>${esc(value)}</p>`; }
  return sanitizeFragment(html).replace(/PRMATHTOKEN(\d+)END/g, (_match, index) => {
    const item = protectedContent.math[Number(index)];
    if (!item) return '';
    return `<span class="pr-math-slot${item.display ? ' is-display' : ''}" data-tex="${esc(item.tex)}" data-display="${item.display ? 'true' : 'false'}"></span>`;
  });
}

function ensureKatex(callback) {
  if (window.renderMathInElement) return callback();
  if (ensureKatex.loading) return ensureKatex.queue.push(callback);
  ensureKatex.loading = true;
  ensureKatex.queue = [callback];
  const katex = document.createElement('script');
  katex.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js';
  katex.onload = () => {
    const auto = document.createElement('script');
    auto.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js';
    auto.onload = () => ensureKatex.queue.splice(0).forEach((fn) => fn());
    document.head.appendChild(auto);
  };
  document.head.appendChild(katex);
}

function renderMath(element) {
  if (!element) return;
  ensureKatex(() => {
    element.querySelectorAll('.pr-math-slot').forEach((slot) => {
      if (slot.dataset.rendered === 'true') return;
      const tex = slot.dataset.tex || '';
      try {
        window.katex.render(tex, slot, {
          displayMode: slot.dataset.display === 'true', throwOnError: false, strict: 'ignore', trust: false
        });
        slot.dataset.rendered = 'true';
      } catch {
        slot.classList.add('pr-math-error');
        slot.textContent = tex;
      }
    });
    try {
      window.renderMathInElement(element, {
        delimiters: [
          { left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false }, { left: '\\[', right: '\\]', display: true }
        ],
        throwOnError: false,
        ignoredClasses: ['pr-math-slot', 'pr-code-block']
      });
    } catch {}
  });
}

function enhanceRichContent(element) {
  if (!element) return;
  element.querySelectorAll('table').forEach((table) => {
    if (table.parentElement?.classList.contains('pr-rich-table')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'pr-rich-table';
    table.parentNode.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });
  element.querySelectorAll('pre').forEach((pre) => {
    if (pre.parentElement?.classList.contains('pr-code-block')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'pr-code-block';
    const copy = document.createElement('button');
    copy.className = 'pr-code-copy';
    copy.type = 'button';
    copy.title = '复制代码';
    copy.setAttribute('aria-label', '复制代码');
    copy.innerHTML = '<i data-lucide="copy"></i>';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent || '');
        copy.innerHTML = '<i data-lucide="check"></i>';
        refreshIcons(copy);
        setTimeout(() => { copy.innerHTML = '<i data-lucide="copy"></i>'; refreshIcons(copy); }, 1200);
      } catch { toast('复制失败', true); }
    });
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.append(copy, pre);
  });
  element.querySelectorAll('a[href]').forEach((link) => {
    if (/^https?:/i.test(link.href)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  });
  element.querySelectorAll('img').forEach((image) => { image.loading = 'lazy'; image.decoding = 'async'; });
  refreshIcons(element);
  renderMath(element);
}

async function call(payload) {
  const { extCall } = await import('/extension/_sdk/ext.js');
  const response = await extCall(payload);
  if (!response || !response.ok) throw new Error(response?.error || '调用失败');
  return response;
}

async function hostCall(path) {
  const token = localStorage.getItem('cc-token') || '';
  if (!token) throw new Error('当前页面缺少登录令牌');
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Session 状态获取失败 (${response.status})`);
  return response.json();
}

function toast(message, bad = false) {
  const element = $('toast');
  element.textContent = message;
  element.className = `pr-toast show${bad ? ' bad' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = 'pr-toast'; }, 2600);
}

function setLoading(message, visible) {
  if (message) $('prLoadingText').textContent = message;
  $('prLoading').classList.toggle('hide', !visible);
}

function renderModelSelect() {
  const select = $('modelSelect');
  select.innerHTML = state.channels.map((channel) =>
    `<option value="${esc(channel.key)}">${esc(channel.label)} · ${esc(channel.model)}</option>`
  ).join('');
  if (!state.model || !state.channels.some((channel) => channel.key === state.model)) state.model = state.channels[0]?.key || '';
  select.value = state.model;
}

function renderRecent() {
  const list = $('recentPapers');
  if (!state.recent.length) {
    list.innerHTML = '<div class="pr-empty-note">暂无最近打开的论文</div>';
    return;
  }
  list.innerHTML = state.recent.slice(0, 20).map((paper) => `
    <button type="button" data-sid="${esc(paper.source_id)}">
      <code>${esc(paper.arxiv_id || paper.source_id)}</code>
      <span>${esc(paper.title || '未命名论文')}</span>
      <i data-lucide="arrow-up-right"></i>
    </button>`).join('');
  list.querySelectorAll('[data-sid]').forEach((button) => button.addEventListener('click', () => {
    $('openDialog').close();
    openPaper(button.dataset.sid);
  }));
  refreshIcons(list);
}

function showOpenDialog() {
  const dialog = $('openDialog');
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => {
    $('openInput').focus();
    $('openInput').select();
  });
}

async function bootstrap() {
  refreshIcons();
  try {
    const result = await call({ action: 'bootstrap' });
    state.channels = result.channels || [];
    state.model = localStorage.getItem('pr-model') || result.default_model || state.channels[0]?.key || '';
    state.recent = result.papers || [];
    renderModelSelect();
    renderRecent();
    setLoading('', false);
    const sourceId = new URLSearchParams(location.search).get('id');
    if (sourceId) await openPaper(sourceId);
    else showOpenDialog();
  } catch (error) {
    $('prLoadingText').textContent = `加载失败：${error.message}`;
    toast(`加载失败：${error.message}`, true);
  }
}

function resolveUrl(raw, sourceId) {
  if (!raw || raw.startsWith('#') || raw.startsWith('data:') || raw.startsWith('mailto:')) return raw;
  try { return new URL(raw, `https://arxiv.org/html/${sourceId}/`).href; }
  catch { return raw; }
}

function normalizePaperDom(body, paper) {
  body.querySelectorAll('.ltx_title_document, .ltx_authors, .ltx_abstract').forEach((node) => node.remove());
  const documentNode = body.querySelector('.ltx_document');
  if (documentNode) {
    const titleKey = String(paper.title || '').replace(/\s+/g, ' ').trim().slice(0, 64).toLowerCase();
    for (const child of [...documentNode.children]) {
      if (child.matches('section, .ltx_bibliography')) break;
      const childText = child.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
      if (titleKey.length > 20 && childText.includes(titleKey)) child.remove();
    }
  }
  body.querySelectorAll('[style]').forEach((node) => node.removeAttribute('style'));
  body.querySelectorAll('[src]').forEach((node) => node.setAttribute('src', resolveUrl(node.getAttribute('src'), paper.arxiv_id || paper.source_id)));
  body.querySelectorAll('a[href]').forEach((node) => node.setAttribute('href', resolveUrl(node.getAttribute('href'), paper.arxiv_id || paper.source_id)));
  body.querySelectorAll('a[href^="http"]').forEach((node) => { node.target = '_blank'; node.rel = 'noopener'; });
  body.querySelectorAll('table').forEach((table) => {
    const parent = table.parentElement;
    if (parent && !parent.classList.contains('ltx_table') && !parent.classList.contains('ltx_tabular')) parent.classList.add('ltx_table');
  });
}

function hashText(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableParagraphId(element) {
  let heading = element.previousElementSibling;
  while (heading && !/^H[2-4]$/.test(heading.tagName)) heading = heading.previousElementSibling;
  const context = `${heading?.textContent || ''}|${element.tagName}|${element.textContent.trim().slice(0, 420)}`;
  return `p-${hashText(context.replace(/\s+/g, ' ').trim())}`;
}

function prepareParagraphs(body) {
  const candidates = [...body.querySelectorAll('p, h2, h3, h4, li, blockquote, figure')]
    .filter((element) => element.textContent.trim().length > 2 && !element.closest('figcaption'));
  candidates.forEach((element, index) => {
    element.dataset.pid = stableParagraphId(element);
    element.dataset.legacyPid = String(index);
    element.addEventListener('click', onParagraphClick);
  });
}

function uniqueHeadingId(text, index) {
  return `section-${index}-${hashText(text.slice(0, 160))}`;
}

function buildOutline() {
  const list = $('outlineList');
  const headings = [...$('paperBody').querySelectorAll('h2, h3')].filter((heading) => heading.textContent.trim());
  headings.forEach((heading, index) => { heading.id = uniqueHeadingId(heading.textContent.trim(), index); });
  list.innerHTML = `<button class="is-active" type="button" data-target="paperTop" data-level="2"><span>开始阅读</span></button>` + headings.map((heading) => `
    <button type="button" data-target="${esc(heading.id)}" data-level="${heading.tagName === 'H3' ? '3' : '2'}">
      <span>${esc(heading.textContent.trim().replace(/\s+/g, ' ').slice(0, 100))}</span>
    </button>`).join('');
  list.querySelectorAll('[data-target]').forEach((button) => button.addEventListener('click', () => {
    document.getElementById(button.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    closeOutline();
  }));
  state.headingObserver?.disconnect();
  const observed = [$('paperTop'), ...headings];
  state.headingObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!visible) return;
    list.querySelectorAll('button').forEach((button) => button.classList.toggle('is-active', button.dataset.target === visible.target.id));
  }, { rootMargin: '-90px 0px -72% 0px', threshold: [0, 1] });
  observed.forEach((heading) => state.headingObserver.observe(heading));
}

async function openPaper(input) {
  const value = String(input ?? $('openInput').value).trim();
  if (!value) { toast('请输入 arXiv ID 或链接', true); return; }
  $('openInput').value = value;
  $('openDialog').close();
  setLoading('正在获取并整理论文全文', true);
  try {
    const result = await call({ action: 'open_paper', arxiv_id: value });
    renderPaper(result.paper);
    await Promise.all([loadNotes(result.paper.source_id), loadComments(result.paper.source_id), loadRuns(result.paper.source_id, { restore: true })]);
    switchPane('chat', false);
    history.replaceState(null, '', `${location.pathname}?id=${encodeURIComponent(result.paper.source_id)}`);
    setLoading('', false);
    toast('论文已载入');
    restoreReadingPosition(result.paper.source_id);
  } catch (error) {
    setLoading('', false);
    toast(`打开失败：${error.message}`, true);
  }
}

function renderPaper(paper) {
  state.paper = paper;
  state.anchor = null;
  state.activeParagraph = null;
  state.pdfUrl = null;
  state.currentView = 'text';
  $('readerEmpty').hidden = true;
  $('viewbar').hidden = false;
  $('paper').hidden = false;
  $('pdfView').hidden = true;
  $('currentPaperMeta').hidden = false;
  $('readProgress').hidden = false;
  $('paperTitle').textContent = paper.title || '未命名论文';
  $('paperAuthors').textContent = paper.authors || '作者信息不可用';
  $('paperAbstract').textContent = paper.abstract || '摘要不可用';
  $('paperArxiv').textContent = `ARXIV ${paper.arxiv_id || paper.source_id}`;
  $('topPaperId').textContent = paper.arxiv_id || paper.source_id;
  $('topPaperTitle').textContent = paper.title || '';
  $('pdfTitle').textContent = paper.title || '';
  $('paperLink').href = `https://arxiv.org/abs/${encodeURIComponent(paper.arxiv_id || paper.source_id)}`;
  $('anchorBar').hidden = true;
  const body = $('paperBody');
  body.innerHTML = sanitizeFragment(paper.html || '<p>未取得全文 HTML，可以切换到 PDF 阅读。</p>');
  normalizePaperDom(body, paper);
  prepareParagraphs(body);
  buildOutline();
  $('transcript').innerHTML = '';
  renderChatEmpty();
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('is-active', button.dataset.view === 'text'));
  renderMath(body);
  refreshIcons();
  updateProgress();
}

async function setView(view) {
  state.currentView = view;
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));
  if (view === 'text') {
    $('paper').hidden = false;
    $('pdfView').hidden = true;
    return;
  }
  $('paper').hidden = true;
  $('pdfView').hidden = false;
  if (!state.paper) return;
  if (state.pdfUrl) {
    $('pdfFrame').src = state.pdfUrl;
    $('pdfFrame').hidden = false;
    $('pdfMsg').hidden = true;
    return;
  }
  $('pdfFrame').hidden = true;
  $('pdfExtLink').hidden = true;
  $('pdfMsg').hidden = false;
  $('pdfMsg').textContent = '正在加载 PDF…';
  try {
    const result = await call({ action: 'get_paper_pdf', source_id: state.paper.source_id });
    if (result.too_large) {
      $('pdfMsg').textContent = `PDF 大小约 ${Math.round(result.bytes / 1024 / 1024)} MB，请在新窗口中阅读。`;
      $('pdfExtLink').href = result.url;
      $('pdfExtLink').hidden = false;
    } else {
      const blob = await (await fetch(`data:${result.mime || 'application/pdf'};base64,${result.pdf_base64}`)).blob();
      state.pdfUrl = URL.createObjectURL(blob);
      $('pdfFrame').src = state.pdfUrl;
      $('pdfFrame').hidden = false;
      $('pdfMsg').hidden = true;
    }
  } catch (error) {
    $('pdfMsg').textContent = `PDF 加载失败：${error.message}`;
  }
}

function setAnchor(element, quote) {
  document.querySelectorAll('.pr-paper-body .is-anchor').forEach((node) => node.classList.remove('is-anchor'));
  if (element) element.classList.add('is-anchor');
  state.anchor = { pid: element?.dataset.pid || '', quote: quote.slice(0, 2000) };
  $('anchorText').textContent = state.anchor.quote;
  $('anchorBar').hidden = false;
}

function onParagraphClick(event) {
  if (event.target.closest('a, button, .pr-pbadge') || window.getSelection()?.toString().trim()) return;
  const element = event.currentTarget;
  const quote = element.textContent.trim();
  if (!quote) return;
  setAnchor(element, quote);
  toast('已将该段加入提问上下文');
}

function commentCountFor(element) {
  return Number(state.commentCounts[element.dataset.pid] || state.commentCounts[element.dataset.legacyPid] || 0);
}

function renderBadges() {
  document.querySelectorAll('.pr-paper-body [data-pid]').forEach((element) => {
    let badge = [...element.children].find((child) => child.classList?.contains('pr-pbadge'));
    if (!badge) {
      badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'pr-pbadge';
      badge.title = '段落讨论';
      badge.setAttribute('aria-label', '段落讨论');
      element.appendChild(badge);
    }
    const count = commentCountFor(element);
    badge.innerHTML = `<i data-lucide="message-circle"></i>${count ? `<b>${count}</b>` : ''}`;
    badge.classList.toggle('has-comments', count > 0);
    badge.onclick = (event) => {
      event.stopPropagation();
      openThread(element.dataset.pid, element.dataset.legacyPid, element.textContent.trim().slice(0, 1600), element);
    };
  });
  refreshIcons($('paperBody'));
}

async function loadComments(sourceId) {
  try {
    const result = await call({ action: 'list_comments', source_id: sourceId });
    state.comments = result.items || [];
    state.commentCounts = result.counts || {};
  } catch {
    state.comments = [];
    state.commentCounts = {};
  }
  renderBadges();
  if (!$('paneThread').hidden) renderThreadComments();
}

function openThread(pid, legacyPid, quote, element = null) {
  state.activeParagraph = { pid, legacyPid, quote };
  setAnchor(element, quote);
  $('threadQuote').textContent = quote;
  document.querySelectorAll('.pr-side-tabs button').forEach((button) => button.classList.remove('is-active'));
  $('paneChat').hidden = true;
  $('paneNotes').hidden = true;
  $('paneThread').hidden = false;
  renderThreadComments();
  openSide();
  $('commentInput').focus();
}

function matchingComments() {
  if (!state.activeParagraph) return [];
  return state.comments.filter((comment) => String(comment.pid) === state.activeParagraph.pid || String(comment.pid) === state.activeParagraph.legacyPid);
}

function renderThreadComments() {
  const list = $('threadComments');
  const items = matchingComments();
  if (!items.length) {
    list.innerHTML = '<div class="pr-empty-note"><i data-lucide="messages-square"></i><br>这里还没有讨论</div>';
    refreshIcons(list);
    return;
  }
  list.innerHTML = items.map((comment) => `
    <article class="pr-comment">
      <div class="pr-comment-meta"><span>${esc(comment.created_by)}</span><span>${esc((comment.created_at || '').slice(0, 16))}</span><button class="pr-icon-action" type="button" data-del-comment="${esc(comment.id)}" title="删除评论" aria-label="删除评论"><i data-lucide="trash-2"></i></button></div>
      <div class="pr-comment-body">${renderMd(comment.content)}</div>
    </article>`).join('');
  list.querySelectorAll('[data-del-comment]').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm('删除这条评论？')) return;
    try { await call({ action: 'delete_comment', id: button.dataset.delComment }); await loadComments(state.paper.source_id); }
    catch (error) { toast(`删除失败：${error.message}`, true); }
  }));
  list.querySelectorAll('.pr-comment-body').forEach(enhanceRichContent);
  refreshIcons(list);
}

async function addComment(event) {
  event.preventDefault();
  if (!state.activeParagraph || !state.paper) return;
  const content = $('commentInput').value.trim();
  if (!content) return;
  try {
    await call({ action: 'add_comment', source_id: state.paper.source_id, pid: state.activeParagraph.pid, content });
    $('commentInput').value = '';
    await loadComments(state.paper.source_id);
  } catch (error) { toast(`评论失败：${error.message}`, true); }
}

function closeThread() {
  state.activeParagraph = null;
  switchPane(state.activeSideTab || 'chat', false);
}

async function loadRuns(sourceId, { restore = false } = {}) {
  try {
    const [runsResult, conversationResult] = await Promise.all([
      call({ action: 'list_runs', source_id: sourceId, limit: 100 }),
      call({ action: 'list_conversation', source_id: sourceId, limit: 100 })
    ]);
    state.runs = runsResult.items || [];
    state.conversation = conversationResult.items || [];
    state.conversationHasMore = Boolean(conversationResult.has_more);
  } catch {
    state.runs = [];
    state.conversation = [];
    state.conversationHasMore = false;
  }
  if (restore) renderConversation();
  else if (!$('transcript').querySelector('.pr-msg')) renderChatEmpty();
}

function cleanStoredReply(value) {
  const match = String(value || '').match(/<further-answering>([\s\S]*?)<\/further-answering>/i);
  return match ? match[1].trim() : String(value || '').trim();
}

function sessionEventParts(entry) {
  const content = Array.isArray(entry?.message?.content) ? entry.message.content : [];
  return content.filter((part) => part && typeof part === 'object');
}

function classifySessionEvents(entries = [], hostStatus = null) {
  const steps = [
    { id: 'submitted', label: '问题已提交' },
    { id: 'session', label: '精读 Session 已创建' }
  ];
  const seen = new Set(steps.map((step) => step.id));
  const add = (id, label, timestamp) => {
    if (seen.has(id)) return;
    seen.add(id);
    steps.push({ id, label, timestamp });
  };
  for (const entry of entries) {
    for (const part of sessionEventParts(entry)) {
      if (part.type !== 'tool_use') continue;
      const name = String(part.name || '').toLowerCase();
      const detail = (() => { try { return JSON.stringify(part.input || {}).toLowerCase(); } catch { return ''; } })();
      const signal = `${name} ${detail}`;
      if (/update\s+agent_runs|web_reply|write.*answer|final.*reply/.test(signal)) {
        add('writeback', '整理并写入最终回答', entry.timestamp);
      } else if (/websearch|webfetch|browser|search|fetch|curl\s+https?:/.test(signal)) {
        add('research', '检索关联资料与论文线索', entry.timestamp);
      } else if (/\bread\b|\brg\b|grep|\bsed\b|\bcat\b|\bhead\b|\btail\b|pdf|arxiv|paper|source_id|sqlite|agent_runs/.test(signal)) {
        add('reading', '读取论文与相关上下文', entry.timestamp);
      } else {
        add('analysis', '执行论文分析步骤', entry.timestamp);
      }
    }
    if (entry?.type === 'assistant' && sessionEventParts(entry).some((part) => part.type === 'text' && String(part.text || '').trim())) {
      add('compose', '形成阶段性分析', entry.timestamp);
    }
  }
  if (hostStatus?.failed) add('error', '执行遇到错误', hostStatus.failed_at);
  return steps;
}

function formatElapsed(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
}

function renderRunProgress(pending, progress) {
  const steps = classifySessionEvents(progress.entries, progress.hostStatus);
  const activeIndex = steps.length - 1;
  const status = progress.hostStatus?.failed ? '执行失败' : progress.hostStatus?.working === false ? '等待回答写回' : 'Agent 正在工作';
  const eventCount = Number(progress.historyTotal || progress.entries.length || 0);
  pending.querySelector('.body').innerHTML = `<div class="pr-run-progress${progress.hostStatus?.failed ? ' is-error' : ''}">
    <div class="pr-run-head"><span class="pr-run-pulse"></span><div><strong>${esc(status)}</strong><small>${esc(formatElapsed(progress.startedAt))}</small></div></div>
    <ol class="pr-run-steps">${steps.map((step, index) => `<li class="pr-run-step${index < activeIndex ? ' is-done' : ' is-active'}"><i>${index < activeIndex ? '✓' : ''}</i><span>${esc(step.label)}</span></li>`).join('')}</ol>
    <div class="pr-run-meta"><span>${eventCount ? `已接收 ${eventCount} 个运行事件` : '正在等待首个运行事件'}</span>${progress.sessionUrl ? `<a class="session" href="${esc(progress.sessionUrl)}" target="_blank" rel="noopener">打开 Session</a>` : ''}</div>
  </div>`;
}

function renderChatEmpty() {
  if (!state.paper) return;
  const transcript = $('transcript');
  const completed = state.runs.filter((run) => run.status === 'completed' || run.web_reply).slice(0, 5);
  transcript.innerHTML = `<div class="pr-chat-empty">
    <div class="ce-mark"><i data-lucide="sparkles"></i></div>
    <p class="ce-title">和论文进行一次真正的对话</p>
    <p class="ce-copy">从一个关键问题开始。</p>
    ${SUGGESTIONS.map((suggestion) => `<button class="pr-suggest" type="button" data-question="${esc(suggestion)}"><span>${esc(suggestion)}</span><i data-lucide="arrow-up-right"></i></button>`).join('')}
    ${completed.length ? `<div class="pr-history"><div class="pr-history-title"><span>RECENT CONVERSATIONS</span><span>${completed.length}</span></div>${completed.map((run) => `<button type="button" data-run-id="${esc(run.id)}"><span>${esc(run.summary || cleanStoredReply(run.web_reply).slice(0, 80) || '历史问答')}</span><small>${esc((run.created_at || '').slice(5, 10))}</small></button>`).join('')}</div>` : ''}
  </div>`;
  transcript.querySelectorAll('[data-question]').forEach((button) => button.addEventListener('click', () => {
    $('chatInput').value = button.dataset.question;
    sendChat();
  }));
  transcript.querySelectorAll('[data-run-id]').forEach((button) => button.addEventListener('click', () => restoreRun(button.dataset.runId)));
  refreshIcons(transcript);
}

function renderConversation() {
  const transcript = $('transcript');
  transcript.innerHTML = '';
  if (!state.conversation.length) {
    renderChatEmpty();
    return;
  }
  const marker = document.createElement('div');
  marker.className = 'pr-conversation-marker';
  marker.innerHTML = `<i data-lucide="history"></i><span>已恢复这篇论文的 ${state.conversation.length} 轮问答</span>${state.conversationHasMore ? '<small>仅显示最近 100 轮</small>' : ''}`;
  transcript.appendChild(marker);
  for (const turn of state.conversation) {
    if (turn.question) addMessage('user', turn.question, false, '');
    if (turn.answer) addMessage('assistant', cleanStoredReply(turn.answer), false, turn.run_id);
  }
  transcript.scrollTop = transcript.scrollHeight;
  refreshIcons(marker);
}

async function restoreRun(runId) {
  const run = state.runs.find((item) => item.id === runId);
  try {
    const result = await call({ action: 'get_run_messages', run_id: runId });
    $('transcript').innerHTML = '';
    for (const message of result.items || []) addMessage(message.role, message.content, false, message.role === 'assistant' ? runId : '');
    if (!(result.items || []).some((message) => message.role === 'assistant') && run?.web_reply) addMessage('assistant', cleanStoredReply(run.web_reply), false, runId);
    if (!(result.items || []).length && run?.web_reply) addMessage('assistant', cleanStoredReply(run.web_reply), false, runId);
  } catch (error) { toast(`恢复会话失败：${error.message}`, true); }
}

function attachAssistantActions(message, runId) {
  if (!message || !runId || message.querySelector('.pr-msg-actions')) return;
  message.dataset.runId = runId;
  const actions = document.createElement('div');
  actions.className = 'pr-msg-actions';
  actions.innerHTML = `<button type="button" class="pr-msg-action" title="让 Agent 提炼本轮关键信息并写入笔记"><i data-lucide="notebook-pen"></i><span>Agent 沉淀</span></button><div class="pr-distill-status" hidden></div>`;
  const button = actions.querySelector('button');
  button.addEventListener('click', () => distillMessageToNote(message, runId, button));
  message.appendChild(actions);
  refreshIcons(actions);
}

function renderDistillStatus(element, progress, label = '') {
  if (!element) return;
  element.hidden = false;
  const steps = classifySessionEvents(progress.entries, progress.hostStatus);
  const stageLabels = {
    '问题已提交': '沉淀请求已提交', '精读 Session 已创建': '沉淀 Session 已创建',
    '读取论文与相关上下文': '核对对话与论文上下文', '检索关联资料与论文线索': '核对论文证据',
    '执行论文分析步骤': '提炼关键机制与启发', '形成阶段性分析': '组织结构化研究笔记',
    '整理并写入最终回答': '整理并写入研究笔记'
  };
  const inferred = steps.at(-1)?.label || '';
  const current = label || stageLabels[inferred] || inferred || 'Agent 正在提炼关键信息';
  const count = Number(progress.historyTotal || progress.entries.length || 0);
  element.innerHTML = `<span class="pr-distill-pulse"></span><span>${esc(current)}</span><small>${esc(formatElapsed(progress.startedAt))}${count ? ` · ${count} 个事件` : ''}</small>${progress.sessionUrl ? `<a href="${esc(progress.sessionUrl)}" target="_blank" rel="noopener" title="打开沉淀 Session"><i data-lucide="external-link"></i></a>` : ''}`;
  refreshIcons(element);
}

async function finishDistill(message, button, note) {
  button.disabled = true;
  button.classList.remove('is-working');
  button.classList.add('is-saved');
  button.innerHTML = '<i data-lucide="check"></i><span>已沉淀</span>';
  const status = message.querySelector('.pr-distill-status');
  if (status) { status.classList.remove('is-error'); status.hidden = false; status.innerHTML = '<i data-lucide="check-circle-2"></i><span>研究笔记已写入</span>'; }
  refreshIcons(message);
  await loadNotes(state.paper.source_id);
  switchPane('notes');
  toast(note?.note ? 'Agent 笔记已沉淀' : '该轮对话已沉淀');
}

function pollDistillRun(runId, message, button, { sessionId = '', sessionUrl = '' } = {}) {
  let attempts = 0;
  let transientFailures = 0;
  const status = message.querySelector('.pr-distill-status');
  status?.classList.remove('is-error');
  const progress = { startedAt: Date.now(), entries: [], historyFrom: 0, historyTotal: 0, hostStatus: null, sessionUrl };
  renderDistillStatus(status, progress, 'Agent 正在提炼关键信息');
  const tick = async () => {
    attempts += 1;
    try {
      const [result, hostStatus, history] = await Promise.all([
        call({ action: 'poll_run', run_id: runId }),
        sessionId ? hostCall(`/api/sessions/${encodeURIComponent(sessionId)}/status`).catch(() => null) : null,
        sessionId ? hostCall(`/api/sessions/${encodeURIComponent(sessionId)}/jsonl-history?from=${progress.historyFrom}&limit=160`).catch(() => null) : null
      ]);
      const run = result.run;
      transientFailures = 0;
      progress.hostStatus = hostStatus;
      if (history?.entries?.length) progress.entries.push(...history.entries);
      if (history) progress.historyFrom = Number(history.from || 0) + Number(history.returned || 0);
      progress.historyTotal = history?.total || progress.historyTotal;
      progress.sessionUrl = run.session_url || progress.sessionUrl;
      if (run.note) return finishDistill(message, button, run.note);
      if (run.status === 'error' || hostStatus?.failed) {
        const error = new Error(run.summary || hostStatus?.failed_reason || 'Agent 提炼失败');
        error.fatal = true;
        throw error;
      }
      renderDistillStatus(status, progress);
    } catch (error) {
      transientFailures += 1;
      if (!error.fatal && transientFailures < 3) {
        renderDistillStatus(status, progress, '连接波动，正在重试');
        if (message.isConnected && button.classList.contains('is-working')) setTimeout(tick, 3000);
        return;
      }
      button.disabled = false;
      button.classList.remove('is-working');
      if (status) { status.hidden = false; status.textContent = `沉淀失败：${error.message}`; status.classList.add('is-error'); }
      toast(`沉淀失败：${error.message}`, true);
      return;
    }
    if (attempts < 600 && message.isConnected && button.classList.contains('is-working')) setTimeout(tick, 3000);
  };
  setTimeout(tick, 350);
}

async function distillMessageToNote(message, sourceRunId, button) {
  if (!state.paper || button.disabled) return;
  button.disabled = true;
  button.classList.add('is-working');
  button.innerHTML = '<i data-lucide="loader-circle"></i><span>正在提炼</span>';
  refreshIcons(button);
  const status = message.querySelector('.pr-distill-status');
  status?.classList.remove('is-error');
  const progress = { startedAt: Date.now(), entries: [], historyTotal: 0, hostStatus: null, sessionUrl: '' };
  renderDistillStatus(status, progress, '正在创建沉淀 Session');
  try {
    const result = await call({ action: 'distill_chat_to_note', run_id: sourceRunId, model_key: state.model });
    if (result.note) return finishDistill(message, button, result.note);
    if (result.async && result.run_id) return pollDistillRun(result.run_id, message, button, { sessionId: result.session_id, sessionUrl: result.session_url });
    throw new Error(result.error || '没有创建沉淀任务');
  } catch (error) {
    button.disabled = false;
    button.classList.remove('is-working');
    button.innerHTML = '<i data-lucide="notebook-pen"></i><span>Agent 沉淀</span>';
    if (status) { status.hidden = false; status.textContent = `沉淀失败：${error.message}`; status.classList.add('is-error'); }
    refreshIcons(message);
    toast(`沉淀失败：${error.message}`, true);
  }
}

function addMessage(role, text, pending = false, runId = '') {
  const transcript = $('transcript');
  transcript.querySelector('.pr-chat-empty')?.remove();
  const message = document.createElement('article');
  message.className = `pr-msg ${role}${pending ? ' pending' : ''}`;
  const agentLabel = state.channels.find((channel) => channel.key === state.model)?.label || 'Assistant';
  message.innerHTML = `<div class="role"><i>${role === 'user' ? '你' : 'AI'}</i><span>${role === 'user' ? '你的问题' : esc(agentLabel)}</span></div><div class="body">${role === 'assistant' ? renderMd(text) : esc(text).replace(/\n/g, '<br>')}</div>`;
  transcript.appendChild(message);
  if (role === 'assistant' && !pending) {
    enhanceRichContent(message.querySelector('.body'));
    attachAssistantActions(message, runId);
  }
  transcript.scrollTop = transcript.scrollHeight;
  return message;
}

async function sendChat() {
  if (!state.paper) { toast('请先打开论文', true); return; }
  const text = $('chatInput').value.trim();
  if (!text) return;
  $('chatInput').value = '';
  addMessage('user', text);
  const pending = addMessage('assistant', '正在阅读相关段落…', true);
  $('chatSend').disabled = true;
  try {
    const result = await call({ action: 'chat_with_paper', source_id: state.paper.source_id, message: text, model_key: state.model, anchor: state.anchor?.quote });
    if (result.async && result.run_id) {
      pollRun(result.run_id, pending, { sessionId: result.session_id, sessionUrl: result.session_url });
    } else if (result.reply) {
      pending.querySelector('.body').innerHTML = renderMd(result.reply);
      pending.classList.remove('pending');
      enhanceRichContent(pending.querySelector('.body'));
      attachAssistantActions(pending, result.run_id);
      await loadRuns(state.paper.source_id);
    }
  } catch (error) {
    pending.querySelector('.body').textContent = `回答失败：${error.message}`;
    pending.classList.remove('pending');
    toast(`提问失败：${error.message}`, true);
  } finally { $('chatSend').disabled = false; }
}

function pollRun(runId, pending, { sessionId = '', sessionUrl = '' } = {}) {
  let attempts = 0;
  const progress = { startedAt: Date.now(), entries: [], historyFrom: 0, historyTotal: 0, hostStatus: null, sessionUrl };
  renderRunProgress(pending, progress);
  const tick = async () => {
    attempts += 1;
    try {
      const [result, hostStatus, history] = await Promise.all([
        call({ action: 'poll_run', run_id: runId }),
        sessionId ? hostCall(`/api/sessions/${encodeURIComponent(sessionId)}/status`).catch(() => null) : null,
        sessionId ? hostCall(`/api/sessions/${encodeURIComponent(sessionId)}/jsonl-history?from=${progress.historyFrom}&limit=160`).catch(() => null) : null
      ]);
      const run = result.run;
      progress.hostStatus = hostStatus;
      if (history?.entries?.length) progress.entries.push(...history.entries);
      if (history) progress.historyFrom = Number(history.from || 0) + Number(history.returned || 0);
      progress.historyTotal = history?.total || progress.historyTotal;
      progress.sessionUrl = run.session_url || progress.sessionUrl;
      if (run.web_reply) {
        pending.querySelector('.body').innerHTML = renderMd(cleanStoredReply(run.web_reply));
        pending.classList.remove('pending');
        enhanceRichContent(pending.querySelector('.body'));
        attachAssistantActions(pending, runId);
        await loadRuns(state.paper.source_id);
        return;
      }
      if (run.status === 'error' || hostStatus?.failed) {
        pending.querySelector('.body').textContent = `回答失败：${run.summary || hostStatus?.failed_reason || 'Agent 执行失败'}`;
        pending.classList.remove('pending');
        return;
      }
      renderRunProgress(pending, progress);
    } catch {}
    if (attempts < 600 && pending.isConnected && pending.classList.contains('pending')) setTimeout(tick, 3000);
  };
  setTimeout(tick, 350);
}

async function loadNotes(sourceId) {
  try {
    const result = await call({ action: 'list_notes', source_id: sourceId });
    state.notes = result.items || [];
  } catch { state.notes = []; }
  renderNotes();
  markNoteParagraphs();
}

function noteKind(note) {
  return NOTE_LABELS[note.color] ? note.color : 'insight';
}

function renderNotes() {
  $('notesCount').textContent = state.notes.length;
  const list = $('notesList');
  if (!state.notes.length) {
    list.innerHTML = '<div class="pr-empty-note"><i data-lucide="notebook-pen"></i><br>这里还没有研究笔记</div>';
    refreshIcons(list);
    return;
  }
  list.innerHTML = state.notes.map((note) => {
    const kind = noteKind(note);
    return `<article class="pr-note" data-kind="${kind}" data-note-id="${esc(note.id)}">
      <div class="pr-note-head"><span>${NOTE_LABELS[kind]}</span><div class="pr-note-tools">
        ${note.quote ? `<button type="button" data-locate-note="${esc(note.id)}" title="定位原文" aria-label="定位原文"><i data-lucide="locate-fixed"></i></button>` : ''}
        <button type="button" data-edit-note="${esc(note.id)}" title="编辑笔记" aria-label="编辑笔记"><i data-lucide="pencil"></i></button>
        <button type="button" data-delete-note="${esc(note.id)}" title="删除笔记" aria-label="删除笔记"><i data-lucide="trash-2"></i></button>
      </div></div>
      ${note.quote ? `<blockquote class="quote">${esc(note.quote.slice(0, 360))}</blockquote>` : ''}
      <div class="body">${renderMd(note.note || '')}</div>
    </article>`;
  }).join('');
  list.querySelectorAll('.pr-note .body').forEach(enhanceRichContent);
  list.querySelectorAll('[data-locate-note]').forEach((button) => button.addEventListener('click', () => locateNote(button.dataset.locateNote)));
  list.querySelectorAll('[data-edit-note]').forEach((button) => button.addEventListener('click', () => openNoteEditor(state.notes.find((note) => note.id === button.dataset.editNote))));
  list.querySelectorAll('[data-delete-note]').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm('删除这条笔记？')) return;
    try { await call({ action: 'delete_note', id: button.dataset.deleteNote }); await loadNotes(state.paper.source_id); toast('笔记已删除'); }
    catch (error) { toast(`删除失败：${error.message}`, true); }
  }));
  refreshIcons(list);
}

function markNoteParagraphs() {
  document.querySelectorAll('.pr-paper-body .has-note').forEach((node) => node.classList.remove('has-note'));
  const quotes = state.notes.map((note) => String(note.quote || '').trim()).filter(Boolean);
  document.querySelectorAll('.pr-paper-body [data-pid]').forEach((element) => {
    const text = element.textContent.trim();
    if (quotes.some((quote) => text.startsWith(quote.slice(0, 80)))) element.classList.add('has-note');
  });
}

function locateNote(noteId) {
  const note = state.notes.find((item) => item.id === noteId);
  if (!note?.quote) return toast('这条笔记没有绑定原文', true);
  const element = [...document.querySelectorAll('.pr-paper-body [data-pid]')].find((node) => node.textContent.trim().startsWith(note.quote.trim().slice(0, 80)));
  if (!element) return toast('原文位置已变化，无法精确定位', true);
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setAnchor(element, element.textContent.trim());
}

function setNoteKind(kind) {
  state.noteKind = kind;
  document.querySelectorAll('[data-note-kind]').forEach((button) => button.classList.toggle('is-active', button.dataset.noteKind === kind));
}

function openNoteEditor(note = null, quote = '') {
  if (!state.paper) return toast('请先打开论文', true);
  state.editingNote = note;
  const resolvedQuote = note?.quote || quote || state.anchor?.quote || '';
  $('noteEditorTitle').textContent = note ? '编辑锚定笔记' : '新建锚定笔记';
  $('noteQuote').textContent = resolvedQuote || '整篇论文';
  $('noteInput').value = note?.note || '';
  $('noteForm').hidden = false;
  $('noteForm').dataset.quote = resolvedQuote;
  setNoteKind(note ? noteKind(note) : 'insight');
  switchPane('notes');
  $('noteInput').focus();
}

function closeNoteEditor() {
  state.editingNote = null;
  $('noteForm').hidden = true;
  $('noteInput').value = '';
}

async function saveNote(event) {
  event.preventDefault();
  const content = $('noteInput').value.trim();
  if (!content) return toast('请输入笔记内容', true);
  try {
    await call({
      action: 'save_note', source_id: state.paper.source_id, id: state.editingNote?.id,
      quote: $('noteForm').dataset.quote || '', note: content, color: state.noteKind
    });
    closeNoteEditor();
    await loadNotes(state.paper.source_id);
    toast('笔记已保存');
  } catch (error) { toast(`保存失败：${error.message}`, true); }
}

function switchPane(name, open = true) {
  state.activeSideTab = name;
  document.querySelectorAll('.pr-side-tabs button').forEach((button) => button.classList.toggle('is-active', button.dataset.sideTab === name));
  $('paneChat').hidden = name !== 'chat';
  $('paneNotes').hidden = name !== 'notes';
  $('paneThread').hidden = true;
  if (open) openSide();
}

function isDrawerMode() { return window.matchMedia('(max-width: 900px)').matches; }

function syncBackdrop() {
  const shell = $('appShell');
  $('backdrop').hidden = !(isDrawerMode() && (shell.classList.contains('is-side-open') || shell.classList.contains('is-outline-open')));
}

function openSide() {
  const shell = $('appShell');
  if (isDrawerMode()) shell.classList.add('is-side-open');
  else shell.classList.remove('is-side-closed');
  syncBackdrop();
}

function closeSide() {
  const shell = $('appShell');
  if (isDrawerMode()) shell.classList.remove('is-side-open');
  else shell.classList.add('is-side-closed');
  syncBackdrop();
}

function toggleSide() {
  const shell = $('appShell');
  if (isDrawerMode()) shell.classList.toggle('is-side-open');
  else shell.classList.toggle('is-side-closed');
  syncBackdrop();
}

function openOutline() {
  $('appShell').classList.add('is-outline-open');
  syncBackdrop();
}

function closeOutline() {
  $('appShell').classList.remove('is-outline-open');
  syncBackdrop();
}

function setupSelectionToolbar() {
  const toolbar = $('selectionToolbar');
  document.addEventListener('mouseup', () => {
    if (!state.paper) return;
    requestAnimationFrame(() => {
      const selection = window.getSelection();
      const quote = selection?.toString().trim() || '';
      if (quote.length < 2 || !selection.rangeCount) { toolbar.hidden = true; return; }
      const range = selection.getRangeAt(0);
      if (!$('paperBody').contains(range.commonAncestorContainer)) { toolbar.hidden = true; return; }
      const rect = range.getBoundingClientRect();
      state.selectedQuote = quote.slice(0, 2000);
      toolbar.style.left = `${Math.max(10, rect.left + window.scrollX + rect.width / 2 - toolbar.offsetWidth / 2)}px`;
      toolbar.style.top = `${Math.max(70, rect.top + window.scrollY - 44)}px`;
      toolbar.hidden = false;
    });
  });
  toolbar.querySelectorAll('[data-selection-action]').forEach((button) => button.addEventListener('click', async () => {
    const action = button.dataset.selectionAction;
    toolbar.hidden = true;
    if (action === 'copy') {
      await navigator.clipboard.writeText(state.selectedQuote);
      toast('已复制选中文本');
      return;
    }
    if (action === 'ask') {
      setAnchor(null, state.selectedQuote);
      switchPane('chat');
      $('chatInput').focus();
      return;
    }
    if (action === 'note') openNoteEditor(null, state.selectedQuote);
  }));
}

function updateProgress() {
  if (!state.paper || state.currentView !== 'text') return;
  const paper = $('paper');
  const top = paper.offsetTop;
  const range = Math.max(1, paper.offsetHeight - window.innerHeight * .65);
  const percent = Math.round(Math.max(0, Math.min(1, (window.scrollY - top + 100) / range)) * 100);
  $('progressLabel').textContent = `${percent}%`;
  $('outlineProgress').textContent = `${percent}%`;
  $('progressBar').style.width = `${percent}%`;
  $('outlineProgressBar').style.width = `${percent}%`;
  clearTimeout(state.saveScrollTimer);
  state.saveScrollTimer = setTimeout(() => localStorage.setItem(`pr-scroll:${state.paper.source_id}`, String(window.scrollY)), 250);
}

function restoreReadingPosition(sourceId) {
  const stored = Number(localStorage.getItem(`pr-scroll:${sourceId}`) || 0);
  requestAnimationFrame(() => window.scrollTo({ top: Number.isFinite(stored) ? stored : 0, behavior: 'auto' }));
}

function panelBounds(kind) {
  const spec = PANEL_SIZES[kind];
  const other = kind === 'outline' && window.innerWidth > 900 ? state.panelSizes.side : (kind === 'side' && window.innerWidth > 1220 ? state.panelSizes.outline : 0);
  const viewportMax = window.innerWidth - other - 560;
  return { min: spec.min, max: Math.max(spec.min, Math.min(spec.max, viewportMax)) };
}

function applyPanelWidth(kind, desired, persist = false) {
  const spec = PANEL_SIZES[kind];
  const bounds = panelBounds(kind);
  const numeric = Number.isFinite(Number(desired)) ? Number(desired) : spec.default;
  const value = Math.round(Math.max(bounds.min, Math.min(bounds.max, numeric)));
  state.panelSizes[kind] = numeric;
  document.documentElement.style.setProperty(spec.css, `${value}px`);
  const resizer = $(`${kind}Resizer`);
  resizer?.setAttribute('aria-valuenow', String(value));
  resizer?.setAttribute('aria-valuemax', String(bounds.max));
  if (persist) localStorage.setItem(spec.storage, String(Math.round(numeric)));
  return value;
}

function setupPanelResize() {
  const layoutVersion = localStorage.getItem('pr-layout:version');
  const storedSide = Number(localStorage.getItem(PANEL_SIZES.side.storage));
  if (layoutVersion !== '0.4.0' && (!storedSide || storedSide === 400)) {
    localStorage.setItem(PANEL_SIZES.side.storage, String(PANEL_SIZES.side.default));
  }
  localStorage.setItem('pr-layout:version', '0.4.0');
  for (const [kind, spec] of Object.entries(PANEL_SIZES)) {
    const stored = Number(localStorage.getItem(spec.storage));
    state.panelSizes[kind] = Number.isFinite(stored) && stored > 0 ? stored : spec.default;
  }
  applyPanelWidth('outline', state.panelSizes.outline);
  applyPanelWidth('side', state.panelSizes.side);

  const bindResizer = (kind) => {
    const element = $(`${kind}Resizer`);
    if (!element) return;
    let drag = null;
    element.addEventListener('pointerdown', (event) => {
      if ((kind === 'outline' && window.innerWidth <= 1220) || (kind === 'side' && window.innerWidth <= 900)) return;
      drag = { startX: event.clientX, startSize: applyPanelWidth(kind, state.panelSizes[kind]) };
      element.setPointerCapture(event.pointerId);
      document.body.classList.add('is-resizing');
      event.preventDefault();
    });
    element.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const delta = kind === 'outline' ? event.clientX - drag.startX : drag.startX - event.clientX;
      applyPanelWidth(kind, drag.startSize + delta);
    });
    const finish = (event) => {
      if (!drag) return;
      drag = null;
      document.body.classList.remove('is-resizing');
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      applyPanelWidth(kind, state.panelSizes[kind], true);
    };
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', finish);
    element.addEventListener('dblclick', () => applyPanelWidth(kind, spec.default, true));
    element.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const physicalDirection = event.key === 'ArrowRight' ? 1 : -1;
      const direction = kind === 'outline' ? physicalDirection : -physicalDirection;
      applyPanelWidth(kind, applyPanelWidth(kind, state.panelSizes[kind]) + direction * (event.shiftKey ? 32 : 12), true);
    });
  };
  bindResizer('outline');
  bindResizer('side');
}

function bind() {
  setupPanelResize();
  $('openCommand').addEventListener('click', showOpenDialog);
  $('emptyOpen').addEventListener('click', showOpenDialog);
  $('openForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.submitter?.value === 'cancel') return $('openDialog').close();
    openPaper();
  });
  $('modelSelect').addEventListener('change', (event) => { state.model = event.target.value; localStorage.setItem('pr-model', state.model); });
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  document.querySelectorAll('[data-side-tab]').forEach((button) => button.addEventListener('click', () => switchPane(button.dataset.sideTab)));
  $('chatForm').addEventListener('submit', (event) => { event.preventDefault(); sendChat(); });
  $('chatInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendChat(); }
  });
  $('anchorClear').addEventListener('click', () => {
    state.anchor = null;
    $('anchorBar').hidden = true;
    document.querySelectorAll('.pr-paper-body .is-anchor').forEach((node) => node.classList.remove('is-anchor'));
  });
  $('sideToggle').addEventListener('click', toggleSide);
  $('sideClose').addEventListener('click', closeSide);
  $('outlineToggle').addEventListener('click', openOutline);
  $('outlineClose').addEventListener('click', closeOutline);
  $('backdrop').addEventListener('click', () => { closeSide(); closeOutline(); });
  $('threadBack').addEventListener('click', closeThread);
  $('commentForm').addEventListener('submit', addComment);
  $('threadAskAi').addEventListener('click', () => {
    if (!state.activeParagraph) return;
    setAnchor(null, state.activeParagraph.quote);
    switchPane('chat');
    $('chatInput').focus();
  });
  $('newNote').addEventListener('click', () => openNoteEditor());
  $('noteCancel').addEventListener('click', closeNoteEditor);
  $('noteForm').addEventListener('submit', saveNote);
  document.querySelectorAll('[data-note-kind]').forEach((button) => button.addEventListener('click', () => setNoteKind(button.dataset.noteKind)));
  document.querySelectorAll('[data-mobile-action]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.mobileAction === 'outline') return openOutline();
    switchPane(button.dataset.mobileAction);
  }));
  setupSelectionToolbar();
  window.addEventListener('scroll', updateProgress, { passive: true });
  window.addEventListener('resize', () => {
    syncBackdrop();
    applyPanelWidth('outline', state.panelSizes.outline);
    applyPanelWidth('side', state.panelSizes.side);
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); showOpenDialog(); }
    if ((event.metaKey || event.ctrlKey) && event.key === '/') { event.preventDefault(); toggleSide(); }
    if (event.key === 'Escape') { $('selectionToolbar').hidden = true; closeSide(); closeOutline(); }
  });
}

bind();
bootstrap();
