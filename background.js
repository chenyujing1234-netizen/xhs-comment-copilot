// ===== 小红书评论获客助手 - 后台服务 =====
// 职责：任务编排、调用 Qwen 生成评论/关键词、日志广播、与 content script 通信

const DEFAULT_SETTINGS = {
  baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  // 大模型 Key 已内置，用户无需填写；如想覆盖，在「设置 → 模型与接口设置」中改成自己的 Key
  apiKey: 'sk-sp-H.DPDYXH.iDCC.MEUCICAjTrpMd_ZuS_v2fToFLu_NNBGrGKf-RPVVjCuU2POsAiEAtqncVYixW6t_74c1oeNUVMgHL1SO3RiigE8rzyIOcHQ',
  model: 'qwen3.7-plus',
  // 关键词生成专用模型：默认用更强的旗舰（一次性重推理任务）；评论/回复仍用上面的 model
  keywordModel: 'qwen4-max-preview',
  commentMaxLen: 25,
  commentMinLen: 6,
  // 拟人化时间区间（秒）
  searchDelayMin: 10,
  searchDelayMax: 22,
  noteOpenDelayMin: 6,
  noteOpenDelayMax: 15,
  commentIntervalMin: 45,
  commentIntervalMax: 100,
  keywordIntervalMin: 20,
  keywordIntervalMax: 40,
  maxVideosPerKeyword: 8,
  minLikes: 50, // 只评论点赞数达到该值的视频/文章；0 表示不限制
  maxKeywordsPerTask: 12,
  scrollTimes: 2,
  skipCommented: true,
  // 评论后回复感兴趣的用户（分析评论区，挑出对产品有需求的人进行回复）
  enableCommentReply: true,
  maxRepliesPerNote: 1,
  replyDelayMin: 15,
  replyDelayMax: 40,
  // 评论后给感兴趣的用户发私信（进入其主页发送）
  enablePrivateMessage: true,
  maxDMsPerNote: 1,
  dmDelayMin: 20,
  dmDelayMax: 45,
  // 任务中断后自动重启：默认开启，按间隔从断点续跑（用户可在设置里关闭）
  autoRestartInterrupted: true,
  autoRestartDelayMin: 5,
  autoRestartMaxAttempts: 5, // 单个任务最多自动重启次数，0 表示不限次数
  // 账号安全：每个手机号每日出站动作（评论/回复/私信/关注/分享）总数上限，达到即停任务；0 表示不限制
  dailyLimit: 50,
  // 运行数据上报服务（看板：https://linkpal.cloud/xhs-report/?key=...）
  // 必须用 HTTPS：Chrome 商店要求用户数据加密传输，明文 HTTP 会被拒（参考违规 Purple Copper）
  reportUrl: 'https://linkpal.cloud/xhs-report',
  reportKey: 'xhs-report-2026'
};

const MODEL_OPTIONS = [
  'qwen3.7-plus',
  'qwen3.7-max',
  'qwen3.8-flash',
  'qwen3.8-max',
  'qwen3.6-flash',
  'qwen4-max-preview',
  'deepseek-v4-pro',
  'deepseek-v4-flash-0731',
  'glm-5.3'
];

// 产品为账号级数据，不再内置预置：每个手机号的产品库以服务端为准，
// 登录时从服务端拉取（换浏览器/换电脑登录也能拿到自己的产品；服务端没有则为空）
const DEFAULT_PRODUCTS = [];

// ===== 运行时状态 =====
const task = {
  running: false,
  paused: false,
  stopRequested: false,
  progress: { keyword: 0, keywordTotal: 0, note: 0, noteTotal: 0, done: 0, total: 0, dms: 0 },
  recordId: null // 对应「任务列表」中的记录 id（运行中才有值）
};

let logs = [];           // 内存日志
let panelPorts = new Set(); // 已连接的面板端口

// 点击工具栏图标直接打开侧边栏（在 SW 启动时设置，避免仅依赖 onInstalled）
try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
} catch (e) { /* 旧版本忽略 */ }

// 当前任务在「任务列表」中的记录：运行中随进度实时更新，暂停/停止/完成时写终态
let currentRecord = null;

// 待自动重启的任务：{taskId, nextAt}（存储键 pendingTaskRetry 的内存镜像，声明提前避免时序问题）
let pendingRetry = null;

// SW 启动兜底：把存储里残留的 running/paused 记录标记为 interrupted
// （SW 重启时内存必无运行任务，这些记录只可能是被电脑关机/SW 回收打断的）
reconcileInterruptedTasks().catch(() => { /* 忽略 */ });
// 恢复待自动重启状态（供任务列表显示重启倒计时；alarm 由浏览器持久化，到点自会触发）
loadPendingRetry().catch(() => { /* 忽略 */ });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (min, max) => min + Math.random() * (max - min);

// ===== 存储 =====
async function storageGet(key, def) {
  try {
    const o = await chrome.storage.local.get(key);
    return o[key] === undefined ? def : o[key];
  } catch (e) {
    return def;
  }
}
async function storageSet(obj) {
  try { await chrome.storage.local.set(obj); } catch (e) { /* ignore */ }
}

// ===== 按手机号隔离的用户数据 =====
// 产品/设置/优质关键词库按 <按键>_<手机号> 存储：同一浏览器换手机号登录，互不看到对方的数据。
// 未登录时仍用旧的全局键（登录前也能配置）；登录切换时把旧全局数据一次性迁给原手机号。
const PHONE_SCOPED_KEYS = ['products', 'settings', 'qualityKeywords', 'promo', 'promoFollowed', 'promoShared'];

// 取当前登录手机号对应的存储键；顺手把残留的旧全局键迁移过来（未登录则原样返回全局键）
async function scopedKey(base) {
  const auth = await getAuth();
  if (!auth || !auth.phone) return base;
  const scoped = base + '_' + auth.phone;
  const [s, g] = await Promise.all([
    chrome.storage.local.get(scoped),
    chrome.storage.local.get(base)
  ]);
  if (s[scoped] === undefined && g[base] !== undefined) {
    await chrome.storage.local.set({ [scoped]: g[base] });
    log('info', `旧版「${base}」数据已归属到手机号 ${auth.phone}`);
  }
  return scoped;
}

// 登录切换前调用：把旧版全局键数据迁给「原登录手机号」（从未登录过则归给新手机号），
// 然后删掉全局键，防止未登录状态或新手机号读到上一个账号的数据
async function migrateLegacyUserData(newPhone) {
  const cur = await getAuth();
  const owner = (cur && cur.phone) || newPhone;
  if (!owner) return;
  for (const base of PHONE_SCOPED_KEYS) {
    const g = await chrome.storage.local.get(base);
    if (g[base] === undefined) continue;
    const scoped = base + '_' + owner;
    const s = await chrome.storage.local.get(scoped);
    if (s[scoped] === undefined) {
      await chrome.storage.local.set({ [scoped]: g[base] });
      log('info', `旧版「${base}」数据已归属到手机号 ${owner}`);
    }
    await chrome.storage.local.remove(base);
  }
}

async function getSettings() {
  const s = await storageGet(await scopedKey('settings'), {});
  const merged = { ...DEFAULT_SETTINGS, ...s };
  // 内置 Key 兜底：历史设置里 apiKey 为空（如按手机号隔离前保存的空值）时回退到内置 Key
  if (!merged.apiKey) merged.apiKey = DEFAULT_SETTINGS.apiKey;
  // 历史版本把上报地址存成裸 IP 明文 HTTP，统一迁移到 HTTPS 域名（安全 + 兼容 manifest 权限收敛）
  if (merged.reportUrl && merged.reportUrl.indexOf('http://124.221.115.174') === 0) {
    merged.reportUrl = merged.reportUrl.replace('http://124.221.115.174', 'https://linkpal.cloud');
  }
  return merged;
}
async function saveSettings(s) {
  await storageSet({ [await scopedKey('settings')]: { ...DEFAULT_SETTINGS, ...s } });
}
async function getProducts() {
  return (await storageGet(await scopedKey('products'), [])) || [];
}
async function saveProducts(p) {
  await storageSet({ [await scopedKey('products')]: p || [] });
}
// 关键词统一规范为 {text, productId, productName}：带产品归属，任务按产品分组执行
// 兼容旧数据（历史上存的是纯字符串数组）
function normalizeKeywords(list) {
  return (Array.isArray(list) ? list : [])
    .map((k) => (typeof k === 'string' ? { text: k } : k))
    .filter((k) => k && String(k.text || '').trim())
    .map((k) => ({
      text: String(k.text).trim(),
      productId: k.productId || '',
      productName: k.productName || ''
    }));
}
async function getKeywords() {
  return normalizeKeywords(await storageGet('keywords', []));
}
async function saveKeywords(k) {
  await storageSet({ keywords: k || [] });
}

// ===== 优质关键词库（每个产品的固定词库，任务只从这里取词）=====
// 与旧版 keywords 分开存储：库是人工筛选沉淀的结果，增删即时生效
// 按手机号隔离：换账号登录后只会看到自己账号的优质库
async function getQualityKeywords() {
  return normalizeKeywords(await storageGet(await scopedKey('qualityKeywords'), []));
}
async function saveQualityKeywords(k) {
  await storageSet({ [await scopedKey('qualityKeywords')]: k || [] });
}
// 首次读取：把旧版关键词整体迁入优质库（历史数据不丢），只迁移一次
async function ensureQualityKeywords() {
  const key = await scopedKey('qualityKeywords');
  const stored = await chrome.storage.local.get(key);
  if (stored[key] === undefined) {
    const legacy = await getKeywords();
    await saveQualityKeywords(legacy);
    if (legacy.length) log('info', `已将原有 ${legacy.length} 个关键词迁入优质关键词库`);
    return legacy;
  }
  return normalizeKeywords(stored[key]);
}

// ===== 任务历史记录（任务列表 + 断点续跑）=====
// 记录结构：{id, status, startedAt, endedAt, reportRunId,
//   params:{products, keywords, phone}（参数快照，不含 apiKey；续跑时读当前设置）,
//   cursor:{gi, ki, doneNoteIds}（产品组/关键词索引 + 本关键词已处理笔记 id）,
//   progress 快照, stats:{comments, replies, dms, videos}}
// status：running 运行中 / paused 已暂停 / stopped 已停止 / completed 已完成 / interrupted 已中断
const TASK_HISTORY_MAX = 100;

async function getTaskHistory() {
  return (await storageGet('taskHistory', [])) || [];
}
async function saveTaskHistory(list) {
  await storageSet({ taskHistory: (list || []).slice(0, TASK_HISTORY_MAX) });
}

// 列表用摘要：不带产品长描述，避免广播 payload 膨胀
function taskSummary(r) {
  const params = r.params || {};
  return {
    id: r.id,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    productNames: (params.products || []).map((p) => p.name || '未命名产品'),
    keywordCount: (params.keywords || []).length,
    phone: params.phone || '',
    progress: r.progress || null,
    stats: r.stats || null,
    autoRestartCount: r.autoRestartCount || 0,
    retryNextAt: pendingRetry && pendingRetry.taskId === r.id ? pendingRetry.nextAt : null
  };
}
async function getTaskSummaries() {
  return (await getTaskHistory()).map(taskSummary);
}

// 串行化任务记录写入，避免并发读-改-写丢失更新
let taskPersistChain = Promise.resolve();
// 写入/更新一条记录（不存在则置顶），并向面板广播摘要列表
async function persistTaskRecord(rec) {
  if (!rec) return;
  const run = taskPersistChain.then(async () => {
    const list = await getTaskHistory();
    const copy = JSON.parse(JSON.stringify(rec));
    const i = list.findIndex((r) => r.id === rec.id);
    if (i >= 0) list[i] = copy; else list.unshift(copy);
    await saveTaskHistory(list);
    broadcast({ type: 'tasks', tasks: list.map(taskSummary) });
  });
  taskPersistChain = run.catch(() => { /* 忽略 */ });
  return run;
}

// SW 启动/面板拉取时调用：残留的 running/paused 说明任务已被关机/SW 回收打断
// （正在本 SW 实例运行的记录要跳过，不能误判）
async function reconcileInterruptedTasks() {
  const list = await getTaskHistory();
  let changed = false;
  const now = Date.now();
  const marked = [];
  for (const r of list) {
    if (task.running && currentRecord && r.id === currentRecord.id) continue;
    if (r.status === 'running' || r.status === 'paused') {
      r.status = 'interrupted';
      r.endedAt = r.endedAt || now;
      marked.push(r);
      changed = true;
    }
  }
  if (changed) await saveTaskHistory(list);
  // 被关机/SW 回收打断的任务：按设置间隔自动从断点重启
  for (const r of marked) {
    await scheduleAutoRestart(r, '浏览器/后台被系统回收，任务中断');
  }
  return list;
}

