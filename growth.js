// JavaScript-Fassung von src/growth.py. Die Referenzdaten kommen aus data.json (erzeugt von scripts/build_web.py).
const MIN_MONTHS = 24.0;
const BONE_AGE_ERROR_MONTHS = 8.0;
const TARGET_RANGE_CM = 8.5;
const KR_MIN_YEARS = 4.0, KR_MAX_YEARS = 17.5;
const LB_PER_KG = 2.2046226;
const PUBERTY_BONE_AGE_YEARS = { male: 12.0, female: 10.5 };

export class InputError extends Error {}

// Normalverteilung: erf per Reihe (|x| < 3) bzw. Kettenbruch (Rand), Genauigkeit etwa 1e-15 wie math.erf in Python
function erfSeries(x) {
  let term = x, sum = x;
  for (let n = 1; n < 100; n++) {
    term *= -x * x / n;
    const add = term / (2 * n + 1);
    sum += add;
    if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
  }
  return (2 / Math.sqrt(Math.PI)) * sum;
}
function erfcPositive(x) {
  if (x < 3) return 1 - erfSeries(x);
  let t = x;
  for (let k = 80; k >= 1; k--) t = x + (k / 2) / t;
  return Math.exp(-x * x) / (Math.sqrt(Math.PI) * t);
}
function normalCdf(z) {
  const x = -z / Math.SQRT2;
  return 0.5 * (x >= 0 ? erfcPositive(x) : 2 - erfcPositive(-x));
}
const pct = (z) => 100 * normalCdf(z);
// Wie Pythons round(): bei exaktem Gleichstand (z. B. 172,25) wird zur geraden Ziffer gerundet, sonst korrekt gerundet.
function round(x, d) {
  const exact = Math.abs(x).toFixed(100);
  const dot = exact.indexOf(".");
  if (d >= 1 && /^50*$/.test(exact.slice(dot + 1 + d))) {
    const kept = exact.slice(0, dot + 1 + d);
    const down = Number(kept);
    const value = Number(kept[kept.length - 1]) % 2 === 0 ? down : Number((down + 10 ** -d).toFixed(d));
    return x < 0 ? -value : value;
  }
  return Number(x.toFixed(d));
}

function bisectRight(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < arr[mid]) hi = mid; else lo = mid + 1;
  }
  return lo;
}

class Reference {
  constructor(raw) {
    Object.assign(this, { key: raw.key, label: raw.label, percentiles: raw.percentiles, adultMonths: raw.adult_months, bmiCuts: raw.bmi_cuts });
    this.tables = raw.tables;
  }

  lms(name, sex, months) {
    const t = this.tables[name][sex];
    const ages = t.age;
    if (!(ages[0] <= months && months <= ages[ages.length - 1])) throw new InputError("Alter außerhalb des Bereichs der Referenz.");
    const i = Math.min(bisectRight(ages, months) - 1, ages.length - 2);
    const f = (months - ages[i]) / (ages[i + 1] - ages[i]);
    const at = (k) => t[k][i] + f * (t[k][i + 1] - t[k][i]);
    return [at("L"), at("M"), at("S")];
  }

  zscore(name, sex, months, value) {
    const [L, M, S] = this.lms(name, sex, months);
    return Math.abs(L) < 1e-9 ? Math.log(value / M) / S : (Math.pow(value / M, L) - 1) / (L * S);
  }

  valueAt(name, sex, months, z) {
    const [L, M, S] = this.lms(name, sex, months);
    return Math.abs(L) < 1e-9 ? M * Math.exp(S * z) : M * Math.pow(1 + L * S * z, 1 / L);
  }

  track(sex, z, fromMonths) {
    const points = [];
    let m = fromMonths;
    while (m < this.adultMonths) {
      points.push([round(m / 12, 2), round(this.valueAt("stature", sex, m, z), 1)]);
      m += 6;
    }
    points.push([round(this.adultMonths / 12, 2), round(this.valueAt("stature", sex, this.adultMonths, z), 1)]);
    return points;
  }

