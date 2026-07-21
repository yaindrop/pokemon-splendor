/* Pokémon Splendor — small offline shell plus runtime asset cache. */
const CACHE = 'ps-cache-v19';
const BALLS = ['red', 'blue', 'black', 'pink', 'yellow', 'purple'].map(
  (color) => `/assets/balls/${color}.png`,
);
const BACKS = ['stage1', 'stage2', 'stage3', 'rare', 'legend'].map(
  (tier) => `/assets/backs/${tier}.webp`,
);
const AVATARS = ['ash', 'misty', 'brock', 'rocket'].map(
  (avatar) => `/assets/avatars/${avatar}.png`,
);
const STATIC_SHELL = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  ...BALLS,
  ...BACKS,
  ...AVATARS,
];

async function cacheShell() {
  const cache = await caches.open(CACHE);
  const [entry, manifestResponse] = await Promise.all([
    fetch('/index.html', { cache: 'no-store' }),
    fetch('/vite-manifest.json', { cache: 'no-store' }),
  ]);
  if (!entry.ok) throw new Error(`无法缓存应用入口：${entry.status}`);
  if (!manifestResponse.ok) throw new Error(`无法读取构建清单：${manifestResponse.status}`);
  const html = await entry.clone().text();
  const manifest = await manifestResponse.clone().json();
  const entryAssets = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)]
    .map((match) => new URL(match[1], self.location.origin))
    .filter((url) => url.origin === self.location.origin)
    .map((url) => url.pathname + url.search);
  const buildAssets = Object.values(manifest).flatMap((item) => [
    item.file,
    ...(item.css || []),
    ...(item.assets || []),
  ]);
  const nestedAssets = (
    await Promise.all(
      buildAssets
        .filter((asset) => asset.endsWith('.js'))
        .map(async (asset) => {
          const response = await fetch(`/${asset}`, { cache: 'no-store' });
          if (!response.ok) throw new Error(`无法读取构建资源：${response.status}`);
          return [...(await response.text()).matchAll(/\/assets\/[\w.-]+/g)].map(
            (match) => match[0],
          );
        }),
    )
  ).flat();
  await Promise.all([
    cache.put('/', entry.clone()),
    cache.put('/index.html', entry),
    cache.put('/vite-manifest.json', manifestResponse),
    cache.addAll(
      [...new Set([...STATIC_SHELL, ...entryAssets, ...buildAssets, ...nestedAssets])].map(
        (asset) => (asset.startsWith('/') ? asset : `/${asset}`),
      ),
    ),
  ]);
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (
    /^\/(api|room)(\/|$)/.test(url.pathname) ||
    url.pathname === '/healthz' ||
    url.pathname === '/readyz'
  )
    return;

  if (request.mode === 'navigate' || /\.(?:html|css|js|json)$/.test(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok)
            void caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit ?? caches.match('/index.html'))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            void caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        }),
    ),
  );
});