// ===== 任务中断自动重启 =====
// 任务异常或被系统回收中断后，用 chrome.alarms 定时把任务从断点续跑起来。
// pendingTaskRetry（存储键）：{taskId, nextAt}；内存镜像 pendingRetry 供任务摘要实时显示
// 重启次数记在任务记录的 autoRestartCount 上（随记录持久化，SW 重启不丢失）
async function loadPendingRetry() {
  pendingRetry = (await storageGet('pendingTaskRetry', null)) || null;
  return pendingRetry;
}
async function clearPendingRetry() {
  pendingRetry = null;
  await storageSet({ pendingTaskRetry: null });
  try { await chrome.alarms.clear('taskRetry'); } catch (e) { /* ignore */ }
}
// 安排一次自动重启。rec 为刚中断的任务记录，reason 仅用于日志
async function scheduleAutoRestart(rec, reason) {
  if (!rec || task.running) return;
  const settings = await getSettings();
  if (!settings.autoRestartInterrupted) {
    if (!rec.autoRestartOffLogged) {
      rec.autoRestartOffLogged = true;
      log('info', `任务已中断（${reason}）。自动重启已关闭，请在任务列表手动「继续执行」`);
      await persistTaskRecord(rec);
    }
    return;
  }
  const max = settings.autoRestartMaxAttempts;
  if (max > 0 && (rec.autoRestartCount || 0) >= max) {
    if (!rec.autoRestartCapped) {
      rec.autoRestartCapped = true;
      log('warn', `任务自动重启次数已达上限（${max} 次），不再自动重启，请手动「继续执行」或检查网络/登录状态`);
      await persistTaskRecord(rec);
    }
    return;
  }
  rec.autoRestartCount = (rec.autoRestartCount || 0) + 1;
  const delayMin = Math.max(1, Math.round(settings.autoRestartDelayMin || 5));
  const nextAt = Date.now() + delayMin * 60000;
  pendingRetry = { taskId: rec.id, nextAt };
  await storageSet({ pendingTaskRetry: pendingRetry });
  chrome.alarms.create('taskRetry', { when: nextAt });
  log('warn', `任务中断（${reason}），${delayMin} 分钟后自动从断点重启（第 ${rec.autoRestartCount} 次` +
    (max > 0 ? `，上限 ${max} 次` : '，不限次数') + '）。可在「设置」关闭自动重启');
  await persistTaskRecord(rec); // 计数落库并广播，面板任务列表显示重启信息
}
// 到点执行：从断点续跑（与面板「继续执行」同一套 runTask 续跑参数）
async function handleRetryAlarm() {
  const pending = pendingRetry || (await loadPendingRetry());
  if (!pending) return;
  await clearPendingRetry(); // 先消费，防止重复触发
  if (task.running) { log('info', '自动重启跳过：已有任务正在运行'); return; }
  const rec = (await getTaskHistory()).find((r) => r.id === pending.taskId);
  if (!rec) return;
  if (rec.status === 'running' || rec.status === 'completed' || rec.status === 'stopped') return;
  const auth = await getAuth();
  if (!auth || !auth.phone) {
    log('warn', '自动重启已取消：未登录，请登录后手动「继续执行」');
    return;
  }
  log('info', `自动重启任务（第 ${rec.autoRestartCount || 1} 次），从断点继续执行`);
  runTask({
    record: rec,
    resume: {
      cursor: rec.cursor || { gi: 0, ki: 0, doneNoteIds: [] },
      progress: rec.progress || null,
      stats: rec.stats || null,
      reportRunId: rec.reportRunId || null
    },
    phone: auth.phone
  });
}

// ===== 手机号 + 验证码登录（参考 ContextBuddy auth_service.py）=====
// 阿里云短信 Dysmsapi 2017-05-25 SendSms（RPC 签名 V1，HMAC-SHA1）
const SMS_CONFIG = {
  accessKeyId: '',
  accessKeySecret: '',
  signName: '哈希流光',
  templateCode: 'SMS_495955218'
};
const CODE_TTL_MS = 60 * 1000;        // 验证码有效期
const RESEND_COOLDOWN_MS = 60 * 1000; // 单号重发冷却
const PHONE_RE = /^1[3-9]\d{9}$/;

// 登录态持久化：local 为主、sync 兜底（local 偶发写入失败/被清理时仍能保持登录）
async function getAuth() {
  let a = (await storageGet('auth', null)) || null;
  if (a && a.phone) return a;
  try {
    const o = await chrome.storage.sync.get('auth');
    if (o.auth && o.auth.phone) return o.auth;
  } catch (e) { /* ignore */ }
  return null;
}

async function saveAuth(auth) {
  // 双写：local 失败不影响 sync，任一处成功登录态即可保留
  let localOk = true;
  try { await chrome.storage.local.set({ auth }); } catch (e) { localOk = false; }
  try { await chrome.storage.sync.set({ auth }); } catch (e) { /* ignore */ }
  if (!localOk) log('warn', '登录态写入本地存储失败，已用同步存储兜底');
}

async function clearAuth() {
  try { await chrome.storage.local.set({ auth: null }); } catch (e) { /* ignore */ }
  try { await chrome.storage.sync.set({ auth: null }); } catch (e) { /* ignore */ }
}

// Python urllib.parse.quote(safe='~') 的等价实现：只保留未保留字符 A-Za-z0-9 与 _.-~
function pctEncode(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// 阿里云短信发送（RPC 签名 V1）。返回 {ok, error}
async function aliyunSendSms(phone, code) {
  const params = {
    AccessKeyId: SMS_CONFIG.accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: 'cn-hangzhou',
    SignName: SMS_CONFIG.signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    TemplateCode: SMS_CONFIG.templateCode,
    // 注意：必须与 Python json.dumps 默认格式一致（冒号后带空格），否则签名不一致
    TemplateParam: '{"code": "' + String(code) + '"}',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2017-05-25'
  };
  const canonical = Object.keys(params)
    .sort()
    .map((k) => pctEncode(k) + '=' + pctEncode(params[k]))
    .join('&');
  const stringToSign = 'GET&%2F&' + pctEncode(canonical);

  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(SMS_CONFIG.accessKeySecret + '&'),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(stringToSign));
  params.Signature = bufToBase64(sigBuf);

  const url = 'https://dysmsapi.aliyuncs.com/?' +
    Object.keys(params).map((k) => pctEncode(k) + '=' + pctEncode(params[k])).join('&');

  let data;
  try {
    const res = await fetch(url, { method: 'GET' });
    data = await res.json();
  } catch (e) {
    return { ok: false, error: '短信发送请求失败：' + e.message };
  }
  if (data && data.Code === 'OK') return { ok: true };
  return { ok: false, error: (data && (data.Message || data.Code)) || '短信发送失败' };
}

// 验证码存 chrome.storage.session：SW 休眠重启后不丢，关闭浏览器自动清
async function sendAuthCode(phone) {
  phone = String(phone || '').trim();
  if (!PHONE_RE.test(phone)) return { ok: false, error: '请输入有效的手机号' };
  const now = Date.now();
  const store = (await chrome.storage.session.get('smsCodes')).smsCodes || {};
  const rec = store[phone];
  if (rec && now - rec.sentAt < RESEND_COOLDOWN_MS) {
    const remain = Math.ceil((RESEND_COOLDOWN_MS - (now - rec.sentAt)) / 1000);
    return { ok: false, error: '验证码已发送，请 ' + Math.max(remain, 1) + ' 秒后再试' };
  }
  const code = String(Math.floor(1000 + Math.random() * 9000));
  const r = await aliyunSendSms(phone, code);
  if (!r.ok) return { ok: false, error: r.error };
  store[phone] = { code, sentAt: now, expiresAt: now + CODE_TTL_MS };
  await chrome.storage.session.set({ smsCodes: store });
  return { ok: true, message: '验证码已发送，请注意查收' };
}

async function loginWithCode(phone, code) {
  phone = String(phone || '').trim();
  code = String(code || '').trim();
  if (!PHONE_RE.test(phone)) return { ok: false, error: '请输入有效的手机号' };
  if (!/^\d{4}$/.test(code)) return { ok: false, error: '请输入4位数字验证码' };
  const now = Date.now();
  const store = (await chrome.storage.session.get('smsCodes')).smsCodes || {};
  const rec = store[phone];
  if (!rec) return { ok: false, error: '请先获取验证码' };
  if (now > rec.expiresAt) {
    delete store[phone];
    await chrome.storage.session.set({ smsCodes: store });
    return { ok: false, error: '验证码已过期，请重新获取' };
  }
  if (code !== rec.code) return { ok: false, error: '验证码不正确' };
  delete store[phone];
  await chrome.storage.session.set({ smsCodes: store });
  // 切换登录态前，先把旧版全局数据归属到原登录手机号（从未登录过则归给本次新号），
  // 避免换手机号登录后看到上一个人的产品/设置/关键词库
  await migrateLegacyUserData(phone);
  const auth = {
    phone,
    loggedInAt: new Date().toLocaleString('zh-CN', { hour12: false })
  };
  await saveAuth(auth);
  log('success', `手机号 ${phone} 登录成功，本客户端将以该手机号标识`);
  // 产品以服务端为准：拉取该手机号的产品库（服务端没有则本地置空；拉取失败保留本地）
  const remote = await pullProductsFromServer(phone);
  if (remote) {
    await saveProducts(remote);
    log('info', remote.length
      ? `已从服务端加载 ${remote.length} 个产品`
      : '该手机号在服务端暂无产品，本地产品库已置空');
  } else {
    log('warn', '服务端产品拉取失败，暂时使用本地产品库');
  }
  // 上报登录事件（服务端看板按手机号标识客户端）
  reportEvent('login', { phone, client: 'chrome-extension' });
  // 登录后同步一次产品信息，服务端即拥有该客户端当前的产品清单
  const products = await getProducts();
  reportEvent('product-sync', {
    phone,
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      selected: !!p.selected
    }))
  });
  return { ok: true, phone };
}

// 从服务端拉取指定手机号的产品库（登录后同步用）；失败返回 null（保留本地数据不动）
async function pullProductsFromServer(phone) {
  try {
    const settings = await getSettings();
    const base = (settings.reportUrl || '').replace(/\/+$/, '');
    if (!base) return null;
    const res = await fetch(base + '/api/products?phone=' + encodeURIComponent(phone), {
      headers: { 'X-Api-Key': settings.reportKey || '' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || data.ok !== true || !Array.isArray(data.products)) return null;
    return data.products
      .filter((p) => p && p.id && p.name)
      .map((p) => ({
        id: String(p.id),
        name: String(p.name),
        description: String(p.description || ''),
        selected: !!p.selected
      }));
  } catch (e) {
    return null;
  }
}

// 节流地从服务端拉取产品库并写入本地：解决「reload/重开面板后看不到服务端新增产品」的问题。
// 只在登录后拉取；默认 60s 内不重复请求，避免每次 GET_STATE 都打服务端。
// 注意：只拉取不回写（不像登录那样 product-sync），所以即使拉取失败也不会误删服务端数据。
let lastProductPullAt = 0;
async function refreshProductsFromServerIfNeeded(force = false) {
  try {
    const auth = await getAuth().catch(() => null);
    if (!auth || !auth.phone) return;
    const now = Date.now();
    if (!force && now - lastProductPullAt < 60 * 1000) return;
    lastProductPullAt = now;
    const remote = await pullProductsFromServer(auth.phone);
    if (Array.isArray(remote)) {
      await saveProducts(remote);
    }
  } catch (e) { /* 静默：拉取失败不能影响 GET_STATE 返回 */ }
}

// ===== 运行数据上报（服务端看板）=====
// 失败静默忽略：上报不能影响主流程；8 秒超时防止服务端异常拖慢任务
async function reportEvent(type, payload) {
  try {
    const settings = await getSettings();
    const base = (settings.reportUrl || '').replace(/\/+$/, '');
    if (!base) return null;
    const res = await fetch(base + '/api/report/' + type, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': settings.reportKey || ''
      },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(8000)
    });
    return await res.json().catch(() => null);
  } catch (e) {
    return null;
  }
}

// 上报潜在客户：评论获客流程中 AI 判为感兴趣的用户登记到看板，按产品维护。
// 同一 (手机号, 产品, 用户) 重复上报由服务端 upsert 合并，不覆盖人工维护的状态/备注。
function reportLead(payload) {
  return reportEvent('lead', payload || {});
}

// ===== 每日发送上限（按手机号，仅统计成功的出站动作）=====
// 单一数据源在服务端 action_logs；插件发送前查询今日已发数，达到上限即停任务，避免账号被风控。
const QUOTA_CACHE_TTL = 30 * 1000; // 额度缓存 30s，避免每个动作都请求服务端
let quotaCache = null;             // { date, total, fetchedAt }
let quotaSessionSent = 0;          // 本次会话自上次拉取后成功发送的动作数（补齐服务端上报延迟）

// 上报一条出站动作（comment/reply/dm/follow/share），仅在发送成功时调用
function reportAction(actionType, extra = {}) {
  const p = reportEvent('action', Object.assign({ action_type: actionType }, extra));
  // 上报后把最新用量推给面板，让「今日已发」实时跳动（不阻塞主流程）
  p.then(() => pushDailyUsage()).catch(() => {});
  return p;
}

// 推送今日用量快照给面板
function pushDailyUsage() {
  getDailyUsageSnapshot().then((usage) => {
    broadcast({ type: 'daily-usage', usage });
  }).catch(() => {});
}

// 拉取某手机号今日已成功发送数（带缓存 + 会话增量）
async function getTodayUsage(phone) {
  try {
    if (!quotaCache || Date.now() - quotaCache.fetchedAt > QUOTA_CACHE_TTL) {
      const settings = await getSettings();
      const base = (settings.reportUrl || '').replace(/\/+$/, '');
      if (base) {
        const res = await fetch(base + '/api/quota?phone=' + encodeURIComponent(phone), {
          method: 'GET',
          headers: { 'X-Api-Key': settings.reportKey || '' },
          signal: AbortSignal.timeout(8000)
        });
        const j = await res.json().catch(() => null);
        if (j && j.ok) {
          // 服务端跨天（date 变化）则重置会话增量
          if (quotaCache && quotaCache.date && j.date && quotaCache.date !== j.date) {
            quotaSessionSent = 0;
          }
          quotaCache = { date: j.date, total: j.today_total || 0, fetchedAt: Date.now() };
        }
      }
    }
  } catch (e) {
    log('warn', '查询每日额度失败：' + (e && e.message));
  }
  return (quotaCache ? quotaCache.total : 0) + quotaSessionSent;
}

