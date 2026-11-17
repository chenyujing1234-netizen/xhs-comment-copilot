// ===== 小红书评论获客助手 - 侧边栏界面逻辑 =====

let state = {
  settings: {},
  products: [],
  keywords: [],
  auth: null,
  task: { running: false, paused: false },
  modelOptions: []
};

const $ = (id) => document.getElementById(id);

// ===== 与后台通信 =====
function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp);
    });
  });
}

// 长连接端口：接收日志与状态推送
const port = chrome.runtime.connect({ name: 'panel' });
port.onMessage.addListener((msg) => {
  if (msg.type === 'log') {
    appendLog(msg.entry);
    if (msg.entry.level === 'error' || msg.entry.level === 'warn') scrollLogs();
  } else if (msg.type === 'state') {
    state.task = msg.state;
    renderStatus();
  } else if (msg.type === 'logs') {
    renderLogs(msg.logs);
  } else if (msg.type === 'logsCleared') {
    clearLogs();
  }
});

// ===== 日志 =====
function appendLog(entry) {
  const box = $('logs');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML =
    '<span class="log-time">' + escapeHtml(entry.timeStr) + '</span>' +
    '<span class="log-level ' + entry.level + '">' + levelLabel(entry.level) + '</span>' +
    '<span class="log-msg">' + escapeHtml(entry.message) + '</span>';
  box.appendChild(line);
  // 自动滚动到底部
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
}
function renderLogs(list) {
  const box = $('logs');
  box.innerHTML = '';
  (list || []).forEach(appendLog);
  box.scrollTop = box.scrollHeight;
}
function clearLogs() {
  $('logs').innerHTML = '';
}
function scrollLogs() {
  const box = $('logs');
  box.scrollTop = box.scrollHeight;
}
function levelLabel(level) {
  const map = { info: '信息', success: '成功', warn: '警告', error: '错误' };
  return map[level] || level;
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ===== 状态显示 =====
function renderStatus() {
  const t = state.task || {};
  const el = $('statusText');
  const btnStart = $('btnStart');
  const btnPause = $('btnPause');
  const btnResume = $('btnResume');

  if (t.running && t.paused) {
    el.textContent = '⏸ 已暂停';
    el.className = 'status paused';
    btnStart.disabled = true;
    btnPause.disabled = true;
    btnResume.disabled = false;
  } else if (t.running) {
    el.textContent = '▶ 运行中';
    el.className = 'status running';
    btnStart.disabled = true;
    btnPause.disabled = false;
    btnResume.disabled = true;
  } else {
    el.textContent = '● 空闲';
    el.className = 'status idle';
    btnStart.disabled = false;
    btnPause.disabled = true;
    btnResume.disabled = true;
  }

  // 进度
  const p = t.progress || {};
  if (t.running && p.keywordTotal) {
    const total = p.total || (p.keywordTotal * (p.noteTotal || 1));
    const done = (p.keyword - 1) * (p.noteTotal || 1) + (p.note || 0);
    const productPart = p.productTotal > 1 ? `产品 ${p.product}/${p.productTotal} · ` : '';
    $('progressText').textContent =
      productPart + `关键词 ${p.keyword}/${p.keywordTotal} · 视频 ${p.note || 0}/${p.noteTotal || 0} · 已评论 ${p.done || 0}`;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    $('progressBar').style.width = pct + '%';
  } else if (t.running) {
    $('progressText').textContent = '运行中…';
    $('progressBar').style.width = '20%';
  } else {
    $('progressText').textContent = '未开始';
    $('progressBar').style.width = '0';
  }
}

// ===== 产品 =====
function renderProducts() {
  const box = $('productList');
  box.innerHTML = '';
  if (!state.products.length) {
    box.innerHTML = '<p class="test-result">暂无产品，点击「添加产品」创建。</p>';
    return;
  }
  state.products.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'product-item';
    item.innerHTML =
      '<div class="p-head">' +
        '<span class="sel"><input type="checkbox" class="p-sel" data-i="' + i + '" ' + (p.selected ? 'checked' : '') + ' /> 选中用于任务</span>' +
        '<button class="btn btn-small btn-del" data-i="' + i + '">删除</button>' +
      '</div>' +
      '<input class="p-name" data-i="' + i + '" placeholder="产品名称" value="' + escapeHtml(p.name || '') + '" />' +
      '<textarea class="p-desc" data-i="' + i + '" placeholder="产品描述（可写一大段）">' + escapeHtml(p.description || '') + '</textarea>';
    box.appendChild(item);
  });

  box.querySelectorAll('.p-sel').forEach((el) => {
    el.addEventListener('change', (e) => {
      state.products[+e.target.dataset.i].selected = e.target.checked;
    });
  });
  box.querySelectorAll('.p-name').forEach((el) => {
    el.addEventListener('input', (e) => {
      state.products[+e.target.dataset.i].name = e.target.value;
    });
  });
  box.querySelectorAll('.p-desc').forEach((el) => {
    el.addEventListener('input', (e) => {
      state.products[+e.target.dataset.i].description = e.target.value;
    });
  });
  box.querySelectorAll('.btn-del').forEach((el) => {
    el.addEventListener('click', () => {
      state.products.splice(+el.dataset.i, 1);
      renderProducts();
    });
  });
}

