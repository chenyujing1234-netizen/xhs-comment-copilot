// ===== 小红书评论获客助手 - 侧边栏界面逻辑 =====

let state = {
  settings: {},
  products: [],
  qualityKeywords: [],
  candidates: [],
  auth: null,
  task: { running: false, paused: false },
  tasks: [],
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
let port = null;
function onPanelMessage(msg) {
  if (msg.type === 'log') {
    appendLog(msg.entry);
    if (msg.entry.level === 'error' || msg.entry.level === 'warn') scrollLogs();
  } else if (msg.type === 'state') {
    state.task = msg.state;
    renderStatus();
  } else if (msg.type === 'tasks') {
    state.tasks = msg.tasks || [];
    renderTaskList();
  } else if (msg.type === 'logs') {
    renderLogs(msg.logs);
  } else if (msg.type === 'logsCleared') {
    clearLogs();
  }
}
function connectPanel() {
  try {
    port = chrome.runtime.connect({ name: 'panel' });
  } catch (e) { return; }
  port.onMessage.addListener(onPanelMessage);
  port.onDisconnect.addListener(() => {
    // SW 可能被回收/重启（任务会因此中断）：稍等后重连并重拉状态，
    // 后台此时已把运行中的记录标记为「已中断」，面板刷新后即可继续执行
    setTimeout(() => { connectPanel(); refreshState(); }, 1500);
  });
}
// 重连/手动刷新：重新拉取后台状态（任务、日志、任务列表）
async function refreshState() {
  const resp = await send({ type: 'GET_STATE' });
  if (!resp || !resp.ok) return;
  state.settings = resp.settings || state.settings;
  state.task = resp.task || state.task;
  state.tasks = resp.tasks || [];
  if (resp.qualityKeywords) {
    state.qualityKeywords = resp.qualityKeywords;
    renderKeywordGroups();
  }
  renderStatus();
  renderTaskList();
  renderLogs(resp.logs || []);
}
connectPanel();

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
    const dmPart = p.dms ? ` · 已私信 ${p.dms}` : '';
    $('progressText').textContent =
      productPart + `关键词 ${p.keyword}/${p.keywordTotal} · 视频 ${p.note || 0}/${p.noteTotal || 0} · 已评论 ${p.done || 0}` + dmPart;
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

// ===== 任务列表 =====
const TASK_STATUS = {
  running: { label: '运行中', cls: 'running' },
  paused: { label: '已暂停', cls: 'paused' },
  stopped: { label: '已停止', cls: 'stopped' },
  completed: { label: '已完成', cls: 'completed' },
  interrupted: { label: '已中断', cls: 'interrupted' }
};
function fmtTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 运行中的任务：与后台广播的 recordId 对应，用实时进度渲染
function liveTaskFor(t) {
  if (state.task && state.task.running && state.task.recordId === t.id) return state.task;
  return null;
}
function renderTaskList() {
  const box = $('taskList');
  if (!box) return;
  const list = state.tasks || [];
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<p class="test-result">暂无任务记录。开始任务后会自动出现在这里。</p>';
    return;
  }
  list.forEach((t) => box.appendChild(buildTaskItem(t)));
}
function buildTaskItem(t) {
  const st = TASK_STATUS[t.status] || TASK_STATUS.stopped;
  const live = liveTaskFor(t);
  const item = document.createElement('div');
  item.className = 'task-item';

  // 头部：状态徽章 + 起止时间
  const head = document.createElement('div');
  head.className = 't-head';
  head.innerHTML =
    '<span class="badge ' + st.cls + '">' + st.label + '</span>' +
    '<span class="t-time">' + fmtTime(t.startedAt) + ' → ' + (t.endedAt ? fmtTime(t.endedAt) : '进行中') + '</span>';
  item.appendChild(head);

  // 参数摘要
  const meta = document.createElement('div');
  meta.className = 'task-meta';
  meta.textContent = '产品：' + ((t.productNames || []).join('、') || '无产品') +
    ' · 关键词 ' + (t.keywordCount || 0) + ' 个 · 账号：' + (t.phone || '未记录');
  item.appendChild(meta);

  // 进度与统计（运行中任务用实时进度）
  const p = (live && live.progress) || t.progress || {};
  const s = t.stats || {};
  const prog = document.createElement('div');
  prog.className = 'task-progress';
  prog.textContent = '关键词 ' + (p.keyword || 0) + '/' + (p.keywordTotal || 0) +
    ' · 已评论 ' + (p.done || 0) +
    ' · 已回复 ' + (s.replies || 0) +
    ' · 已私信 ' + (p.dms || 0);
  item.appendChild(prog);

  // 操作按钮：运行中只提示；可续跑的给「继续执行」；完成的给「重新执行」
  const actions = document.createElement('div');
  actions.className = 'task-actions';
  if (live) {
    actions.innerHTML = live.paused
      ? '<button class="btn btn-small btn-primary" data-act="resume" data-id="' + t.id + '">继续</button>'
      : '<span class="t-time">运行中，可在「运行」页查看实时日志与控制</span>';
  } else if (t.status === 'completed') {
    actions.innerHTML =
      '<button class="btn btn-small" data-act="rerun" data-id="' + t.id + '">重新执行</button>' +
      '<button class="btn btn-small btn-danger" data-act="delete" data-id="' + t.id + '">删除</button>';
  } else if (t.status === 'stopped' || t.status === 'interrupted' || t.status === 'paused') {
    actions.innerHTML =
      '<button class="btn btn-small btn-primary" data-act="continue" data-id="' + t.id + '">继续执行</button>' +
      '<button class="btn btn-small" data-act="rerun" data-id="' + t.id + '">重新执行</button>' +
      '<button class="btn btn-small btn-danger" data-act="delete" data-id="' + t.id + '">删除</button>';
  }
  item.appendChild(actions);
  return item;
}
// 任务列表按钮统一事件委托（列表会随广播频繁重渲，避免逐按钮绑定）
function bindTaskList() {
  $('taskList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === 'resume') {
      await send({ type: 'RESUME_TASK' });
    } else if (btn.dataset.act === 'continue') {
      // 断点续跑：成功即切到运行页看实时进度
      const r = await send({ type: 'CONTINUE_TASK', taskId: id });
      if (r.ok) switchTab('run');
      else flash('继续执行失败：' + (r.error || '未知'), false);
    } else if (btn.dataset.act === 'rerun') {
      // 重新执行：沿用该记录的参数快照，新建一条任务记录
      const r = await send({ type: 'START_TASK', taskId: id });
      if (r.ok) switchTab('run');
      else flash('重新执行失败：' + (r.error || '未知'), false);
    } else if (btn.dataset.act === 'delete') {
      if (!confirm('确定删除这条任务记录？')) return;
      const r = await send({ type: 'DELETE_TASK', taskId: id });
      if (!r.ok) flash('删除失败：' + (r.error || '未知'), false);
    }
  });
  $('btnRefreshTasks').addEventListener('click', async () => {
    const r = await send({ type: 'GET_TASKS' });
    if (r.ok) { state.tasks = r.tasks || []; renderTaskList(); }
  });
  $('btnClearTasks').addEventListener('click', async () => {
    if (!confirm('确定清空所有已结束的任务记录？运行中的任务会保留。')) return;
    const r = await send({ type: 'CLEAR_TASKS' });
    if (r.ok) { state.tasks = r.tasks || []; renderTaskList(); flash('已清空结束的任务记录', true); }
    else flash('操作失败：' + (r.error || '未知'), false);
  });
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
        '<span class="p-kwcount" data-id="' + p.id + '"></span>' +
        '<button class="btn btn-small btn-del" data-i="' + i + '">删除</button>' +
      '</div>' +
      '<input class="p-name" data-i="' + i + '" placeholder="产品名称" value="' + escapeHtml(p.name || '') + '" />' +
      '<textarea class="p-desc" data-i="' + i + '" placeholder="产品描述（可写一大段）">' + escapeHtml(p.description || '') + '</textarea>';
    box.appendChild(item);
  });
  updateProductKwCounts();

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
  $('minLikes').value = s.minLikes != null ? s.minLikes : 50;
  $('commentIntervalMin').value = s.commentIntervalMin != null ? s.commentIntervalMin : 45;
  $('commentIntervalMax').value = s.commentIntervalMax != null ? s.commentIntervalMax : 100;
  $('skipCommented').checked = s.skipCommented !== false;
  $('enableCommentReply').checked = s.enableCommentReply !== false;
  $('maxRepliesPerNote').value = s.maxRepliesPerNote != null ? s.maxRepliesPerNote : 1;
  $('replyDelayMin').value = s.replyDelayMin != null ? s.replyDelayMin : 15;
  $('replyDelayMax').value = s.replyDelayMax != null ? s.replyDelayMax : 40;
  $('enablePrivateMessage').checked = s.enablePrivateMessage !== false;
  $('maxDMsPerNote').value = s.maxDMsPerNote != null ? s.maxDMsPerNote : 1;
  $('dmDelayMin').value = s.dmDelayMin != null ? s.dmDelayMin : 20;
  $('dmDelayMax').value = s.dmDelayMax != null ? s.dmDelayMax : 45;

  const modelSel = $('model');
  modelSel.innerHTML = '';
  const models = state.modelOptions && state.modelOptions.length ? state.modelOptions : [s.model || 'qwen3.7-plus'];
  models.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    if (m === s.model) opt.selected = true;
    modelSel.appendChild(opt);
  });

  const kwModelSel = $('keywordModel');
  kwModelSel.innerHTML = '';
  const kwModels = state.modelOptions && state.modelOptions.length ? state.modelOptions : [s.keywordModel || 'qwen4-max-preview'];
  kwModels.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    if (m === s.keywordModel) opt.selected = true;
    kwModelSel.appendChild(opt);
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
    model: $('model').value,
    keywordModel: $('keywordModel').value,
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
    minLikes: num('minLikes'),
    commentIntervalMin: num('commentIntervalMin'),
    commentIntervalMax: num('commentIntervalMax'),
    skipCommented: $('skipCommented').checked,
    enableCommentReply: $('enableCommentReply').checked,
    maxRepliesPerNote: num('maxRepliesPerNote'),
    replyDelayMin: num('replyDelayMin'),
    replyDelayMax: num('replyDelayMax'),
    enablePrivateMessage: $('enablePrivateMessage').checked,
    maxDMsPerNote: num('maxDMsPerNote'),
    dmDelayMin: num('dmDelayMin'),
    dmDelayMax: num('dmDelayMax')
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