// 检查是否达到每日上限；达到则停止当前任务并广播，返回 true。
// 额度查询异常时返回 false（不阻断任务，避免误伤）。
async function checkDailyLimit() {
  try {
    const settings = await getSettings();
    const limit = Number(settings.dailyLimit);
    if (!limit || limit <= 0) return false; // 0 或未设置 = 不限制
    const auth = await getAuth();
    const phone = auth && auth.phone;
    if (!phone) return false;
    const used = await getTodayUsage(phone);
    if (used >= limit) {
      log('warn', `今日已发送 ${used} 条，达到每日上限 ${limit}，停止任务以保护账号`);
      task.stopRequested = true;
      task.stopReason = `已达每日发送上限 ${used}/${limit}`;
      broadcast({ type: 'daily-limit-hit', used, limit });
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

// 供面板展示：返回当前今日用量快照（不强制刷新，用缓存值）
async function getDailyUsageSnapshot() {
  const settings = await getSettings();
  const auth = await getAuth().catch(() => null);
  const phone = auth && auth.phone;
  const limit = Number(settings.dailyLimit) || 0;
  if (!phone) return { phone: '', limit, used: 0, remaining: limit || 0 };
  const used = await getTodayUsage(phone);
  return { phone, limit, used, remaining: limit > 0 ? Math.max(0, limit - used) : -1 };
}

async function getCommentedNotes() {
  return (await storageGet('commentedNotes', [])) || [];
}

// ===== 日志 =====
function log(level, message, meta) {
  const entry = {
    time: Date.now(),
    timeStr: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    level, // info | success | warn | error
    message: String(message),
    meta: meta || null
  };
  logs.push(entry);
  if (logs.length > 500) logs = logs.slice(-500);
  storageSet({ logs: logs.slice(-200) });
  broadcast({ type: 'log', entry });
}

function broadcast(msg) {
  for (const port of panelPorts) {
    try { port.postMessage(msg); } catch (e) { /* ignore */ }
  }
}

function stateSnapshot() {
  return {
    task: { ...task },
    productsCount: 0,
    keywordsCount: 0
  };
}
function broadcastState() {
  // 同步进任务记录（仅内存）：暂停/落库时拿到的都是最新进度
  if (currentRecord) currentRecord.progress = { ...task.progress };
  broadcast({ type: 'state', state: { ...task, progress: { ...task.progress } } });
}

// ===== LLM 调用 =====
async function callLLM(messages, opts = {}) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    // 没配 Key 时直接给明确提示：设置按手机号隔离，每个手机号需各自配置
    throw new Error('未配置 LLM API Key，请先在「设置 → 模型与接口设置」中填写');
  }
  const base = (settings.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const body = {
    model: opts.model || settings.model || 'qwen3.7-plus',
    messages,
    temperature: opts.temperature !== undefined ? opts.temperature : 0.85,
    top_p: 0.9
  };
  if (opts.json) body.response_format = { type: 'json_object' };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (settings.apiKey || '')
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 未返回内容');
  return content;
}

// ===== 关键词生成 =====
// 核心原则：只生成"产品真能满足搜索者需求"的关键词。
// 先让模型盘点产品真实能力与做不到的事，再据此生成关键词并自检，
// 避免出现与产品无关、或产品根本满足不了搜索者需求的词。
// ===== 关键词生成（按产品逐个生成，保证关键词与产品一一对应）=====
async function generateKeywordsForProduct(product) {
  const settings = await getSettings();
  // 关键词生成单独用更强的模型（keywordModel），效果不好时可在设置里更换
  const keywordModel = settings.keywordModel || settings.model || 'qwen4-max-preview';
  const sys =
    '你是小红书搜索行为分析专家。你的唯一标准是：搜这个词的人，是不是这个产品的潜在客户，' +
    '并且他的需求这个产品是否真的能满足。产品做不到的需求，一概不生成对应关键词。';

  const user =
    '产品名称：' + product.name + '\n' +
    '产品描述：' + product.description + '\n\n' +
    '请严格分三步生成小红书搜索关键词。\n\n' +
    '第一步：能力盘点（只能从产品描述中提炼，不能臆测产品没有的功能）\n' +
    '1. 列出产品 3~6 个真实能力；\n' +
    '2. 每个能力对应用户的什么痛点或场景；\n' +
    '3. 列出产品做不到的事（描述未提及、或不属于产品范围的能力都算做不到，例如找回已删除的数据、远程监控他人等）。\n\n' +
    '第二步：生成关键词，必须同时满足以下全部条件：\n' +
    '1. 每个关键词必须对应第一步中"产品确实能做到"的痛点；产品做不到的痛点，一律不生成对应关键词；\n' +
    '2. 是目标用户会主动张口搜的词：口语化，像普通用户自己打的字，2~8 个字；\n' +
    '3. 搜索意图必须是"遇到问题想找方法/找经验/找工具"，或"找合作伙伴/找技术团队/找开发人才/找项目搭档"（仅当产品描述明确写了承接合作、定制开发、技术合伙时才生成后者）；不要娱乐、八卦、围观测评、纯好奇类词（这类搜索者不会转化）；\n' +
    '4. 不得包含产品名、品牌名、公司名；\n' +
    '5. 不要过于宽泛的词（如"效率工具""知识管理"这类谁都在搜、人群不聚焦的词）；\n' +
    '6. 覆盖不同痛点和人群，不要意思相近的词堆数量；\n' +
    '7. 共 10~15 个。\n\n' +
    '第三步：自检。逐个核对每个关键词：若它对应的痛点产品其实做不到，或搜索者根本不是潜在客户，就删掉。\n\n' +
    '只输出 JSON，格式：\n' +
    '{"capabilities":["能力1（对应痛点）","能力2（对应痛点）"],"cannotDo":["做不到的事1"],"keywords":["关键词1","关键词2"]}';

  const content = await callLLM(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    { json: true, temperature: 0.5, model: keywordModel }
  );

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch (e2) { parsed = null; }
    }
  }
  const clean = (arr) =>
    (Array.isArray(arr) ? arr : []).map((x) => String(x).trim()).filter(Boolean);
  const keywords = clean(parsed && parsed.keywords).filter((v, i, a) => a.indexOf(v) === i);
  return {
    keywords,
    capabilities: clean(parsed && parsed.capabilities),
    cannotDo: clean(parsed && parsed.cannotDo)
  };
}

// 多产品：逐个产品生成，关键词带上产品归属，任务执行时按产品分组，评论/回复不会串产品
async function generateKeywords(products) {
  const out = [];
  const allCaps = [];
  const allCannot = [];
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    log('info', `[产品 ${i + 1}/${products.length}] 正在为其生成关键词：${p.name}`);
    let r;
    try {
      r = await generateKeywordsForProduct(p);
    } catch (e) {
      log('warn', `产品「${p.name}」关键词生成失败：${e.message}`);
      continue;
    }
    if (r.capabilities.length) log('info', `「${p.name}」能力盘点：` + r.capabilities.join('；'));
    if (r.cannotDo.length) log('info', `「${p.name}」做不到（相关词已排除）：` + r.cannotDo.join('；'));
    for (const kw of r.keywords) {
      out.push({ text: kw, productId: p.id, productName: p.name });
    }
    allCaps.push(...r.capabilities);
    allCannot.push(...r.cannotDo);
    log('success', `「${p.name}」生成 ${r.keywords.length} 个关键词`);
  }
  // 同一关键词被多个产品生成时只保留第一个，避免重复搜索
  const seen = new Set();
  const dedup = out.filter((k) => {
    if (seen.has(k.text)) return false;
    seen.add(k.text);
    return true;
  });
  return { keywords: dedup, capabilities: allCaps, cannotDo: allCannot };
}

// ===== 评论生成 =====
async function generateComment(product, info, withHook) {
  const settings = await getSettings();
  const sys =
    '你就是个普通小红书用户，刷到这条随手留一句。说人话，别端着。' +
    '你的人设：踩过视频里这个坑、并且已经自己解决了的人。' +
    '你的评论要让刷到的人觉得"这人有路子"，想问他到底怎么弄的，但他偏又把话说一半。' +
    '绝不能像客服、营销号、AI，也不要"希望对你有帮助""值得一试"这种客套话，' +
    '不要排比、不要总结、不要小作文、不要堆感叹号。';

  const comments = (info.comments || [])
    .slice(0, 6)
    .map((c) => `- ${c.name || '用户'}：${c.content}`)
    .join('\n');

  // 钩子模式：共鸣 + 暗示解决 + 暗语引导；纯共鸣模式：共鸣 + 意犹未尽，不主动引导
  // 两种模式交替出现，避免每条都带钩子，一看就是营销号
  const hookRules = withHook
    ? '1. 开头贴视频内容共鸣：针对视频里的具体问题吐槽或认同，别泛泛而谈；\n' +
      '2. 中间暗示你自己已经解决了：比如"后来找对路子才好""抄了近道才搞定""靠个偏方弄好的"，方法绝不展开；\n' +
      '3. 结尾留钩子但不把话说白：用"评论区不方便细说""在这说容易被夹""你懂的""戳我""思信""不好公开讲"这类说法勾别人来问，绝不能直接写"私我""加微信""免费送""+v"这种明文，且每次换一种说法，别重复；\n'
    : '1. 开头贴视频内容共鸣：针对视频里的具体问题吐槽或认同，别泛泛而谈；\n' +
      '2. 结尾意犹未尽：比如"后来弄好了""改对个地方才成"，不主动勾搭，但方法也别说透；\n';

  const user =
    '产品名称：' + product.name + '\n' +
    '产品描述：' + product.description + '\n\n' +
    '视频标题：' + (info.title || '(无)') + '\n' +
    '视频内容：' + (info.desc || '(无)') + '\n' +
    '作者：' + (info.author || '(未知)') + '\n' +
    '部分已有评论：\n' + (comments || '(无)') + '\n\n' +
    '写一条极短的中文评论，' + settings.commentMinLen + '~' + settings.commentMaxLen + '字，像刷手机时随手打的。\n' +
    '写法（三句话融成一句）：\n' +
    hookRules +
    '其他要求：\n' +
    'a. 口语化，可以带语气词（啊/吧/了/真的/咋），可以省略主语，最多一个标点；\n' +
    'b. 贴合视频内容，别硬提产品名，别提私我；不要贴超链接，但产品描述里明确给出官网域名的，可以自然带一句域名（如 shiflowmind.cloud），没给就不提；\n' +
    'c. 信息只说一半，解决方法永远不写出来——写出来就没钩子了；\n' +
    'd. 只输出评论正文，不要引号、不要解释、不要换行。';

  const content = await callLLM(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    { temperature: 1.0 }
  );

  let c = (content || '').trim();
  c = c.replace(/^["'“”\s]+|["'“”\s]+$/g, '');
  c = c.replace(/\n+/g, ' ').trim();
  if (c.length > settings.commentMaxLen) {
    // 超长时优先在标点处断开，避免句子被砍成半截
    const cut = c.slice(0, settings.commentMaxLen + 5);
    const m = cut.match(/^[\s\S]*[，,。！？~～]/);
    c = (m ? m[0] : cut.slice(0, settings.commentMaxLen)).replace(/[，,。！？~～\s]+$/, '');
  }
  return c;
}

// ===== 评论区兴趣分析：找出对产品有真实需求的用户 =====
async function analyzeInterestedComments(product, info, comments) {
  const list = comments
    .map((c) => `${c.index}. ${c.name}：${c.content}`)
    .join('\n');

  const sys =
    '你是社交媒体评论分析专家，擅长从评论区里找出"对某个产品有真实需求"的人。' +
    '判断必须严格：只有评论明确表达了需求、困惑、提问或求助，且这个需求产品确实能满足时才选中。';

  const user =
    '产品名称：' + product.name + '\n' +
    '产品描述：' + product.description + '\n\n' +
    '视频标题：' + (info.title || '(无)') + '\n' +
    '视频内容：' + (info.desc || '(无)') + '\n\n' +
    '评论区（编号. 昵称：内容）：\n' + list + '\n\n' +
    '请挑出"对产品可能感兴趣"的评论，要求：\n' +
    '1. 评论者表达了与产品能力相关的需求、困惑、提问或求助；\n' +
    '2. 纯赞同、纯夸奖、闲聊、与产品无关的内容，一律不选；\n' +
    '3. 最多选 3 个，按感兴趣程度从高到低排；\n' +
    '4. 一条都不符合就返回空数组，不要硬凑。\n\n' +
    '只输出 JSON：{"interested":[{"index":<上面评论的编号>,"reason":"<一句话理由>"}]}';

  const content = await callLLM(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    { json: true, temperature: 0.3 }
  );

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch (e2) { parsed = null; }
    }
  }
  const arr = (parsed && Array.isArray(parsed.interested) && parsed.interested) || [];
  return arr
    .filter((x) => x && typeof x.index === 'number')
    .map((x) => ({ index: x.index, reason: String(x.reason || '').slice(0, 60) }));
}