  curves(sex) {
    const series = (name) => {
      const t = this.tables[name][sex];
      const out = {};
      for (const p of this.percentiles) out[String(p)] = t.age.map((a, i) => [round(a / 12, 3), round(t.P[String(p)][i], 2)]);
      return out;
    };
    return { reference: this.key, adult_age_years: this.adultMonths / 12, percentiles: [...this.percentiles], stature: series("stature"), weight: series("weight") };
  }
}

let DATA = null;
const REFERENCES = {};

export async function loadGrowthData() {
  if (DATA) return;
  DATA = await (await fetch("data.json")).json();
  for (const [key, raw] of Object.entries(DATA.references)) REFERENCES[key] = new Reference(raw);
}

function khamisRoche(sex, ageMonths, heightCm, weightKg, fatherCm, motherCm) {
  const age = ageMonths / 12;
  if (!(KR_MIN_YEARS <= age && age <= KR_MAX_YEARS)) return null;
  const rows = DATA.kr[sex];
  const i = Math.min(bisectRight(rows.map((r) => r[0]), age) - 1, rows.length - 2);
  const a = rows[i], b = rows[i + 1];
  const f = (age - a[0]) / (b[0] - a[0]);
  const c = [1, 2, 3, 4].map((k) => a[k] + f * (b[k] - a[k]));
  const inches = c[0] + c[1] * heightCm / 2.54 + c[2] * weightKg * LB_PER_KG + c[3] * (fatherCm + motherCm) / 2 / 2.54;
  return inches * 2.54;
}

function bmiCategory(ref, p) {
  const [low, over, obese] = ref.bmiCuts;
  if (p < low) return "Untergewicht";
  if (p < over) return "normalgewichtig";
  if (p < obese) return "übergewichtig";
  return "adipös";
}

export function curves(sex, reference = "kiggs") {
  if (typeof reference !== "string" || !Object.hasOwn(REFERENCES, reference)) throw new InputError("Unbekannte Referenz.");
  return REFERENCES[reference].curves(sex === "male" ? 1 : 2);
}

const isNum = (v) => v !== null && v !== undefined;

