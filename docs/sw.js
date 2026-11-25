/* Point Crawl player: service worker.
 * - The app itself (page, scripts, icons) is cached so it opens instantly and works as an installed app.
 * - Map images are content-hashed, so they are cached once and never re-downloaded.
 * - Live map data (GitHub API / raw state) is never cached here: it must always be fresh. */
const VERSION = "pc-v2";
const MAPS = "pc-maps";
const SHELL = ["./", "index.html", "manifest.webmanifest", "pwa/icon-192.png", "pwa/icon-512.png"];

self.addEventListener("install", (e) => {
	e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
	e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== MAPS).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function cacheFirst(req, name, keep) {
	const cache = await caches.open(name);
	const hit = await cache.match(req);
	if (hit) return hit;
	const res = await fetch(req);
	if (res.ok) {
		await cache.put(req, res.clone());
		if (keep) { const keys = await cache.keys(); for (const k of keys.slice(0, Math.max(0, keys.length - keep))) await cache.delete(k); }
	}
	return res;
}

async function staleWhileRevalidate(req) {
	const cache = await caches.open(VERSION);
	const hit = await cache.match(req, { ignoreSearch: req.mode === "navigate" });
	const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
	return hit || net;
}

self.addEventListener("fetch", (e) => {
	const req = e.request;
	if (req.method !== "GET") return;
	const url = new URL(req.url);
	if (url.hostname === "raw.githubusercontent.com" && /\/maps\/.+\.(webp|png|jpe?g)$/i.test(url.pathname)) { e.respondWith(cacheFirst(req, MAPS, 6)); return; }
	if (url.origin === self.location.origin) e.respondWith(staleWhileRevalidate(req));
});