// ===== 回复内容生成：回复感兴趣的用户，吸引其他人私聊 =====
async function generateReply(product, info, target) {
  const settings = await getSettings();
  const sys =
    '你是小红书上一个真实用户，正在回复别人的评论。你对这个话题有亲身经验，愿意顺手分享。' +
    '回复要短、口语化、像真人，绝不像客服，绝不像广告。';

  const user =
    '产品名称：' + product.name + '\n' +
    '产品描述：' + product.description + '\n\n' +
    '视频标题：' + (info.title || '(无)') + '\n\n' +
    '你要回复的用户昵称：' + target.name + '\n' +
    '他的评论内容：' + target.content + '\n\n' +
    '请写一条回复，要求：\n' +
    '1. 10~25 字，口语化，像刷手机时随手回的；\n' +
    '2. 顺着他的评论说（认同、补充经验或分享自己的做法），让他觉得你懂他；\n' +
    '3. 自然带出产品能帮上忙的地方——讲你的做法，别报产品名，别像推销；\n' +
    '4. 结尾自然地邀请私聊，例如"想了解的话私我""需要的话单独聊"；产品描述里明确给出官网域名的，也可以自然引导去官网看看（如"官网 shiflowmind.cloud 有案例"）；不要"点击链接""加微信"这类话，不要贴超链接；\n' +
    '5. 只输出回复正文，不要引号、解释、换行。';

  const content = await callLLM(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    { temperature: 0.9 }
  );

  let c = (content || '').trim();
  c = c.replace(/^["'“”\s]+|["'“”\s]+$/g, '');
  c = c.replace(/\n+/g, ' ').trim();
  if (c.length > settings.commentMaxLen) {
    const cut = c.slice(0, settings.commentMaxLen + 5);
    const m = cut.match(/^[\s\S]*[，,。！？~～]/);
    c = (m ? m[0] : cut.slice(0, settings.commentMaxLen)).replace(/[，,。！？~～\s]+$/, '');
  }
  return c;
}

// ===== 私信内容生成：给感兴趣的用户发一对一私信，吸引其进一步了解产品 =====
async function generateDM(product, info, target) {
  const sys =
    '你是小红书上一个真实用户，正在给一位看过你视频、留过言的用户发私信。' +
    '私信要像真人一对一聊天：自然、有针对性，绝对不像群发广告。';

  const user =
    '产品名称：' + product.name + '\n' +
    '产品描述：' + product.description + '\n\n' +
    '视频标题：' + (info.title || '(无)') + '\n\n' +
    '对方昵称：' + target.name + '\n' +
    '对方在视频下的评论：' + target.content + '\n\n' +
    '请写一条私信，要求：\n' +
    '1. 20~50 字，口语化，像真人在打字；\n' +
    '2. 结合对方的评论内容说事，让他感觉你确实看过他说的话；\n' +
    '3. 自然带出产品能帮上忙的点，然后邀请进一步了解；产品描述里明确给出官网域名的，结尾自然带上域名本身（不要带 http:// 或 https://，不要用超链接形式）；没给域名的，就邀请他回复继续聊；\n' +
    '4. 不要用"亲""您好""打扰了"等客服腔，不要堆感叹号，不要出现"福利""限时""点击"等营销词；\n' +
    '5. 只输出私信正文，不要引号、解释、换行。';

  const content = await callLLM(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    { temperature: 0.9 }
  );

  let c = (content || '').trim();
  c = c.replace(/^["'“”\s]+|["'“”\s]+$/g, '');
  c = c.replace(/\n+/g, ' ').trim();
  return c.slice(0, 120);
}

// ===== 视频推广：从视频简介生成推广搜索词 =====
async function generatePromoKeywords(promo) {
  const settings = await getSettings();
  const keywordModel = settings.keywordModel || settings.model || 'qwen4-max-preview';
  const sys =
    '你是小红书内容兴趣分析专家。根据一个视频的简介，推断出"对这类视频感兴趣的人会主动搜什么词"，' +
    '用来搜索同类视频，在它们的评论区里找到可能喜欢这个视频的用户。';
  const user =
    '视频标题：' + (promo.title || '(未填)') + '\n' +
    '视频简介：' + (promo.intro || '(未填)') + '\n\n' +
    '请生成小红书搜索关键词，要求：\n' +
    '1. 是对这类视频/话题感兴趣的人会主动搜的词，口语化、像用户自己打的字，2~10 个字；\n' +
    '2. 覆盖视频简介里的不同主题/角度，不要堆近义词；\n' +
    '3. 不要包含视频里的具体人名、账号名；\n' +
    '4. 共 8~12 个；\n' +
    '5. 只输出 JSON：{"keywords":["词1","词2"]}';
  const content = await callLLM(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { json: true, temperature: 0.6, model: keywordModel }
  );
  let parsed;
  try { parsed = JSON.parse(content); } catch (e) {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) { parsed = null; } }
  }
  const arr = (Array.isArray(parsed && parsed.keywords) ? parsed.keywords : [])
    .map((x) => String(x).trim()).filter(Boolean);
  return arr.filter((v, i, a) => a.indexOf(v) === i).slice(0, 15);
}

// ===== 视频推广：判断评论者是否会对我方视频感兴趣 =====
async function analyzeVideoInterest(promo, info, comments) {
  const list = comments.map((c) => `${c.index}. ${c.name}：${c.content}`).join('\n');
  const sys =
    '你是社交媒体受众分析专家，要从一条视频的评论区里找出"会对另一个指定视频感兴趣"的人。' +
    '判断必须严格：只有评论明确表现出对该话题的好奇、认同、提问、想看、共鸣时才选中。';
  const user =
    '我方视频标题：' + (promo.title || '(未填)') + '\n' +
    '我方视频简介：' + (promo.intro || '(未填)') + '\n\n' +
    '当前所在视频标题：' + (info.title || '(无)') + '\n' +
    '当前所在视频内容：' + (info.desc || '(无)') + '\n\n' +
    '评论区（编号. 昵称：内容）：\n' + list + '\n\n' +
    '请挑出"会对我方视频感兴趣"的评论，要求：\n' +
    '1. 评论者表现出对我方视频话题的好奇、提问、认同、想看、或明确的兴趣信号；\n' +
    '2. 纯灌水、纯表情、与话题无关的内容一律不选；\n' +
    '3. 最多选 3 个，按感兴趣程度从高到低；\n' +
    '4. 一条都不符合就返回空数组，不要硬凑。\n\n' +
    '只输出 JSON：{"interested":[{"index":<评论编号>,"reason":"<一句话理由>"}]}';
  const content = await callLLM(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { json: true, temperature: 0.3 }
  );
  let parsed;
  try { parsed = JSON.parse(content); } catch (e) {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) { parsed = null; } }
  }
  const arr = (parsed && Array.isArray(parsed.interested) && parsed.interested) || [];
  return arr.filter((x) => x && typeof x.index === 'number')
    .map((x) => ({ index: x.index, reason: String(x.reason || '').slice(0, 60) }));
}

// ===== 视频推广：生成分享配文（结合对方评论，自然推荐我方视频）=====
async function generatePromoShareText(promo, info, target) {
  const sys =
    '你是小红书上一个真实用户，正要把一个视频分享给一位在评论区留言的用户。' +
    '配文要像真人随手写的，自然、有针对性，绝不像群发广告。';
  const user =
    '我方视频标题：' + (promo.title || '(未填)') + '\n' +
    '我方视频简介：' + (promo.intro || '(未填)') + '\n\n' +
    '对方昵称：' + target.name + '\n' +
    '对方在视频下的评论：' + target.content + '\n\n' +
    '请写一句分享配文，要求：\n' +
    '1. 10~30 字，口语化，像真人打字；\n' +
    '2. 结合对方评论，说明为什么觉得这个视频他会感兴趣；\n' +
    '3. 不要客服腔，不要"亲/您好/打扰了"，不要营销词；\n' +
    '4. 只输出配文正文，不要引号、解释、换行。';
  const content = await callLLM(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { temperature: 0.9 }
  );
  let c = (content || '').trim();
  c = c.replace(/^["'""\s]+|["'""\s]+$/g, '');
  c = c.replace(/\n+/g, ' ').trim();
  return c.slice(0, 60);
}

// ===== content script 通信 =====
async function sendContent(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    // content script 可能未注入，手动注入后重试一次
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await sleep(800);
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e2) {
      return { ok: false, error: String(e2 && e2.message ? e2.message : e2) };
    }
  }
}

async function waitForContentReady(tabId, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const r = await sendContent(tabId, { type: 'PING' });
    if (r && r.ok) return true;
    await sleep(500);
  }
  return false;
}

async function waitForPageType(tabId, type, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const r = await sendContent(tabId, { type: 'PING' });
    if (r && r.ok && r.pageType === type) return true;
    await sleep(500);
  }
  return false;
}

function navigateAndWait(tabId, url, timeout = 25000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(true);
    };
    const listener = (tid, info) => {
      if (tid === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch(() => finish());
    setTimeout(finish, timeout);
  });
}

function searchUrl(keyword) {
  return 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(keyword) + '&source=web_search_result_notes';
}

async function ensureTab() {
  const tabs = await chrome.tabs.query({ url: '*://*.xiaohongshu.com/*' });
  if (tabs.length) {
    // 优先取活动 tab
    const active = tabs.find((t) => t.active);
    return active || tabs[0];
  }
  return chrome.tabs.create({ url: 'https://www.xiaohongshu.com/explore', active: true });
}

function humanSleep(minSec, maxSec, reason) {
  const sec = rnd(minSec, maxSec);
  log('info', `${reason}，等待 ${sec.toFixed(1)}s`);
  return sleep(sec * 1000);
}

async function waitWhilePaused() {
  while (task.paused && !task.stopRequested) {
    await sleep(500);
  }
}

async function isAlreadyCommented(noteId) {
  const list = await getCommentedNotes();
  return list.some((n) => n.id === noteId);
}
async function recordCommented(noteId, data) {
  const list = await getCommentedNotes();
  list.push({ id: noteId, ...data, time: Date.now() });
  // 只保留最近 500 条
  const trimmed = list.slice(-500);
  await storageSet({ commentedNotes: trimmed });
}

// ===== 已回复的评论（去重，避免同一评论重复回复） =====
async function getRepliedComments() {
  return (await storageGet('repliedComments', [])) || [];
}
async function isAlreadyReplied(noteId, name, content) {
  const list = await getRepliedComments();
  return list.some((r) => r.noteId === noteId && r.name === name && r.content === content);
}
async function recordRepliedComment(noteId, name, content, reply, phone) {
  const list = await getRepliedComments();
  list.push({ noteId, name, content, reply, phone: phone || '', time: Date.now() });
  await storageSet({ repliedComments: list.slice(-500) });
}

// ===== 私信记录（按用户去重：同一个用户只私信一次）=====
async function getDmRecords() {
  return (await storageGet('dmRecords', [])) || [];
}
async function isAlreadyDmed(userId) {
  if (!userId) return false;
  const list = await getDmRecords();
  return list.some((r) => r.userId === userId);
}
async function recordDmed(userId, name) {
  const list = await getDmRecords();
  list.push({ userId, name: name || '', time: Date.now() });
  await storageSet({ dmRecords: list.slice(-500) });
}

// ===== 视频推广配置（按手机号隔离）=====
const DEFAULT_PROMO = {
  videoUrl: '',          // 要推广的小红书视频链接
  noteId: '',            // 从链接解析出的笔记 ID
  title: '',             // 视频标题（可选）
  intro: '',             // 视频简介：用于生成搜索词、判断兴趣、生成分享配文
  keywords: [],          // 确认后的推广搜索词
  maxVideosPerKeyword: 5, // 每个搜索词最多处理几个目标视频
  maxInterestedPerVideo: 2, // 每个视频最多选几个感兴趣的人
  maxFollowsPerRun: 10,  // 单轮关注上限
  maxSharesPerRun: 10,   // 单轮分享上限
  followDelayMin: 12,    // 关注后停留（秒）
  followDelayMax: 25,
  shareDelayMin: 15,     // 分享后停留（秒）
  shareDelayMax: 30,
  dryRun: true           // 默认空跑：只采集+分析+打日志，不真正关注/分享
};
async function getPromoConfig() {
  const raw = await storageGet(await scopedKey('promo'), {});
  return { ...DEFAULT_PROMO, ...(raw || {}) };
}
async function savePromoConfig(cfg) {
  const key = await scopedKey('promo');
  // 与当前已存配置合并：面板只发部分字段（如保存限制项）时，不能清空已确认的关键词等
  const cur = await storageGet(key, {});
  const merged = { ...DEFAULT_PROMO, ...(cur || {}), ...(cfg || {}) };
  await storageSet({ [key]: merged });
  return merged;
}
// 从视频链接解析 noteId（/discovery/item/<id> 或 /explore/<id>）
function parseNoteId(url) {
  if (!url) return '';
  const m = String(url).match(/\/(?:discovery\/item|explore)\/([a-f0-9]+)/i);
  return m ? m[1] : '';
}