// ===== 关键词（优质库 + AI 候选词）=====
// 每个勾选产品一组：组内上方是固定的「优质关键词库」（任务只从这里取词），
// AI 生成的结果是候选词（默认全选），勾选后移入优质库，也可一键全部移入。
// 属于未勾选产品的库内关键词也会成组展示并原样保留（切页不丢）。
function keywordGroupModel() {
  const products = collectProductsFromDOM();
  const selected = products.filter((p) => p.selected && p.name);
  const byId = new Map();
  for (const k of state.qualityKeywords || []) {
    const pid = k.productId || '';
    if (!byId.has(pid)) byId.set(pid, { productId: pid, productName: k.productName || '未归属', texts: [] });
    if (k.text) byId.get(pid).texts.push(String(k.text));
  }
  const selIds = new Set(selected.map((p) => p.id));
  const groups = selected.map((p) => ({
    productId: p.id,
    productName: p.name,
    texts: (byId.get(p.id) || { texts: [] }).texts,
    note: ''
  }));
  const orphans = [];
  for (const [pid, g] of byId) {
    if (selIds.has(pid)) continue;
    orphans.push({
      productId: pid,
      productName: g.productName,
      texts: g.texts,
      note: pid ? '（未勾选，不会执行）' : '（未归属，按第一个勾选产品执行）'
    });
  }
  // AI 候选词按产品归拢到对应组
  const candByPid = new Map();
  for (const c of state.candidates || []) {
    if (!candByPid.has(c.productId)) candByPid.set(c.productId, []);
    candByPid.get(c.productId).push(c);
  }
  for (const g of groups.concat(orphans)) g.candidates = candByPid.get(g.productId) || [];
  // 候选词对应的产品未勾选/已删除：补一个组展示，保证候选词不丢
  for (const [pid, cs] of candByPid) {
    if (groups.concat(orphans).some((g) => g.productId === pid)) continue;
    orphans.push({
      productId: pid,
      productName: cs[0].productName || '未归属',
      texts: [],
      note: '（产品未勾选，移入后不会执行）',
      candidates: cs
    });
  }
  return { groups, orphans };
}

