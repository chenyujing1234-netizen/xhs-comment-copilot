# 商店上架材料 · 小红书评论获客助手 v1.0.0

> 提交前必改：隐私政策中的「联系邮箱」占位符（report-server/privacy.html，改后需重新部署）。
> 商店 zip 内含内置 LLM Key 与短信密钥（按用户决定保留内置），公开市场任何人都可解包提取，风险自担；如需止损，可在阿里云侧对 Key 做限额/监控。

---

## 1. 包与素材清单

| 用途 | 文件 | 规格 |
|---|---|---|
| 上传包（Chrome / Edge 通用） | `xhs-comment-copilot-v1.0.0-store.zip` | manifest 在根目录，含 icons/ |
| Chrome 商店图标 | `icons/icon128.png` | 128×128 |
| Edge 商店 Logo | `icons/store-300.png` | 300×300 |
| Chrome/Edge 截图（5 张内） | `screenshots/01-run.png` ~ `04-tasklist.png` | 1280×800 |
| 隐私政策 URL | https://linkpal.cloud/xhs-report/privacy | 公网可访问 |

## 2. 通用信息

- 名称：小红书评论获客助手
- 英文名：XHS Comment Copilot
- 类别：生产力工具（Productivity）
- 价格：免费
- 语言：简体中文（另附英文文案，Chrome 建议默认语言用英文以便全球展示，可任选其一为主语言）

## 3. Chrome Web Store 表单（developer.chrome.com → Dashboard）

### 商店 Listing
- **名称**：小红书评论获客助手
- **摘要（≤132 字符）**：
  > 在小红书相关视频下自动发布 AI 拟人化评论，智能回复感兴趣用户并私信；多产品管理、关键词库、断点续跑与运营看板，助你低成本获客。
- **详细描述（中文）**：
  > 小红书评论获客助手是一款运行在 Chrome / Edge 上的 AI 获客插件。你只需在插件里维护自己的产品（名称 + 描述 + 引流地址），插件就会：
  > 1. 按产品用 AI 生成搜索关键词，自动搜索小红书相关视频；
  > 2. 进入视频评论区，由 AI 结合产品与视频内容生成拟人化短评论自动发布；
  > 3. 分析评论区，识别对产品感兴趣的用户，智能回复并发送一对一私信，引导对方主动联系你；
  > 4. 每个产品可维护固定的「优质关键词库」，任务只从库内取词执行；
  > 5. 支持多产品并行任务，评论/回复/私信节奏全部可配置，拟人化随机间隔，降低风控概率；
  > 6. 任务中断（浏览器回收、断网、关机）后自动从断点重启，已执行动作不重复；
  > 7. 手机号登录，不同账号的数据完全隔离；
  > 8. 配套运营看板，实时掌握评论、回复、私信数据。
  > 适用于：需要从小红书获取潜在客户线索的团队与个人。
- **详细描述（English）**：
  > XHS Comment Copilot is an AI-powered lead generation extension for Chrome/Edge. Add your products (name, description, landing page), and the extension will: generate search keywords per product, find relevant Xiaohongshu videos, publish human-like AI comments, detect interested users in the comment section, reply to them and send one-to-one direct messages — all at human-like randomized intervals. Features: per-product quality keyword library, multi-product tasks, auto-resume after interruption, phone-number account isolation, and a built-in operations dashboard.
- **类别**：Productivity（生产力工具）
- **截图**：上传 screenshots/01-run.png、02-products.png、03-keywords.png、04-tasklist.png（顺序即展示顺序）
- **图标**：上传 icons/icon128.png
- **宣传图（可选）**：未制作，可跳过
- **网站**（可选）：https://linkpal.cloud/xhs-report/
- **支持邮箱**：填你的邮箱（与隐私政策一致）

### 隐私实践（Privacy practices）
- **单一用途说明**：
  > 本插件唯一用途是帮助用户在自己的小红书账号会话中，基于用户自行配置的产品信息，进行评论、回复与私信等获客操作，并提供运行统计看板。
- **权限理由**：
  - storage：本地保存产品、设置、关键词库、任务记录与断点信息
  - tabs / activeTab / scripting：打开并操作小红书视频页、注入自动化脚本
  - sidePanel：提供侧边栏操作界面
  - alarms：任务中断后的定时自动重启
  - host_permissions（xiaohongshu.com）：在小红书页面内执行评论/回复/私信自动化
  - host_permissions（阿里云 / api.openai.com）：调用大模型生成关键词、评论、回复与私信内容；阿里云短信发送登录验证码
- **是否使用远程代码**：否（全部逻辑内置，无外部脚本加载）
- **数据收集申报**：
  - 个人信息（手机号）：用于登录标识 → 用途：App functionality；不出售、不用于非应用目的
  - 网站内容（小红书视频页/评论区内容）：用于生成评论与识别感兴趣用户 → App functionality
  - 用户活动（任务事件、统计数据）：用于断点续跑与看板展示 → App functionality
- **隐私政策 URL**：https://linkpal.cloud/xhs-report/privacy

### 分发
- 可见性：Public（公开）
- 发布方式：直接发布（审核通过后自动上线）

## 4. Edge 加载项表单（partner.microsoft.com → 新加载项）

- **名称**：小红书评论获客助手
- **Logo**：icons/store-300.png（300×300）
- **截图**：上传 4 张 1280×800（Edge 要求 ≥640×480）
- **类别**：Productivity
- **价格**：免费
- **可见性**：公开
- **隐私政策 URL**：https://linkpal.cloud/xhs-report/privacy
- **数据收集说明**（Edge 表单）：勾选/填写与 Chrome 相同的数据类别与用途
- **描述**：用上面中文详细描述即可（Edge 无硬性字数上限，保留要点）

## 5. 注册与提交流程

### Chrome Web Store
1. 访问 https://developer.chrome.com/docs/webstore/register （需可访问 Google 的网络环境）
2. 一次性注册费 US$5，接受开发者协议
3. 完成身份验证（约需数个工作日；未验证前可上传但无法发布）
4. Dashboard → 「添加新项目」→ 上传 zip
5. 按上面表单填写 Listing 与隐私实践 → 提交审核
6. 审核通常数个工作日；如需改版本：manifest version 号 +1（如 1.0.1）后重新打包上传

### Edge 加载项
1. 访问 https://partner.microsoft.com/dashboard/microsoftedge （用微软账号登录，免费注册）
2. 「新加载项」→ 上传 zip（与 Chrome 同一个包）
3. 填写名称/描述/类别/Logo/截图/隐私政策 → 提交
4. Edge 审核通常 1-3 个工作日

## 6. 审核风险提示（提前准备）

- 自动化工具可能触发人工审核：在隐私实践与审核备注中强调「所有操作都在用户已登录的小红书会话中、由用户主动开始、参数与节奏完全由用户控制」。
- 内置密钥：zip 可被解包提取。若担心滥用，可在阿里云侧对 Key 设置消费限额与告警；或改用「用户自填 Key」版本重新发布。
- Edge 加载项商店在中国大陆可直接访问；Chrome Web Store 开发者后台需要海外网络环境。