// ===== 推广去重：已关注 / 已分享（按手机号隔离）=====
async function getPromoFollowed() {
  return (await storageGet(await scopedKey('promoFollowed'), [])) || [];
}
async function isPromoFollowed(userId) {
  if (!userId) return false;
  const list = await getPromoFollowed();
  return list.some((r) => r.userId === userId);
}
async function recordPromoFollowed(userId, name) {
  const key = await scopedKey('promoFollowed');
  const list = await storageGet(key, []);
  list.push({ userId, name: name || '', time: Date.now() });
  await storageSet({ [key]: list.slice(-500) });
}
async function getPromoShared() {
  return (await storageGet(await scopedKey('promoShared'), [])) || [];
}
async function isPromoShared(userId) {
  if (!userId) return false;
  const list = await getPromoShared();
  return list.some((r) => r.userId === userId);
}
async function recordPromoShared(userId, name, method) {
  const key = await scopedKey('promoShared');
  const list = await storageGet(key, []);
  list.push({ userId, name: name || '', method: method || '', time: Date.now() });
  await storageSet({ [key]: list.slice(-500) });
}

// ===== 任务主循环 =====
// cfg 两种形态：
//   新建：{products, keywords, phone}
//   续跑：{record, resume:{cursor, progress, stats, reportRunId}, phone}（record 为任务列表里的旧记录）
async function runTask(cfg) {
  const settings = await getSettings();
  task.running = true;
  task.paused = false;
  task.stopRequested = false;
  task.recordId = null;
  let taskError = null;

  const isResume = !!cfg.record;
  // 按产品分组：一个产品一个产品地跑，关键词/评论/回复都属于同一个产品，不会张冠李戴
  // 续跑用记录里的参数快照重建分组，产品顺序与关键词归属不受用户后续改动影响
  const products = isResume ? (cfg.record.params.products || []) : (cfg.products || []);
  const keywords = isResume ? normalizeKeywords(cfg.record.params.keywords) : normalizeKeywords(cfg.keywords || []);
  const groups = buildProductGroups(products, keywords, settings.maxKeywordsPerTask);
  if (!groups.length) {
    log('error', '任务未启动：所选产品的优质关键词库为空，请先在「关键词」页生成并移入库');
    task.running = false;
    task.paused = false;
    broadcastState();
    return;
  }
  // 启动前检查每日上限：已达上限则不启动任务，避免账号被风控
  if (await checkDailyLimit()) {
    task.running = false;
    task.paused = false;
    broadcastState();
    return;
  }
  const allKeywordCount = groups.reduce((n, g) => n + g.keywords.length, 0);

  // 续跑断点：从哪个产品组/关键词继续，本关键词中断前已处理过哪些笔记
  const resume = cfg.resume || null;
  const startGi = resume && resume.cursor ? (resume.cursor.gi || 0) : 0;
  const startKi = resume && resume.cursor ? (resume.cursor.ki || 0) : 0;
  const resumeDoneIds = resume && resume.cursor && resume.cursor.doneNoteIds ? resume.cursor.doneNoteIds : [];

  // 任务列表记录：续跑复用旧记录（状态改回 running），否则新建一条
  if (isResume) {
    currentRecord = cfg.record;
    currentRecord.status = 'running';
    currentRecord.endedAt = null;
  } else {
    currentRecord = {
      id: 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      params: {
        products: products.map((p) => ({ id: p.id, name: p.name || '', description: p.description || '', selected: !!p.selected })),
        keywords: keywords.map((k) => ({ text: k.text, productId: k.productId || '', productName: k.productName || '' })),
        phone: cfg.phone || ''
      },
      cursor: { gi: 0, ki: 0, doneNoteIds: [] },
      progress: null,
      stats: { comments: 0, replies: 0, dms: 0, videos: 0 },
      reportRunId: null
    };
  }
  task.recordId = currentRecord.id;
  // 任务已在跑：取消之前安排的自动重启（重试已失去意义，再次中断会重新安排）
  await clearPendingRetry();

  // 断点失效保护：产品/关键词被删、每产品关键词上限调小导致组数不足时不能硬跑
  if (isResume && (startGi >= groups.length || startKi >= (groups[startGi].keywords || []).length)) {
    log('error', '无法继续：产品/关键词已被删除或修改，原断点失效，请使用「重新执行」');
    currentRecord.status = 'stopped';
    currentRecord.endedAt = Date.now();
    await persistTaskRecord(currentRecord);
    currentRecord = null;
    task.running = false;
    task.paused = false;
    task.recordId = null;
    broadcastState();
    return;
  }

  // 进度初始化；续跑恢复累计值，让进度条接着中断处显示
  task.progress = {
    product: 0, productTotal: groups.length,
    keyword: 0, keywordTotal: allKeywordCount,
    note: 0, noteTotal: 0, done: 0, total: 0, dms: 0
  };
  let totalComments = 0;
  let totalReplies = 0;
  let totalDMs = 0;
  let totalVideos = 0;
  if (resume) {
    const p = resume.progress || {};
    task.progress.product = p.product || 0;
    task.progress.keyword = p.keyword || 0;
    task.progress.done = p.done || 0;
    task.progress.dms = p.dms || 0;
    const s = resume.stats || {};
    totalComments = s.comments || 0;
    totalReplies = s.replies || 0;
    totalDMs = s.dms || 0;
    totalVideos = s.videos || 0;
  }

  // 把游标/进度/统计同步进任务记录：checkpoint 落库、暂停时立即保存都靠它
  const setCursor = (gi, ki, doneIds) => {
    if (currentRecord) currentRecord.cursor = { gi, ki, doneNoteIds: doneIds.slice(-50) };
  };
  const syncStats = () => {
    if (currentRecord) {
      currentRecord.stats = { comments: totalComments, replies: totalReplies, dms: totalDMs, videos: totalVideos };
    }
  };
  const checkpoint = () => {
    if (!currentRecord) return;
    currentRecord.progress = { ...task.progress };
    syncStats();
    persistTaskRecord(currentRecord);
  };

  // 上报本次任务，拿到服务端 run_id，后续评论/回复都关联它；续跑沿用旧 run_id，不重复上报
  let reportRunId = (resume && resume.reportRunId) || null;
  if (!reportRunId) {
    try {
      const rs = await reportEvent('task-start', {
        phone: cfg.phone || '',
        keywords: groups.reduce((arr, g) => arr.concat(g.keywords.map((k) => k.text)), []),
        products: products.map((p) => p.name || '')
      });
      if (rs && rs.ok && rs.run_id) reportRunId = rs.run_id;
    } catch (e) { /* 上报失败不影响任务 */ }
    if (reportRunId && currentRecord) currentRecord.reportRunId = reportRunId;
  }

  await persistTaskRecord(currentRecord);
  broadcastState();

  log('info', `任务开始：${groups.length} 个产品、共 ${allKeywordCount} 个关键词，账号：${cfg.phone || '未登录'}`);
  log('info', '执行顺序：' + groups.map((g) => `${g.product.name}（${g.keywords.length} 词）`).join(' → '));
  if (isResume) {
    log('info', `任务继续：从第 ${startGi + 1} 个产品、第 ${startKi + 1} 个关键词处恢复（累计已评论 ${totalComments} 条）`);
  }

  try {
    const tab = await ensureTab();

    // 外层按产品：一个产品跑完（它的全部关键词）再跑下一个产品；续跑从断点产品起步
    for (let gi = startGi; gi < groups.length; gi++) {
      if (task.stopRequested) break;
      const group = groups[gi];
      const product = group.product; // 本组所有评论/回复都用这个产品
      task.progress.product = gi + 1;
      broadcastState();
      log('info', `[产品 ${gi + 1}/${groups.length}] ${product.name}：${group.keywords.length} 个关键词，评论与回复均按该产品生成`);

      for (let ki = (gi === startGi ? startKi : 0); ki < group.keywords.length; ki++) {
        if (task.stopRequested) break;
        await waitWhilePaused();
        const kw = group.keywords[ki].text;
        // 续跑起点所在的关键词在中断前已计数，不重复累加
        if (!(gi === startGi && ki === startKi)) task.progress.keyword++;
        // 本关键词已处理过的笔记 id（续跑时按 id 跳过，抗搜索结果重排）
        const doneIds = (gi === startGi && ki === startKi) ? resumeDoneIds.slice() : [];
        setCursor(gi, ki, doneIds);
        checkpoint();
        broadcastState();

        log('info', `[产品 ${gi + 1}/${groups.length} · 关键词 ${ki + 1}/${group.keywords.length}] 搜索：${kw}`);
        await navigateAndWait(tab.id, searchUrl(kw));
        const ready = await waitForContentReady(tab.id);
        if (!ready) {
          log('warn', '页面加载超时，跳过该关键词');
          continue;
        }
        await humanSleep(settings.searchDelayMin, settings.searchDelayMax, '浏览搜索结果');

        const r = await sendContent(tab.id, {
          type: 'COLLECT_SEARCH_RESULTS',
          max: settings.maxVideosPerKeyword,
          minLikes: settings.minLikes || 0,
          scrollTimes: settings.scrollTimes
        });
        const notes = (r && r.notes) || [];
        totalVideos += notes.length;
        task.progress.noteTotal = notes.length;
        task.progress.note = 0;
        log('info', `找到 ${notes.length} 个视频`);

        for (let ni = 0; ni < notes.length; ni++) {
          if (task.stopRequested) break;
          await waitWhilePaused();
          const note = notes[ni];
          task.progress.note = ni + 1;
          broadcastState();

          // 去重：已评论过的跳过
          if (settings.skipCommented && (await isAlreadyCommented(note.id))) {
            log('info', `[视频 ${ni + 1}/${notes.length}] 已评论过，跳过：${note.title || note.id}`);
            continue;
          }
          // 续跑跳过：本关键词在中断前已处理过的笔记
          if (doneIds.indexOf(note.id) >= 0) {
            log('info', `[视频 ${ni + 1}/${notes.length}] 续跑跳过已处理：${note.title || note.id}`);
            continue;
          }
          // 点赞数过滤：卡片上取到点赞数且低于下限的不选这篇
          // （不写入 doneIds：续跑时允许重新审视，万一是点赞数涨上来了）
          if ((settings.minLikes || 0) > 0 && note.likes != null && note.likes < settings.minLikes) {
            log('info', `[视频 ${ni + 1}/${notes.length}] 点赞数 ${note.likes} 不足 ${settings.minLikes}，跳过：${note.title || note.id}`);
            continue;
          }
          doneIds.push(note.id);
          setCursor(gi, ki, doneIds);

          log('info', `[视频 ${ni + 1}/${notes.length}] 打开：${note.title || note.id}`);
          // 点击笔记卡片（SPA 跳转），避免冷跳转触发反爬 300031
          const openRes = await sendContent(tab.id, { type: 'OPEN_NOTE', id: note.id });
          if (!openRes || !openRes.ok) {
            log('warn', '打开笔记失败：' + ((openRes && openRes.error) || '未知'));
            continue;
          }
          const ready2 = await waitForPageType(tab.id, 'note');
          if (!ready2) {
            // 读取当前 URL，判断是否触发反爬（300031/404），便于后续排查
            const st = await sendContent(tab.id, { type: 'PING' });
            const curUrl = (st && st.url) || '';
            const blocked = /error_code=300031|current_note|sec_|404/.test(curUrl);
            log('warn', (blocked ? '笔记打开被反爬拦截（300031）' : '视频页加载超时') + '，跳过。当前页面：' + (curUrl || '未知'));
            continue;
          }
          await humanSleep(settings.noteOpenDelayMin, settings.noteOpenDelayMax, '阅读视频内容');

          const info = await sendContent(tab.id, { type: 'GET_NOTE_INFO' });
          if (!info || !info.ok) {
            log('warn', '无法读取视频信息，跳过');
            continue;
          }
          log('info', `视频标题：${info.title || '(空)'} | 作者：${info.author || '(未知)'}`);

          // 兜底校验：卡片上没取到点赞数的，用详情页点赞数复核，低于下限则跳过不评论
          if ((settings.minLikes || 0) > 0 && note.likes == null && info.likes != null && info.likes < settings.minLikes) {
            log('info', `[视频 ${ni + 1}/${notes.length}] 详情页点赞数 ${info.likes} 不足 ${settings.minLikes}，跳过：${info.title || note.id}`);
            continue;
          }

          // 每日上限检查：达到则停止整个任务（后续回复/私信由 !stopRequested 守卫跳过）
          if (await checkDailyLimit()) break;

          let comment;
          try {
            // 70% 带钩子（共鸣+暗示解决+暗语引导），30% 纯共鸣，交替出现更自然
            comment = await generateComment(product, info, Math.random() < 0.7);
          } catch (e) {
            log('error', `评论生成失败：${e.message}`);
            continue;
          }
          log('info', `生成评论：${comment}`);

          const res = await sendContent(tab.id, { type: 'POST_COMMENT', text: comment });
          if (res && res.ok) {
            totalComments++;
            task.progress.done = totalComments;
            syncStats();
            log('success', `评论已发布`);
            quotaSessionSent++;
            reportAction('comment', { phone: cfg.phone || '', note_id: note.id });
          } else {
            log('error', `评论发布失败：${(res && res.error) || '未知原因'}`);
          }

          // 上报评论事件（含视频 URL，便于日后回看是否有回复）
          reportEvent('comment', {
            phone: cfg.phone || '',
            run_id: reportRunId,
            note_id: note.id,
            note_url: note.url || '',
            note_title: info.title || '',
            note_author: info.author || '',
            keyword: kw,
            product_name: product.name || '',
            comment_text: comment,
            ok: !!(res && res.ok),
            error: (res && res.ok) ? '' : ((res && res.error) || '未知原因')
          });

          await recordCommented(note.id, {
            title: info.title || '',
            comment,
            url: note.url,
            keyword: kw,
            product: product.name,
            phone: cfg.phone || ''
          });

          // ===== 回复 / 私信评论区里对产品感兴趣的用户 =====
          // 仅在主评论发布成功后进行；失败不影响主流程；与主评论同一个产品
          if ((settings.enableCommentReply || settings.enablePrivateMessage) && res && res.ok && !task.stopRequested) {
            await waitWhilePaused();
            try {
              const cRes = await sendContent(tab.id, { type: 'GET_COMMENTS', max: 12 });
              const allComments = (cRes && cRes.ok && cRes.comments) || [];
              // 排除自己刚发的主评论
              const others = allComments.filter((c) => c.content !== comment);
              log('info', `评论区共 ${others.length} 条其他用户评论，开始分析兴趣`);

              // 过滤已回复过的（同一笔记 + 同昵称 + 同内容）
              const fresh = [];
              for (const c of others) {
                if (await isAlreadyReplied(note.id, c.name, c.content)) continue;
                if (c.hasReply === false) continue; // 找不到回复按钮的跳过
                fresh.push(c);
              }
              if (!fresh.length) {
                log('info', '没有可回复的新评论');
              } else {
                let interested = [];
                try {
                  interested = await analyzeInterestedComments(product, info, fresh);
                } catch (e) {
                  log('warn', `评论兴趣分析失败：${e.message}`);
                }
                // 上报潜在客户：所有被判为感兴趣的用户都登记到看板（去重由服务端 upsert 保证，
                // 即使因「已回复/已私信」被过滤掉、本次不再触达，也仍保留客户记录）
                for (const p of interested) {
                  const t = fresh.find((c) => c.index === p.index);
                  if (!t) continue;
                  reportLead({
                    phone: cfg.phone || '',
                    product_name: product.name || '',
                    user_id: t.userId || '',
                    user_name: t.name || '',
                    user_url: t.userUrl || '',
                    note_id: note.id,
                    note_url: note.url || '',
                    note_title: info.title || '',
                    keyword: kw,
                    comment_content: t.content || '',
                    interest_reason: p.reason || '',
                    source: 'comment'
                  });
                }
                // 回复与私信分别取前 N 个；picked 取两者较大值，供两个环节各自切片
                const picked = interested.slice(0, Math.max(
                  settings.enableCommentReply ? settings.maxRepliesPerNote : 0,
                  settings.enablePrivateMessage ? settings.maxDMsPerNote : 0
                ));
                if (!picked.length) {
                  log('info', '未发现对产品感兴趣的用户评论');
                }
                for (const p of (settings.enableCommentReply ? picked.slice(0, settings.maxRepliesPerNote) : [])) {
                  if (task.stopRequested) break;
                  // 每日上限检查：达到则停止后续回复
                  if (await checkDailyLimit()) break;
                  await waitWhilePaused();
                  // 注意：LLM 返回的 index 是评论自身的 index 字段（DOM 位置），不是 fresh 数组下标
                  const target = fresh.find((c) => c.index === p.index);
                  if (!target) continue;
                  log('info', `发现感兴趣用户「${target.name}」：${target.content.slice(0, 30)}${p.reason ? '（' + p.reason + '）' : ''}`);
                  let reply;
                  try {
                    reply = await generateReply(product, info, target);
                  } catch (e) {
                    log('error', `回复内容生成失败：${e.message}`);
                    continue;
                  }
                  if (!reply) {
                    log('warn', '回复内容为空，跳过');
                    continue;
                  }
                  log('info', `生成回复：${reply}`);
                  await humanSleep(settings.replyDelayMin, settings.replyDelayMax, '回复前随机间隔');
                  const rr = await sendContent(tab.id, { type: 'REPLY_COMMENT', index: target.index, text: reply });
                  if (rr && rr.ok) {
                    totalReplies++;
                    syncStats();
                    log('success', `已回复「${target.name}」`);
                    await recordRepliedComment(note.id, target.name, target.content, reply, cfg.phone);
                    // 同步更新该潜在客户的「已回复」动作（服务端 OR 合并，不影响人工状态/备注）
                    reportLead({
                      phone: cfg.phone || '',
                      product_name: product.name || '',
                      user_id: target.userId || '',
                      user_name: target.name || '',
                      user_url: target.userUrl || '',
                      replied: true
                    });
                    quotaSessionSent++;
                    reportAction('reply', { phone: cfg.phone || '', note_id: note.id, target_user_id: target.userId || '' });
                  } else {
                    log('error', `回复「${target.name}」失败：${(rr && rr.error) || '未知原因'}`);
                  }
                  // 上报回复事件
                  reportEvent('reply', {
                    phone: cfg.phone || '',
                    run_id: reportRunId,
                    note_id: note.id,
                    note_url: note.url || '',
                    note_title: info.title || '',
                    target_name: target.name,
                    target_content: target.content,
                    reply_text: reply,
                    ok: !!(rr && rr.ok),
                    error: (rr && rr.ok) ? '' : ((rr && rr.error) || '未知原因')
                  });
                }

                // ===== 给感兴趣的用户发私信（导航到会话页发送） =====
                if (settings.enablePrivateMessage && !task.stopRequested) {
                  for (const p of picked.slice(0, settings.maxDMsPerNote)) {
                    if (task.stopRequested) break;
                    // 每日上限检查：达到则停止后续私信
                    if (await checkDailyLimit()) break;
                    await waitWhilePaused();
                    const target = fresh.find((c) => c.index === p.index);
                    if (!target) continue;
                    if (!target.userUrl) {
                      log('warn', `「${target.name}」没有主页链接，无法私信`);
                      continue;
                    }
                    // 实测（2026-11-19，浏览器验证）：
                    // /chat/{userId} 只对【已有会话】的用户有效，对新用户是“点击消息开启会话”空状态，
                    // 输入框永远不出现（这就是“私信输入框未出现/私信页加载超时”报错的原因）。
                    // 正确入口是 /chat?openUid={userId}：已有会话直接打开，新用户会创建会话并显示输入栏。
                    let dmUid = target.userId;
                    if (!dmUid) {
                      // 评论没带上主页 ID：先落地主页，从主页 URL 里取 userId（主页链接即 /user/profile/{id}）
                      await navigateAndWait(tab.id, target.userUrl);
                      const ping = await sendContent(tab.id, { type: 'PING' });
                      const m = ping && ping.url ? ping.url.match(/\/user\/profile\/([0-9a-zA-Z]+)/) : null;
                      dmUid = m ? m[1] : '';
                      if (!dmUid) {
                        log('warn', `「${target.name}」无法获取 userId，跳过私信`);
                        continue;
                      }
                    }
                    if (await isAlreadyDmed(dmUid)) {
                      log('info', `已给「${target.name}」发过私信，跳过`);
                      continue;
                    }
                    let dm;
                    try {
                      dm = await generateDM(product, info, target);
                    } catch (e) {
                      log('error', `私信内容生成失败：${e.message}`);
                      continue;
                    }
                    log('info', `准备给「${target.name}」发私信：${dm}`);
                    await humanSleep(settings.dmDelayMin, settings.dmDelayMax, '私信前随机间隔');
                    const dmUrl = 'https://www.xiaohongshu.com/chat?openUid=' + encodeURIComponent(dmUid);
                    await navigateAndWait(tab.id, dmUrl);
                    const chatReady = await waitForPageType(tab.id, 'chat', 25000);
                    if (!chatReady) {
                      log('warn', `「${target.name}」私信页加载超时，跳过私信`);
                      reportEvent('dm', {
                        phone: cfg.phone || '',
                        run_id: reportRunId,
                        note_id: note.id,
                        note_url: note.url || '',
                        note_title: info.title || '',
                        target_name: target.name,
                        target_user_id: dmUid,
                        dm_text: dm,
                        ok: false,
                        error: '私信页加载超时'
                      });
                      continue;
                    }
                    await humanSleep(2, 4, '等待会话窗口就绪');
                    const dr = await sendContent(tab.id, { type: 'SEND_DM', text: dm });
                    if (dr && dr.ok) {
                      totalDMs++;
                      task.progress.dms = totalDMs;
                      syncStats();
                      log('success', `已给「${target.name}」发送私信`);
                      await recordDmed(dmUid, target.name);
                      // 同步更新该潜在客户的「已私信」动作（服务端 OR 合并，不影响人工状态/备注）
                      reportLead({
                        phone: cfg.phone || '',
                        product_name: product.name || '',
                        user_id: target.userId || dmUid || '',
                        user_name: target.name || '',
                        user_url: target.userUrl || '',
                        dmed: true
                      });
                      quotaSessionSent++;
                      reportAction('dm', { phone: cfg.phone || '', note_id: note.id, target_user_id: dmUid || '' });
                    } else {
                      log('error', `给「${target.name}」发私信失败：${(dr && dr.error) || '未知原因'}`);
                    }
                    reportEvent('dm', {
                      phone: cfg.phone || '',
                      run_id: reportRunId,
                      note_id: note.id,
                      note_url: note.url || '',
                      note_title: info.title || '',
                      target_name: target.name,
                      target_user_id: dmUid,
                      dm_text: dm,
                      ok: !!(dr && dr.ok),
                      error: (dr && dr.ok) ? '' : ((dr && dr.error) || '未知原因')
                    });
                  }
                }
              }
            } catch (e) {
              log('error', `评论回复环节异常：${e.message}`);
            }
          }

          checkpoint(); // 笔记收尾：落库当前断点/进度/统计
          if (ni < notes.length - 1 && !task.stopRequested) {
            // 返回搜索结果页，继续下一个笔记。
            // 不要用 history.back()：小红书 SPA 的返回不可靠（页面常卡在加载态或实际未返回，
            // 导致后续 openNote 找不到笔记卡片）。改为整页重新加载搜索地址：
            // 重新加载会为所有笔记重新生成 xsec_token，点击打开更稳定。
            await navigateAndWait(tab.id, searchUrl(kw));
            const back = await waitForPageType(tab.id, 'search', 20000);
            if (!back) log('warn', '搜索页重新加载超时，仍继续尝试');
            await humanSleep(settings.commentIntervalMin, settings.commentIntervalMax, '评论间随机间隔');
          }
        }

        // 关键词之间休息；跨到最后一个关键词时若还有下一个产品，也休息
        const isLastKeyword = gi === groups.length - 1 && ki === group.keywords.length - 1;
        if (!isLastKeyword && !task.stopRequested) {
          await humanSleep(
            settings.keywordIntervalMin,
            settings.keywordIntervalMax,
            ki < group.keywords.length - 1 ? '切换关键词前休息' : '切换产品前休息'
          );
        }
        checkpoint(); // 关键词收尾：落库当前断点/进度/统计
      }
    }

    log('success', `任务完成：共发布 ${totalComments}/${totalVideos} 条评论` +
      (totalReplies ? `，回复 ${totalReplies} 人` : '') +
      (totalDMs ? `，私信 ${totalDMs} 人` : ''));
  } catch (e) {
    taskError = e;
    log('error', `任务异常：${e.message}`);
  } finally {
    // 上报任务结束（含最终计数），无论正常完成还是异常/停止
    if (reportRunId) {
      reportEvent('task-end', {
        phone: cfg.phone || '',
        run_id: reportRunId,
        comments_total: totalComments,
        replies_total: totalReplies,
        dms_total: totalDMs
      });
    }
    // 任务列表终态：用户停止→stopped；运行异常→interrupted；正常跑完→completed
    // 注意：先清运行标志再安排自动重启，否则 scheduleAutoRestart 的「任务在跑」守卫会把它挡掉
    task.running = false;
    task.paused = false;
    task.recordId = null;
    if (currentRecord) {
      const interruptedByError = !task.stopRequested && !!taskError;
      currentRecord.status = task.stopRequested ? 'stopped' : (taskError ? 'interrupted' : 'completed');
      currentRecord.endedAt = Date.now();
      currentRecord.progress = { ...task.progress };
      syncStats();
      await persistTaskRecord(currentRecord);
      // 异常中断：按设置间隔安排自动重启（从本次落库的断点续跑）
      if (interruptedByError) {
        await scheduleAutoRestart(currentRecord, (taskError && taskError.message) || '任务异常');
      }
      currentRecord = null;
    }
    broadcastState();
  }
}