function collectProductsFromDOM() {
  const items = [];
  document.querySelectorAll('.product-item').forEach((node, i) => {
    items.push({
      id: (state.products[i] && state.products[i].id) || ('p_' + Date.now() + '_' + i),
      name: node.querySelector('.p-name').value.trim(),
      description: node.querySelector('.p-desc').value.trim(),
      selected: node.querySelector('.p-sel').checked
    });
  });
  return items;
}

// ===== 设置 =====
function fillSettingsForm() {
  const s = state.settings || {};
  $('baseUrl').value = s.baseUrl || '';
  $('apiKey').value = s.apiKey || '';
  $('smsAccessKeyId').value = s.smsAccessKeyId || '';
  $('smsAccessKeySecret').value = s.smsAccessKeySecret || '';
  $('commentMinLen').value = s.commentMinLen != null ? s.commentMinLen : 6;
  $('commentMaxLen').value = s.commentMaxLen != null ? s.commentMaxLen : 25;
  $('reportUrl').value = s.reportUrl || '';
  $('reportKey').value = s.reportKey || '';
  $('searchDelayMin').value = s.searchDelayMin != null ? s.searchDelayMin : 10;
  $('searchDelayMax').value = s.searchDelayMax != null ? s.searchDelayMax : 22;
  $('noteOpenDelayMin').value = s.noteOpenDelayMin != null ? s.noteOpenDelayMin : 6;
  $('noteOpenDelayMax').value = s.noteOpenDelayMax != null ? s.noteOpenDelayMax : 15;
  $('keywordIntervalMin').value = s.keywordIntervalMin != null ? s.keywordIntervalMin : 20;
  $('keywordIntervalMax').value = s.keywordIntervalMax != null ? s.keywordIntervalMax : 40;
  $('maxVideos').value = s.maxVideosPerKeyword != null ? s.maxVideosPerKeyword : 5;
  $('commentIntervalMin').value = s.commentIntervalMin != null ? s.commentIntervalMin : 45;
  $('commentIntervalMax').value = s.commentIntervalMax != null ? s.commentIntervalMax : 100;
  $('skipCommented').checked = s.skipCommented !== false;
  $('enableCommentReply').checked = s.enableCommentReply !== false;
  $('maxRepliesPerNote').value = s.maxRepliesPerNote != null ? s.maxRepliesPerNote : 1;
  $('replyDelayMin').value = s.replyDelayMin != null ? s.replyDelayMin : 15;
  $('replyDelayMax').value = s.replyDelayMax != null ? s.replyDelayMax : 40;

  const modelSel = $('model');
  modelSel.innerHTML = '';
  const models = state.modelOptions && state.modelOptions.length ? state.modelOptions : [s.model || 'qwen3.7-plus'];
  models.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    if (m === s.model) opt.selected = true;
    modelSel.appendChild(opt);
  });
}

