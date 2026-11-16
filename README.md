# xhs-comment-copilot · 小红书评论获客助手

Chrome 浏览器插件（Manifest V3）：在小红书的视频笔记下发布 AI 实时生成的拟人化评论，吸引潜在客户主动私聊；自动分析评论区、找出对产品感兴趣的用户并回复；配套后端上报服务与运营看板，完整记录每次任务的运行情况。

## 功能特性

**插件端**

- **产品管理**：维护多个产品（名称 + 大段描述），任务时勾选启用；预置两个示例产品（ContextBuddy、哈希流光），可在界面增删改
- **AI 关键词生成**：先让模型盘点产品真实能力与做不到的事，只生成"产品真能满足搜索者需求"的关键词，避免无关词
- **拟人化自动评论**：按关键词循环搜索 → 逐个打开视频 → 在评论区发布 6~25 字口语化评论；搜索/打开/评论间隔均为随机区间，模拟真人节奏
- **评论区智能回复**：发布评论后自动抓取该视频下的用户评论，由 LLM 挑出对产品有真实需求的人，生成 10~25 字自然回复并发送，引导对方私聊或访问官网；记录已回复评论，避免重复
- **防呆保护**：评论输入框非空时中止发布；只打开带 `xsec_token` 的笔记卡片（SPA 跳转，不冷跳转 URL）
- **手机号登录**：手机号 + 阿里云短信验证码，验证码 4 位 / 60 秒有效 / 60 秒重发冷却；未登录不能启动任务，手机号作为客户端唯一标识
- **数据上报**：登录、任务开始/结束、每条评论（含视频 URL，便于日后回看是否有回复）、每条回复、产品变更，实时上报到自建服务端

**服务端（report-server/）**

- FastAPI 上报服务，写入 MySQL（devices / task_runs / comment_logs / reply_logs / login_logs / products 六张表）
- 运营看板：汇总卡片、最近 7 天趋势、按产品/关键词排行、产品库、最近任务、评论明细（视频可点击）、回复明细、客户端列表，30 秒自动刷新
- `X-Api-Key` 头鉴权，看板页面 `?key=` 访问

## 目录结构

```
├── manifest.json          # MV3 清单（权限 / side panel / content script）
├── background.js          # 后台 Service Worker：任务编排、LLM 调用、登录、上报
├── content.js             # 小红书页面 DOM 自动化（搜索/打开笔记/发评论/回复）
├── sidepanel.html/css/js  # 侧边栏界面（产品 / 关键词 / 运行 / 设置）
├── prompt.txt             # 需求与迭代记录（已脱敏）
└── report-server/         # 上报服务与看板（可独立部署）
    ├── app.py             # FastAPI 服务（上报接口 + 看板数据接口）
    ├── dashboard.html     # 运营看板单页
    ├── schema.sql         # MySQL 建表脚本（IF NOT EXISTS，可重复执行）
    ├── xhs-report.service # systemd unit（敏感配置走 EnvironmentFile=/opt/xhs-report/.env）
    ├── deploy.sh          # 部署脚本：导 schema → 重启服务 → 健康检查
    ├── e2e_test.sh        # 冒烟测试：模拟插件完整上报流程
    └── lingxiu-ai.nginx.deployed  # nginx 反代配置参考（/xhs-report/ → 127.0.0.1:8081）
```

## 快速开始

### 1. 安装插件

1. 打开 `chrome://extensions`，右上角开启「开发者模式」
2. 「加载已解压的扩展程序」，选择本仓库目录
3. 点击工具栏图标打开侧边栏

### 2. 填写配置（设置 → 模型与接口设置）

| 配置项 | 说明 |
|---|---|
| Base URL | 默认阿里百炼 Token Plan 兼容接口，可改其它 OpenAI 兼容接口 |
| API Key | **必填**，你自己的大模型 Key（不写死在代码里） |
| 短信 AccessKey ID / Secret | **必填**，阿里云短信 AK（登录验证码用；签名与模板号在代码 `SMS_CONFIG` 中按需修改） |
| 模型 | 默认 `qwen3.7-plus`，可切换 |
| 数据上报地址 / 上报密钥 | 默认指向示例部署；自建服务端时改成你的地址与密钥 |

### 3. 使用

1. 手机号 + 验证码登录（首次使用需先在设置页填好短信 AK）
2. 「产品」页确认/编辑产品，勾选要推广的产品
3. 「关键词」页一键 AI 生成（或手动增删）
4. 「运行」页开始任务，实时查看日志与进度；可暂停/停止
5. 打开看板页面查看各手机号的运行数据

## 服务端部署（可选，不使用则关闭上报地址即可）

```bash
# 1. 准备 MySQL，执行建表脚本
mysql -h<host> -P3306 -u<user> -p<dbname> < report-server/schema.sql

# 2. 安装依赖并启动
cd report-server
pip install fastapi uvicorn pymysql
export XHS_DB_PASS='<数据库密码>'   # 也可写入 /opt/xhs-report/.env
uvicorn app:app --host 0.0.0.0 --port 8081

# 3. （推荐）systemd 托管
cp report-server/xhs-report.service /etc/systemd/system/
# 按 unit 内注释创建 /opt/xhs-report/.env 放入 XHS_DB_PASS 等敏感配置
systemctl daemon-reload && systemctl enable --now xhs-report

# 4. （推荐）nginx 反代，经 80 端口子路径访问
# 参考 report-server/lingxiu-ai.nginx.deployed：
#   location /xhs-report/ { proxy_pass http://127.0.0.1:8081/; }
```

看板地址：`http://<你的服务器>/xhs-report/?key=<上报密钥>`（默认密钥 `xhs-report-2026`，**部署后请修改**：服务端设 `XHS_API_KEY` 环境变量，插件设置页同步改）。

冒烟测试：`bash report-server/e2e_test.sh`（会写入一条完整测试链路数据，用完记得清理）。

### 数据表

| 表 | 内容 |
|---|---|
| `devices` | 客户端（按手机号）：首次/最近出现时间、登录次数 |
| `task_runs` | 任务会话：关键词/产品快照、评论/回复计数、起止时间 |
| `comment_logs` | 每条主评论：视频 URL/标题/作者、关键词、产品、评论内容、成败 |
| `reply_logs` | 每条回复：回复了谁、对方评论、我的回复、所在视频、成败 |
| `login_logs` | 登录事件 |
| `products` | 产品库：各手机号在推的产品（名称/描述/是否启用），本地删除服务端同步删 |

## 工作原理（一次任务）

```
生成关键词（LLM 盘点产品能力 → 只出真能满足的词）
  → 逐个关键词搜索小红书
  → 逐个打开视频笔记（点击卡片 SPA 跳转，随机延迟）
  → LLM 结合产品 + 视频内容生成 6~25 字口语化评论并逐字输入发布
  → 抓取该视频评论区 → LLM 挑出感兴趣的用户 → 生成 10~25 字回复发布
  → 全程上报服务端（run_id 关联一次任务的所有动作）
```

## 安全说明

- **密钥不落地**：大模型 Key、短信 AK 只在插件设置页填写，存于浏览器本地；数据库密码只在服务器 `.env`，均不进仓库
- 上报失败静默忽略，不影响主流程；上报请求 8 秒超时
- 请勿把自己的 `.env`、Token 提交进仓库

## 免责声明

本项目仅供学习与技术研究使用。在小红书平台的自动化评论行为可能违反平台用户协议，存在被限流、封禁账号等风险，请自行评估并遵守平台规则与相关法律法规，作者不对使用本项目造成的任何后果负责。
