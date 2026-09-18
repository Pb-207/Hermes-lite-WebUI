# Hermes Lite WebUI

纯静态、移动优先的 [Hermes Agent](https://hermes-agent.nousresearch.com/docs) 聊天前端。
**没有自己的后端、服务器上不存任何密钥**：访问者在页面里填自己的 Base URL 和 API Key，
它们只写进那台浏览器的本地存储，请求由浏览器直接发给访问者自己填的 Hermes 网关。

会话历史就是**桌面端 / CLI / dashboard 用的那一份**（`state.db`）：侧栏列出的是服务端真实会话，
打开一条就是那段桌面端对话，你在这里发的每一轮也写回同一个会话。

> English documentation: [README.md](README.md)。

---

## 为什么做这个

Hermes 有桌面端、TUI 和消息网关，但没有一个"丢到静态主机上、把链接发出去就能用"的网页端。
这就是它：一个文件夹的 HTML/CSS/JS，不需要构建、没有依赖、不用 npm install，任何能托管静态文件
的地方都能部署。

## 特性

- **纯静态、零依赖** —— 原生 ES 模块，没有打包器、没有框架、没有构建步骤。
- **密钥不出浏览器** —— 配置存在 `localStorage`；静态文件里不含任何凭据，托管方也无法冒充使用者。
- **共享历史** —— 会话、消息、工具调用都来自网关的 `state.db`，网页端与桌面端是同一些对话；
  侧栏的来源徽章标出每条来自哪里（桌面端 / 网页 / CLI / Telegram …）。
- **多会话并发** —— 每条会话维护自己的流。一个会话在生成时，你可以切到别的、也可以新建；
  切回来按累积文本重绘。生成中的会话在侧栏有转圈标记。
- **工具调用与正文交错** —— 每个工具条落在它在回复里真正发生的位置，靠事件到达时记录的字符偏移定位。
- **可发图片** —— 选文件或直接粘贴截图；图片在浏览器里先压过，再以 `data:` URL 发送。
- **可中途停止** —— 停止键先请网关停掉该 run，再断开本地事件流，且只影响当前会话。
- **Markdown** —— 代码块（语言标签 + 复制）、表格、列表、引用、链接；先转义再替换。
- **使用统计页** —— 对服务端会话行求和（会话数、消息数、工具调用、输入/输出 tokens、缓存读取、成本）。
- **导出** —— 把当前对话存成 Markdown。
- **移动优先** —— 抽屉式侧栏、安全区适配、100dvh、输入框 16px（避免 iOS 缩放）、软键盘顶起、PWA 离线兜底。

## 前置条件

- 一台在运行的 Hermes Agent，其 **api_server**（网关）能被浏览器以 HTTPS 访问，例如
  `https://hermes.example.com/v1`。
- 它的 `API_SERVER_KEY`。
- 别的都不需要。api_server 会回 `Access-Control-Allow-Origin: *`，所以纯静态部署不必配反代。
  （如果你收紧了 CORS，就把这些文件部署到同源反代后面。）

## 快速开始

1. 把这些文件放到任意静态主机上（本地试跑：`python -m http.server 8080`）。
2. 打开页面，首次访问填入 **Base URL** 和 **API Key**，它们只存在本机。
   「测试连接」会同时验**模型列表**和**会话历史可读** —— 能立刻暴露"能对话但读不到历史"这种半通状态。

也可以用查询参数替使用者预填网关地址：

```
https://你的域名/hermes/?base=https://hermes.example.com/v1
```

这样别人只需要粘自己的 key。

## 用到的接口

| 用途 | 端点 |
|---|---|
| 会话列表 | `GET /api/sessions?limit=&offset=` |
| 新建会话 | `POST /api/sessions` |
| 读历史 | `GET /api/sessions/{id}/messages?limit=&order=` |
| 发一轮 | `POST /api/sessions/{id}/chat/stream`（SSE） |
| 改名 / 置顶 | `PATCH /api/sessions/{id}` |
| 删除 | `DELETE /api/sessions/{id}` |
| 模型探测 | `GET {base}/models` |

发送用的是"会话内流式"端点：它是唯一同时满足**从数据库读该会话历史**和**返回浏览器可读的 CORS 头**
的端点。事件词表与解析细节见 `js/api.js`（`run.started`、`assistant.delta`、
`tool.started|completed|failed`、`assistant.completed`、`run.completed|failed|cancelled`）。

另有一条面：`POST {base}/chat/completions` 带 `X-Hermes-Session-Id` 请求头 —— 服务端会用该会话在
`state.db` 里的历史**替换**请求体里的 `messages`，所以每次只发当轮那一条 user 消息。它要求 API Key
鉴权，且服务端会回显它实际绑定的会话 id（上下文压缩后 id 可能变）。

首轮之后服务端会**自动给会话起标题**，侧栏标题自己就会出现。

## 本机存了什么

`localStorage` 只有 3 个 key（`hermes-lite-webui.{config,prefs,cache}.v1`）：连接配置、偏好，以及一份
只读缓存（会话列表 + 最近几个会话的消息，用于秒开与离线查看）。
**历史的权威副本在服务端** —— 清掉浏览器数据不会丢对话。

## 安全须知

- `API_SERVER_KEY` 不只是"一个 API key"：api_server 会派发**带终端能力**的 agent 工作，
  源码原话是「a guessable key is remote code execution」。拿到它的人能在主机上执行命令，
  并读到该 profile 的全部会话历史。
- **不要**把它提交进仓库、也不要写进页面或构建产物。这个项目正是为此设计：key 由每个使用者自己填。
- 要给多人用？api_server 支持**按 profile 作用域的密钥**，并把每个 profile 镜像到 `/p/<profile>/`。
  给每人一个 profile 和对应的 Base URL（`https://host/p/<名字>/v1`），顺带隔离了各自的历史 ——
  否则同一把 key 看到的是同一批会话。还可以在静态站前面再加一层 basic auth。
- 会话占用的情况已处理：同一条会话若正在别处运行，网关会返回一句明确的拒绝而不是执行，
  界面会如实提示，不会把它当成正常回复。

## 已知限制

- **网页端无法改名 / 置顶 / 归档 / 标记未读。** 网关的 CORS 预检只声明
  `GET, POST, DELETE, OPTIONS`，跨源 `PATCH` 根本发不出去；路由也没有 POST 别名，前端无解。
- **没有选项框（`clarify`）。** api_server 这条面从不注入 clarify 回调，模型在该环境下看不到这个工具。
  回复里的编号选项会被渲染成可点击的胶囊作为替代。
- **图片不会进历史。** 写入 `state.db` 时图片部件会被投影成文字占位 `[screenshot]`
  （这是设计：不把几 MB 的 base64 塞进会话数据库）。发出后本次可见，刷新后只剩占位符。
- **历史行的工具 emoji 来自本地映射表** —— 服务端只在实时事件里带 emoji。
- **删除会话是跨端生效的**：从网页删掉一条桌面端会话，桌面端 / CLI 里也会消失。
- **界面文案目前是中文。** 代码注释也是中文；README 为中英双语。

## 更新部署

Service worker 对静态资源是**网络优先**（离线才回落缓存），且新 worker 激活后会自动刷新一次页面，
所以部署在下次加载即生效。它只缓存本站外壳，跨源请求与 `/api`、`/v1` 路径**永不拦截**。
若改动缓存策略，记得把 `sw.js` 里的 `VERSION` 抬一版，让旧缓存被清掉。

## 目录结构

```
index.html              入口（配置页 + 主界面 + 设置抽屉）
css/                    tokens / base / layout / components
js/api.js               网关客户端（REST + SSE 解析）
js/store.js             localStorage：配置、偏好、只读缓存
js/ui.js                渲染（会话、回复、工具条、选项、审批）
js/main.js              启动、状态机、每会话独立流、事件接线
js/markdown.js          先转义的极简 markdown 渲染
js/settings.js          设置抽屉
sw.js, manifest...      PWA 外壳
```

无构建、无依赖：不需要 npm，改完直接刷新。

## 本地验证

前端没有测试框架；端到端验证靠真实 Chrome（CDP `127.0.0.1:9222`）驱动本地服务的一份副本：

```bash
python -m http.server 8915 --bind 127.0.0.1
# 再用一个脚本（本仓库未附带）连上你自己的网关跑断言
```

两条值得保留的习惯：断言刚改过的文件前，先清掉 service worker 与 caches；以及**核验回复的块序**
（正文 / 工具 / 正文），别只看一张截图。

## 许可

MIT，见 [LICENSE](LICENSE)。
