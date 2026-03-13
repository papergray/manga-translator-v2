// ─── On-Device Translation Engine ─────────────────────────────────────────────
// Uses Tesseract.js for OCR (bounding boxes) + Transformers.js for translation
// Everything runs on the phone — no internet needed after first model download

// Language packs for Tesseract OCR
// Maps detected script → tesseract lang code + opus-mt model
const LANG_CONFIGS = {
  chi_sim: { label: "Chinese (Simplified)", tesseract: "chi_sim", model: "Xenova/opus-mt-zh-en" },
  chi_tra: { label: "Chinese (Traditional)", tesseract: "chi_tra", model: "Xenova/opus-mt-zh-en" },
  jpn:     { label: "Japanese",              tesseract: "jpn",     model: "Xenova/opus-mt-ja-en" },
  kor:     { label: "Korean",                tesseract: "kor",     model: "Xenova/opus-mt-ko-en" },
};

// Memory tier → controls resolution + whether to keep model cached
export const MEMORY_TIERS = {
  low:    { label: "Low (150MB)",    maxRes: 512,  keepCached: false, description: "Slower, less RAM" },
  medium: { label: "Medium (300MB)", maxRes: 768,  keepCached: true,  description: "Recommended" },
  high:   { label: "High (500MB)",   maxRes: 1024, keepCached: true,  description: "Faster, more RAM" },
};

let _tesseractWorker = null;
let _translationPipeline = null;
let _loadedModel = null;
let _memoryTier = "medium";

export function setMemoryTier(tier) {
  _memoryTier = tier;
}

// Dynamically import to avoid loading on startup
async function getTesseract() {
  if (!window._Tesseract) {
    const mod = await import("tesseract.js");
    window._Tesseract = mod;
  }
  return window._Tesseract;
}

async function getTransformers() {
  if (!window._Transformers) {
    const mod = await import("@xenova/transformers");
    window._Transformers = mod;
  }
  return window._Transformers;
}

// Resize image data URL to max dimension
function resizeDataUrl(dataUrl, maxDim) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      res({ dataUrl: canvas.toDataURL("image/jpeg", 0.85), w, h, origW: img.width, origH: img.height });
    };
    img.src = dataUrl;
  });
}