// 把关键词按产品归属分组：一个产品一组，组内所有关键词/评论/回复都用同一个产品
// maxPerProduct：每个产品最多取前 N 个关键词（对应设置项 maxKeywordsPerTask）
function buildProductGroups(products, keywords, maxPerProduct) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const groups = new Map();
  for (const k of keywords) {
    let p = byId.get(k.productId);
    if (!p) {
      // 没有归属信息（如手动输入的关键词）：归入第一个勾选的产品
      p = products[0];
      if (p && products.length > 1) {
        log('warn', `关键词「${k.text}」没有产品归属信息，暂归入「${p.name}」`);
      }
    }
    if (!p) continue;
    if (!groups.has(p.id)) groups.set(p.id, { product: p, keywords: [] });
    const g = groups.get(p.id);
    if (!maxPerProduct || g.keywords.length < maxPerProduct) g.keywords.push(k);
  }
  // 按产品在产品列表中的顺序输出，保证执行顺序稳定
  return products.filter((p) => groups.has(p.id)).map((p) => groups.get(p.id));
}

// ===== 保活：定时心跳，避免长时间任务中 service worker 被回收 =====
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    if (task.running) broadcastState();
  } else if (alarm.name === 'taskRetry') {
    handleRetryAlarm().catch((e) => log('error', '自动重启执行失败：' + e.message));
  }
});

