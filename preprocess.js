// Bildvorbereitung wie im Training: Pillow convert("L") -> Resize((500,500), BILINEAR) -> ToTensor -> Normalize.
// Die Verkleinerung ist Pillows Algorithmus (feste 22-Bit-Koeffizienten, erst waagerecht, dann senkrecht, je auf 8 Bit gerundet).
const PRECISION_BITS = 22;
const MEAN = [0.485, 0.456, 0.406].map(Math.fround);
const STD = [0.229, 0.224, 0.225].map(Math.fround);

function resampleCoefficients(inSize, outSize) {
  const scale = inSize / outSize;
  const filterScale = Math.max(scale, 1);
  const support = 1.0 * filterScale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const coeffs = new Int32Array(outSize * ksize);
  const raw = new Float64Array(ksize);
  const ss = 1.0 / filterScale;
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    let ww = 0;
    for (let x = 0; x < xmax; x++) {
      let d = (x + xmin - center + 0.5) * ss;
      if (d < 0) d = -d;
      const w = d < 1.0 ? 1.0 - d : 0.0;
      raw[x] = w;
      ww += w;
    }
    for (let x = 0; x < ksize; x++) {
      const w = x < xmax && ww !== 0 ? raw[x] / ww : 0;
      coeffs[xx * ksize + x] = w < 0 ? Math.trunc(-0.5 + w * (1 << PRECISION_BITS)) : Math.trunc(0.5 + w * (1 << PRECISION_BITS));
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, bounds, coeffs };
}

function clip8(v) {
  const r = v >> PRECISION_BITS;
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

// Einkanaliges 8-Bit-Bild, erst horizontal, dann vertikal, jeweils auf 8 Bit gerundet (wie Pillow).
export function pillowResizeBilinear(src, sw, sh, dw, dh) {
  let cur = src, cw = sw, ch = sh;
  if (dw !== sw) {
    const { ksize, bounds, coeffs } = resampleCoefficients(sw, dw);
    const out = new Uint8Array(dw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < dw; x++) {
        const xmin = bounds[x * 2], xmax = bounds[x * 2 + 1];
        let acc = 1 << (PRECISION_BITS - 1);
        for (let i = 0; i < xmax; i++) acc += cur[y * cw + xmin + i] * coeffs[x * ksize + i];
        out[y * dw + x] = clip8(acc);
      }
    }
    cur = out; cw = dw;
  }
  if (dh !== sh) {
    const { ksize, bounds, coeffs } = resampleCoefficients(sh, dh);
    const out = new Uint8Array(cw * dh);
    for (let y = 0; y < dh; y++) {
      const ymin = bounds[y * 2], ymax = bounds[y * 2 + 1];
      for (let x = 0; x < cw; x++) {
        let acc = 1 << (PRECISION_BITS - 1);
        for (let i = 0; i < ymax; i++) acc += cur[(ymin + i) * cw + x] * coeffs[y * ksize + i];
        out[y * cw + x] = clip8(acc);
      }
    }
    cur = out;
  }
  return cur;
}

// RGBA (aus dem Canvas) -> Graustufen wie Pillow convert("L")
export function rgbaToGray(rgba, w, h) {
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    gray[i] = (rgba[j] * 19595 + rgba[j + 1] * 38470 + rgba[j + 2] * 7471 + 0x8000) >> 16;
  }
  return gray;
}

// Graustufen 500x500 -> Tensor [1,3,500,500] (drei gleiche Kanäle, ImageNet-Normalisierung)
export function toTensorData(gray, size = 500) {
  const n = size * size;
  const data = new Float32Array(3 * n);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) {
      data[c * n + i] = Math.fround(Math.fround(Math.fround(gray[i] / 255) - MEAN[c]) / STD[c]);
    }
  }
  return data;
}

// Bilddatei -> Graustufen. Das Bild wird über ein Bildelement geladen (nicht über createImageBitmap):
// Nur so stimmen die Pixel in Safari exakt mit Pillow überein. Der Browser dreht Fotos anhand der EXIF-Angabe
// selbst und decodiert auf dem iPhone auch HEIC.
export async function decodeFileToGray(file, maxPixels = 16000000) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error("Das Bild konnte nicht gelesen werden. Bitte ein anderes Format (JPEG, PNG) versuchen.");
    }
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error("Das Bild konnte nicht gelesen werden.");
    // iOS begrenzt die Fläche eines Canvas (ca. 16,7 Mio. Pixel), sehr große Fotos werden deshalb verkleinert
    let cw = w, ch = h;
    if (w * h > maxPixels) {
      const scale = Math.sqrt(maxPixels / (w * h));
      cw = Math.floor(w * scale);
      ch = Math.floor(h * scale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, cw, ch);
    const gray = rgbaToGray(ctx.getImageData(0, 0, cw, ch).data, cw, ch);
    canvas.width = canvas.height = 0;
    return { gray, w: cw, h: ch };
  } finally {
    URL.revokeObjectURL(url);
  }
}
