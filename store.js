// Speicher für die großen Dateien (Modell, Laufzeit) in IndexedDB. Absichtlich nicht der Cache-Speicher des Browsers:
// Andere Apps unter derselben Adresse (z. B. github.io) können fremde Caches löschen, IndexedDB bleibt unberührt.
const DB_NAME = "skelettalter";
const STORE = "files";

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

export const idbGet = (key) => run("readonly", (s) => s.get(key));
export const idbPut = (key, value) => run("readwrite", (s) => s.put(value, key));
export const idbDelete = (key) => run("readwrite", (s) => s.delete(key));
export const idbKeys = () => run("readonly", (s) => s.getAllKeys());

const keyFor = (file) => `big/${file.name}@${file.sha256.slice(0, 16)}`;

async function download(file, onBytes) {
  const response = await fetch(file.name, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${file.name}: Server antwortet mit ${response.status}`);
  const data = new Uint8Array(file.size);
  let offset = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.length > file.size) throw new Error(`${file.name}: Datei ist größer als erwartet`);
    data.set(value, offset);
    offset += value.length;
    onBytes(offset);
  }
  if (offset !== file.size) throw new Error(`${file.name}: Download unvollständig (${offset} von ${file.size} Bytes)`);
  if (globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== file.sha256) throw new Error(`${file.name}: Prüfsumme stimmt nicht`);
  }
  return data.buffer;
}

export async function loadManifest() {
  return (await fetch("assets.json")).json();
}

// Lädt fehlende große Dateien einmalig herunter und legt sie im Gerätespeicher ab.
export async function ensureAssets(onProgress) {
  const manifest = await loadManifest();
  const total = manifest.big.reduce((sum, f) => sum + f.size, 0);
  let finished = 0;
  const existing = new Set(await idbKeys());
  for (const file of manifest.big) {
    const key = keyFor(file);
    if (!existing.has(key)) {
      const buffer = await download(file, (n) => onProgress?.((finished + n) / total));
      await idbPut(key, buffer);
      for (const other of await idbKeys()) {
        if (typeof other === "string" && other.startsWith(`big/${file.name}@`) && other !== key) await idbDelete(other);
      }
    }
    finished += file.size;
    onProgress?.(finished / total);
  }
  return manifest;
}

export async function readAsset(name) {
  const manifest = await loadManifest();
  const file = manifest.big.find((f) => f.name === name);
  if (!file) throw new Error(`${name} ist nicht vorgesehen`);
  const buffer = await idbGet(keyFor(file));
  if (!buffer) throw new Error("Das Modell ist noch nicht auf diesem Gerät. Bitte die App einmal mit Internetverbindung öffnen.");
  return buffer;
}

export async function assetsPresent() {
  const manifest = await loadManifest();
  const existing = new Set(await idbKeys());
  return manifest.big.every((f) => existing.has(keyFor(f)));
}

export async function requestPersistence() {
  try {
    return (await navigator.storage?.persist?.()) ?? null;
  } catch {
    return null;
  }
}
