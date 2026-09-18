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
- **共享历史** —— 会话、消息、工具调用都来自网关的 `state.db`，网页端与桌面端是同一些对话。
- **多会话并发** —— 每条会话维护自己的流。一个会话在生成时，切到另一个继续用；切回来按累积文本重绘。
- **工具调用与正文交错** —— 每个工具条落在它在回复里真正发生的位置，靠事件到达时记录的字符偏移定位。
- **可发图片** —— 选文件或直接粘贴截图；图片在浏览器里先压过，再以 `data:` URL 发送。
- **移动优先** —— 抽屉式侧栏、安全区适配、100dvh、输入框 16px（避免 iOS 缩放）、带离线兜底的 PWA 外壳。

## 前置条件

- 一台在运行的 Hermes Agent，其 **api_server**（网关）能被浏览器以 HTTPS 访问，例如
  `https://hermes.example.com/v1`。
- 它的 `API_SERVER_KEY`。
- 别的都不需要。api_server 会回 `Access-Control-Allow-Origin: *`，所以纯静态部署不必配反代。
  （如果你收紧了 CORS，就把这些文件部署到同源反代后面。）

## 快速开始

1. 把这些文件放到任意静态主机上（本地试跑：`python -m http.server 8080`）。
2. 打开页面，首次访问填入 **Base URL** 和 **API Key**，它们只存在本机。

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

## 安全须知

- `API_SERVER_KEY` 不只是"一个 API key"：api_server 会派发具备终端能力的 agent 工作，
  拿到它的人就能在这台主机上执行命令。**不要提交它、不要把它写进页面**。
- 要给多人用？给每个人建一个 Hermes profile，发对应的作用域密钥和 `/p/<profile>/v1` 地址，
  这样每把密钥只能触达自己的 profile。
- 会话占用的情况已处理：同一条会话若正在别处运行，网关会返回一句明确的拒绝而不是执行，
  界面会如实提示，不会把它当成正常回复。

## 已知限制

- **网页端无法改名 / 置顶 / 归档 / 标记未读。** 网关的 CORS 预检只声明
  `GET, POST, DELETE, OPTIONS`，跨源 `PATCH` 根本发不出去；路由也没有 POST 别名，前端无解。
- **没有选项框（`clarify`）。** api_server 这条面从不注入 clarify 回调，模型在该环境下看不到这个工具。
  回复里的编号选项会被渲染成可点击的胶囊作为替代。
- **图片不会进历史。** 写入 `state.db` 时图片部件会被投影成文字占位 `[screenshot]`
  （这是设计：不把几 MB 的 base64 塞进会话数据库）。发出后本次可见，刷新后只剩占位符。
- **界面文案目前是中文。** 代码注释也是中文；README 为中英双语。

## 更新部署

Service worker 对静态资源是**网络优先**（离线才回落缓存），且新 worker 激活后会自动刷新一次页面，
所以部署在下次加载即生效。若改动缓存策略，记得把 `sw.js` 里的 `VERSION` 抬一版，让旧缓存被清掉。

## 目录结构

```
index.html              入口
css/                    tokens / base / layout / components
js/api.js               网关客户端（REST + SSE 解析）
js/store.js             localStorage：配置、偏好、只读缓存
js/ui.js                渲染（会话、回复、工具条、选项、审批）
js/main.js              状态机、每会话独立流、事件接线
js/markdown.js          轻量 markdown 渲染
sw.js, manifest...      PWA 外壳
```

## 许可

MIT，见 [LICENSE](LICENSE)。
