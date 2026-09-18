/**
 * sw.js —— 只缓存自己的静态外壳，永不碰 API 请求
 *
 * 目标：离线/弱网时页面还能打开（然后提示连不上后端），
 * 而不是白屏。api_server 的请求（跨源或 /v1、/api）一律直通网络。
 */

const VERSION = 'v2';
const CACHE = `hermes-lite-webui-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
  './css/tokens.css',
  './css/base.css',
  './css/layout.css',
  './css/components.css',
  './js/main.js',
  './js/util.js',
  './js/store.js',
  './js/api.js',
  './js/ui.js',
  './js/markdown.js',
  './js/settings.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 跨源（= 用户配置的 Hermes 后端）直通，绝不缓存、绝不拦截
  if (url.origin !== self.location.origin) return;

  // 本源的 API 路径（同源反代部署时会走到这里）也直通
  if (/^\/(api|auth|login|v1)(\/|$)/.test(url.pathname)) return;

  // 导航请求：网络优先，失败回落缓存的 index.html
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 静态资源：**网络优先**，失败才回落缓存。
  //
  // 这里以前是 stale-while-revalidate，结果是"部署了但没生效"：上传新版本后第一次加载跑的
  // 仍是缓存里的旧 css/js，要再刷一次才变（用户实际踩过：改了布局，页面上还是旧的）。
  // 自己部署的静态站，可预期性比省那几毫秒重要 —— 有网就用网上的，没网用缓存的。
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
