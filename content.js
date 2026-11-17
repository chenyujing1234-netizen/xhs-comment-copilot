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
      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, { id, url, title, hasToken });
      } else {
        // 已有不带 token 的链接，遇到带 token 的则替换
        if (hasToken && !existing.hasToken) {
          existing.url = url;
          existing.hasToken = true;
        }
        if (!existing.title && title) existing.title = title;
      }
    });
    return Array.from(byId.values()).map(({ id, url, title }) => ({ id, url, title }));
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
  // 实测（2026-11-17）：主页入口文案为「发消息」（官方号/关闭私信的用户无此按钮）；
  // 会话页 URL 为 /chat/{userId}，输入框 .xhs-im-input-bar-editor，发送按钮为输入栏内无文本图标按钮
  function findDmButton() {
    const cands = qa('button, span, div, a, [role="button"]');
    let fallback = null;
    for (const el of cands) {
      const t = (el.innerText || '').trim();
      if (t !== '私信' && t !== '发私信' && t !== '发消息') continue;
      const hasSmaller = qa('*', el).some((c) => {
        const ct = (c.innerText || '').trim();
        return ct === '私信' || ct === '发私信' || ct === '发消息';
      });
      if (hasSmaller) continue;
      const cls = el.getAttribute('class') || '';
      if (/im|dm|message|chat/i.test(cls)) return el;
      if (!fallback) fallback = el;
    }
    return fallback;
  }

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
    // 已处于会话页（background 直接导航 /chat/{userId}）时无需找主页按钮
    const inChatPage = location.pathname.indexOf('/chat') === 0;
    if (!inChatPage) {
      const dmBtn = findDmButton();
      if (!dmBtn) {
        return { ok: false, error: '用户主页未找到「发消息/私信」按钮（该用户可能不接受私信）' };
      }
      dmBtn.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(rnd(400, 800));
      dmBtn.click();
      await sleep(rnd(1200, 2000));
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

  // ===== 消息处理 =====
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case 'PING':
            return { ok: true, pageType: pageType(), url: location.href };
          case 'COLLECT_SEARCH_RESULTS': {
            const count = await scrollToLoad(msg.scrollTimes || 5);
            const notes = noteLinks().slice(0, msg.max || 5);
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
