# Hermes Lite WebUI

纯静态、移动优先的 Hermes 聊天前端。**没有自己的后端、不存任何密钥** —— 访问者在页面里填自己的 Base URL 和 API Key，只写进本机浏览器存储；请求直接发给他填的那个 Hermes 网关。

**会话历史与桌面端 / CLI / dashboard 共用同一份**（`state.db`）：侧栏列出的是服务端真实会话，打开即是桌面端那段对话，发送的一轮也写回同一会话。

布局与设计语言参考 Hermes 桌面端 / `pyrate-llama/hermes-ui`（左侧栏 + 居中消息列 + 细状态条；紫强调 + 助手绿；卡片 12px / composer 14px 圆角）。

---

## 两条接口面

| 用途 | 端点 |
|---|---|
| 会话列表 | `GET /api/sessions?limit=&offset=` |
| 新建会话 | `POST /api/sessions` |
| 历史消息 | `GET /api/sessions/{id}/messages` |
| 改名 / 置顶 | `PATCH /api/sessions/{id}` |
| 删除 | `DELETE /api/sessions/{id}` |
| 模型探测 | `GET {base}/models` |
| 流式对话 | `POST {base}/chat/completions`（`stream:true`） |

**共享历史的关键**：`POST /v1/chat/completions` 带上请求头 `X-Hermes-Session-Id: <id>`，服务端会用 `state.db` 里的历史**替换**请求体里的 `messages`（源码注释：*continues an existing session (history from state.db, not the body)*）。所以每次只发当轮那一条 user 消息，上下文由服务端补全。

两个约束：
- 该请求头**必须配合 API Key**（否则 403：`Session continuation requires API key authentication`）。
- 服务端会回显它实际绑定的 `X-Hermes-Session-Id`（压缩轮换后 id 可能变），客户端应以后缀它为准。

首轮对话后服务端会**自动给会话起标题**，所以侧栏标题会自己出现（客户端不需要自己命名）。

## 部署

拷到静态目录即可，**路径无关**（资源全是相对路径，可放 `/hermes/` 子路径）：

```bash
scp -r ./* user@server:/var/www/html/hermes/
```

**Caddy / Nginx 无需任何反代规则**：请求是浏览器直连你填的绝对地址（如 `https://hermes.example.com/v1`）。前提是该网关放行跨源 —— `API_SERVER_CORS_ORIGINS` 默认 `*`，实测跨源预检返回 `Access-Control-Allow-Origin: *` 且 `Allow-Headers` 含 `Authorization, Content-Type, X-Hermes-Session-Id`。若被收紧，就要改成同源反代部署。

分发给别人时带默认地址，对方只需填 Key：`https://你的域名/hermes/?base=https://hermes.example.com/v1`

> Service Worker 只缓存本站外壳（HTML/CSS/JS），**永不拦截**跨源请求与 `/v1`、`/api` 路径，且走 stale-while-revalidate（改完代码不必手动清缓存）。

## 使用

1. 打开 → 填 **Base URL**（到 `/v1`）和 **API Key** → 「测试连接」。这个按钮会同时验**模型列表**和**会话历史可读**，能立刻暴露「能对话但读不到历史」这种半通状态。
2. 侧栏有来源徽章：`桌面端 / 网页 / CLI / TG …`，一眼看出这条是谁产生的。
3. 顶部 ⟳ 按钮从服务端重新拉列表与历史（快捷键 `Ctrl/Cmd+Shift+R`）。

### 多人共用：每人一份 Key

`api_server` 支持**按 profile 作用域的 Key**，并把每个 profile 的路由镜像到 `/p/<profile>/` 下。所以每人只需不同的 Base URL：

| 用户 | Base URL |
|---|---|
| 甲 | `https://host/v1` |
| 乙 | `https://host/p/乙的profile/v1` |

Key 各自写在自己 profile 的 `.env`（`API_SERVER_KEY`）。

> 注意：**同一个 Key 看到的是同一个网关的同一批会话**。要各人隔离历史，就必须各用一个 profile。

### ⚠️ 安全前提

`API_SERVER_KEY` 是该网关**唯一凭据**，而这条端点会派发**带终端能力**的 agent 工作 —— 源码原话是「a guessable key is remote code execution」。

- **拿到 Key 的人 = 能在你机器上执行命令、读写文件，并读到该 profile 的全部会话历史。**
- 因此**不要**把 Key 写进前端、构建产物或任何公开文件。本项目正是为此设计：Key 由使用者自己在浏览器里填。
- 想再收一层口：在静态站前面加 Caddy `basic_auth`，或按 profile 隔离 + 限制可达工具。

## 功能

- **多会话并发**：每个会话各自维护一条独立的流 —— 一个会话在生成时，你可以随意切到别的会话、新建会话、甚至让另一个会话同时开跑。切走只是解绑该会话的 DOM 引用，请求在后台继续；切回来按累积内容重绘。侧栏对生成中的会话显示转圈标记，顶栏/状态条显示当前有几个在跑，只对非当前会话的流完成时弹提示。
- **审批卡片**：Hermes 要执行被判危险的操作时，流里会出现一张卡片（工具名 + 待执行的命令 + 四个按钮：允许一次 / 本会话都允许 / 始终允许 / 拒绝），点击即 `POST /v1/runs/{id}/approval`。切走再切回来卡片会重建（审批状态在内存的流对象里，不在 DOM 里）。
  > 注意：本机装了 **smart approval**（`tools/terminal_tool.py`），被判危险的终端命令会被**自动放行**，所以多数情况下你根本看不到这张卡片。要让它真的弹出来，得关掉那一层自动审批。
