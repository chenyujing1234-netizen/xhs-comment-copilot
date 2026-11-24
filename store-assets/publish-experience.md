# 小红书评论获客助手 · 双平台上架经验总结

> 适用范围：Chrome 网上应用店 + Edge 加载项商店上架/更新。基于 2026-11-24 实际操作沉淀，下次更新版本或被拒重提时直接参照。
> 配套素材清单与文案见同目录 [store-listing.md](./store-listing.md)。

---

## 0. 一句话流程

1. 准备好 zip 包（manifest 在根目录）+ 图标 + 截图 + 隐私政策页（公网可访问）。
2. **先做一致性检查**：支持邮箱 = 隐私政策里的联系邮箱（必改项，否则审核可能挑刺）。
3. 两个后台分别：上传包 → 填 Listing（描述/图标/截图）→ 填隐私实践 → 设分发为 Public → 提交审核。
4. 提交是**不可逆**操作，点最终 Submit/Publish 前先向用户确认。
5. 被拒 → manifest version +1 重新打包 → 两个后台各自上传更新重提。

---

## 1. 上架前准备（必做）

### 1.1 素材清单
| 用途 | 文件 | 规格 |
|---|---|---|
| 上传包（Chrome / Edge 通用） | `store-assets/xhs-comment-copilot-v1.0.0-store.zip` | manifest 在根目录，含 icons/ |
| Chrome 商店图标 | `icons/icon128.png` | 128×128 |
| Edge 商店 Logo | `icons/store-300.png` | 300×300（最小 128×128，1:1） |
| 截图 | `store-assets/screenshots/01-run.png` ~ `04-tasklist.png` | 1280×800（Edge 也接受 640×400） |
| 隐私政策 URL | `http://124.221.115.174/xhs-report/privacy` | 公网可访问 |

### 1.2 一致性检查（最容易漏，store-listing.md 顶部明确标注「提交前必改」）
- **支持邮箱（表单里填的）必须 = 隐私政策页面里的联系邮箱**。
- 本次修复：用户指定支持邮箱为 `594462206@qq.com`，但 `report-server/privacy.html` 里原本是 `****************@gmail.com`。
  - 改源文件 [report-server/privacy.html](../report-server/privacy.html) 第 87 行联系邮箱 → `594462206@qq.com`。
  - 部署上线（见 §5）。
  - 浏览器验证线上页已生效（注意浏览器缓存，加 `?v=2` 强刷确认）。

### 1.3 审核风险预判（提前在备注里说清楚，降低被拒概率）
- 自动化工具会触发人工审核 → 审核备注强调：**所有操作都在用户已登录的小红书会话中、由用户主动开始、参数与节奏完全由用户控制、不绕过登录态、不获取账号密码**。
- zip 内含内置 LLM Key 与短信密钥，公开市场任何人可解包提取 → 风险自担；如需止损在阿里云侧对 Key 做限额/监控（store-listing.md 已提示）。
- Chrome 开发者后台需海外网络环境；Edge 后台大陆可直接访问。

---

## 2. Edge 加载项上架（partner.microsoft.com）

### 2.1 入口与账号
- 后台：`https://partner.microsoft.com/dashboard/microsoftedge`
- 登录账号见「§7 关键信息速查」；会话易过期，间隙可能弹登录框，MFA 验证码发到 `594462206@qq.com`，自动化点不动时用 `browser_waiting_for_user_interaction` 交给用户登录。

### 2.2 章节顺序（草稿已存在时）
`Packages → Availability → Properties → Privacy → Store Listings → 最终提交页 /submission`

每节填完点 **Save & Continue** 跳下一节；只有当前节校验通过才会跳转，所以「能成功跳转到下一节」≈「本节已完成」。

### 2.3 各节要点
- **Packages**：上传 zip，状态变 Complete。
- **Availability**：Visibility = Public，市场全选，Save & Continue。
- **Properties**：Category = Productivity；**Support contact detail** 填支持邮箱（本次是 `594462206@qq.com`）。
- **Privacy**：单一用途说明 + 各权限理由（storage/tabs/scripting/sidePanel/activeTab/alarms/host_permissions）+ 数据收集申报。文案照 store-listing.md §3 填。
- **Store Listings**：点语言（English US）的 **Edit details** → 填 Description（用 store-listing.md 的中文详细描述）+ 确认 Logo（store-300.png）+ 上传 4 张截图 → Save draft → Close 回总览 → 语言状态变 **Complete** → 顶部出现 **Publish**。

