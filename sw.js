// Service Worker der Offline-App. Wird von scripts/build_web.py mit Version und Dateiliste befüllt.
// Die kleinen Programmdateien liegen in IndexedDB (nicht im Cache-Speicher), damit andere Apps unter derselben
// Adresse sie nicht versehentlich löschen. Die großen Dateien (Modell, Laufzeit) verwaltet die Seite selbst (store.js).
const VERSION = "5f86231683d3";
const SHELL = ["assets.json", "data.json", "growth.js", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "index.html", "info.html", "manifest.webmanifest", "offline.js", "ort-wasm-simd-threaded.js", "ort.wasm.min.js", "preprocess.js", "selftest.js", "selftest.json", "store.js"];
const DB_NAME = "skelettalter";
const STORE = "files";
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".png": "image/png", ".webmanifest": "application/manifest+json", ".css": "text/css",
};
const shellSet = new Set(SHELL);
const scopePath = new URL(self.registration.scope).pathname;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run(mode, action) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

const typeOf = (path) => TYPES[path.slice(path.lastIndexOf("."))] || "application/octet-stream";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    for (const path of SHELL) {
      const response = await fetch(path, { cache: "reload" });
      if (!response.ok) throw new Error(`${path}: ${response.status}`);
      const buffer = await response.arrayBuffer();
      await run("readwrite", (s) => s.put(buffer, `shell/${VERSION}/${path}`));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await run("readonly", (s) => s.getAllKeys());
    for (const key of keys) {
      if (typeof key === "string" && key.startsWith("shell/") && !key.startsWith(`shell/${VERSION}/`)) {
        await run("readwrite", (s) => s.delete(key));
      }
    }
    await self.clients.claim();
  })());
});

async function serve(path, request) {
  const buffer = await run("readonly", (s) => s.get(`shell/${VERSION}/${path}`));
  if (buffer) return new Response(buffer, { headers: { "Content-Type": typeOf(path) } });
  return fetch(request);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scopePath)) return;
  let path = decodeURIComponent(url.pathname.slice(scopePath.length));
  if (path === "") path = "index.html";
  if (!shellSet.has(path)) return;
  event.respondWith(serve(path, request));
});