function buildKwGroup(g) {
  const div = document.createElement('div');
  div.className = 'kw-group';
  div.dataset.productId = g.productId;
  div.dataset.productName = g.productName;
  if (g.note) div.dataset.orphan = '1';
  const head = document.createElement('div');
  head.className = 'kw-group-head';
  const name = document.createElement('span');
  name.className = 'kw-group-name';
  name.textContent = g.productName + g.note;
  const count = document.createElement('span');
  count.className = 'kw-count';
  count.textContent = '优质库 ' + g.texts.length + ' 个';
  head.appendChild(name);
  head.appendChild(count);
  if (!g.note) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-small';
    btn.textContent = 'AI 生成';
    btn.dataset.genFor = g.productId;
    head.appendChild(btn);
  }
  div.appendChild(head);

  // 优质关键词库：chips，单条可删除
  const lib = document.createElement('div');
  lib.className = 'kw-lib';
  if (!g.texts.length) {
    const empty = document.createElement('span');
    empty.className = 'kw-lib-empty';
    empty.textContent = '暂无关键词：AI 生成后移入，或在下方手动添加';
    lib.appendChild(empty);
  }
  for (const text of g.texts) {
    const chip = document.createElement('span');
    chip.className = 'kw-chip';
    chip.textContent = text;
    const del = document.createElement('button');
    del.className = 'kw-del';
    del.title = '从优质库删除';
    del.textContent = '×';
    del.dataset.delKw = text;
    chip.appendChild(del);
    lib.appendChild(chip);
  }
  div.appendChild(lib);

  // 手动添加一行
  const addRow = document.createElement('div');
  addRow.className = 'kw-add';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '手动添加关键词，回车加入优质库';
  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-small';
  addBtn.textContent = '添加';
  addRow.appendChild(input);
  addRow.appendChild(addBtn);
  div.appendChild(addRow);

  // AI 候选词：默认全选的复选框列表 + 移入操作
  if (g.candidates && g.candidates.length) {
    const cand = document.createElement('div');
    cand.className = 'kw-cand';
    const chead = document.createElement('div');
    chead.className = 'kw-cand-head';
    const ctitle = document.createElement('span');
    ctitle.textContent = 'AI 候选词（默认全选，取消勾选跳过不合适的）';
    const btnAll = document.createElement('button');
    btnAll.className = 'btn btn-small btn-primary';
    btnAll.textContent = '一键全部移入';
    btnAll.dataset.candAll = '1';
    const btnSel = document.createElement('button');
    btnSel.className = 'btn btn-small';
    btnSel.textContent = '移入选中';
    btnSel.dataset.candSel = '1';
    const btnDrop = document.createElement('button');
    btnDrop.className = 'btn btn-small';
    btnDrop.textContent = '丢弃';
    btnDrop.dataset.candDrop = '1';
    chead.appendChild(ctitle);
    chead.appendChild(btnAll);
    chead.appendChild(btnSel);
    chead.appendChild(btnDrop);
    cand.appendChild(chead);
    const list = document.createElement('div');
    list.className = 'kw-cand-list';
    for (const c of g.candidates) {
      const label = document.createElement('label');
      label.className = 'kw-cand-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = c.selected !== false;
      cb.dataset.candText = c.text;
      const txt = document.createElement('span');
      txt.textContent = c.text;
      label.appendChild(cb);
      label.appendChild(txt);
      list.appendChild(label);
    }
    cand.appendChild(list);
    div.appendChild(cand);
  }
  return div;
}

