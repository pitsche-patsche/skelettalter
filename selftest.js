// Selbsttest (Aufruf: Adresse mit ?selftest). Prüft auf dem Gerät selbst, ob Modell und Rechnung dieselben Zahlen
// liefern wie die Python-Fassung, und misst Zeit. Die Sollwerte kommen aus selftest.json (vom Build erzeugt).
import { pillowResizeBilinear, toTensorData } from "./preprocess.js";

const fmt = (n, d = 3) => Number(n).toFixed(d);

// Zwischenablage: navigator.clipboard gibt es nur über HTTPS, sonst Ersatz über ein verstecktes Textfeld.
async function copyText(text) {
  try {
    if (navigator.clipboard && isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* weiter mit Ersatzverfahren */ }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
  document.body.appendChild(area);
  const range = document.createRange();
  range.selectNodeContents(area);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  area.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* ok bleibt false */ }
  area.remove();
  return ok;
}

function showManualCopy(button, text) {
  let area = document.getElementById("selftestManual");
  if (!area) {
    area = document.createElement("textarea");
    area.id = "selftestManual";
    area.readOnly = true;
    area.rows = 8;
    area.style.cssText = "width:100%;margin-top:10px;font-size:12px;box-sizing:border-box;";
    area.onfocus = () => area.select();
    button.insertAdjacentElement("afterend", area);
  }
  area.value = text;
  area.focus();
  area.select();
}

function syntheticGray(w, h) {
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = (x * 7 + y * 13 + ((x * y) >> 5)) & 255;
  return gray;
}

export async function runSelftest({ getSession, runModel, growth, workerReady, assetsPresent, loadManifest, output, copyButton }) {
  const lines = [];
  let failed = false;
  const log = (line) => { lines.push(line); output.textContent = lines.join("\n"); };
  const check = (ok, text) => { if (!ok) failed = true; log(`${ok ? "OK    " : "FEHLER"} ${text}`); };
  copyButton.onclick = async () => {
    const text = lines.join("\n");
    if (await copyText(text)) {
      copyButton.textContent = "Kopiert";
    } else {
      copyButton.textContent = "Kopieren nicht möglich: Text unten markieren und kopieren";
      showManualCopy(copyButton, text);
    }
  };

  try {
    const expected = await (await fetch("selftest.json")).json();
    const manifest = await loadManifest();
    log(`Selbsttest, Version ${manifest.version}`);
    log(`Gerät: ${navigator.userAgent}`);
    log(`Sicherer Kontext: ${isSecureContext}, Service Worker aktiv: ${workerReady}, gesteuert: ${Boolean(navigator.serviceWorker?.controller)}`);
    log(`Dauerhafter Speicher: ${(await navigator.storage?.persisted?.()) ?? "unbekannt"}, cross-origin isolated: ${self.crossOriginIsolated}`);
    let t = performance.now();
    await getSession();
    log(`Modell bereit und Sitzung erstellt in ${fmt((performance.now() - t) / 1000, 2)} s (inklusive Download beim ersten Mal)`);
    check(await assetsPresent(), `Modell und Laufzeit im Gerätespeicher (${manifest.big.map((f) => `${(f.size / 1e6).toFixed(1)} MB`).join(" + ")})`);

    const { w, h } = expected.synthetic;
    const tensor = toTensorData(pillowResizeBilinear(syntheticGray(w, h), w, h, 500, 500), 500);
    for (const c of expected.model_cases) {
      for (let run = 1; run <= 2; run++) {
        t = performance.now();
        const months = await runModel(tensor, c.male === 1);
        const seconds = (performance.now() - t) / 1000;
        const diff = Math.abs(months - c.months);
        check(diff < 0.01, `${c.male ? "Junge" : "Mädchen"}, Lauf ${run}: ${fmt(months)} Monate (Soll ${fmt(c.months)}, Abweichung ${fmt(diff, 4)}), ${fmt(seconds, 2)} s`);
      }
    }

    await growth.loadGrowthData();
    let worst = 0;
    for (const c of expected.growth_cases) {
      const got = growth.assess(c.params);
      for (const [path, want] of Object.entries(c.expect)) {
        const value = path.split(".").reduce((o, k) => o?.[k], got);
        const diff = Math.abs(value - want);
        worst = Math.max(worst, diff);
        if (!(diff < 0.051)) check(false, `Endgröße ${path}: ${value} statt ${want}`);
      }
    }
    check(worst < 0.051, `Endgrößen-Rechnung: ${expected.growth_cases.length} Fälle, größte Abweichung ${fmt(worst, 3)}`);
  } catch (error) {
    check(false, `Selbsttest abgebrochen: ${error.message}`);
  }
  log(failed ? "ERGEBNIS: FEHLER" : "ERGEBNIS: BESTANDEN");
  document.title = failed ? "Selbsttest: FEHLER" : "Selbsttest: BESTANDEN";
}
