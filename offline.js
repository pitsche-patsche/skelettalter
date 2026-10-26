// Offline-Betrieb: Modell und Rechnung laufen im Browser. Setzt window.skelettalterApi für die Oberfläche (index.html).
import { assetsPresent, ensureAssets, loadManifest, readAsset, requestPersistence } from "./store.js";
import { decodeFileToGray, pillowResizeBilinear, toTensorData } from "./preprocess.js";
import * as growth from "./growth.js";
import { runSelftest } from "./selftest.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("offlineStatus");
const IMAGE_SIZE = 500;

function setStatus(text, state = "") {
  statusEl.hidden = false;
  statusEl.className = `offline-status ${state}`.trim();
  statusEl.textContent = text;
}

let workerReady = false;
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return false;
  try {
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController) location.reload();
    });
    await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    return true;
  } catch {
    return false;
  }
}

let assetsPromise = null;
function prepareAssets() {
  assetsPromise ??= (async () => {
    try {
      if (!(await assetsPresent())) setStatus("Modell wird für den Offline-Betrieb geladen … 0 %");
      await ensureAssets((fraction) => setStatus(`Modell wird für den Offline-Betrieb geladen … ${Math.round(fraction * 100)} %`));
      await requestPersistence();
      setStatus(workerReady ? "Offline bereit: Die App funktioniert jetzt auch ohne Internet." : "Modell geladen. Zum Starten ohne Internet wird die Adresse über HTTPS benötigt.", workerReady ? "ready" : "");
    } catch (error) {
      assetsPromise = null;
      const offline = navigator.onLine === false;
      setStatus(offline
        ? "Das Modell ist noch nicht auf diesem Gerät. Bitte die App einmal mit Internetverbindung öffnen. (Tippen zum Wiederholen)"
        : `Das Modell konnte nicht geladen werden: ${error.message} (Tippen zum Wiederholen)`);
      throw error;
    }
  })();
  return assetsPromise;
}

let sessionPromise = null;
export function getSession() {
  sessionPromise ??= (async () => {
    await prepareAssets();
    const ort = window.ort;
    const [wasm, model] = await Promise.all([readAsset("ort-wasm-simd-threaded.wasm"), readAsset("model.onnx")]);
    ort.env.wasm.wasmBinary = new Uint8Array(wasm);
    ort.env.wasm.wasmPaths = { mjs: new URL("ort-wasm-simd-threaded.js", document.baseURI).href };
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    return ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  })();
  sessionPromise.catch(() => { sessionPromise = null; });
  return sessionPromise;
}

let queue = Promise.resolve();
function serial(task) {
  queue = queue.catch(() => {}).then(task);
  return queue;
}

export async function runModel(tensorData, male) {
  return serial(async () => {
    const session = await getSession();
    const ort = window.ort;
    const output = await session.run({
      image: new ort.Tensor("float32", tensorData, [1, 3, IMAGE_SIZE, IMAGE_SIZE]),
      male: new ort.Tensor("float32", new Float32Array([male ? 1 : 0]), [1, 1]),
    });
    return output.months.data[0];
  });
}

window.skelettalterApi = {
  async predict(file, sex) {
    const { gray, w, h } = await decodeFileToGray(file);
    const tensor = toTensorData(pillowResizeBilinear(gray, w, h, IMAGE_SIZE, IMAGE_SIZE), IMAGE_SIZE);
    return runModel(tensor, sex === "male");
  },
  async growth(body) {
    await growth.loadGrowthData();
    return growth.assess(body);
  },
  async curves(sex, reference) {
    await growth.loadGrowthData();
    return growth.curves(sex, reference);
  },
};

statusEl.addEventListener("click", () => {
  if (!assetsPromise) prepareAssets().catch(() => {});
});

(async () => {
  workerReady = await registerServiceWorker();
  prepareAssets().catch(() => {});
  if (new URLSearchParams(location.search).has("selftest")) {
    $("selftestCard").hidden = false;
    runSelftest({ getSession, runModel, growth, workerReady, assetsPresent, loadManifest, output: $("selftestOut"), copyButton: $("selftestCopy") });
  }
})();