let lastKwSelSig = '';
function renderKeywordGroups() {
  lastKwSelSig = collectProductsFromDOM().filter((p) => p.selected && p.name).map((p) => p.id).join(',');
  const { groups, orphans } = keywordGroupModel();
  const wrap = $('kwGroups');
  wrap.innerHTML = '';
  if (!groups.length && !orphans.length) {
    wrap.innerHTML = '<p class="test-result">请先在「产品」页勾选并填写产品，再生成或填写关键词。</p>';
  }
  groups.concat(orphans).forEach((g) => wrap.appendChild(buildKwGroup(g)));
  updateKeywordOwnerHint();
  updateProductKwCounts();
}

// 移入优质库：AI 候选勾选项或手动添加；后台按产品去重，返回最新库
async function addKeywordsToLibrary(list) {
  if (!list.length) return flash('没有可移入的关键词', false);
  const r = await send({ type: 'ADD_QUALITY_KEYWORDS', keywords: list });
  if (!r.ok) return flash('移入失败：' + (r.error || '未知'), false);
  state.qualityKeywords = r.keywords || [];
  // 已处理的候选词从待移入列表移除（含后台去重跳过的）
  const doneKeys = new Set(list.map((k) => k.productId + '\u0000' + k.text));
  state.candidates = (state.candidates || []).filter((c) => !doneKeys.has(c.productId + '\u0000' + c.text));
  renderKeywordGroups();
  flash(`已移入优质库 ${r.added} 个${r.skipped ? `（${r.skipped} 个已存在，已跳过）` : ''}`, true);
}