### 2.4 最终提交页 `/submission`
- 「Does a tester need credentials?」选 **No**（登录由用户用自己的手机号+短信完成，无需给审核员账号）。
- **Notes for certification 为必填**（<2000 字）：填 §1.3 的审核说明 + 隐私政策 URL + 支持邮箱。
- 点 **Publish** → 跳转 `/packages/dashboard`，状态显示 **In review**，即提交成功。
- 微软提示：7 个工作日内反馈。

### 2.5 提交结果（本次）
- 状态：In review
- Store ID：`0RDCK9N2GFH9`
- CRX ID：`haaenehkdmiaiohchajdmgphnpblkcka`
- Product ID：`546cba37-213a-4248-8a89-f7b96b5609a1`

---

## 3. Chrome 网上应用店上架（chrome.google.com/webstore/devconsole）

### 3.1 入口与账号
- 后台：`https://chrome.google.com/webstore/devconsole`
- 一次性注册费 US$5（已缴）；发布者「福州哈希流光」。
- 登录账号见 §7；需海外网络环境。

### 3.2 流程
Dashboard → 「添加新项」→ 上传 zip → 填 **商品详情**（标题/摘要/详细描述/类别/语言/图标/截图）→ 填 **隐私权**（单一用途/权限理由/数据使用/隐私政策 URL）→ 设 **分发**（免费 + 公开 + 地区）→ 点 **提请审核**。

> 「提请审核」按钮变灰 = 有必填项没填或校验没过；点旁边的「我为何无法提交？」看提示。提交成功后该按钮禁用，状态变「待审核」。

### 3.3 各节要点（文案照 store-listing.md §3）
- **商品详情**：摘要 ≤132 字符；详细描述中英文都可（本次用中文 385 字）；类别本次提交显示为「工具」（原定 Productivity/生产力，已锁定无法改，不影响审核，仅影响分类发现性，下次更新版本时可调）；语言选中文。
- **隐私权**：单一用途说明 + 每个权限的理由（storage/tabs/scripting/sidePanel/activeTab/alarms/主机权限）+ 数据使用分类勾选（个人身份信息/网站内容/用户活动等，用途选 App functionality，不出售）+ 远程代码 = 否 + 隐私政策 URL。
- **分发**：付款 = 免费；公开范围 = 公开；地区 = 所有地区。

### 3.4 提交结果（本次）
- 本次会话开始时该商品**已处于「待审核」**（之前会话已提交，非本次操作），仅做了内容完整性核实。
- Item ID：`kmghnfoeicmaopmkdphcbmkbggkfkeaa`
- 已核实：标题/摘要/说明 385 字、商店图标 128×128、4 张截图齐全、隐私权完整、分发=免费+公开+所有地区。

---

## 4. Trae 浏览器自动化在这两个后台的踩坑与解法（下次直接套用）

> 两个后台都是重度 Shadow DOM 的现代 SPA，常规快照/选择器经常失效。以下都是本次实测有效的解法。

### 4.1 browser_snapshot 在某些页面彻底不可用
- **现象**：Edge 的 Privacy / Properties / 提交页，调用 `browser_snapshot` 报 `Shadow DOM query budget exceeded (128 roots / 32 levels)`，加 selector 限定也失败（因为先全局 discoverScopes）。
- **解法**：改用 `browser_evaluate` 读 `document.body.innerText` 查状态/错误文案/定位元素；判断按钮用 `querySelectorAll("v6_he-button,he-button,button")` 过滤文本 + 读 `getBoundingClientRect()` + 判断 `disabled`。
- **注意**：`browser_evaluate` 的 `document.querySelector` **不穿透 shadow DOM**，要查 shadow 内元素必须手动递归收集所有 shadowRoot（见 4.5）。但 `browser_click/browser_type` 用**快照 ref（e##）能穿透 shadow DOM** 操作元素——所以优先拿 ref 用正规工具，evaluate 只读状态。