// ===== 视频推广主循环 =====
// cfg: { phone, dryRun }
// 链路：推广搜索词 → 搜同类视频 → 爬评论 → LLM 判兴趣 → 关注 → 分享我方视频
// dryRun=true 时只采集+分析+打日志，不真正关注/分享，用于验证链路
async function runVideoPromo(cfg) {
  const settings = await getSettings();
  const promo = await getPromoConfig();
  const phone = cfg.phone || '';
  const dryRun = cfg.dryRun !== undefined ? cfg.dryRun : !!promo.dryRun;

  const maxVideos = Number(promo.maxVideosPerKeyword) || 5;
  const maxInterested = Number(promo.maxInterestedPerVideo) || 2;
  const maxFollows = Number(promo.maxFollowsPerRun) || 0;
  const maxShares = Number(promo.maxSharesPerRun) || 0;

  const keywords = (promo.keywords || []).map((k) => String(k).trim()).filter(Boolean);
  const noteId = parseNoteId(promo.videoUrl) || promo.noteId || '';

  const failStart = () => {
    task.running = false; task.paused = false; task.stopRequested = false;
    broadcastState();
  };
  if (!promo.videoUrl) { log('error', '推广未启动：请先填写要推广的视频链接'); return failStart(); }
  if (!noteId) { log('error', '推广未启动：无法从视频链接解析出笔记 ID'); return failStart(); }
  if (!promo.intro) { log('error', '推广未启动：请先填写视频简介'); return failStart(); }
  if (!keywords.length) { log('error', '推广未启动：请先生成并确认推广搜索词'); return failStart(); }
  // 启动前检查每日上限：已达上限则不启动（空跑是模拟，不拦截）
  if (!dryRun && await checkDailyLimit()) {
    task.running = false; task.paused = false;
    broadcastState();
    return;
  }

  task.running = true;
  task.paused = false;
  task.stopRequested = false;
  task.recordId = null;
  let taskError = null;
  let totalFollowed = 0;
  let totalShared = 0;
  let totalVideos = 0;

  task.progress = {
    mode: 'promo',
    keyword: 0, keywordTotal: keywords.length,
    note: 0, noteTotal: 0, done: 0, total: 0,
    followed: 0, shared: 0, dryRun
  };
  broadcastState();

  log('info', (dryRun ? '【空跑模式】' : '') +
    `视频推广开始：推广视频「${promo.title || noteId}」，${keywords.length} 个搜索词，账号：${phone || '未登录'}`);
  log('info', '执行链路：搜索词 → 同类视频 → 爬评论 → 判兴趣 → 关注 → 分享视频');
  if (dryRun) log('warn', '空跑模式：不会真正点关注、不会真正发分享，仅采集+分析+打日志');

  try {
    const tab = await ensureTab();

    for (let ki = 0; ki < keywords.length; ki++) {
      if (task.stopRequested) break;
      await waitWhilePaused();
      const kw = keywords[ki];
      task.progress.keyword = ki + 1;
      task.progress.note = 0;
      task.progress.noteTotal = 0;
      broadcastState();

      log('info', `[搜索词 ${ki + 1}/${keywords.length}] 搜索：${kw}`);
      await navigateAndWait(tab.id, searchUrl(kw));
      const ready = await waitForContentReady(tab.id);
      if (!ready) { log('warn', '页面加载超时，跳过该搜索词'); continue; }
      await humanSleep(settings.searchDelayMin, settings.searchDelayMax, '浏览搜索结果');

      const r = await sendContent(tab.id, {
        type: 'COLLECT_SEARCH_RESULTS',
        max: maxVideos, minLikes: 0, scrollTimes: settings.scrollTimes
      });
      if (!r || !r.ok || !r.notes || !r.notes.length) {
        log('warn', `搜索「${kw}」未采集到视频，跳过`);
        continue;
      }
      task.progress.noteTotal = r.notes.length;
      broadcastState();

      for (let ni = 0; ni < r.notes.length; ni++) {
        if (task.stopRequested) break;
        await waitWhilePaused();
        const note = r.notes[ni];
        task.progress.note = ni + 1;
        broadcastState();

        if (note.id === noteId) {
          log('info', `跳过：该视频是要推广的视频本身（${noteId}）`);
          continue;
        }
        log('info', `[视频 ${ni + 1}/${r.notes.length}] 打开：${note.title || note.id}（点赞 ${note.likes ?? '?'}）`);
        const opened = await sendContent(tab.id, { type: 'OPEN_NOTE', id: note.id });
        if (!opened || !opened.ok) {
          log('warn', '打开视频失败：' + (opened && opened.error ? opened.error : '未知'));
          continue;
        }
        await humanSleep(settings.noteOpenDelayMin, settings.noteOpenDelayMax, '等待视频详情页加载');

        const info = await sendContent(tab.id, { type: 'GET_NOTE_INFO' });
        if (!info || !info.ok) { log('warn', '读取视频信息失败'); continue; }
        const cResp = await sendContent(tab.id, { type: 'GET_COMMENTS', max: 15 });
        const comments = (cResp && cResp.ok && cResp.comments) ? cResp.comments : [];
        if (!comments.length) { log('info', '该视频评论区为空或未加载到，跳过'); continue; }
        totalVideos++;
        log('info', `采集到 ${comments.length} 条评论，正在用 AI 判断哪些用户对我方视频感兴趣...`);

        let interested = [];
        try {
          interested = await analyzeVideoInterest(promo, info, comments);
        } catch (e) {
          log('warn', '兴趣分析失败：' + e.message);
          continue;
        }
        const picks = interested.slice(0, maxInterested)
          .map((x) => comments.find((c) => c.index === x.index))
          .filter((c) => c && c.userId);
        log('info', `判为感兴趣 ${interested.length} 人，取前 ${picks.length} 人处理`);
        picks.forEach((p) => {
          const reason = (interested.find((x) => x.index === p.index) || {}).reason || '';
          log('info', `  · 感兴趣：${p.name}（${p.userId}）—— ${reason}`);
        });

        for (const target of picks) {
          if (task.stopRequested) break;
          // 每日上限检查：达到则停止（空跑是模拟，不拦截）
          if (!dryRun && await checkDailyLimit()) break;
          await waitWhilePaused();
          if (!dryRun) {
            if (maxFollows && totalFollowed >= maxFollows) {
              log('warn', `已达单轮关注上限 ${maxFollows}，停止本轮`);
              task.stopRequested = true; break;
            }
            if (maxShares && totalShared >= maxShares) {
              log('warn', `已达单轮分享上限 ${maxShares}，停止本轮`);
              task.stopRequested = true; break;
            }
          }
          const alreadyF = await isPromoFollowed(target.userId);
          const alreadyS = await isPromoShared(target.userId);
          if (alreadyF && alreadyS) {
            log('info', `跳过 ${target.name}（已关注且已分享过）`);
            continue;
          }

          if (dryRun) {
            const reason = (interested.find((x) => x.index === target.index) || {}).reason || '';
            log('info', `【空跑】将关注 ${target.name}（${target.userId}），理由：${reason}`);
            log('info', `【空跑】将把推广视频分享给 ${target.name}`);
            totalFollowed++; totalShared++;
            task.progress.followed = totalFollowed;
            task.progress.shared = totalShared;
            broadcastState();
            await sleep(800);
            continue;
          }

          // 1) 关注
          if (!alreadyF) {
            log('info', `进入 ${target.name} 的主页，准备关注`);
            await navigateAndWait(tab.id, target.userUrl || ('https://www.xiaohongshu.com/user/profile/' + target.userId));
            if (await waitForContentReady(tab.id)) {
              const fres = await sendContent(tab.id, { type: 'FOLLOW_USER' });
              if (fres && fres.ok) {
                await recordPromoFollowed(target.userId, target.name);
                totalFollowed++;
                task.progress.followed = totalFollowed;
                log('success', fres.alreadyFollowing ? `已关注 ${target.name}（此前已关注）` : `已关注 ${target.name}`);
                // 「此前已关注」不产生新动作，不计入每日上限
                if (!fres.alreadyFollowing) {
                  quotaSessionSent++;
                  reportAction('follow', { phone: cfg.phone || '', target_user_id: target.userId || '' });
                }
              } else {
                log('warn', `关注 ${target.name} 失败：${fres && fres.error ? fres.error : '未知'}`);
              }
              broadcastState();
              await humanSleep(promo.followDelayMin || 12, promo.followDelayMax || 25, '关注后停留');
            } else {
              log('warn', '用户主页加载超时，跳过关注');
            }
          } else {
            log('info', `${target.name} 已关注过，跳过关注`);
          }
          if (task.stopRequested) break;

          // 2) 分享我方视频
          if (!alreadyS) {
            log('info', `打开推广视频，准备分享给 ${target.name}`);
            await navigateAndWait(tab.id, promo.videoUrl);
            if (await waitForContentReady(tab.id)) {
              let caption = '';
              try { caption = await generatePromoShareText(promo, info, target); } catch (e) { caption = ''; }
              const sres = await sendContent(tab.id, {
                type: 'SHARE_NOTE_TO_USER',
                userId: target.userId, userName: target.name, caption
              });
              if (sres && sres.ok) {
                await recordPromoShared(target.userId, target.name, sres.method || 'share_panel');
                totalShared++;
                task.progress.shared = totalShared;
                log('success', `已把推广视频分享给 ${target.name}（${sres.method || ''}）`);
                quotaSessionSent++;
                reportAction('share', { phone: cfg.phone || '', target_user_id: target.userId || '' });
              } else if (sres && sres.fallback) {
                // 原生转发面板走不通：打印完整诊断信息（面板是否找到/class/文本/所有按钮），不发送文字链接
                log('warn', `原生转发面板走不通（${sres.error || '未知'}），按要求不发送文字链接，已跳过 ${target.name}`);
                if (sres.candidateCount !== undefined) log('info', `  · 分享按钮候选数：${sres.candidateCount}，命中：${sres.shareBtnInfo || '无'}`);
                log('info', `  · 面板是否找到：${sres.panelFound ? '是' : '否'}` + (sres.panelCls ? `，class=${sres.panelCls}` : ''));
                if (sres.panelText) log('info', `  · 面板文本：${sres.panelText}`);
                if (sres.dialogText) log('info', `  · 转发对话框文本：${sres.dialogText}`);
                if (sres.searchFound !== undefined) log('info', `  · 对话框是否有搜索框：${sres.searchFound ? '有' : '无（只能在最近聊天/互相关注里选）'}`);
                if (sres.visibleNames && sres.visibleNames.length) log('info', `  · 对话框可见用户名（共${sres.visibleNames.length}个）：${sres.visibleNames.join('、')}`);
                if (sres.probe && sres.probe.length) {
                  const probeTexts = sres.probe.map((p) => (p && p.text) || p).join('、');
                  log('info', `  · 面板可点击项：${probeTexts}`);
                } else {
                  log('info', '  · 面板无可点击项（可能面板根本未弹出，需排查分享按钮）');
                }
                log('info', '  （请把以上诊断日志发给开发者，据此修正分享面板选择器）');
              } else {
                log('warn', `分享给 ${target.name} 失败：${sres && sres.error ? sres.error : '未知'}`);
              }
              broadcastState();
              await humanSleep(promo.shareDelayMin || 15, promo.shareDelayMax || 30, '分享后停留');
            } else {
              log('warn', '推广视频页加载超时，跳过分享');
            }
          } else {
            log('info', `已分享过视频给 ${target.name}，跳过`);
          }
        }
        task.progress.done = (task.progress.done || 0) + picks.length;
        broadcastState();
      }
      if (ki < keywords.length - 1 && !task.stopRequested) {
        await humanSleep(settings.keywordIntervalMin, settings.keywordIntervalMax, '搜索词之间休息');
      }
    }
  } catch (e) {
    taskError = e;
    log('error', '推广任务异常：' + e.message);
  }

  task.running = false;
  task.paused = false;
  task.stopRequested = false;
  broadcastState();
  if (taskError) {
    log('error', '视频推广因异常结束');
  } else {
    log('success', (dryRun ? '【空跑】' : '') +
      `视频推广完成：处理 ${totalVideos} 个视频，关注 ${totalFollowed} 人，分享 ${totalShared} 人`);
  }
}