async function removeKeywordFromLibrary(text, productId) {
  const r = await send({ type: 'REMOVE_QUALITY_KEYWORD', text, productId });
  if (!r.ok) return flash('删除失败：' + (r.error || '未知'), false);
  state.qualityKeywords = r.keywords || [];
  renderKeywordGroups();
}

// 用新生成的候选词替换某产品的旧候选（默认全选）
function setCandidatesForProduct(productId, list) {
  const kept = (state.candidates || []).filter((c) => c.productId !== productId);
  state.candidates = kept.concat(list.map((k) => ({
    text: k.text,
    productId: k.productId,
    productName: k.productName,
    selected: true
  })));
}

// 某产品的候选词当前勾选项
function selectedCandidates(productId) {
  return (state.candidates || [])
    .filter((c) => c.productId === productId && c.selected !== false)
    .map((c) => ({ text: c.text, productId: c.productId, productName: c.productName }));
}

// 分组下方汇总：优质库每个产品几个、还有多少候选词待移入
function updateKeywordOwnerHint() {
  const { groups, orphans } = keywordGroupModel();
  const all = groups.concat(orphans);
  const libCount = all.reduce((n, g) => n + g.texts.length, 0);
  const candCount = all.reduce((n, g) => n + (g.candidates ? g.candidates.length : 0), 0);
  if (!libCount && !candCount) {
    $('kwhint').textContent = '优质库为空：点「AI 生成关键词」生成候选词，勾选后移入优质库';
    return;
  }
  const selIds = new Set(collectProductsFromDOM().filter((p) => p.selected && p.name).map((p) => p.id));
  const parts = all.map((g) => {
    const note = !g.productId ? '（未归属）' : (selIds.has(g.productId) ? '' : '（未勾选，不执行）');
    return g.productName + ' ' + g.texts.length + ' 个' + note;
  });
  let msg = '优质库共 ' + libCount + ' 个：' + parts.join(' · ');
  if (candCount) msg += '；还有 ' + candCount + ' 个候选词待移入';
  $('kwhint').textContent = msg;
}

// 产品列表里显示每个产品的优质库词数，两个页面之间的对应关系一目了然
function updateProductKwCounts() {
  const counts = new Map();
  for (const k of state.qualityKeywords || []) {
    if (!k.productId) continue;
    counts.set(k.productId, (counts.get(k.productId) || 0) + 1);
  }
  document.querySelectorAll('.p-kwcount').forEach((el) => {
    const n = counts.get(el.dataset.id) || 0;
    el.textContent = n ? (n + ' 个关键词') : '优质库为空';
    el.classList.toggle('zero', !n);
  });
}

