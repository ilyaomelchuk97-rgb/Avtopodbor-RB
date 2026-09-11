'use strict';

const VERSION = '1.5.0';
const SHELL_CACHE = `motor-by-shell-${VERSION}`;
const IMAGE_CACHE = `motor-by-images-${VERSION}`;
const CACHE_PREFIX = 'motor-by-';
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest',
  '/assets/hero-car.jpg', '/assets/hero-car-light.jpg', '/assets/category-city.jpg',
  '/assets/favicon.svg', '/assets/favicon-32.png', '/assets/apple-touch-icon.png',
  '/assets/icon-192.png', '/assets/icon-512.png', '/assets/icon-maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && ![SHELL_CACHE, IMAGE_CACHE].includes(name)).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

async function trimCache(cache, maximum) {
  const keys = await cache.keys();
  if (keys.length > maximum) await Promise.all(keys.slice(0, keys.length - maximum).map(key => cache.delete(key)));
}

async function imageResponse(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const shell = await caches.open(SHELL_CACHE);
  const cached = (await cache.match(request)) || (await shell.match(request));
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
      await cache.put(request, response.clone());
      trimCache(cache, 72).catch(() => {});
    }
    return response;
  } catch (error) {
    return cached || Response.error();
  }
}

async function navigationResponse(request) {
  const cache = await caches.open(SHELL_CACHE);
  const network = fetch(request).then(async response => {
    if (response.ok) await cache.put('/index.html', response.clone());
    return response;
  });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('network timeout')), 4500));
  try { return await Promise.race([network, timeout]); }
  catch (_) { return (await cache.match('/index.html')) || (await cache.match('/')); }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (request.destination === 'image') {
    event.respondWith(imageResponse(request));
    return;
  }
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }
  if (url.origin === self.location.origin && ['style', 'script', 'manifest', 'font'].includes(request.destination)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