- **回复里的编号选项可点**：Hermes 常用「1. … 2. …」列方案，UI 会把末尾连续 2–8 条编号/字母项渲染成可点胶囊，点一下即当作回复发出；正文里的普通罗列不会被误判。
- 流式输出（SSE），可随时**停止生成**（先 `POST /v1/runs/{id}/stop` 再断本地事件流，只停当前会话）
- **工具调用过程可见**：渲染 Hermes 专有事件 `event: hermes.tool.progress`（emoji + 工具名 + 参数预览），生成期间不是一片空白
- **历史工具行合并**：桌面端会话里「只有 tool_calls、无正文」的 assistant 行会按组归到对应回复上方（实测 44 次工具调用收进 9 个回合），不会刷出一片空条目
- Markdown：代码块（语言标签 + 复制）、表格、列表、引用、链接；**先转义再替换，无 HTML 注入面**
- 会话：新建 / 切换 / 重命名（双击或长按，同步回桌面端）/ 删除 / 过滤 / 导出当前会话为 Markdown
- 「使用统计」页：对服务端会话行求和（会话数、消息数、工具调用、输入/输出 tokens、缓存读取、成本）
- 设置：Base URL / Key / 模型名 / 主题（深·浅·跟随系统）/ 工具过程开关 / 配置导出导入 / 清本机数据
- PWA 可「添加到主屏幕」；顶部连接状态灯（`/health` → 回退 `/v1/models`）
- 长会话分页：`pagination.total` 超过单页时自动取**最后一页**（最近的对话最有用）并提示

## 移动端适配

| 处理 | 说明 |
|---|---|
| 断点 768px | 与 Hermes 桌面端一致（`SIDEBAR_COLLAPSE_BREAKPOINT_PX`） |
| 侧栏 → 抽屉 | 移动端 84vw 滑入 + 遮罩，桌面端常驻 264px |
| 设置 → 底部抽屉 | 移动端底部上滑，桌面端右侧滑出 |
| 输入框 16px | iOS 聚焦不再自动放大整页 |
| 触摸目标 ≥44px | 图标按钮与列表项 |
| `100dvh` | 地址栏收放不跳动 |
| `env(safe-area-inset-*)` | 刘海 / Home 指示条避让 |
| `visualViewport` | 软键盘弹出时顶起输入区并滚到底 |
| Enter 分流 | 触屏 Enter 换行（防误发）；桌面 Enter 发送、Shift+Enter 换行 |
| 横屏压缩留白 | `max-height:500px` 时收紧顶栏与输入框 |
| 触屏无 hover | 删除键常显（半透明），不依赖悬停 |

## 文件结构

```
hermes-lite-webui/
├── index.html              单页：配置页 + 主界面 + 设置抽屉
├── manifest.webmanifest    PWA 清单
├── sw.js                   只缓存自身外壳，永不碰 API
├── icon.svg / icon-maskable.svg
├── css/  tokens · base · layout · components
├── js/
│   ├── main.js             启动、状态机、发送流程、会话编排
│   ├── api.js              会话面 + OpenAI 面 + SSE 解析
│   ├── store.js            仅 config / prefs / 只读缓存
│   ├── ui.js               会话列表 / 消息流 / 工具条 / 状态条
│   ├── markdown.js         安全的极简 Markdown
│   ├── settings.js         设置抽屉
│   └── util.js             DOM / 格式化 / 剪贴板
└── _tools/                 CDP 端到端验证脚本（不含密钥）
```

无构建、无依赖：不需要 npm，改完直接刷新。

**localStorage 只有 3 个 key**（`hermes-lite-webui.{config,prefs,cache}.v1`）：连接配置、偏好、以及一份只读缓存（列表 + 最近 6 个会话的消息，用于秒开和离线查看）。**会话历史的权威副本在服务端**，清掉浏览器数据不会丢对话。

## 本地验证

```bash
python -m http.server 8900 --bind 127.0.0.1        # 起静态服务
python _tools/verify_shared.py http://127.0.0.1:8900/ "$API_SERVER_KEY" ./_shots
```

`_tools/verify_shared.py` 会驱动真实 Chrome（CDP `127.0.0.1:9222`）跑完整链路并断言：
侧栏含 `source=desktop` 会话 → 打开桌面端会话能渲染出正文与工具条 → 新建会话发一轮 →
**回查 `GET /api/sessions/{id}/messages` 确认服务端真的记下了 user+assistant**。`_tools/cdp_quick.py` 用于移动端响应式截图，`_tools/final_check.py` 用于断点断言。

## 已知限制

- **不支持图片 / 附件上传**：`api_server` 接受 `image_url`（base64 / https），但本项目当前只发纯文本。
- **工具过程依赖 Hermes 专有事件**：接别的 OpenAI 兼容后端时没有 `hermes.tool.progress`，只显示文本。
- **历史工具行的 emoji 是本地兜底映射**：服务端只在实时事件里带 emoji，静态历史行用内置映射表（未知工具显示 🔧）。
- **删除会话是跨端生效的**：从网页删掉一条桌面端会话，桌面端/CLI 里也会消失（有二次确认，会提示来源）。
- 需要该网关**放行跨源**；被收紧时须改成同源反代。
