// ===== 小红书评论获客助手 - 后台服务 =====
// 职责：任务编排、调用 Qwen 生成评论/关键词、日志广播、与 content script 通信

const DEFAULT_SETTINGS = {
  baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  // 大模型 Key 不放默认值：请在「设置 → 模型与接口设置」中填写自己的 Key
  apiKey: '',
  model: 'qwen3.7-plus',
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
  // 运行数据上报服务（看板：http://124.221.115.174/xhs-report/?key=...）
  reportUrl: 'http://124.221.115.174/xhs-report',
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

// 预置默认产品（首次安装时写入；后续版本新增的预置产品会自动合并进用户列表，不影响用户改动）
const DEFAULT_PRODUCTS = [
  {
    id: 'p_contextbuddy',
    name: 'ContextBuddy（上下文管家）',
    description:
      'ContextBuddy 是一款本地运行的免费桌面应用，把散落在浏览器、微信、电脑和手机端的上下文数据（浏览记录、聊天记录、AI 对话、操作记录等）统一归档到本地文件夹，形成个人专属的数据底座，方便后续跨端同步、上下文管理和分享给 WorkBuddy 等第三方应用。主打隐私安全、数据自有，当前以本地保存为主，后续再做跨端同步与企业端能力。',
    selected: true
  },
  {
    id: 'p_hashliuguang',
    name: '哈希流光（福州AI上门落地服务）',
    description:
      '哈希流光是福州鼓楼区一家本地AI服务公司（成立于2025年），官网 https://www.shiflowmind.cloud 。' +
      '采用FDE（Forward Deployed Engineer，前沿部署工程师）模式，工程师上门到企业现场交付服务：' +
      '1）一次免费的AI上门培训，帮福州本地企业把AI引入业务系统、降本增效；' +
      '2）AI工具与技能实训，手把手教团队用AI绘图、图片生成、视频制作、AI营销与精准获客，以及Claude、OpenAI、Midjourney等工具；' +
      '3）软件定制开发与长期技术支持，包括智能体（AI Agent）构建、企业内部AI Coding指导、代码维护，复杂项目可派驻场工程师。' +
      '团队成员多为985/211毕业、有10到20年大厂工作经验，已有3年以上AI落地经验，服务过福州财税、电商、教育等本地企业。' +
      '目标客户：福州本地想用AI降本增效、但不知道从何入手的中小企业、小团队和老板。' +
      '推广目标：让对AI落地感兴趣的人访问官网 https://www.shiflowmind.cloud 了解服务并预约免费上门培训；' +
      '写评论和回复时可以自然地提到官网域名 shiflowmind.cloud 引导别人去看（不要带 http:// 或 https:// 前缀，不要贴成超链接）。',
    selected: true
  }
];

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

// SW 启动兜底：把存储里残留的 running/paused 记录标记为 interrupted
// （SW 重启时内存必无运行任务，这些记录只可能是被电脑关机/SW 回收打断的）
reconcileInterruptedTasks().catch(() => { /* 忽略 */ });

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

async function getSettings() {
  const s = await storageGet('settings', {});
  return { ...DEFAULT_SETTINGS, ...s };
}
async function saveSettings(s) {
  await storageSet({ settings: { ...DEFAULT_SETTINGS, ...s } });
}
async function getProducts() {
  const stored = (await storageGet('products', [])) || [];
  if (!stored.length) return DEFAULT_PRODUCTS;
  // 合并预置产品：新版本新增的默认产品自动补齐，用户已增删改的产品保持不动
  const ids = new Set(stored.map((p) => p.id));
  const missing = DEFAULT_PRODUCTS.filter((p) => !ids.has(p.id));
  return missing.length ? stored.concat(missing) : stored;
}
async function saveProducts(p) {
  await storageSet({ products: p || [] });
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
    stats: r.stats || null
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
  for (const r of list) {
    if (task.running && currentRecord && r.id === currentRecord.id) continue;
    if (r.status === 'running' || r.status === 'paused') {
      r.status = 'interrupted';
      r.endedAt = r.endedAt || now;
      changed = true;
    }
  }
  if (changed) await saveTaskHistory(list);
  return list;
}

// ===== 手机号 + 验证码登录（参考 ContextBuddy auth_service.py）=====
// 阿里云短信 Dysmsapi 2017-05-25 SendSms（RPC 签名 V1，HMAC-SHA1）
const SMS_CONFIG = {
  accessKeyId: 'YOUR_ACCESS_KEY_ID',
  accessKeySecret: 'YOUR_ACCESS_KEY_SECRET',
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
  const auth = {
    phone,
    loggedInAt: new Date().toLocaleString('zh-CN', { hour12: false })
  };
  await saveAuth(auth);
  log('success', `手机号 ${phone} 登录成功，本客户端将以该手机号标识`);
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
  const base = (settings.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const body = {
    model: settings.model || 'qwen3.7-plus',
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
    '3. 搜索意图必须是"遇到问题想找方法/找经验/找工具"，不要娱乐、八卦、围观测评、纯好奇类词（这类搜索者不会转化）；\n' +
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
    { json: true, temperature: 0.5 }
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
async function generateComment(product, info) {
  const settings = await getSettings();
  const sys =
    '你就是个普通小红书用户，刷到这条随手留一句。说人话，别端着。' +
    '绝不能像客服、营销号、AI，也不要"希望对你有帮助""值得一试"这种客套话，' +
    '不要排比、不要总结、不要小作文、不要堆感叹号。' +
    '目标：让别人觉得你踩过同样的坑，愿意回你一句或者来问你怎么办。';

  const comments = (info.comments || [])
    .slice(0, 6)
    .map((c) => `- ${c.name || '用户'}：${c.content}`)
    .join('\n');

  const user =
    '产品名称：' + product.name + '\n' +
    '产品描述：' + product.description + '\n\n' +
    '视频标题：' + (info.title || '(无)') + '\n' +
    '视频内容：' + (info.desc || '(无)') + '\n' +
    '作者：' + (info.author || '(未知)') + '\n' +
    '部分已有评论：\n' + (comments || '(无)') + '\n\n' +
    '写一条极短的中文评论，' + settings.commentMinLen + '~' + settings.commentMaxLen + '字，像刷手机时随手打的。\n' +
    '要求：\n' +
    '1. 口语化，可以带语气词（啊/吧/了/真的/咋），可以省略主语；\n' +
    '2. 一句话说完，最多一个标点；\n' +
    '3. 像跟朋友吐槽或分享，别用书面语；\n' +
    '4. 贴合视频内容，别硬提产品名，别提私我；不要贴超链接，但产品描述里明确给出官网域名的，可以自然带一句域名（如 shiflowmind.cloud），没给就不提；\n' +
    '5. 只输出评论正文，不要引号、不要解释、不要换行。';

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
    log('error', '任务未启动：所选产品没有任何归属关键词，请先在「关键词」页生成');
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

          let comment;
          try {
            comment = await generateComment(product, info);
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

                // ===== 给感兴趣的用户发私信（导航到其主页发送） =====
                if (settings.enablePrivateMessage && !task.stopRequested) {
                  for (const p of picked.slice(0, settings.maxDMsPerNote)) {
                    if (task.stopRequested) break;
                    await waitWhilePaused();
                    const target = fresh.find((c) => c.index === p.index);
                    if (!target) continue;
                    if (!target.userUrl) {
                      log('warn', `「${target.name}」没有主页链接，无法私信`);
                      continue;
                    }
                    if (target.userId && (await isAlreadyDmed(target.userId))) {
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
                    // 实测：主页「发消息」按钮点击不稳定，直接进入与该用户的会话页 /chat/{userId} 最可靠
                    // （userId 与主页链接中的一致；拿不到 userId 时退回主页，由 content 点「发消息」）
                    const dmUrl = target.userId
                      ? 'https://www.xiaohongshu.com/chat/' + encodeURIComponent(target.userId)
                      : target.userUrl;
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
                        target_user_id: target.userId || '',
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
                      await recordDmed(target.userId, target.name);
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
                      target_user_id: target.userId || '',
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
    if (currentRecord) {
      currentRecord.status = task.stopRequested ? 'stopped' : (taskError ? 'interrupted' : 'completed');
      currentRecord.endedAt = Date.now();
      currentRecord.progress = { ...task.progress };
      syncStats();
      await persistTaskRecord(currentRecord);
      currentRecord = null;
    }
    task.running = false;
    task.paused = false;
    task.recordId = null;
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
chrome.alarms.onAlarm.addListener(() => {
  if (task.running) broadcastState();
});

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
      return {
        ok: true,
        settings: await safe(getSettings, {}),
        products: await safe(getProducts, []),
        keywords: await safe(getKeywords, []),
        commentedNotes: await safe(getCommentedNotes, []),
        auth: curAuth,
        authDiag,
        task: { ...task, progress: { ...task.progress } },
        tasks: taskList.map(taskSummary),
        logs: logs.slice(-200),
        modelOptions: MODEL_OPTIONS
      };
    case 'SAVE_SETTINGS':
      await saveSettings(msg.settings);
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
    case 'SAVE_KEYWORDS':
      await saveKeywords(msg.keywords);
      return { ok: true };
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
        log('success', `已生成 ${res.keywords.length} 个关键词`);
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
      if (!msg.keywords || !msg.keywords.length) return { ok: false, error: '请至少填写一个关键词' };
      runTask({ products: msg.products, keywords: normalizeKeywords(msg.keywords), phone: auth.phone });
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
      await clearAuth();
      log('info', '已退出登录');
      return { ok: true };
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
  // 首次安装时预置默认产品
  const existing = await storageGet('products', null);
  if (existing == null) await saveProducts(DEFAULT_PRODUCTS);
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) { /* 旧版本忽略 */ }
});