// ===== 消息处理 =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((resp) => sendResponse(resp || { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true; // 异步
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'GET_STATE':
      // 逐项容错：任一项读取异常都不能拖垮整个状态（否则登录态丢失、面板卡在登录页）
      const safe = async (fn, def) => {
        try { return await fn(); } catch (e) { return def; }
      };
      const curAuth = await safe(getAuth, null);
      // 登录态诊断：面板重开后仍要求登录时，用来区分「后台连不上」与「存储里没有」
      const authDiag = { local: '', sync: '' };
      try {
        const l = await chrome.storage.local.get('auth');
        if (l.auth && l.auth.phone) authDiag.local = l.auth.phone;
        const s = await chrome.storage.sync.get('auth');
        if (s.auth && s.auth.phone) authDiag.sync = s.auth.phone;
      } catch (e) { authDiag.error = e && e.message; }
      log('info', '面板打开：登录态 ' + (curAuth ? '已登录 ' + curAuth.phone : '未登录') +
        '（本地=' + (authDiag.local || '无') + '，同步=' + (authDiag.sync || '无') + '）');
      // 面板拉取状态时顺手 reconcile：被关机/SW 回收打断的任务在这里标记为已中断
      const taskList = await reconcileInterruptedTasks();
      // 打开面板时从服务端拉取最新产品库（节流），这样服务端新增的产品无需重新登录即可显示
      await safe(refreshProductsFromServerIfNeeded, undefined);
      return {
        ok: true,
        settings: await safe(getSettings, {}),
        products: await safe(getProducts, []),
        qualityKeywords: await safe(ensureQualityKeywords, []),
        commentedNotes: await safe(getCommentedNotes, []),
        promo: await safe(getPromoConfig, {}),
        auth: curAuth,
        authDiag,
        task: { ...task, progress: { ...task.progress } },
        tasks: taskList.map(taskSummary),
        logs: logs.slice(-200),
        dailyUsage: await safe(getDailyUsageSnapshot, null),
        modelOptions: MODEL_OPTIONS
      };
    case 'SAVE_SETTINGS':
      await saveSettings(msg.settings);
      // 用户关闭自动重启：取消已安排的重启
      if (msg.settings && msg.settings.autoRestartInterrupted === false) {
        await clearPendingRetry();
        log('info', '已关闭任务中断自动重启，待重启的任务已取消');
      }
      log('info', '设置已保存');
      return { ok: true };
    case 'SAVE_PRODUCTS':
      await saveProducts(msg.products);
      // 产品信息同步到服务端（按手机号归属，运营看板可查看各客户端在推什么产品）
      {
        const auth = await getAuth();
        if (auth && auth.phone) {
          reportEvent('product-sync', {
            phone: auth.phone,
            products: (msg.products || []).map((p) => ({
              id: p.id,
              name: p.name,
              description: p.description,
              selected: !!p.selected
            }))
          });
        }
      }
      return { ok: true };
    case 'ADD_QUALITY_KEYWORDS': {
      // 把 AI 候选词（或手动添加）移入优质库：同产品同词去重，返回最新库与新增/跳过数
      const list = normalizeKeywords(msg.keywords || []);
      const cur = await getQualityKeywords();
      const seen = new Set(cur.map((k) => k.productId + '\u0000' + k.text));
      let added = 0;
      let skipped = 0;
      for (const k of list) {
        const key = k.productId + '\u0000' + k.text;
        if (seen.has(key)) { skipped++; continue; }
        seen.add(key);
        cur.push(k);
        added++;
      }
      await saveQualityKeywords(cur);
      log('info', `优质库新增 ${added} 个关键词${skipped ? `（${skipped} 个已存在，跳过）` : ''}`);
      return { ok: true, added, skipped, keywords: cur };
    }
    case 'REMOVE_QUALITY_KEYWORD': {
      const text = String(msg.text || '').trim();
      const productId = msg.productId || '';
      const cur = await getQualityKeywords();
      const next = cur.filter((k) => !(k.text === text && k.productId === productId));
      await saveQualityKeywords(next);
      return { ok: true, keywords: next };
    }
    case 'GENERATE_KEYWORDS':
      if (!msg.products || !msg.products.length) return { ok: false, error: '请先选择产品' };
      try {
        log('info', '正在用 AI 生成关键词...');
        const res = await generateKeywords(msg.products);
        if (res.capabilities.length) {
          log('info', '产品能力盘点：' + res.capabilities.join('；'));
        }
        if (res.cannotDo.length) {
          log('info', '产品做不到（相关词已排除）：' + res.cannotDo.join('；'));
        }
        log('success', `已生成 ${res.keywords.length} 个候选关键词，请在面板中勾选移入优质库`);
        return { ok: true, keywords: res.keywords };
      } catch (e) {
        log('error', `关键词生成失败：${e.message}`);
        return { ok: false, error: e.message };
      }
    case 'TEST_LLM':
      try {
        const content = await callLLM(
          [
            { role: 'system', content: '你是助手。' },
            { role: 'user', content: '请只回复"连接成功"四个字。' }
          ],
          { temperature: 0 }
        );
        return { ok: true, message: content.slice(0, 50) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    case 'START_TASK':
      if (task.running) return { ok: false, error: '任务已在运行中' };
      // 登录门禁：未通过手机号验证码登录不允许使用
      const auth = await getAuth();
      if (!auth || !auth.phone) return { ok: false, error: '请先使用手机号验证码登录' };
      if (msg.taskId) {
        // 重新执行历史任务：沿用其参数快照，新建一条任务记录
        const old = (await getTaskHistory()).find((r) => r.id === msg.taskId);
        if (!old) return { ok: false, error: '任务记录不存在或已删除' };
        runTask({ products: old.params.products, keywords: old.params.keywords, phone: auth.phone });
        return { ok: true };
      }
      if (!msg.products || !msg.products.length) return { ok: false, error: '请选择至少一个产品' };
      // 任务只跑优质关键词库：按所选产品从库里取词（界面传入的关键词不作为来源）
      const library = await getQualityKeywords();
      const selIds = new Set(msg.products.map((p) => p.id));
      const libKw = library.filter((k) => selIds.has(k.productId));
      if (!libKw.length) return { ok: false, error: '所选产品的优质关键词库为空，请先在「关键词」页生成并移入库' };
      runTask({ products: msg.products, keywords: libKw, phone: auth.phone });
      return { ok: true };
    case 'STOP_TASK':
      task.stopRequested = true;
      log('warn', '已请求停止任务（当前步骤完成后停止）');
      return { ok: true };
    case 'PAUSE_TASK':
      if (task.running) {
        task.paused = true;
        log('warn', '任务已暂停');
        // 同步任务列表记录状态（进度已由 broadcastState 实时同步进记录）
        if (currentRecord) {
          currentRecord.status = 'paused';
          persistTaskRecord(currentRecord);
        }
        broadcastState();
      }
      return { ok: true };
    case 'RESUME_TASK':
      if (task.running && task.paused) {
        task.paused = false;
        log('info', '任务已继续');
        if (currentRecord) {
          currentRecord.status = 'running';
          persistTaskRecord(currentRecord);
        }
        broadcastState();
      }
      return { ok: true };
    case 'CONTINUE_TASK': {
      // 断点续跑：从任务记录的中断处继续（应对暂停/停止/电脑关机）
      if (task.running) return { ok: false, error: '任务已在运行中' };
      const auth = await getAuth();
      if (!auth || !auth.phone) return { ok: false, error: '请先使用手机号验证码登录' };
      const rec = (await getTaskHistory()).find((r) => r.id === msg.taskId);
      if (!rec) return { ok: false, error: '任务记录不存在或已删除' };
      if (rec.status === 'running') return { ok: false, error: '该任务正在运行中' };
      runTask({
        record: rec,
        resume: {
          cursor: rec.cursor || { gi: 0, ki: 0, doneNoteIds: [] },
          progress: rec.progress || null,
          stats: rec.stats || null,
          reportRunId: rec.reportRunId || null
        },
        phone: auth.phone
      });
      return { ok: true };
    }
    case 'DELETE_TASK': {
      if (task.running && currentRecord && currentRecord.id === msg.taskId) {
        return { ok: false, error: '运行中的任务不能删除' };
      }
      const list = (await getTaskHistory()).filter((r) => r.id !== msg.taskId);
      await saveTaskHistory(list);
      // 删掉的正是待自动重启的任务：取消重启
      if (pendingRetry && pendingRetry.taskId === msg.taskId) await clearPendingRetry();
      const tasks = list.map(taskSummary);
      broadcast({ type: 'tasks', tasks });
      return { ok: true, tasks };
    }
    case 'CLEAR_TASKS': {
      // 只清掉已结束的任务记录；运行中的保留
      const list = (await getTaskHistory()).filter(
        (r) => task.running && currentRecord && r.id === currentRecord.id
      );
      await saveTaskHistory(list);
      // 待重启的任务记录被清掉：取消重启
      if (pendingRetry && !list.some((r) => r.id === pendingRetry.taskId)) await clearPendingRetry();
      const tasks = list.map(taskSummary);
      broadcast({ type: 'tasks', tasks });
      log('info', '已清空结束的任务记录');
      return { ok: true, tasks };
    }
    case 'GET_TASKS': {
      const list = await reconcileInterruptedTasks();
      return { ok: true, tasks: list.map(taskSummary) };
    }
    case 'CLEAR_LOGS':
      logs = [];
      await storageSet({ logs: [] });
      broadcast({ type: 'logsCleared' });
      return { ok: true };
    case 'CLEAR_COMMENTED':
      await storageSet({ commentedNotes: [] });
      log('info', '已清空评论记录');
      return { ok: true };
    case 'CLEAR_REPLIED':
      await storageSet({ repliedComments: [] });
      log('info', '已清空回复记录');
      return { ok: true };
    case 'CLEAR_DM':
      await storageSet({ dmRecords: [] });
      log('info', '已清空私信记录');
      return { ok: true };
    case 'SEND_CODE':
      return await sendAuthCode(msg.phone);
    case 'LOGIN':
      return await loginWithCode(msg.phone, msg.code);
    case 'LOGOUT':
      // 退出前把残留的旧版全局数据归属到当前手机号，避免下个账号登录时捡到别人的数据
      await migrateLegacyUserData(null);
      await clearAuth();
      log('info', '已退出登录');
      return { ok: true };
    case 'SAVE_PROMO': {
      const cfg = msg.promo || {};
      cfg.noteId = parseNoteId(cfg.videoUrl) || cfg.noteId || '';
      const merged = await savePromoConfig(cfg);
      log('info', '推广配置已保存');
      return { ok: true, promo: merged };
    }
    case 'GENERATE_PROMO_KEYWORDS': {
      const promo = msg.promo || {};
      if (!promo.intro) return { ok: false, error: '请先填写视频简介' };
      try {
        log('info', '正在用 AI 生成推广搜索词...');
        const kws = await generatePromoKeywords(promo);
        log('success', `已生成 ${kws.length} 个推广搜索词`);
        return { ok: true, keywords: kws };
      } catch (e) {
        log('error', `推广搜索词生成失败：${e.message}`);
        return { ok: false, error: e.message };
      }
    }
    case 'START_PROMO': {
      if (task.running) return { ok: false, error: '已有任务在运行中' };
      const authP = await getAuth();
      if (!authP || !authP.phone) return { ok: false, error: '请先使用手机号验证码登录' };
      log('info', `收到启动推广请求，dryRun=${msg.dryRun}（${msg.dryRun ? '空跑-不真实执行' : '真实执行关注/分享'}）`);
      runVideoPromo({ phone: authP.phone, dryRun: msg.dryRun });
      return { ok: true };
    }
    case 'PROBE_SHARE': {
      // 测试用：打开推广视频，只读探测分享面板结构（不发送）
      const promoP = await getPromoConfig();
      if (!promoP.videoUrl) return { ok: false, error: '请先填写推广视频链接' };
      const tab = await ensureTab();
      await navigateAndWait(tab.id, promoP.videoUrl);
      await waitForContentReady(tab.id);
      const r = await sendContent(tab.id, { type: 'PROBE_SHARE' });
      if (r && r.ok) {
        log('info', '【探测】候选分享按钮数：' + (r.candidateCount || 0));
        (r.tried || []).forEach((t, i) => {
          log('info', `【探测候选${i + 1}】点击=${t.clicked} cls=${t.cls} text=${t.text || ''} aria=${t.aria || ''} rect=${JSON.stringify(t.rect)} 新文本=${JSON.stringify(t.newTexts || [])} 特征=${JSON.stringify(t.sigs || [])} 浮层数=${t.overlayCount || 0}`);
          if (t.overlays && t.overlays.length) {
            t.overlays.forEach((o, j) => {
              log('info', `  浮层${j + 1}: pos=${o.pos} cls=${o.cls} text=${o.text}`);
              log('info', `  浮层${j + 1} 可交互项: ` + JSON.stringify(o.items || []));
              log('info', `  浮层${j + 1} HTML摘要: ` + (o.html || ''));
            });
          }
        });
        if (r.panelInfo) {
          log('info', '【探测】面板 found=' + r.panelInfo.found + ' cls=' + r.panelInfo.cls);
          log('info', '【探测】面板项：' + JSON.stringify(r.panelInfo.items || []));
        }
        if (!r.effective) log('warn', '【探测】所有候选点击后均未出现分享面板特征，可能需手动确认分享按钮位置');
      }
      return r || { ok: false, error: '探测无响应' };
    }
    case 'CLEAR_PROMO_FOLLOWED': {
      await storageSet({ [await scopedKey('promoFollowed')]: [] });
      log('info', '已清空推广关注记录');
      return { ok: true };
    }
    case 'CLEAR_PROMO_SHARED': {
      await storageSet({ [await scopedKey('promoShared')]: [] });
      log('info', '已清空推广分享记录');
      return { ok: true };
    }
    default:
      return { ok: false, error: '未知消息类型：' + msg.type };
  }
}

// ===== 面板端口 =====
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
  // 连接后立即推送当前状态与日志
  port.postMessage({ type: 'state', state: { ...task, progress: { ...task.progress } } });
  port.postMessage({ type: 'logs', logs: logs.slice(-200) });
  getTaskSummaries().then((tasks) => {
    try { port.postMessage({ type: 'tasks', tasks }); } catch (e) { /* 端口已断开，忽略 */ }
  });
});

// ===== 安装初始化 =====
chrome.runtime.onInstalled.addListener(async () => {
  await saveSettings(await getSettings()); // 保证默认值写入
  // 产品不再预置：每个手机号的产品库在登录时从服务端拉取
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) { /* 旧版本忽略 */ }
});