function collectSettingsForm() {
  const num = (id) => {
    const v = parseFloat($(id).value);
    return isNaN(v) ? 0 : v;
  };
  return {
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    smsAccessKeyId: $('smsAccessKeyId').value.trim(),
    smsAccessKeySecret: $('smsAccessKeySecret').value.trim(),
    model: $('model').value,
    commentMinLen: num('commentMinLen'),
    commentMaxLen: num('commentMaxLen'),
    reportUrl: $('reportUrl').value.trim(),
    reportKey: $('reportKey').value.trim(),
    searchDelayMin: num('searchDelayMin'),
    searchDelayMax: num('searchDelayMax'),
    noteOpenDelayMin: num('noteOpenDelayMin'),
    noteOpenDelayMax: num('noteOpenDelayMax'),
    keywordIntervalMin: num('keywordIntervalMin'),
    keywordIntervalMax: num('keywordIntervalMax'),
    maxVideosPerKeyword: num('maxVideos'),
    commentIntervalMin: num('commentIntervalMin'),
    commentIntervalMax: num('commentIntervalMax'),
    skipCommented: $('skipCommented').checked,
    enableCommentReply: $('enableCommentReply').checked,
    maxRepliesPerNote: num('maxRepliesPerNote'),
    replyDelayMin: num('replyDelayMin'),
    replyDelayMax: num('replyDelayMax')
  };
}

// ===== 登录门禁 =====
function applyAuthUI() {
  const phone = state.auth && state.auth.phone;
  document.body.classList.toggle('not-logged', !phone);
  $('userPhone').textContent = phone ? ('账号：' + phone) : '';
  $('btnLogout').style.display = phone ? '' : 'none';
}

let codeCountdownTimer = null;
function startCodeCountdown(seconds) {
  const btn = $('btnSendCode');
  clearInterval(codeCountdownTimer);
  btn.disabled = true;
  btn.textContent = seconds + 's 后重发';
  codeCountdownTimer = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(codeCountdownTimer);
      btn.disabled = false;
      btn.textContent = '获取验证码';
    } else {
      btn.textContent = seconds + 's 后重发';
    }
  }, 1000);
}

function setLoginMsg(text, ok) {
  const el = $('loginMsg');
  el.textContent = text || '';
  el.className = 'test-result' + (text ? (ok ? ' ok' : ' err') : '');
}

function bindLoginEvents() {
  $('btnSendCode').addEventListener('click', async () => {
    const phone = $('loginPhone').value.trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) return setLoginMsg('请输入有效的 11 位手机号', false);
    $('btnSendCode').disabled = true;
    const r = await send({ type: 'SEND_CODE', phone });
    $('btnSendCode').disabled = false;
    if (r.ok) {
      setLoginMsg(r.message || '验证码已发送', true);
      startCodeCountdown(60);
    } else {
      setLoginMsg(r.error || '发送失败', false);
      // 命中 60 秒重发冷却时也启动倒计时
      if (/秒后再试/.test(r.error || '')) startCodeCountdown(60);
    }
  });

  $('btnLogin').addEventListener('click', async () => {
    const phone = $('loginPhone').value.trim();
    const code = $('loginCode').value.trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) return setLoginMsg('请输入有效的 11 位手机号', false);
    if (!/^\d{4}$/.test(code)) return setLoginMsg('请输入 4 位数字验证码', false);
    $('btnLogin').disabled = true;
    const r = await send({ type: 'LOGIN', phone, code });
    $('btnLogin').disabled = false;
    if (r.ok) {
      state.auth = { phone: r.phone };
      setLoginMsg('', false);
      $('loginCode').value = '';
      applyAuthUI();
      flash('登录成功', true);
    } else {
      setLoginMsg(r.error || '登录失败', false);
    }
  });

  $('btnLogout').addEventListener('click', async () => {
    await send({ type: 'LOGOUT' });
    state.auth = null;
    applyAuthUI();
    flash('已退出登录', true);
  });
}