export function assess({ sex, age_months, height_cm, weight_kg = null, bone_age_months = null, father_cm = null, mother_cm = null, reference = "kiggs" }) {
  if (sex !== "male" && sex !== "female") throw new InputError("Geschlecht fehlt.");
  const ref = typeof reference === "string" && Object.hasOwn(REFERENCES, reference) ? REFERENCES[reference] : undefined;
  if (!ref) throw new InputError("Unbekannte Referenz.");
  const s = sex === "male" ? 1 : 2;
  const adult = ref.adultMonths;
  if (!(MIN_MONTHS <= age_months && age_months <= adult)) throw new InputError(`Das Lebensalter muss zwischen 2 und ${adult / 12} Jahren liegen.`);
  if (!(60 <= height_cm && height_cm <= 230)) throw new InputError("Die Körpergröße muss zwischen 60 und 230 cm liegen.");
  if (isNum(weight_kg) && !(5 <= weight_kg && weight_kg <= 250)) throw new InputError("Das Gewicht muss zwischen 5 und 250 kg liegen.");
  for (const parent of [father_cm, mother_cm]) {
    if (isNum(parent) && !(120 <= parent && parent <= 230)) throw new InputError("Die Größe der Eltern muss zwischen 120 und 230 cm liegen.");
  }
  if (isNum(father_cm) !== isNum(mother_cm)) throw new InputError("Für die Zielgröße werden beide Elterngrößen benötigt.");
  if (isNum(bone_age_months) && !(0 <= bone_age_months && bone_age_months <= 300)) throw new InputError("Das Skelettalter muss zwischen 0 und 25 Jahren liegen.");

  const notes = [];
  const zChrono = ref.zscore("stature", s, age_months, height_cm);
  const result = {
    reference: { key: ref.key, label: ref.label, adult_age_years: adult / 12 },
    height_percentile: round(pct(zChrono), 1),
    adult_by_percentile_cm: round(ref.valueAt("stature", s, adult, zChrono), 1),
    track_chrono: ref.track(s, zChrono, age_months),
    by_bone_age: null,
    khamis_roche: null,
    weight: null,
    target: null,
    notes,
  };

  if (isNum(bone_age_months)) {
    if (bone_age_months < MIN_MONTHS) {
      notes.push("Skelettalter unter 2 Jahren: Die Hochrechnung nach Skelettalter ist hier nicht möglich.");
    } else {
      const adultAt = (ba) => {
        const z = ref.zscore("stature", s, Math.min(ba, adult), height_cm);
        return [z, ref.valueAt("stature", s, adult, z)];
      };
      const ba = Math.min(bone_age_months, adult);
      const [zBa, adultCm] = adultAt(ba);
      const low = adultAt(bone_age_months + BONE_AGE_ERROR_MONTHS)[1];
      const high = adultAt(Math.max(MIN_MONTHS, bone_age_months - BONE_AGE_ERROR_MONTHS))[1];
      result.by_bone_age = {
        adult_cm: round(adultCm, 1),
        low_cm: round(Math.min(low, adultCm), 1),
        high_cm: round(Math.max(high, adultCm), 1),
        height_percentile_at_bone_age: round(pct(zBa), 1),
        bone_age_years: round(bone_age_months / 12, 1),
        plot_age_years: round(ba / 12, 2),
        track: ref.track(s, zBa, ba),
      };
      if (pct(zBa) > 99 || pct(zBa) < 1) notes.push("Die Körpergröße liegt für das Skelettalter außerhalb des üblichen Bereichs (unter der 1. oder über der 99. Perzentile). Die Prognose nach Skelettalter ist dann unzuverlässig.");
      if (Math.abs(bone_age_months - age_months) > 24) notes.push("Das Skelettalter weicht mehr als 2 Jahre vom Lebensalter ab. Die Hochrechnung ist dann besonders unsicher, bitte ärztlich abklären lassen.");
      if (bone_age_months / 12 >= PUBERTY_BONE_AGE_YEARS[sex]) notes.push("Während der Pubertät sind Prognosen besonders unsicher. Fachleute empfehlen sie vor einem Skelettalter von 12 Jahren (Jungen) bzw. 10,5 Jahren (Mädchen).");
    }
  } else {
    notes.push("Ohne Skelettalter ist nur die Hochrechnung nach Lebensalter möglich, sie unterstellt eine durchschnittliche Reifung.");
  }

  if (isNum(weight_kg)) {
    const bmi = weight_kg / Math.pow(height_cm / 100, 2);
    const zW = ref.zscore("weight", s, age_months, weight_kg);
    const bmiPct = pct(ref.zscore("bmi", s, age_months, bmi));
    result.weight = { percentile: round(pct(zW), 1), bmi: round(bmi, 1), bmi_percentile: round(bmiPct, 1), category: bmiCategory(ref, bmiPct) };
    if (bmiPct >= ref.bmiCuts[1]) {
      notes.push("Der BMI ist erhöht. Bei Jungen ist ein höherer BMI im Kindesalter im Mittel mit einer etwas niedrigeren Endgröße verbunden (etwa 1,5 cm je Standardabweichung, bei Mädchen weniger), die Prognosen können daher zu hoch ausfallen. Eingerechnet wird das nicht, weil es sich in unabhängigen Überprüfungen nicht verlässlich bewährt hat.");
    } else if (bmiPct < ref.bmiCuts[0]) {
      notes.push("Der BMI ist niedrig. Untergewicht kann Wachstum und Skelettreife verzögern und die Prognose verfälschen.");
    }
  }

  if (isNum(father_cm)) {
    const mph = (father_cm + mother_cm + (sex === "male" ? 13 : -13)) / 2;
    result.target = {
      mid_parental_cm: round(mph, 1),
      low_cm: round(mph - TARGET_RANGE_CM, 1),
      high_cm: round(mph + TARGET_RANGE_CM, 1),
      percentile: round(pct(ref.zscore("stature", s, adult, mph)), 1),
    };
    if (isNum(weight_kg)) {
      const kr = khamisRoche(s, age_months, height_cm, weight_kg, father_cm, mother_cm);
      if (kr === null) notes.push("Das Verfahren nach Khamis und Roche gilt nur für Kinder von 4 bis 17,5 Jahren.");
      else result.khamis_roche = { adult_cm: round(kr, 1) };
    }
  }
  return result;
}
