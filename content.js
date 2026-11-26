// ===== 小红书评论获客助手 - 内容脚本 =====
// 职责：在小红书页面执行 DOM 自动化（搜索采集、读取视频信息、拟人化评论发布）
// 说明：小红书 DOM 使用混淆类名，故采用「多候选选择器 + 文本匹配」策略提升兼容性。

(() => {
  if (window.__xhsCommentHelperLoaded) return;
  window.__xhsCommentHelperLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (min, max) => min + Math.random() * (max - min);

  function q(sel, root) {
    try { return (root || document).querySelector(sel); } catch (e) { return null; }
  }
  function qa(sel, root) {
    try { return Array.from((root || document).querySelectorAll(sel)); } catch (e) { return []; }
  }

  function pageType() {
    const u = location.href;
    if (/\/(explore|discovery\/item)\/[0-9a-zA-Z]+/.test(u)) return 'note';
    if (/\/search_result\/[0-9a-zA-Z]+/.test(u)) return 'note'; // 通过搜索进入的单个笔记
    if (u.includes('/search_result')) return 'search';
    if (u.includes('/user/profile')) return 'profile';
    if (location.pathname.indexOf('/chat') === 0) return 'chat';
    return 'other';
  }

  function extractNoteId(url) {
    const m = (url || location.href).match(/\/(?:explore|discovery\/item|search_result)\/([0-9a-zA-Z]+)/);
    return m ? m[1] : '';
  }

  // 解析计数文本："1.2万"→12000、"3456"→3456、"赞 123"→123；解析失败返回 null
  function parseCount(text) {
    const t = (text || '').replace(/[\s,]/g, '');
    const m = t.match(/(\d+(?:\.\d+)?)(万|w|W)?/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (isNaN(n)) return null;
    return m[2] ? Math.round(n * 10000) : Math.round(n);
  }

  // 读取点赞数：多候选选择器依次尝试，取第一个能解析出数字的；取不到返回 null
  function readLikes(root) {
    const cands = [
      q('.like-wrapper .count', root),
      q('[class*="like-wrapper"] [class*="count"]', root),
      q('[class*="like"] [class*="count"]', root),
      q('.count', root)
    ];
    for (const el of cands) {
      if (!el) continue;
      const n = parseCount(el.innerText || el.textContent);
      if (n != null) return n;
    }
    return null;
  }

  // ===== 搜索结果采集 =====
  // 关键：同一笔记在 DOM 里存在多个 <a>，只有带 xsec_token 的链接（cover/title）能正常打开，
  // 不带 token 的 /explore/xxx 空链接会触发 300031「当前笔记暂时无法浏览」。这里优先保留带 token 的链接。
  function noteLinks() {
    const byId = new Map();
    qa('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/(?:explore|discovery\/item|search_result)\/([0-9a-zA-Z]+)/);
      if (!m) return;
      const id = m[1];
      const hasToken = href.indexOf('xsec_token') >= 0;
      const section = a.closest('section') || a.closest('[class*="note-item"]') || a;
      let title = (a.getAttribute('title') || '').trim();
      if (!title) {
        title = (section.innerText || '').trim().slice(0, 80);
      }
      const url = a.href || ('https://www.xiaohongshu.com' + href);
      const likes = readLikes(section);
      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, { id, url, title, hasToken, likes });
      } else {
        // 已有不带 token 的链接，遇到带 token 的则替换
        if (hasToken && !existing.hasToken) {
          existing.url = url;
          existing.hasToken = true;
        }
        if (!existing.title && title) existing.title = title;
        if (existing.likes == null && likes != null) existing.likes = likes;
      }
    });
    return Array.from(byId.values()).map(({ id, url, title, likes }) => ({ id, url, title, likes }));
  }

  async function scrollToLoad(scrollTimes) {
    for (let i = 0; i < scrollTimes; i++) {
      const before = noteLinks().length;
      // 拟人化滚动：整屏的 60%~90%，再小幅度回滚
      window.scrollBy({ top: Math.round(window.innerHeight * rnd(0.6, 0.9)), behavior: 'smooth' });
      await sleep(rnd(1200, 2500));
      if (Math.random() < 0.35) {
        window.scrollBy({ top: -Math.round(window.innerHeight * rnd(0.1, 0.25)), behavior: 'smooth' });
        await sleep(rnd(400, 900));
      }
      const after = noteLinks().length;
      // 若滚动后数量不再增加，说明已到底
      if (i > 2 && after <= before) break;
    }
    return noteLinks().length;
  }

  // ===== 视频信息读取 =====
  function getNoteInfo() {
    const title =
      (q('#detail-title')?.innerText || q('.title')?.innerText || q('h1')?.innerText || '').trim();
    const desc =
      (q('#detail-desc')?.innerText ||
        q('.desc')?.innerText ||
        q('.note-content')?.innerText ||
        q('.note-text')?.innerText ||
        '').trim();
    const author =
      (q('.author-wrapper .username, .author .name, .info .name, .username, .name')?.innerText || '').trim();
    return {
      title,
      desc,
      author,
      likes: readLikes(document),
      url: location.href,
      id: extractNoteId(location.href)
    };
  }

  function collectTopComments(n) {
    const items = [];
    const seen = new Set();
    // 每个 parent-comment 是一条顶层评论（含其回复），取其首个昵称与正文
    let blocks = qa('.parent-comment');
    if (!blocks.length) blocks = qa('.comment-item');
    for (const el of blocks) {
      const name = (q('[class*="name"]', el)?.innerText || q('[class*="author"]', el)?.innerText || q('[class*="user"]', el)?.innerText || '').trim();
      const content = (q('[class*="content"]', el)?.innerText || q('.note-text', el)?.innerText || '').trim();
      if (content && !seen.has(content)) {
        seen.add(content);
        items.push({ name, content });
        if (items.length >= n) break;
      }
    }
    return items;
  }

  async function ensureCommentsVisible() {
    for (let i = 0; i < 8; i++) {
      const found = q('.comments-container, .comment-container, [class*="comment"]');
      // 滚动到底部评论区域
      window.scrollBy({ top: Math.round(window.innerHeight * rnd(0.6, 0.9)), behavior: 'smooth' });
      await sleep(rnd(700, 1400));
      if (found && i >= 2) break;
    }
  }

  function findCommentEditor() {
    return (
      q('.comment-container [contenteditable="true"]') ||
      q('.comment-inner-container [contenteditable="true"]') ||
      q('.comments-container [contenteditable="true"]') ||
      q('.ql-editor[contenteditable="true"]') ||
      q('[class*="comment"] [contenteditable="true"]') ||
      q('[contenteditable="true"]')
    );
  }

  function findSubmitButton(root) {
    const scope = root || document;
    const btns = qa('button, [role="button"], .submit, .publish-btn, [class*="submit"]', scope);
    for (const b of btns) {
      const t = (b.innerText || '').trim();
      if (t === '发送' || t === '评论' || t === '发布' || t === '确定') return b;
    }
    return null;
  }

  function isSubmitDisabled(btn) {
    return (
      btn.hasAttribute('disabled') ||
      btn.disabled === true ||
      btn.getAttribute('aria-disabled') === 'true' ||
      btn.classList.contains('disabled') ||
      btn.classList.contains('btn-disabled')
    );
  }

  async function postComment(text) {
    await ensureCommentsVisible();

    const editor = findCommentEditor();
    if (!editor) {
      // 有些版本需要先点击评论输入占位区
      const placeholder = q('.comment-container .placeholder, [class*="comment"] [class*="placeholder"], .comment-inner-container');
      if (placeholder) {
        placeholder.click();
        await sleep(rnd(500, 1000));
      }
    }
    const editor2 = findCommentEditor();
    if (!editor2) return { ok: false, error: '未找到评论输入框' };

    editor2.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(rnd(400, 800));
    editor2.click();
    editor2.focus();
    await sleep(rnd(300, 600));

    // 清空已有内容
    try { editor2.innerHTML = ''; } catch (e) { /* ignore */ }

    // 逐字模拟打字
    for (const ch of text) {
      document.execCommand('insertText', false, ch);
      editor2.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
      await sleep(rnd(45, 170));
    }
    await sleep(rnd(600, 1200));

    const btn = findSubmitButton();
    if (!btn) return { ok: false, error: '未找到发送按钮' };
    const disabled =
      btn.hasAttribute('disabled') ||
      btn.getAttribute('aria-disabled') === 'true' ||
      btn.classList.contains('disabled') ||
      btn.classList.contains('btn-disabled');
    if (disabled) return { ok: false, error: '发送按钮不可用（可能需要登录或输入内容未生效）' };

    btn.click();
    await sleep(rnd(900, 1600));
    return { ok: true };
  }

  // ===== 评论区：收集评论 / 回复感兴趣的用户 =====

  // 在评论块内找「回复」入口：文本精确为「回复」的最小元素，优先 class 含 reply 的
  function findReplyButton(block) {
    const cands = qa('span, div, a, p, button, [role="button"]', block);
    let fallback = null;
    for (const el of cands) {
      if ((el.innerText || '').trim() !== '回复') continue;
      // 只取最小元素（内部没有同样只显示「回复」的子元素），避免命中外层容器
      const hasSmaller = qa('*', el).some((c) => (c.innerText || '').trim() === '回复');
      if (hasSmaller) continue;
      const cls = el.getAttribute('class') || '';
      if (/reply/i.test(cls)) return el;
      if (!fallback) fallback = el;
    }
    return fallback;
  }

  // 收集顶层评论。index 为在全部 .parent-comment 中的位置（回复时按此定位原评论）；
  // hasReply 标记该评论是否能找到「回复」入口，找不到的后台会跳过不回复。
  function findUserProfile(block) {
    const a = q('a[href*="/user/profile/"]', block);
    if (!a) return null;
    const href = a.href || '';
    const m = href.match(/\/user\/profile\/([0-9a-zA-Z]+)/);
    return { url: href, userId: m ? m[1] : '' };
  }

  function collectComments(max) {
    let blocks = qa('.parent-comment');
    if (!blocks.length) blocks = qa('.comment-item');
    const items = [];
    const seen = new Set();
    for (let i = 0; i < blocks.length; i++) {
      const el = blocks[i];
      const name = (q('[class*="name"]', el)?.innerText || '').trim();
      const content = (q('[class*="content"]', el)?.innerText || q('.note-text', el)?.innerText || '').trim();
      if (!content) continue;
      const key = name + '|' + content;
      if (seen.has(key)) continue;
      seen.add(key);
      const profile = findUserProfile(el);
      items.push({
        index: i,
        name: name || '用户',
        content: content.slice(0, 120),
        hasReply: !!findReplyButton(el),
        userUrl: profile ? profile.url : '',
        userId: profile ? profile.userId : ''
      });
      if (items.length >= max) break;
    }
    return items;
  }

  // 从输入框逐级向上找发送按钮（回复框通常紧挨输入框），找不到再全局找
  function findSubmitNear(el) {
    let scope = el;
    for (let i = 0; i < 4 && scope; i++) {
      const b = findSubmitButton(scope);
      if (b) return b;
      scope = scope.parentElement;
    }
    return findSubmitButton();
  }

  async function replyToComment(index, text) {
    let blocks = qa('.parent-comment');
    if (!blocks.length) blocks = qa('.comment-item');
    const block = blocks[index];
    if (!block) return { ok: false, error: '未找到编号为 ' + index + ' 的评论块' };

    // 先滚动到该评论，模拟真人先看上下文再回复
    block.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(rnd(400, 900));

    const replyBtn = findReplyButton(block);
    if (!replyBtn) return { ok: false, error: '该评论下未找到「回复」入口' };
    replyBtn.click();
    await sleep(rnd(900, 1600));

    // 等待回复输入框出现：优先块内的 contenteditable，其次 placeholder 含「回复」，最后取页面上最后一个
    let editor = null;
    for (let i = 0; i < 8; i++) {
      editor =
        q('[contenteditable="true"]', block) ||
        q('[placeholder*="回复"]') ||
        (qa('[contenteditable="true"]').slice(-1)[0] || null);
      if (editor) break;
      await sleep(rnd(300, 600));
    }
    if (!editor) return { ok: false, error: '回复输入框未出现（可能点击未生效）' };

    // 安全检查：输入框已有内容说明定位错了，中止以防把回复发到别处
    const existing = (editor.innerText || '').trim();
    if (existing) {
      return { ok: false, error: '输入框非空，已中止以防发错：' + existing.slice(0, 20) };
    }

    editor.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(rnd(300, 600));
    editor.click();
    editor.focus();
    await sleep(rnd(300, 600));
    try { editor.innerHTML = ''; } catch (e) { /* ignore */ }

    // 逐字模拟打字
    for (const ch of text) {
      document.execCommand('insertText', false, ch);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
      await sleep(rnd(45, 170));
    }
    await sleep(rnd(600, 1200));

    const btn = findSubmitNear(editor);
    if (!btn) return { ok: false, error: '未找到回复发送按钮' };
    if (isSubmitDisabled(btn)) return { ok: false, error: '回复发送按钮不可用（内容可能未生效）' };

    btn.click();
    await sleep(rnd(900, 1600));
    return { ok: true };
  }

  // ===== 用户主页：给感兴趣的用户发私信 =====
  // 实测（2026-11-19，浏览器验证）：
  // 主页入口文案为「发消息」，但点击它是新开标签页，本页跟不上；
  // background 统一导航 /chat?openUid={userId}（已有会话直接打开，新用户会创建会话），
  // 输入框为 .xhs-im-input-bar-editor，发送按钮为输入栏内无文本图标按钮
  // 私信发送按钮：输入栏（input-bar）内的按钮。小红书用无文本图标按钮，文本匹配找不到
  function findDmSubmitButton() {
    const bar = q('[class*="input-bar"]');
    if (bar) {
      const b = q('button:not([disabled]), [role="button"]:not([disabled])', bar);
      if (b) return b;
    }
    return q('.xhs-im-input-bar-action-btn') || q('[class*="input-bar"] button');
  }

  async function sendPrivateMessage(text) {
    // background 已导航到 /chat?openUid={userId} 并确认处于会话页，这里直接找输入框
    const inChatPage = location.pathname.indexOf('/chat') === 0;
    if (!inChatPage) {
      // 兜底：落在非会话页（如 userId 缺失时退回的主页），从 URL 取 userId 再导航进会话页
      const m = location.pathname.match(/\/user\/profile\/([0-9a-zA-Z]+)/);
      if (m) {
        location.href = 'https://www.xiaohongshu.com/chat?openUid=' + encodeURIComponent(m[1]);
        return { ok: false, error: '不在会话页，已跳转会话页，请重发一次' };
      }
      return { ok: false, error: '不在会话页，且无法从当前 URL 获取 userId' };
    }

    // 等会话输入框出现：优先私信窗口内的 contenteditable，最后兜底取页面最后一个
    let editor = null;
    for (let i = 0; i < 20; i++) {
      editor =
        q('.xhs-im-input-bar-editor') ||
        q('[class*="im-chat"] [contenteditable="true"]') ||
        q('[class*="chat"] [contenteditable="true"]') ||
        q('[placeholder*="私信"]') ||
        q('[placeholder*="发消息"]') ||
        q('[placeholder*="说点什么"]') ||
        (qa('[contenteditable="true"]').slice(-1)[0] || null);
      if (editor) break;
      await sleep(rnd(400, 700));
    }
    if (!editor) return { ok: false, error: '私信输入框未出现（该用户可能不接受私信）' };

    // 安全检查：输入框非空说明定位错了，中止以防发错
    const existing = (editor.innerText || '').trim();
    if (existing) {
      return { ok: false, error: '私信输入框非空，已中止以防发错：' + existing.slice(0, 20) };
    }

    editor.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(rnd(300, 600));
    editor.click();
    editor.focus();
    await sleep(rnd(300, 600));
    try { editor.innerHTML = ''; } catch (e) { /* ignore */ }

    // 逐字模拟打字
    for (const ch of text) {
      document.execCommand('insertText', false, ch);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
      await sleep(rnd(45, 170));
    }
    await sleep(rnd(800, 1400));

    const btn = findDmSubmitButton() || findSubmitNear(editor);
    if (!btn) return { ok: false, error: '未找到私信发送按钮' };
    if (isSubmitDisabled(btn)) return { ok: false, error: '私信发送按钮不可用（内容可能未生效）' };

    // 实测（2026-11-17）：发送按钮 .click() 合成点击不触发发送，Enter 键可靠。
    // 双保险：先点按钮，1.2 秒后输入框仍有内容（未发出）则补发 Enter 键事件。
    btn.click();
    await sleep(rnd(1000, 1300));
    if ((editor.innerText || '').trim()) {
      editor.focus();
      for (const type of ['keydown', 'keypress', 'keyup']) {
        editor.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true, cancelable: true
        }));
      }
      await sleep(rnd(800, 1200));
    }
    return { ok: true };
  }

  // ===== 打开笔记（点击卡片，SPA 跳转，避免冷跳转触发反爬） =====
  // 只接受带 xsec_token 的链接：不带 token 的 /explore/xxx 空链接会触发 300031。
  function findNoteAnchor(id) {
    const anchors = qa('a[href]');
    const re = new RegExp('/(explore|discovery/item|search_result)/' + id + '(\\?|$)');
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      if (re.test(href) && href.indexOf('xsec_token') >= 0) return a;
    }
    return null;
  }

  function noteIdInDom(id) {
    const anchors = qa('a[href]');
    const re = new RegExp('/(explore|discovery/item|search_result)/' + id + '(\\?|$)');
    return anchors.some((a) => re.test(a.getAttribute('href') || ''));
  }

  async function openNote(id) {
    // 从顶部开始找，避免停在中途时上方卡片未渲染
    window.scrollTo({ top: 0, behavior: 'auto' });
    // 先等搜索结果渲染出来（刚整页加载完时卡片是逐步出现的），最多约 8 秒
    for (let i = 0; i < 8; i++) {
      if (qa('a[href*="xsec_token"]').length > 0) break;
      await sleep(rnd(700, 1000));
    }
    // 当前视口找不到就向下滚动加载更多
    for (let i = 0; i < 10; i++) {
      const a = findNoteAnchor(id);
      if (a) {
        a.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await sleep(rnd(300, 700));
        a.click();
        return { ok: true, url: a.href };
      }
      window.scrollBy({ top: Math.round(window.innerHeight * 0.8), behavior: 'smooth' });
      await sleep(rnd(600, 1200));
    }
    // 失败时给出可诊断的原因，方便从日志判断
    const inDom = noteIdInDom(id);
    const tokenCount = qa('a[href*="xsec_token"]').length;
    return {
      ok: false,
      error: '未找到带有效链接的笔记卡片：' + id +
        (inDom ? '（DOM 中该笔记存在但链接缺少 xsec_token）' : '（当前页面未加载到该笔记，token 链接数：' + tokenCount + '）')
    };
  }

  // ===== 视频推广：关注用户 / 分享视频给用户 =====

  function findShareButton() {
    const cands = [
      document.querySelector('[class*="share"]'),
      document.querySelector('[aria-label*="分享"]'),
      document.querySelector('[title*="分享"]'),
      document.querySelector('[data-e2e*="share"]')
    ];
    for (const c of cands) {
      if (!c) continue;
      const t = (c.innerText || c.textContent || '').trim();
      if (t && t.length > 8) continue; // 排除大段文字的元素
      return c;
    }
    return null;
  }

  function findSharePanel() {
    const sels = [
      '.xhs-note-share-popup-container', '.xhs-note-share-popup', '[class*="xhs-note-share-popup"]',
      '[class*="share-panel"]', '[class*="sharePanel"]', '[class*="share-container"]',
      '[class*="shareContainer"]', '[role="dialog"]', '.modal', '[class*="popup"]'
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.getBoundingClientRect().width > 0) return el;
    }
    return null;
  }

  // 转储容器内可点击元素的文本（诊断分享面板结构用）
  function dumpClickableTexts(scope) {
    const out = [];
    const els = (scope || document).querySelectorAll('button, [role="button"], a, span, div, li');
    for (const el of els) {
      const t = (el.innerText || '').trim();
      if (!t || t.length > 24) continue;
      if (out.some((x) => x.text === t)) continue;
      out.push({ text: t, cls: (el.getAttribute('class') || '').slice(0, 50), tag: el.tagName });
      if (out.length >= 40) break;
    }
    return out;
  }

  // 收集所有"可能是分享按钮"的候选（可见、含分享语义）
  function collectShareCandidates() {
    const seen = new Set();
    const out = [];
    const pushEl = (el) => {
      if (!el || seen.has(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return;
      seen.add(el);
      out.push({
        el,
        tag: el.tagName,
        cls: (el.getAttribute('class') || '').slice(0, 80),
        text: (el.innerText || el.textContent || '').trim().slice(0, 30),
        aria: el.getAttribute('aria-label') || el.getAttribute('title') || '',
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      });
    };
    document.querySelectorAll('[class*="share"], [aria-label*="分享"], [title*="分享"], [data-e2e*="share"], [data-testid*="share"]').forEach(pushEl);
    document.querySelectorAll('button, [role="button"], a').forEach((el) => {
      const t = (el.innerText || '').trim();
      if (t && t.length <= 6 && /分享/.test(t)) pushEl(el);
    });
    return out;
  }

  // 页面短文本快照（用于 diff 点击前后变化）
  function snapshotTexts() {
    const set = new Set();
    document.querySelectorAll('button, [role="button"], a, span, div, li, p').forEach((el) => {
      const t = (el.innerText || '').trim();
      if (t && t.length <= 40) set.add(t);
    });
    return set;
  }

  // 浮层签名（cls + 文本前缀），用于点击前后 diff，排除页面原有元素
  function overlaySig(el) {
    const t = (el.innerText || '').trim().slice(0, 40);
    return (el.className || '').toString().slice(0, 40) + '|' + t;
  }
  function snapshotOverlaySigs() {
    const set = new Set();
    document.querySelectorAll('div, section, ul').forEach((el) => {
      const st = getComputedStyle(el);
      if (st.position !== 'fixed' && st.position !== 'absolute') return;
      set.add(overlaySig(el));
    });
    return set;
  }

  // 分享面板特征文本命中检测（强判据）
  function sharePanelSignatures() {
    const sigs = ['分享至', '私信好友', '扫码分享', '微信', '朋友圈', 'QQ空间', 'QQ', '微博', '复制链接', '私信', '发给好友', '分享给好友', '分享链接', '生成海报', '更多分享', '生成图片'];
    const body = document.body.innerText || '';
    return sigs.filter((s) => body.indexOf(s) !== -1);
  }

  // 浮层内可交互项（含 icon-only：看 aria/title/svg）
  function overlayItems(el) {
    const items = [];
    el.querySelectorAll('button, [role="button"], a, [class*="item"], [class*="icon"], svg').forEach((n) => {
      const r = n.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const text = (n.innerText || '').trim().slice(0, 20);
      const aria = n.getAttribute('aria-label') || n.getAttribute('title') || '';
      const cls = (n.className || '').toString().slice(0, 50);
      if (!text && !aria && !cls) return;
      if (items.some((x) => x.text === text && x.aria === aria && x.cls === cls)) return;
      items.push({ tag: n.tagName, text, aria, cls });
    });
    return items.slice(0, 30);
  }

  // 扫描"新出现"的浮层：fixed/absolute 且签名不在 before 集合里（排除页面原有元素），返回含 outerHTML 摘要的铁证
  function scanNewOverlays(beforeSigs) {
    const out = [];
    document.querySelectorAll('div, section, ul').forEach((el) => {
      const st = getComputedStyle(el);
      if (st.position !== 'fixed' && st.position !== 'absolute') return;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) return;
      if (beforeSigs.has(overlaySig(el))) return; // 页面原有，跳过（修复 note-item 假阳性）
      const t = (el.innerText || '').trim();
      out.push({
        text: t.slice(0, 200),
        cls: (el.className || '').toString().slice(0, 60),
        pos: st.position,
        items: overlayItems(el),
        html: (el.outerHTML || '').slice(0, 800)
      });
    });
    return out;
  }

  // 只读探测：逐个尝试全部候选分享按钮，用"点击前后 diff"判断面板是否出现，绝不点发送
  async function probeSharePanel() {
    const cands = collectShareCandidates();
    const tried = [];

    // 全部尝试（不再提前停），每个都记录证据
    for (let i = 0; i < cands.length && i < 6; i++) {
      const c = cands[i];
      const beforeTexts = snapshotTexts();
      const beforeOverlays = snapshotOverlaySigs();
      let clicked = false, errMsg = '';
      try {
        c.el.scrollIntoView({ block: 'center', behavior: 'instant' });
        await sleep(rnd(300, 500));
        c.el.click();
        clicked = true;
      } catch (e) { errMsg = e.message; }
      await sleep(rnd(3000, 3800)); // 给面板渲染留足时间
      const afterTexts = snapshotTexts();
      const newTexts = [...afterTexts].filter((t) => !beforeTexts.has(t));
      const sigs = sharePanelSignatures();
      const newOverlays = scanNewOverlays(beforeOverlays);
      tried.push({
        cls: c.cls, text: c.text, aria: c.aria, rect: c.rect,
        clicked, err: errMsg,
        newTexts: newTexts.slice(0, 30), sigs,
        overlayCount: newOverlays.length,
        overlays: newOverlays.slice(0, 4)
      });
    }

    // 选最可能命中的候选：特征文本优先，其次新浮层
    let bestIdx = -1, bestScore = -1;
    tried.forEach((t, i) => {
      const score = t.sigs.length * 100 + t.overlayCount * 10;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    });
    const effective = bestIdx >= 0 && bestScore > 0 ? tried[bestIdx] : null;

    let panelInfo = null;
    if (effective && effective.overlayCount > 0 && effective.overlays.length > 0) {
      const ov = effective.overlays[0];
      panelInfo = { found: true, cls: ov.cls, items: ov.items || [], html: ov.html };
    }

    // 关闭可能残留的面板（仅点遮罩/发 Esc，不点任何发送）
    try {
      const mask = document.querySelector('[class*="mask"], [class*="overlay"]');
      if (mask) mask.click();
      await sleep(200);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } catch (e) {}

    // 兼容旧字段 + 新诊断字段
    return {
      ok: true,
      candidateCount: cands.length,
      tried,
      effective,
      panelFound: !!(panelInfo && panelInfo.found),
      panelCls: panelInfo ? panelInfo.cls : '',
      items: panelInfo ? panelInfo.items : [],
      panelInfo
    };
  }

  // 用户主页：关注用户；已关注/互关 则返回已关注
  async function followUser() {
    if (location.pathname.indexOf('/user/profile') !== 0) {
      return { ok: false, error: '不在用户主页：' + location.pathname };
    }
    let followBtn = null;
    let state = 'unknown';
    for (let i = 0; i < 12; i++) {
      const btns = document.querySelectorAll('button, [role="button"], a, span, div');
      for (const b of btns) {
        const t = (b.innerText || '').trim();
        if (t === '已关注' || t === '互相关注' || t === '回关') { state = 'followed'; if (!followBtn) followBtn = b; }
        else if (t === '关注' || t === '+ 关注' || t === '关注TA' || t === '+关注') { state = 'not_followed'; followBtn = b; }
      }
      if (state !== 'unknown') break;
      await sleep(rnd(500, 800));
    }
    if (state === 'followed') return { ok: true, alreadyFollowing: true };
    if (!followBtn) return { ok: false, error: '未找到关注按钮，state=' + state };
    followBtn.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(rnd(400, 800));
    followBtn.click();
    await sleep(rnd(1500, 2500));
    let after = 'unknown';
    const btns2 = document.querySelectorAll('button, [role="button"], a, span, div');
    for (const b of btns2) {
      const t = (b.innerText || '').trim();
      if (t === '已关注' || t === '互相关注' || t === '回关') { after = 'followed'; break; }
    }
    return { ok: after === 'followed', alreadyFollowing: false, state: after };
  }

  // 分享笔记给指定用户：走「分享按钮→分享至面板→私信好友→选人→发送」原生转发（发视频卡片，非文字）
  // 等待元素出现（轮询，最多 timeout ms）
  function waitForEl(selector, scope, timeout) {
    return new Promise((resolve) => {
      const root = scope || document;
      const start = Date.now();
      const to = timeout || 4000;
      const tick = () => {
        const el = root.querySelector(selector);
        if (el && el.getBoundingClientRect().width > 0) return resolve(el);
        if (Date.now() - start > to) return resolve(null);
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  // 分享笔记给指定用户：走「分享按钮→分享至面板→私信好友→选人→发送」原生转发（发视频卡片，非文字）
  // 所有选择器均来自小红书 Web 真实 DOM（已用浏览器实测验证）
  async function shareNoteToUser(userId, userName, caption) {
    if (!userId) return { ok: false, error: '缺少目标 userId' };

    const setNativeValue = (el, val) => {
      try {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    const fail = (error, extra) => ({ ok: false, error, fallback: true, ...extra });

    // ---- 1. 点击分享按钮，等待分享面板 ----
    let shareBtn = document.querySelector('.share-icon-container, [class*="share-icon"]');
    let candidateCount = 0;
    if (!shareBtn) {
      const cands = collectShareCandidates();
      candidateCount = cands.length;
      shareBtn = cands.length ? cands[0].el : null;
    }
    if (!shareBtn) return fail('未找到分享按钮', { panelFound: false, candidateCount });
    const shareBtnInfo = 'cls=' + (shareBtn.className || '').toString().slice(0, 80);
    try {
      shareBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
      await sleep(rnd(300, 500));
      shareBtn.click();
    } catch (e) { return fail('点击分享按钮异常：' + e.message, { panelFound: false, shareBtnInfo }); }

    const panel = await waitForEl('.xhs-note-share-popup-container, .xhs-note-share-popup, [class*="xhs-note-share-popup"]', document, 4500);
    if (!panel) {
      const sigs = sharePanelSignatures();
      return fail('点击分享按钮后未出现分享面板', { panelFound: false, shareBtnInfo, candidateCount, sigs, probe: dumpClickableTexts(document) });
    }
    const diag = {
      panelFound: true,
      panelCls: (panel.className || '').toString().slice(0, 80),
      panelText: (panel.innerText || '').slice(0, 300)
    };

    // ---- 2. 点击「私信好友」打开联系人选择对话框 ----
    let dmItem = null;
    panel.querySelectorAll('.xhs-note-share-popup-action-item, [class*="share-popup-action"]').forEach((it) => {
      if (dmItem) return;
      const label = it.querySelector('.xhs-note-share-popup-action-label, [class*="action-label"]') || it;
      const t = (label.innerText || label.textContent || '').trim();
      if (/私信好友|^私信$/.test(t)) dmItem = it;
    });
    if (!dmItem) return fail('分享面板未找到私信好友入口', { ...diag, probe: dumpClickableTexts(panel) });
    try { dmItem.click(); } catch (e) { return fail('点击私信好友异常：' + e.message, { ...diag }); }
    await sleep(rnd(1200, 1800));

    // ---- 3. 等待转发对话框（联系人选择器）出现 ----
    let dialog = await waitForEl('.xhs-note-forward-dialog, [class*="note-forward-dialog"]', document, 4500);
    if (!dialog) dialog = document.querySelector('.reds-modal, [class*="reds-modal"]');
    if (!dialog) return fail('点击私信好友后未出现联系人对话框', { ...diag, probe: dumpClickableTexts(document) });
    const scope = dialog;
    diag.dialogText = (scope.innerText || '').slice(0, 400);

    // ---- 4. 选中目标用户 ----
    let picked = false;
    // 4a. 登录账号的对话框可能带搜索框（实测部分账号没有，兜底扫描）
    const searchInput = scope.querySelector('input[placeholder], input[type="text"], input:not([type]), [contenteditable="true"]');
    if (searchInput && userName) {
      try {
        searchInput.focus();
        if (searchInput.tagName === 'INPUT' || searchInput.tagName === 'TEXTAREA') setNativeValue(searchInput, userName);
        else searchInput.textContent = userName;
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(rnd(1200, 1800));
      } catch (e) {}
    }
    // 4b. 扫描联系人列表，精确/包含匹配用户名
    const pickByName = () => {
      const names = scope.querySelectorAll('.xhs-im-forward-user-list-name, [class*="user-list-name"]');
      for (const sp of names) {
        const t = (sp.innerText || sp.textContent || '').trim();
        if (!t) continue;
        if (userName && (t === userName || t.indexOf(userName) !== -1 || userName.indexOf(t) !== -1)) {
          const item = sp.closest('.xhs-im-forward-user-list-item, [class*="user-list-item"]') || sp;
          item.click();
          return true;
        }
      }
      return false;
    };
    if (pickByName()) { picked = true; }
    else {
      // 滚动加载更多分组（最近聊天 / 互相关注 / 我关注的…）
      const scroller = scope.querySelector('.xhs-note-forward-dialog-sticky-block, [class*="forward-dialog"]') || scope;
      for (let s = 0; s < 6; s++) {
        scroller.scrollTop = (scroller.scrollTop || 0) + 600;
        await sleep(rnd(500, 800));
        if (pickByName()) { picked = true; break; }
      }
    }
    if (!picked) {
      // 诊断：列出当前对话框里所有可见用户名，便于判断目标是否真的不在列表
      const visible = [];
      scope.querySelectorAll('.xhs-im-forward-user-list-name').forEach((sp) => {
        const t = (sp.innerText || '').trim();
        if (t && visible.length < 40) visible.push(t);
      });
      return fail('未在联系人列表找到目标用户：' + userName, {
        ...diag, searchFound: !!searchInput, visibleNames: visible, probe: dumpClickableTexts(scope)
      });
    }
    diag.pickedName = userName;
    await sleep(rnd(500, 900));

    // ---- 5. 填配文（如有） ----
    if (caption) {
      const capInput = scope.querySelector('textarea, input[placeholder*="说点"], input[placeholder*="留言"], input[placeholder*="私信"]');
      if (capInput) {
        capInput.focus();
        setNativeValue(capInput, caption);
        await sleep(rnd(400, 700));
      }
    }

    // ---- 6. 点发送（实测：button.btn.submit.gray 文本「发送」） ----
    let sent = false;
    const sendBtn = scope.querySelector('button.btn.submit.gray, button.btn.submit');
    if (sendBtn && /发送/.test((sendBtn.innerText || '').trim())) { sendBtn.click(); sent = true; }
    if (!sent) {
      const all = scope.querySelectorAll('button, [role="button"], a');
      for (const b of all) {
        const t = (b.innerText || '').trim();
        if (/^(发送|分享|确定|发)$/.test(t) && b.getBoundingClientRect().width > 0) { b.click(); sent = true; break; }
      }
    }
    if (!sent) return fail('未找到发送按钮', { ...diag, probe: dumpClickableTexts(scope) });
    await sleep(rnd(1500, 2500));
    return { ok: true, method: 'share_panel' };
  }

  // ===== 消息处理 =====
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case 'PING':
            return { ok: true, pageType: pageType(), url: location.href };
          case 'COLLECT_SEARCH_RESULTS': {
            const count = await scrollToLoad(msg.scrollTimes || 5);
            const max = msg.max || 5;
            const minLikes = msg.minLikes || 0;
            // 点赞数下限过滤：卡片上取到点赞数且不达标的直接剔除；
            // 取不到点赞数的先保留，由后台打开详情页后兜底校验
            const notes = noteLinks()
              .filter((n) => minLikes <= 0 || n.likes == null || n.likes >= minLikes)
              .slice(0, max);
            return { ok: true, count, notes };
          }
          case 'OPEN_NOTE': {
            return await openNote(msg.id);
          }
          case 'GO_BACK': {
            history.back();
            return { ok: true };
          }
          case 'GET_NOTE_INFO': {
            await ensureCommentsVisible();
            const info = getNoteInfo();
            info.comments = collectTopComments(6);
            return { ok: true, ...info };
          }
          case 'POST_COMMENT': {
            return await postComment(msg.text);
          }
          case 'GET_COMMENTS': {
            await ensureCommentsVisible();
            const comments = collectComments(msg.max || 12);
            return { ok: true, count: comments.length, comments };
          }
          case 'REPLY_COMMENT': {
            return await replyToComment(msg.index, msg.text || '');
          }
          case 'SEND_DM': {
            // 在用户主页发送私信（由后台导航到 /user/profile/ 后调用）
            return await sendPrivateMessage(msg.text || '');
          }
          case 'FOLLOW_USER': {
            return await followUser();
          }
          case 'PROBE_SHARE': {
            return await probeSharePanel();
          }
          case 'SHARE_NOTE_TO_USER': {
            return await shareNoteToUser(msg.userId, msg.userName, msg.caption);
          }
          default:
            return { ok: false, error: '未知消息类型：' + msg.type };
        }
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })().then(sendResponse);
    return true; // 保持异步响应
  });
})();