// ===== 关键词 =====
function fillKeywordsForm() {
  $('keywordsInput').value = (state.keywords || []).map((k) => k.text).join('\n');
  updateKeywordOwnerHint();
}

// 把输入框里的每一行与已有关键词对象对应，保留产品归属；
// 手动新增/编辑的行归入当前勾选的第一个产品（单产品时无歧义）
function collectKeywordsFromInput() {
  const products = collectProductsFromDOM().filter((p) => p.selected && p.name);
  const first = products[0];
  const known = new Map((state.keywords || []).map((k) => [k.text, k]));
  const out = [];
  const lines = $('keywordsInput').value.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const text of lines) {
    const hit = known.get(text);
    if (hit && hit.productId) {
      out.push(hit);
      continue;
    }
    out.push({ text, productId: first ? first.id : '', productName: first ? first.name : '' });
  }
  return out;
}

// 输入框下方提示：每个产品各有多少个关键词（任务会按产品分组执行）
function updateKeywordOwnerHint() {
  const products = collectProductsFromDOM().filter((p) => p.selected && p.name);
  const counts = new Map();
  for (const k of state.keywords || []) {
    const key = k.productName || '未归属';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (!counts.size) {
    $('kwhint').textContent = '建议 10~15 个；多个产品时按产品分别生成，任务一个产品一个产品地跑';
    return;
  }
  const parts = [];
  for (const p of products) {
    const n = counts.get(p.name) || 0;
    if (n) parts.push(`${p.name} ${n} 个`);
  }
  const unknown = counts.get('未归属') || 0;
  if (unknown) parts.push(`未归属 ${unknown} 个（按第一个勾选产品执行）`);
  $('kwhint').textContent = '归属：' + (parts.join(' · ') || '无');
}

// ===== 初始化 =====
async function init() {
  const resp = await send({ type: 'GET_STATE' });
  if (resp && resp.ok) {
    state.settings = resp.settings || {};
    state.products = resp.products || [];
    state.keywords = resp.keywords || [];
    state.auth = resp.auth || null;
    state.task = resp.task || {};
    state.modelOptions = resp.modelOptions || [];
    renderProducts();
    fillSettingsForm();
    fillKeywordsForm();
    applyAuthUI();
    renderLogs(resp.logs || []);
    renderStatus();
  } else {
    renderLogs([{ timeStr: '--:--:--', level: 'error', message: '无法连接后台：' + (resp && resp.error) }]);
  }
}

// ===== 事件绑定 =====
function bindTabs() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $('tab-' + t.dataset.tab).classList.add('active');
    });
  });
}