// ===== 初始化 =====
async function init() {
  let resp = await send({ type: 'GET_STATE' });
  // SW 冷启动/休眠时首次通信可能失败：重试一次，避免面板因拿不到登录态而卡在登录页
  if (!resp || !resp.ok) {
    await new Promise((r) => setTimeout(r, 600));
    resp = await send({ type: 'GET_STATE' });
  }
  if (resp && resp.ok) {
    state.settings = resp.settings || {};
    state.products = resp.products || [];
    state.qualityKeywords = resp.qualityKeywords || [];
    state.auth = resp.auth || null;
    state.task = resp.task || {};
    state.tasks = resp.tasks || [];
    state.modelOptions = resp.modelOptions || [];
    // 登录态判定优先执行：后续任一渲染异常都不能让面板卡在登录页
    // （曾因关键词渲染函数抛 TypeError 中断 init，导致每次重开都要求重新登录）
    applyAuthUI();
    try {
      renderProducts();
      fillSettingsForm();
      renderKeywordGroups();
      renderLogs(resp.logs || []);
      renderStatus();
      renderTaskList();
    } catch (e) {
      console.error('面板渲染失败：', e);
    }
    // 后台连接正常却没读到登录态：给出诊断信息（区分存储问题/插件副本问题），便于定位
    if (!state.auth || !state.auth.phone) {
      const d = resp.authDiag || {};
      const fmt = (v) => (v ? '有(' + v + ')' : '无');
      const diag = '后台连接正常；本地存储=' + (d.error ? '读取失败:' + d.error : fmt(d.local)) +
        '；同步存储=' + (d.error ? '未知' : fmt(d.sync)) +
        '；插件ID=' + chrome.runtime.id;
      setLoginMsg('未检测到登录态。诊断：' + diag + '。如果你刚登录过，请把这段文字反馈给开发者。', false);
    }
  } else {
    renderLogs([{ timeStr: '--:--:--', level: 'error', message: '无法连接后台：' + (resp && resp.error) }]);
    // 未登录时日志区被隐藏，把连接错误同时显示在登录页上，避免用户只看到登录页却不知原因
    setLoginMsg('无法连接插件后台：' + ((resp && resp.error) || '请关闭面板重开，或到 chrome://extensions 刷新插件'), false);
  }
}