### 4.2 evaluate 脚本里的正则坑（必避）
- 带标志的正则字面量（如 `/xxx/i`）会报 `ReferenceError: i is not defined`。
- 含 `\n` 的 replace 正则（`/\\n/g`）会报 `Invalid regular expression: missing /`。
- **统一改用**：`indexOf` 判包含；换行替换用 `text.split(String.fromCharCode(10)).join(" ")`。

### 4.3 React/Formly 受控输入框：填了值但校验仍报错
- **现象**：Support contact detail 用 `browser_fill/browser_type` 填了邮箱，DOM `value` 正确，但内联错误和页面横幅仍在，Save & Continue 不跳转。
- **解法（本次有效）**：`browser_click` 聚焦 → `browser_type({clear:true, slowly:true})` 逐字输入 → `browser_press_key({key:'Tab'})` 失焦触发校验 → 内联错误消失 → 保存成功跳转。
- **备选**（若上法失效）：evaluate 执行原生 value setter + 派发事件：
  ```js
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  setter.call(input,'594462206@qq.com');
  input.dispatchEvent(new Event('input',{bubbles:true}));
  input.dispatchEvent(new Event('change',{bubbles:true}));
  ```

### 4.4 上传截图/图标：隐藏 file input 拿不到 ref
- **现象**：`input[type=file]` 是隐藏的（`offsetParent===null`），快照不收录，`browser_upload_file` 需要 ref 无从下手。
- **解法**：
  1. 用 evaluate 找到目标 file input（Edge Store Listings 页有 4 个：Logo / SmallTile / Screenshots / LargeTile，靠向上找父容器文本含 "Screenshot" 等来区分），临时设为可见：
     ```js
     target.style.display='block'; target.style.visibility='visible';
     target.style.width='200px'; target.style.height='30px';
     // 并把祖先容器也设为可见
     ```
  2. 重新 `browser_snapshot`，目标 input 会以 `textbox [e##]` 出现在对应 Add image 按钮下方。
  3. `browser_upload_file({ref:'e##', filePath:'...'})` 上传。
- **注意**：Edge 的 Logo 上次已传（store-300.png），截图 4 张其实之前会话也传过了——上传前先 `document.querySelectorAll("img[alt^=Screenshot]")` 看已有几张，别重复传。

### 4.5 提交页表单控件在 Shadow DOM 内，textarea 默认 readOnly
- **现象**：Edge `/submission` 的 Notes textarea 是 readOnly，`browser_type` 报 `Element is disabled or readonly`；单选按钮也不是普通 button，`document.querySelector` 抓不到。
- **解法**：evaluate 递归收集所有 shadowRoot，在里面找 textarea 移除 readOnly、找单选点击：
  ```js
  var roots=[document]; var seen=new Set();
  function collect(root){
    var els=root.querySelectorAll('*');
    for(var i=0;i<els.length;i++){
      if(els[i].shadowRoot && !seen.has(els[i].shadowRoot)){
        seen.add(els[i].shadowRoot); roots.push(els[i].shadowRoot); collect(els[i].shadowRoot);
      }
    }
  }
  collect(document);
  // 然后在 roots 里 querySelector('textarea') / 找含 "No, testers" 的元素 click
  ```
  textarea 解除 readOnly 后再用 `browser_type` 填（ref 从快照拿，能穿透 shadow DOM）。

### 4.6 自定义元素按钮 host.click() 不触发跳转
- **现象**：`<v6_he-button>` 等自定义元素，对 host 调 `.click()` 有时不触发动作。
- **解法**：点它 shadowRoot 内的真实 `<button>/<a>`：`host.shadowRoot.querySelector('button,a').click()`。

### 4.7 「Sign in required」幽灵弹窗误导
- **现象**：`document.querySelectorAll("[role=dialog]").length` 总返回 1，body 含 "Sign in required / Your session has expired"，以为要重新登录。
- **根因**：是个残留的隐藏 DOM 节点，`getBoundingClientRect()` 为 0×0，并非真可见。
- **判断**：用 `dialog.getBoundingClientRect().width > 0` 判断是否真可见；视口中心 `elementsFromPoint` 返回的是表单元素就说明无遮挡。**会话其实是好的，别被误导反复登录**。