function bindEvents() {
  // 产品
  $('btnAddProduct').addEventListener('click', () => {
    state.products.push({ id: 'p_' + Date.now(), name: '', description: '', selected: true });
    renderProducts();
  });
  $('btnSaveProducts').addEventListener('click', async () => {
    const products = collectProductsFromDOM();
    state.products = products;
    const r = await send({ type: 'SAVE_PRODUCTS', products });
    flash(r.ok ? '产品已保存' : ('保存失败：' + r.error), r.ok);
  });

  // 关键词
  $('btnGenKeywords').addEventListener('click', async () => {
    const products = collectProductsFromDOM().filter((p) => p.selected && p.name);
    if (!products.length) return flash('请先在「产品」页勾选并填写产品', false);
    $('btnGenKeywords').disabled = true;
    const r = await send({ type: 'GENERATE_KEYWORDS', products });
    $('btnGenKeywords').disabled = false;
    if (r.ok && r.keywords && r.keywords.length) {
      state.keywords = r.keywords;
      fillKeywordsForm();
      flash(`已生成 ${r.keywords.length} 个关键词（${products.length > 1 ? '按产品分别生成' : '单个产品'}）`, true);
    } else {
      flash('生成失败：' + (r.error || '未知'), false);
    }
  });
  $('btnClearKeywords').addEventListener('click', () => { $('keywordsInput').value = ''; });
  $('btnSaveKeywords').addEventListener('click', async () => {
    const keywords = collectKeywordsFromInput();
    state.keywords = keywords;
    const r = await send({ type: 'SAVE_KEYWORDS', keywords });
    flash(r.ok ? '关键词已保存' : ('保存失败：' + r.error), r.ok);
  });

  // 运行控制
  $('btnStart').addEventListener('click', async () => {
    const products = collectProductsFromDOM().filter((p) => p.selected && p.name);
    const keywords = collectKeywordsFromInput();
    if (!products.length) return flash('请先在「产品」页勾选并填写产品', false);
    if (!keywords.length) return flash('请先填写关键词（或 AI 生成）', false);

    // 先保存最新设置与产品、关键词
    await send({ type: 'SAVE_SETTINGS', settings: collectSettingsForm() });
    await send({ type: 'SAVE_PRODUCTS', products: collectProductsFromDOM() });
    await send({ type: 'SAVE_KEYWORDS', keywords });

    const r = await send({ type: 'START_TASK', products, keywords });
    if (!r.ok) flash('启动失败：' + (r.error || '未知'), false);
  });
  $('btnPause').addEventListener('click', () => send({ type: 'PAUSE_TASK' }));
  $('btnResume').addEventListener('click', () => send({ type: 'RESUME_TASK' }));
  $('btnStop').addEventListener('click', () => send({ type: 'STOP_TASK' }));
  $('btnClearLogs').addEventListener('click', () => send({ type: 'CLEAR_LOGS' }));
  $('btnExportLogs').addEventListener('click', exportLogs);

  // 设置
  $('btnToggleKey').addEventListener('click', () => {
    const el = $('apiKey');
    el.type = el.type === 'password' ? 'text' : 'password';
  });
  $('btnSaveSettings').addEventListener('click', async () => {
    const r = await send({ type: 'SAVE_SETTINGS', settings: collectSettingsForm() });
    state.settings = collectSettingsForm();
    flash(r.ok ? '设置已保存' : ('保存失败：' + r.error), r.ok);
  });
  $('btnTestLLM').addEventListener('click', async () => {
    const r = await send({ type: 'TEST_LLM' });
    const el = $('testResult');
    if (r.ok) { el.textContent = '连接成功：' + r.message; el.className = 'test-result ok'; }
    else { el.textContent = '连接失败：' + r.error; el.className = 'test-result err'; }
  });
  $('btnSaveTiming').addEventListener('click', async () => {
    const r = await send({ type: 'SAVE_SETTINGS', settings: collectSettingsForm() });
    state.settings = collectSettingsForm();
    flash(r.ok ? '节奏设置已保存' : ('保存失败：' + r.error), r.ok);
  });
  $('btnClearCommented').addEventListener('click', async () => {
    const r = await send({ type: 'CLEAR_COMMENTED' });
    flash(r.ok ? '已清空评论记录' : '操作失败', r.ok);
  });
  $('btnSaveReply').addEventListener('click', async () => {
    const r = await send({ type: 'SAVE_SETTINGS', settings: collectSettingsForm() });
    state.settings = collectSettingsForm();
    flash(r.ok ? '回复设置已保存' : ('保存失败：' + r.error), r.ok);
  });
  $('btnClearReplied').addEventListener('click', async () => {
    const r = await send({ type: 'CLEAR_REPLIED' });
    flash(r.ok ? '已清空回复记录' : '操作失败', r.ok);
  });
}

function flash(msg, ok) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show ' + (ok ? 'ok' : 'err');
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { el.className = 'toast'; }, 2800);
}

function exportLogs() {
  const box = $('logs');
  const lines = Array.from(box.querySelectorAll('.log-line')).map((l) => l.innerText.replace(/\s+/g, ' '));
  const text = lines.join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'xhs-logs-' + Date.now() + '.txt';
  a.click();
  URL.revokeObjectURL(a.href);
}

bindTabs();
bindLoginEvents();
bindEvents();
init();