// ===== 事件绑定 =====
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((x) => x.classList.toggle('active', x.id === 'tab-' + name));
  // 产品勾选情况变化后切回关键词页：重建分组，保证新勾选的产品有关键词组、
  // 取消勾选的产品的关键词转为「未勾选」组保留（切页不丢未保存的编辑）
  if (name === 'task') {
    const sig = collectProductsFromDOM().filter((p) => p.selected && p.name).map((p) => p.id).join(',');
    if (sig !== lastKwSelSig) renderKeywordGroups();
  }
}
function bindTabs() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
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

  // 关键词（优质库 + AI 候选词）
  $('btnGenKeywords').addEventListener('click', async () => {
    const products = collectProductsFromDOM().filter((p) => p.selected && p.name);
    if (!products.length) return flash('请先在「产品」页勾选并填写产品', false);
    $('btnGenKeywords').disabled = true;
    const r = await send({ type: 'GENERATE_KEYWORDS', products });
    $('btnGenKeywords').disabled = false;
    if (r.ok && r.keywords && r.keywords.length) {
      // 候选词整体替换：按产品归组展示，默认全选，等用户勾选后移入优质库
      state.candidates = r.keywords.map((k) => ({
        text: k.text,
        productId: k.productId,
        productName: k.productName,
        selected: true
      }));
      renderKeywordGroups();
      flash(`已生成 ${r.keywords.length} 个候选词（${products.length > 1 ? '按产品分别生成' : '单个产品'}），勾选后「移入优质库」`, true);
    } else {
      flash('生成失败：' + (r.error || '未知'), false);
    }
  });
  // 分组区点击：AI 生成 / 删除库词 / 候选词移入与丢弃 / 手动添加
  $('kwGroups').addEventListener('click', async (e) => {
    const groupEl = e.target.closest('.kw-group');
    if (!groupEl) return;
    const productId = groupEl.dataset.productId;

    const genBtn = e.target.closest('button[data-gen-for]');
    if (genBtn) {
      const product = collectProductsFromDOM().find((p) => p.id === genBtn.dataset.genFor);
      if (!product || !product.name) return flash('请先填写该产品名称', false);
      genBtn.disabled = true;
      const r = await send({ type: 'GENERATE_KEYWORDS', products: [product] });
      genBtn.disabled = false;
      if (r.ok && r.keywords && r.keywords.length) {
        setCandidatesForProduct(product.id, r.keywords);
        renderKeywordGroups();
        flash(`已为「${product.name}」生成 ${r.keywords.length} 个候选词，勾选后「移入优质库」`, true);
      } else {
        flash('生成失败：' + (r.error || '未知'), false);
      }
      return;
    }
    const delBtn = e.target.closest('button[data-del-kw]');
    if (delBtn) {
      removeKeywordFromLibrary(delBtn.dataset.delKw, productId);
      return;
    }
    if (e.target.closest('button[data-cand-all]')) {
      const list = (state.candidates || [])
        .filter((c) => c.productId === productId)
        .map((c) => ({ text: c.text, productId: c.productId, productName: c.productName }));
      addKeywordsToLibrary(list);
      return;
    }
    if (e.target.closest('button[data-cand-sel]')) {
      addKeywordsToLibrary(selectedCandidates(productId));
      return;
    }
    if (e.target.closest('button[data-cand-drop]')) {
      state.candidates = (state.candidates || []).filter((c) => c.productId !== productId);
      renderKeywordGroups();
      return;
    }
    if (e.target.closest('button[data-add-for], .kw-add button')) {
      const input = groupEl.querySelector('.kw-add input');
      const text = (input.value || '').trim();
      if (!text) return flash('请先输入关键词', false);
      await addKeywordsToLibrary([{ text, productId, productName: groupEl.dataset.productName || '未归属' }]);
      return;
    }
  });
  // 候选词勾选/取消勾选：记进 state，不即时重渲染（避免打断勾选操作）
  $('kwGroups').addEventListener('change', (e) => {
    const cb = e.target;
    if (!cb.matches('input[type="checkbox"][data-cand-text]')) return;
    const g = cb.closest('.kw-group');
    const c = (state.candidates || []).find((x) => x.productId === g.dataset.productId && x.text === cb.dataset.candText);
    if (c) c.selected = cb.checked;
  });
  // 手动添加框回车 = 点添加
  $('kwGroups').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (!e.target.matches('.kw-add input')) return;
    e.preventDefault();
    e.target.closest('.kw-group').querySelector('.kw-add button').click();
  });

  // 运行控制
  $('btnStart').addEventListener('click', async () => {
    const products = collectProductsFromDOM().filter((p) => p.selected && p.name);
    if (!products.length) return flash('请先在「产品」页勾选并填写产品', false);
    // 任务只跑优质库：界面只做非空校验，后台按所选产品从库里取词
    const selIds = new Set(products.map((p) => p.id));
    const libKw = (state.qualityKeywords || []).filter((k) => selIds.has(k.productId));
    if (!libKw.length) return flash('所选产品的优质关键词库为空，请先生成并移入关键词', false);

    // 先保存最新设置与产品；关键词库的增删已实时落库，无需整体保存
    await send({ type: 'SAVE_SETTINGS', settings: collectSettingsForm() });
    await send({ type: 'SAVE_PRODUCTS', products: collectProductsFromDOM() });

    const r = await send({ type: 'START_TASK', products });
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
  $('btnSaveDm').addEventListener('click', async () => {
    const r = await send({ type: 'SAVE_SETTINGS', settings: collectSettingsForm() });
    state.settings = collectSettingsForm();
    flash(r.ok ? '私信设置已保存' : ('保存失败：' + r.error), r.ok);
  });
  $('btnClearDm').addEventListener('click', async () => {
    const r = await send({ type: 'CLEAR_DM' });
    flash(r.ok ? '已清空私信记录' : '操作失败', r.ok);
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
bindTaskList();
init();