// Group Tesseract word boxes into bubble regions using proximity clustering
function clusterBoxes(words, imgW, imgH) {
  if (!words.length) return [];

  // Filter low-confidence and very small results
  const valid = words.filter(w =>
    w.confidence > 40 &&
    w.bbox.x1 >= 0 && w.bbox.y1 >= 0 &&
    w.text.trim().length > 0
  );
  if (!valid.length) return [];

  // Merge words that are on the same line and close together
  const GAP = Math.max(imgW, imgH) * 0.04; // 4% of larger dimension
  const clusters = [];

  for (const word of valid) {
    const box = word.bbox; // {x0, y0, x1, y1}
    let merged = false;
    for (const cluster of clusters) {
      const cx = cluster.bbox;
      // Check vertical overlap and horizontal proximity
      const vertOverlap = box.y0 < cx.y1 + GAP && box.y1 > cx.y0 - GAP;
      const horizClose  = box.x0 < cx.x1 + GAP && box.x1 > cx.x0 - GAP;
      if (vertOverlap && horizClose) {
        cluster.bbox.x0 = Math.min(cx.x0, box.x0);
        cluster.bbox.y0 = Math.min(cx.y0, box.y0);
        cluster.bbox.x1 = Math.max(cx.x1, box.x1);
        cluster.bbox.y1 = Math.max(cx.y1, box.y1);
        cluster.text += " " + word.text;
        cluster.conf = Math.min(cluster.conf, word.confidence);
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusters.push({
        bbox: { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 },
        text: word.text,
        conf: word.confidence,
      });
    }
  }

  // Convert to fractional coordinates
  return clusters
    .filter(c => c.conf > 35 && c.text.trim().length > 1)
    .map(c => {
      const PAD = 0.008;
      return {
        x1: Math.max(0, c.bbox.x0 / imgW - PAD),
        y1: Math.max(0, c.bbox.y0 / imgH - PAD),
        x2: Math.min(1, c.bbox.x1 / imgW + PAD),
        y2: Math.min(1, c.bbox.y1 / imgH + PAD),
        sourceText: c.text.trim(),
      };
    });
}

// Detect which language is most likely on the page
async function detectLanguage(dataUrl, onLog) {
  const Tesseract = await getTesseract();
  const tier = MEMORY_TIERS[_memoryTier];
  const { dataUrl: resized, w, h } = await resizeDataUrl(dataUrl, tier.maxRes);

  // Quick pass with each CJK lang, pick highest average confidence
  const scores = {};
  for (const [key, cfg] of Object.entries(LANG_CONFIGS)) {
    try {
      const result = await Tesseract.recognize(resized, cfg.tesseract, { errorHandler: () => {} });
      const words = result.data.words || [];
      const goodWords = words.filter(w => w.confidence > 50);
      scores[key] = goodWords.length > 0
        ? goodWords.reduce((s, w) => s + w.confidence, 0) / goodWords.length
        : 0;
    } catch { scores[key] = 0; }
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  onLog && onLog(`   🔍 Detected language: ${LANG_CONFIGS[best[0]]?.label} (${Math.round(best[1])}% confidence)`);
  return best[0]; // returns key like "chi_sim"
}

// Full OCR pass — returns word boxes
async function ocrPage(dataUrl, langKey) {
  const Tesseract = await getTesseract();
  const tier = MEMORY_TIERS[_memoryTier];
  const { dataUrl: resized, w, h } = await resizeDataUrl(dataUrl, tier.maxRes);

  if (_tesseractWorker && _tesseractWorker._lang !== langKey) {
    await _tesseractWorker.terminate();
    _tesseractWorker = null;
  }

  if (!_tesseractWorker) {
    _tesseractWorker = await Tesseract.createWorker(LANG_CONFIGS[langKey].tesseract);
    _tesseractWorker._lang = langKey;
  }

  const result = await _tesseractWorker.recognize(resized);
  const words = result.data.words || [];
  return { words, imgW: w, imgH: h };
}

// Load or reuse translation pipeline
async function getTranslator(modelName, onProgress) {
  const Transformers = await getTransformers();
  const { pipeline, env } = Transformers;

  // Allow loading from HuggingFace Hub (cached in IndexedDB)
  env.allowLocalModels = false;
  env.useBrowserCache = true;

  if (_translationPipeline && _loadedModel === modelName) {
    return _translationPipeline;
  }

  // Unload previous model if memory is tight
  if (_translationPipeline && _loadedModel !== modelName) {
    _translationPipeline = null;
    _loadedModel = null;
  }

  _translationPipeline = await pipeline("translation", modelName, {
    quantized: true, // Use INT8 quantized model — ~4x smaller
    progress_callback: info => {
      if (info.status === "downloading" && info.total > 0) {
        const pct = Math.round((info.loaded / info.total) * 100);
        onProgress && onProgress(`   📥 Downloading model: ${pct}% (${Math.round(info.loaded / 1e6)}MB / ${Math.round(info.total / 1e6)}MB)`);
      }
      if (info.status === "loading") onProgress && onProgress("   ⚙️ Loading model into memory…");
    },
  });
  _loadedModel = modelName;
  return _translationPipeline;
}

// Main on-device translate function
// Returns { bubbles } same format as API calls
export async function translatePageOnDevice(dataUrl, detectedLangKey, targetLang, onLog, onProgress) {
  const tier = MEMORY_TIERS[_memoryTier];

  // Step 1: OCR
  onLog("   🔬 Running OCR…");
  const { words, imgW, imgH } = await ocrPage(dataUrl, detectedLangKey);
  const clusters = clusterBoxes(words, imgW, imgH);
  onLog(`   📝 Found ${clusters.length} text region${clusters.length !== 1 ? "s" : ""}`);

  if (!clusters.length) return { bubbles: [] };

  // Step 2: Load translation model
  const modelName = LANG_CONFIGS[detectedLangKey].model;
  onLog(`   🤖 Loading translator (${modelName})…`);
  const translator = await getTranslator(modelName, msg => onLog(msg));

  // Step 3: Translate each cluster
  const bubbles = [];
  for (const cluster of clusters) {
    try {
      // Transformers.js translation
      const result = await translator(cluster.sourceText, {
        src_lang: detectedLangKey === "jpn" ? "ja" : detectedLangKey === "kor" ? "ko" : "zh",
        tgt_lang: targetLang === "English" ? "en" : targetLang.slice(0, 2).toLowerCase(),
      });
      const translated = result[0]?.translation_text || cluster.sourceText;
      bubbles.push({
        x1: cluster.x1, y1: cluster.y1,
        x2: cluster.x2, y2: cluster.y2,
        translated,
        font_size_frac: Math.min(0.06, (cluster.y2 - cluster.y1) * 0.5),
        bg: "white", align: "center", style: "speech", dark_bg: false,
      });
    } catch (e) {
      // Skip failed translations
    }
  }

  // Free memory if low tier
  if (!tier.keepCached) {
    _translationPipeline = null;
    _loadedModel = null;
  }

  return { bubbles };
}

export async function cleanupOnDevice() {
  if (_tesseractWorker) {
    await _tesseractWorker.terminate().catch(() => {});
    _tesseractWorker = null;
  }
  _translationPipeline = null;
  _loadedModel = null;
}