### 4.8 browser_navigate 偶发报错但实际已跳转
- **现象**：`browser_navigate` 返回 `Browser SDK operation is closed, not ready, or already executing`，但下一次 evaluate 发现 URL 已经变了、`readyState` 是 interactive/complete。
- **解法**：忽略该报错，直接 `evaluate` 读 `location.href` + `document.readyState` 确认是否真的跳转并加载完成，再继续。

---

## 5. 隐私政策页面部署

- 源文件：`report-server/privacy.html`（app.py 用 `FileResponse` 运行时读盘，**覆盖文件即生效，无需重启服务**）。
- 服务器：阿里云 `124.221.115.174`，root 免密 SSH；部署目录 `/opt/xhs-report/`。
- 部署命令（本机 PowerShell，需联网）：
  ```powershell
  scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new "e:/Source/xiaoHongShuPlugin/report-server/privacy.html" root@124.221.115.174:/opt/xhs-report/privacy.html
  ```
- 验证：
  ```powershell
  ssh -o BatchMode=yes root@124.221.115.174 "grep -o '联系邮箱[^<]*' /opt/xhs-report/privacy.html"
  ```
  再浏览器访问 `http://124.221.115.174/xhs-report/privacy?v=2`（加 `?v=2` 绕过浏览器本地缓存）确认内容。
- 缓存说明：nginx 对 `/xhs-report/` 不走 proxy_cache（1 年强缓存只针对 `/_next/static/`），服务器侧返回的是最新内容；只有浏览器本地可能缓存旧页，强刷即可。

---

## 6. 被拒后改版本重提

1. 改 `manifest.json` 的 `version` +1（如 `1.0.0` → `1.0.1`）。
2. 重新打包 zip（manifest 在根目录，含 icons/），覆盖 `store-assets/xhs-comment-copilot-v1.0.1-store.zip`（按版本号命名）。
3. **Edge**：Partner Center → 对应扩展 → Packages → 上传新包 → 其余章节若无变更可沿用 → 重新 Publish 提交。
4. **Chrome**：DevConsole → 对应商品 → 文件包 → 上传新包 → 商品详情/隐私权/分发按需修改 → 重新「提请审核」。
5. 两个平台的修改/提交流程相互独立，分别操作。
6. 若被拒原因是「类别不对」「截图不够」「隐私政策不一致」等，先在后台改好（注意 Chrome 审核中字段锁定，需先取消提交才能改）再重提。

---

## 7. 关键信息速查

| 项 | 值 |
|---|---|
| Edge 后台 | `https://partner.microsoft.com/dashboard/microsoftedge` |
| Chrome 后台 | `https://chrome.google.com/webstore/devconsole` |
| 微软/Edge 登录账号 | 见项目记忆 `project_memory.md`（MFA 验证码 → `594462206@qq.com`） |
| Chrome 登录账号 | 同微软账号（Google 账号） |
| 支持 / 联系邮箱 | `594462206@qq.com` |
| 隐私政策 URL | `http://124.221.115.174/xhs-report/privacy` |
| 隐私页源文件 | `report-server/privacy.html` |
| 服务器 | `124.221.115.174`，root 免密 SSH，部署目录 `/opt/xhs-report/` |
| Edge Store ID | `0RDCK9N2GFH9` |
| Edge CRX ID | `haaenehkdmiaiohchajdmgphnpblkcka` |
| Edge Product ID | `546cba37-213a-4248-8a89-f7b96b5609a1` |
| Chrome Item ID | `kmghnfoeicmaopmkdphcbmkbggkfkeaa` |
| Chrome 发布者 | 福州哈希流光 |
| 当前版本 | 1.0.0 |
| 当前状态（2026-11-24） | Edge: In review；Chrome: 待审核 |
| 预计反馈 | Edge 约 7 个工作日；Chrome 通常数个工作日 |

> 敏感凭据（密码、API Key）不写入本文档，统一从项目记忆 `project_memory.md` 或密码管理器取用，避免明文扩散。
