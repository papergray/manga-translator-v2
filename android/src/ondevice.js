// ─── On-Device Translation Engine ──────────────────────────────────────────
// OCR:         Tesseract.js  (chi_sim / chi_tra / jpn / kor)
// Translation: Transformers.js + NLLB-200-distilled-600M
//              (Meta's multilingual model — 200 languages, much better than opus-mt)
//
// NLLB-200 source: https://huggingface.co/Xenova/nllb-200-distilled-600M

export const NLLB_MODEL = "Xenova/nllb-200-distilled-600M";

// NLLB language codes for source scripts
const NLLB_SRC = {
  chi_sim: "zho_Hans",
  chi_tra: "zho_Hant",
  jpn:     "jpn_Jpan",
  kor:     "kor_Hang",
};

// NLLB target languages (covers all 15 UI options)
export const NLLB_TARGETS = {
  "English":    "eng_Latn",
  "Spanish":    "spa_Latn",
  "French":     "fra_Latn",
  "German":     "deu_Latn",
  "Portuguese": "por_Latn",
  "Italian":    "ita_Latn",
  "Russian":    "rus_Cyrl",
  "Arabic":     "arb_Arab",
  "Hindi":      "hin_Deva",
  "Indonesian": "ind_Latn",
  "Thai":       "tha_Thai",
  "Vietnamese": "vie_Latn",
  "Turkish":    "tur_Latn",
  "Polish":     "pol_Latn",
  "Dutch":      "nld_Latn",
};

export const MEMORY_TIERS = {
  low:    { label: "Low (~400MB)",    maxRes: 512,  keepCached: false, description: "Slower, uses less RAM" },
  medium: { label: "Medium (~700MB)", maxRes: 768,  keepCached: true,  description: "Recommended" },
  high:   { label: "High (~1.2GB)",   maxRes: 1024, keepCached: true,  description: "Fastest, more RAM needed" },
};

// Approximate size of all model files
export const MODEL_SIZE_MB = 650;

let _tesseractWorker = null;
let _translationPipeline = null;
let _memoryTier = "medium";

export function setMemoryTier(tier) { _memoryTier = tier; }

async function getTesseract() {
  if (!window._Tesseract) window._Tesseract = await import("tesseract.js");
  return window._Tesseract;
}
async function getTransformers() {
  if (!window._Transformers) window._Transformers = await import("@xenova/transformers");
  return window._Transformers;
}

// ─── Pre-download: cache all model files before first use ─────────────────────
// onProgress(pct: 0-100, message: string)
export async function preDownloadModels(langs, onProgress) {
  langs = langs || ["chi_sim"];
  const Transformers = await getTransformers();
  const { pipeline, env } = Transformers;
  env.allowLocalModels = false;
  env.useBrowserCache = true;

  onProgress(1, "Connecting to HuggingFace Hub…");

  const fileProgress = {};
  const trackProgress = info => {
    if (info.status === "downloading" && info.total > 0) {
      fileProgress[info.file] = { loaded: info.loaded, total: info.total };
      const loaded = Object.values(fileProgress).reduce((s, f) => s + f.loaded, 0);
      const total  = Object.values(fileProgress).reduce((s, f) => s + f.total, 0);
      const pct    = total > 0 ? Math.min(94, Math.round((loaded / total) * 94)) : 1;
      onProgress(pct, `Downloading NLLB-200 model… ${Math.round(loaded/1e6)}MB / ${Math.round(total/1e6)}MB`);
    }
    if (info.status === "loading") onProgress(95, "Loading model into memory…");
    if (info.status === "ready")   onProgress(97, "Model loaded!");
  };

  try {
    _translationPipeline = await pipeline("translation", NLLB_MODEL, {
      quantized: true,
      progress_callback: trackProgress,
    });
  } catch (e) {
    throw new Error("Model download failed: " + e.message);
  }

  // Pre-warm Tesseract language packs
  const Tesseract = await getTesseract();
  const tesseractLangs = { chi_sim: "chi_sim", chi_tra: "chi_tra", jpn: "jpn", kor: "kor" };
  for (const langKey of langs) {
    const tl = tesseractLangs[langKey] || "chi_sim";
    onProgress(97, `Downloading OCR data (${tl})…`);
    try {
      const w = await Tesseract.createWorker(tl);
      await w.terminate();
    } catch {}
  }

  onProgress(100, "All models ready — you can now translate offline!");
  localStorage.setItem("mt_models_downloaded", "true");
  localStorage.setItem("mt_models_ts", Date.now().toString());
}

export function areModelsDownloaded() {
  return localStorage.getItem("mt_models_downloaded") === "true";
}

// ─── Resize ───────────────────────────────────────────────────────────────────
function resizeDataUrl(dataUrl, maxDim) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      res({ dataUrl: c.toDataURL("image/jpeg", 0.85), w, h });
    };
    img.src = dataUrl;
  });
}

