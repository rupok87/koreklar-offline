/* Service worker: precaches the entire app shell + content + media tree on install so the app
   works fully offline afterward, matching the native app's "no network needed" design.
   Core app-shell files (html/css/js/json) are small and change often during development, so they're
   always re-fetched and kept fresh (network-first at runtime). Media (~424MB) never changes once
   scraped, so it's fetched once and served cache-first forever after — no need to re-download it
   just because a code file changed. */
const CACHE_NAME = 'koreklar-v2';
const CHUNK_SIZE = 40;

async function postProgress(done, total) {
  const clientsList = await self.clients.matchAll({ includeUncontrolled: true });
  clientsList.forEach((client) => client.postMessage({ type: 'cache-progress', done, total }));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const manifestRes = await fetch('assets-manifest.json', { cache: 'no-store' });
    const manifest = await manifestRes.json();
    const coreUrls = [...manifest.core, 'assets-manifest.json'];
    const mediaUrls = manifest.media;
    const total = coreUrls.length + mediaUrls.length;
    let done = 0;

    // Core files: always re-fetch, so code/content updates are picked up without a full media re-download.
    await Promise.all(coreUrls.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (res.ok) await cache.put(url, res);
      } catch (e) { /* ignore; served from any existing cache entry at runtime */ }
    }));
    done += coreUrls.length;
    await postProgress(done, total);

    // Media: only fetch what isn't already cached — these files never change once scraped.
    for (let i = 0; i < mediaUrls.length; i += CHUNK_SIZE) {
      const chunk = mediaUrls.slice(i, i + CHUNK_SIZE);
      await Promise.all(chunk.map(async (url) => {
        try {
          const existing = await cache.match(url);
          if (!existing) {
            const res = await fetch(url);
            if (res.ok) await cache.put(url, res);
          }
        } catch (e) {
          /* ignore individual failures; app still works, that asset just re-fetches on demand */
        }
      }));
      done += chunk.length;
      await postProgress(Math.min(done, total), total);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const CORE_EXTENSIONS = ['.html', '.js', '.css', '.webmanifest', '.json'];

function isCoreRequest(url) {
  return CORE_EXTENSIONS.some((ext) => url.endsWith(ext)) && !url.includes('/media/');
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const isCore = isCoreRequest(event.request.url);

  event.respondWith((async () => {
    if (isCore) {
      // Network-first for app-shell files, so a redeploy is visible on next online load.
      try {
        const res = await fetch(event.request);
        if (res.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(event.request, res.clone());
        }
        return res;
      } catch (e) {
        return (await caches.match(event.request)) || Response.error();
      }
    }

    // Cache-first for media — large, static, and must work fully offline.
    const cached = await caches.match(event.request);
    if (cached) return cached;
    try {
      const res = await fetch(event.request);
      if (res.ok && event.request.url.startsWith(self.location.origin)) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(event.request, res.clone());
      }
      return res;
    } catch (e) {
      return cached || Response.error();
    }
  })());
});