// ─── Cluster word boxes into speech-bubble regions ────────────────────────────
function clusterBoxes(words, imgW, imgH) {
  const valid = words.filter(w =>
    w.confidence > 40 && w.bbox.x1 >= 0 && w.bbox.y1 >= 0 && w.text.trim().length > 0
  );
  if (!valid.length) return [];
  const GAP = Math.max(imgW, imgH) * 0.04;
  const clusters = [];
  for (const word of valid) {
    const box = word.bbox;
    let merged = false;
    for (const cl of clusters) {
      const cx = cl.bbox;
      if (box.y0 < cx.y1 + GAP && box.y1 > cx.y0 - GAP &&
          box.x0 < cx.x1 + GAP && box.x1 > cx.x0 - GAP) {
        cx.x0 = Math.min(cx.x0, box.x0); cx.y0 = Math.min(cx.y0, box.y0);
        cx.x1 = Math.max(cx.x1, box.x1); cx.y1 = Math.max(cx.y1, box.y1);
        cl.text += " " + word.text;
        cl.conf = Math.min(cl.conf, word.confidence);
        merged = true; break;
      }
    }
    if (!merged) clusters.push({
      bbox: { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 },
      text: word.text, conf: word.confidence,
    });
  }
  const PAD = 0.008;
  return clusters
    .filter(c => c.conf > 35 && c.text.trim().length > 1)
    .map(c => ({
      x1: Math.max(0, c.bbox.x0/imgW - PAD), y1: Math.max(0, c.bbox.y0/imgH - PAD),
      x2: Math.min(1, c.bbox.x1/imgW + PAD), y2: Math.min(1, c.bbox.y1/imgH + PAD),
      sourceText: c.text.trim(),
    }));
}

// ─── OCR ─────────────────────────────────────────────────────────────────────
async function ocrPage(dataUrl, langKey) {
  const Tesseract = await getTesseract();
  const tier = MEMORY_TIERS[_memoryTier];
  const { dataUrl: resized, w, h } = await resizeDataUrl(dataUrl, tier.maxRes);
  if (_tesseractWorker && _tesseractWorker._lang !== langKey) {
    await _tesseractWorker.terminate();
    _tesseractWorker = null;
  }
  if (!_tesseractWorker) {
    _tesseractWorker = await Tesseract.createWorker(langKey);
    _tesseractWorker._lang = langKey;
  }
  const result = await _tesseractWorker.recognize(resized);
  return { words: result.data.words || [], imgW: w, imgH: h };
}

// ─── Load NLLB-200 pipeline ───────────────────────────────────────────────────
async function getTranslator(onLog) {
  if (_translationPipeline) return _translationPipeline;
  const Transformers = await getTransformers();
  const { pipeline, env } = Transformers;
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  const fileProgress = {};
  _translationPipeline = await pipeline("translation", NLLB_MODEL, {
    quantized: true,
    progress_callback: info => {
      if (info.status === "downloading" && info.total > 0) {
        fileProgress[info.file] = { loaded: info.loaded, total: info.total };
        const loaded = Object.values(fileProgress).reduce((s, f) => s + f.loaded, 0);
        const total  = Object.values(fileProgress).reduce((s, f) => s + f.total, 0);
        const pct = total > 0 ? Math.round((loaded/total)*100) : 0;
        onLog && onLog(`   📥 Downloading NLLB-200: ${pct}% (${Math.round(loaded/1e6)}MB / ${Math.round(total/1e6)}MB)`);
      }
      if (info.status === "loading") onLog && onLog("   ⚙️  Loading NLLB-200 into memory…");
    },
  });
  return _translationPipeline;
}

// ─── Main translate function ──────────────────────────────────────────────────
export async function translatePageOnDevice(dataUrl, langKey, targetLang, onLog, onProgress) {
  onLog("   🔬 Running OCR…");
  const { words, imgW, imgH } = await ocrPage(dataUrl, langKey);
  const clusters = clusterBoxes(words, imgW, imgH);
  onLog(`   📝 ${clusters.length} text region${clusters.length !== 1 ? "s" : ""}`);
  if (!clusters.length) return { bubbles: [] };

  onLog("   🤖 Loading NLLB-200…");
  const translator = await getTranslator(onLog);

  const srcLang = NLLB_SRC[langKey] || "zho_Hans";
  const tgtLang = NLLB_TARGETS[targetLang] || "eng_Latn";
  const texts = clusters.map(c => c.sourceText);

  let translations = [];
  try {
    // Batch translate — more efficient than one at a time
    const results = await translator(texts, {
      src_lang: srcLang, tgt_lang: tgtLang, max_new_tokens: 256,
    });
    translations = results.map(r => r.translation_text || "");
  } catch {
    // Individual fallback
    for (const cluster of clusters) {
      try {
        const r = await translator(cluster.sourceText, {
          src_lang: srcLang, tgt_lang: tgtLang, max_new_tokens: 128,
        });
        translations.push(r[0]?.translation_text || cluster.sourceText);
      } catch { translations.push(cluster.sourceText); }
    }
  }

  const bubbles = clusters.map((c, i) => ({
    x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2,
    translated: translations[i] || c.sourceText,
    font_size_frac: Math.min(0.06, (c.y2 - c.y1) * 0.5),
    bg: "white", align: "center", style: "speech", dark_bg: false,
  }));

  if (!MEMORY_TIERS[_memoryTier].keepCached) _translationPipeline = null;
  return { bubbles };
}

export async function cleanupOnDevice() {
  if (_tesseractWorker) {
    await _tesseractWorker.terminate().catch(() => {});
    _tesseractWorker = null;
  }
  if (!MEMORY_TIERS[_memoryTier].keepCached) _translationPipeline = null;
}
