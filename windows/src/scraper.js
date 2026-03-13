// ─── Manga URL Scraper ─────────────────────────────────────────────────────────
// Strategy inspired by Kotatsu's parser architecture:
//   - Site-specific parsers for known sites (hit internal APIs directly)
//   - JS-rendering support via Electron hidden BrowserWindow or iframe
//   - Proper headers: Chrome UA, Referer, cookies
//   - JSON extraction from embedded <script> tags

const IS_ELECTRON = typeof window !== "undefined" && !!window.electronAPI;

const CHROME_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

const CORS_PROXY = "https://api.allorigins.win/raw?url=";

// ─── Platform-aware plain fetch ────────────────────────────────────────────────
async function platformFetch(url, extraHeaders = {}) {
  const headers = { "User-Agent": CHROME_UA, ...extraHeaders };
  if (IS_ELECTRON) {
    const r = await window.electronAPI.fetch(url, headers);
    if (r.error) throw new Error(r.error);
    return r.text;
  }
  try {
    const r = await fetch(url, { headers });
    if (r.ok) return await r.text();
  } catch {}
  const r = await fetch(CORS_PROXY + encodeURIComponent(url));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}

// ─── Image fetch → base64 data URL ────────────────────────────────────────────
async function fetchImage(imgUrl, referer = "") {
  if (IS_ELECTRON) {
    const r = await window.electronAPI.fetchImage(imgUrl, referer);
    if (r.error) throw new Error(r.error);
    return r.dataUrl;
  }
  for (const u of [imgUrl, CORS_PROXY + encodeURIComponent(imgUrl)]) {
    try {
      const r = await fetch(u, referer ? { headers: { Referer: referer } } : {});
      if (!r.ok) continue;
      const blob = await r.blob();
      return await blobToDataUrl(blob);
    } catch {}
  }
  throw new Error(`Could not download: ${imgUrl}`);
}

const blobToDataUrl = b =>
  new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b);
  });

function getImageDimensions(dataUrl) {
  return new Promise(res => {
    const i = new Image();
    i.onload = () => res({ w: i.width, h: i.height });
    i.onerror = () => res({ w: 0, h: 0 });
    i.src = dataUrl;
  });
}

// ─── Electron hidden BrowserWindow JS scraping ────────────────────────────────
async function electronJSScrape(url, onLog) {
  onLog("🖥️  Launching headless browser for JS-rendered page…");
  const result = await window.electronAPI.jsScrape(url);
  if (result.error) throw new Error(result.error);
  onLog(`   ✅ JS page loaded — found ${result.imageUrls.length} image URLs`);
  return result.imageUrls;
}

// ─── Download image list → data URL array ─────────────────────────────────────
async function downloadImages(imageUrls, referer, onLog) {
  const dataUrls = [];
  let skipped = 0;
  for (let i = 0; i < imageUrls.length; i++) {
    onLog(`   ⬇️  ${i + 1}/${imageUrls.length}`);
    try {
      const dataUrl = await fetchImage(imageUrls[i], referer);
      const { w, h } = await getImageDimensions(dataUrl);
      if (w >= 200 && h >= 200) {
        dataUrls.push(dataUrl);
      } else { skipped++; }
    } catch (e) { skipped++; onLog(`   ⚠️  ${e.message}`); }
  }
  if (skipped > 0) onLog(`   ℹ️  ${skipped} image(s) skipped`);
  return dataUrls;
}

// ─── MangaDex ─────────────────────────────────────────────────────────────────
function extractMangaDexId(url) {
  const m = url.match(/mangadex\.org\/chapter\/([a-f0-9-]{36})/i);
  return m ? m[1] : null;
}

async function scrapeMangaDex(url, onLog) {
  const id = extractMangaDexId(url);
  if (!id) throw new Error("Could not extract MangaDex chapter ID.");
  onLog("📡 Fetching MangaDex API…");
  const res = await fetch(`https://api.mangadex.org/at-home/server/${id}`);
  if (!res.ok) throw new Error(`MangaDex API: HTTP ${res.status}`);
  const meta = await res.json();
  const urls = meta.chapter.data.map(p => `${meta.baseUrl}/data/${meta.chapter.hash}/${p}`);
  onLog(`📄 ${urls.length} pages`);
  return downloadImages(urls, "https://mangadex.org", onLog);
}

// ─── HappyMH ──────────────────────────────────────────────────────────────────
// happymh loads images via JavaScript — plain HTML returns nothing.
// We try 3 strategies:
//   1. Extract JSON from embedded <script> tags
//   2. Hit the internal API endpoint directly
//   3. Electron headless browser fallback
async function scrapeHappyMH(url, onLog) {
  onLog("📡 Fetching HappyMH chapter page…");

  const html = await platformFetch(url, {
    Referer: "https://m.happymh.com/",
    Cookie: "",
  });

  // Strategy 1 — JSON patterns in embedded scripts
  const jsonPatterns = [
    /window\.__DATA__\s*=\s*({[\s\S]+?});\s*(?:<\/|window|var )/,
    /"currentScans"\s*:\s*(\[[\s\S]+?\])\s*[,}]/,
    /"scans"\s*:\s*(\[[\s\S]+?\])\s*[,}]/,
    /"imgs"\s*:\s*(\[[\s\S]+?\])\s*[,}]/,
    /"images"\s*:\s*(\[[\s\S]+?\])\s*[,}]/,
    /var\s+chapterImages\s*=\s*(\[[\s\S]+?\]);/,
    /var\s+images\s*=\s*(\[[\s\S]+?\]);/,
    /"pageArr"\s*:\s*(\[[\s\S]+?\])/,
    /pageArr\s*=\s*(\[[\s\S]+?\]);/,
  ];

  for (const pat of jsonPatterns) {
    const m = html.match(pat);
    if (!m) continue;
    try {
      const data = JSON.parse(m[1]);
      const imgs = extractImageArray(data);
      if (imgs.length > 0) {
        onLog(`✅ Found ${imgs.length} images in embedded JS data`);
        return downloadImages(imgs, url, onLog);
      }
    } catch {}
  }

  // Strategy 2 — Internal API
  const readMatch = url.match(/mangaread\/([^/?#]+)\/([^/?#]+)/);
  if (readMatch) {
    const [, mangaSlug, chapterId] = readMatch;
    onLog(`🔌 Trying HappyMH internal API…`);
    const apiCandidates = [
      `https://m.happymh.com/apis/readerdetail?chapter_id=${chapterId}&manga_id=${mangaSlug}`,
      `https://m.happymh.com/apis/readerdetail?chapter_id=${chapterId}`,
      `https://m.happymh.com/apis/v2.0/readerdetail?chapter_id=${chapterId}`,
    ];
    for (const apiUrl of apiCandidates) {
      try {
        const json = await platformFetch(apiUrl, {
          Referer: url,
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json, text/plain, */*",
        });
        const data = JSON.parse(json);
        const imgs = extractImageArray(data);
        if (imgs.length > 0) {
          onLog(`✅ HappyMH API: ${imgs.length} images`);
          return downloadImages(imgs, url, onLog);
        }
      } catch {}
    }
  }

  // Strategy 3 — Electron headless browser
  if (IS_ELECTRON) {
    onLog("🖥️  Falling back to headless browser…");
    const imageUrls = await electronJSScrape(url, onLog);
    if (imageUrls.length > 0) return downloadImages(imageUrls, url, onLog);
  }

  throw new Error(
    "HappyMH loads images via JavaScript — plain HTTP can't see them.\n\n" +
    "✅ Windows app: headless browser will retry automatically\n" +
    "📱 Android: download the CBZ from another app and use the File tab"
  );
}

// ─── Webtoons ─────────────────────────────────────────────────────────────────
async function scrapeWebtoons(url, onLog) {
  onLog("📡 Fetching Webtoons episode…");
  const html = await platformFetch(url, {
    Referer: "https://www.webtoons.com/",
    Cookie: "needCCPA=false; needCOPPA=false; needGDPR=false",
  });
  const matches = [...html.matchAll(/data-url="([^"]+webtoons[^"]+)"/g)];
  const imageUrls = [...new Set(matches.map(m => m[1]))];
  if (imageUrls.length === 0) throw new Error("FALLBACK");
  onLog(`🖼  ${imageUrls.length} panels`);
  return downloadImages(imageUrls, "https://www.webtoons.com/", onLog);
}

// ─── CopyManga ────────────────────────────────────────────────────────────────
async function scrapeCopyManga(url, onLog) {
  onLog("📡 Fetching CopyManga chapter…");
  const html = await platformFetch(url, { Referer: "https://www.copymanga.site/" });
  const m =
    html.match(/"imageList"\s*:\s*(\[[\s\S]+?\])/) ||
    html.match(/imageList\s*=\s*(\[[\s\S]+?\]);/);
  if (m) {
    try {
      const imgs = JSON.parse(m[1]);
      const urls = imgs.map(i => (typeof i === "string" ? i : i.url || i.src || "")).filter(Boolean);
      if (urls.length > 0) {
        onLog(`✅ ${urls.length} images`);
        return downloadImages(urls, url, onLog);
      }
    } catch {}
  }
  throw new Error("FALLBACK");
}

// ─── Madara WordPress theme ───────────────────────────────────────────────────
async function scrapeMadara(url, onLog) {
  onLog("📡 Fetching Madara/WordPress chapter…");
  const html = await platformFetch(url, { Referer: new URL(url).origin + "/" });
  // Look for reading content section
  const m = html.match(/class="[^"]*(?:reading-content|container-chapter-reader|wp-manga-chapter)[^"]*"[^>]*>([\s\S]{100,}?)<\/div>/i);
  const section = m ? m[0] : html;
  const imageUrls = extractImageUrlsFromHtml(section, url);
  if (imageUrls.length === 0) throw new Error("FALLBACK");
  onLog(`🖼  ${imageUrls.length} images`);
  return downloadImages(imageUrls, url, onLog);
}

// ─── Generic fallback ─────────────────────────────────────────────────────────
async function scrapeGeneric(url, onLog) {
  onLog("🔍 Scanning page for images…");

  const html = await platformFetch(url, {
    Referer: new URL(url).origin + "/",
    Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
  });

  // Try extracting image arrays from embedded JS first
  for (const sm of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const pat of [
      /(?:images?|pages?|imgs?|scans?|picList|imgList|pageList)\s*[=:]\s*(\[["'][^"']+["'][^\]]*\])/gi,
      /"(?:images?|pages?|imgs?|scans?)"\s*:\s*(\[[\s\S]{10,1000}?\])/g,
    ]) {
      const m = sm[1].match(pat);
      if (m) {
        try {
          const rawJson = m[0].replace(/^[^[]*/, "");
          const parsed = JSON.parse(rawJson);
          const urls = parsed
            .map(i => (typeof i === "string" ? i : i.url || i.src || ""))
            .filter(u => u && /^https?:\/\/.+\.(jpg|jpeg|png|webp)/i.test(u));
          if (urls.length >= 2) {
            onLog(`📜 ${urls.length} images in embedded JS`);
            return downloadImages([...new Set(urls)], url, onLog);
          }
        } catch {}
      }
    }
  }

  // Fall back to HTML image extraction
  const imageUrls = extractImageUrlsFromHtml(html, url);
  onLog(`🖼  ${imageUrls.length} candidate images in HTML`);

  if (imageUrls.length === 0) {
    if (IS_ELECTRON) {
      onLog("⚠️  No images in HTML — trying headless browser…");
      try {
        const jsUrls = await electronJSScrape(url, onLog);
        if (jsUrls.length > 0) return downloadImages(jsUrls, url, onLog);
      } catch (e) { onLog(`   ⚠️  Headless failed: ${e.message}`); }
    }
    throw new Error(
      "No images found — this site loads images with JavaScript.\n\n" +
      "• Windows: headless browser was attempted above\n" +
      "• Android: save the chapter as a CBZ file and use the File tab"
    );
  }

  return downloadImages(imageUrls, url, onLog);
}

// ─── HTML image URL extractor ──────────────────────────────────────────────────
function extractImageUrlsFromHtml(html, pageUrl) {
  const candidates = new Set();
  for (const pat of [
    /\bsrc=["']([^"']+)["']/gi,
    /\bdata-src=["']([^"']+)["']/gi,
    /\bdata-original=["']([^"']+)["']/gi,
    /\bdata-url=["']([^"']+)["']/gi,
    /\bdata-lazy-src=["']([^"']+)["']/gi,
  ]) {
    for (const m of html.matchAll(pat)) candidates.add(m[1]);
  }
  for (const m of html.matchAll(/["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"'?#]*)["']/gi)) {
    candidates.add(m[1]);
  }
  return [...candidates]
    .filter(s => {
      if (!s || s.startsWith("data:")) return false;
      if (!/\.(jpg|jpeg|png|webp)/i.test(s.split("?")[0])) return false;
      if (/\b(?:logo|avatar|icon|favicon|banner|sprite|thumbnail|ad)\b/i.test(s)) return false;
      return true;
    })
    .map(s => { try { return new URL(s, pageUrl).href; } catch { return s; } })
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
}

// ─── Recursive image URL extractor from parsed JSON ───────────────────────────
function extractImageArray(data, depth = 0) {
  if (depth > 5) return [];
  if (Array.isArray(data)) {
    const urls = data
      .map(i => {
        if (typeof i === "string" && /^https?:\/\/.+\.(jpg|jpeg|png|webp)/i.test(i)) return i;
        if (typeof i === "object" && i) {
          for (const k of ["url", "src", "img", "path", "image", "file", "src2"]) {
            if (typeof i[k] === "string" && /^https?:\/\//.test(i[k])) return i[k];
          }
        }
        return null;
      })
      .filter(Boolean);
    if (urls.length > 0) return urls;
    for (const item of data) {
      if (typeof item === "object" && item) {
        const r = extractImageArray(item, depth + 1);
        if (r.length > 0) return r;
      }
    }
  }
  if (typeof data === "object" && data) {
    for (const k of ["images", "imgs", "pages", "scans", "picList", "imgList", "pageArr", "data", "result", "chapter"]) {
      if (data[k]) { const r = extractImageArray(data[k], depth + 1); if (r.length > 0) return r; }
    }
    for (const v of Object.values(data)) {
      if (typeof v === "object" && v) { const r = extractImageArray(v, depth + 1); if (r.length > 0) return r; }
    }
  }
  return [];
}

// ─── Main entry point ─────────────────────────────────────────────────────────
export async function scrapeURL(url, onLog) {
  const trimmed = url.trim();
  let parsed;
  try { parsed = new URL(trimmed); } catch { throw new Error("Invalid URL — must start with https://"); }

  const host = parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
  onLog(`🌐 Connecting to ${host}…`);

  if (host.includes("mangadex.org"))                               return scrapeMangaDex(trimmed, onLog);
  if (host.includes("happymh.com"))                                return scrapeHappyMH(trimmed, onLog);
  if (host.includes("webtoons.com"))                               return scrapeWebtoons(trimmed, onLog);
  if (host.includes("copymanga") || host.includes("copy-manga"))   return scrapeCopyManga(trimmed, onLog);

  // Madara WordPress theme (hundreds of sites use this)
  const isMadara =
    host.includes("toonily.") || host.includes("manganato.") ||
    host.includes("mangakakalot.") || host.includes("chapmanganato.") ||
    host.includes("manhuafast.") || host.includes("manhuaplus.");
  if (isMadara) {
    try { return await scrapeMadara(trimmed, onLog); }
    catch (e) { if (e.message !== "FALLBACK") throw e; }
  }

  return scrapeGeneric(trimmed, onLog);
}

export const SUPPORTED_SITES = [
  { name: "MangaDex",       support: "full",    note: "Full API — best quality, no limits" },
  { name: "HappyMH",        support: "full",    note: "Internal API + headless browser fallback" },
  { name: "Webtoons",       support: "good",    note: "Direct image extraction" },
  { name: "CopyManga",      support: "good",    note: "Embedded JS data extraction" },
  { name: "Madara sites",   support: "good",    note: "Toonily, Manganato, Manhuafast, etc." },
  { name: "Any site",       support: "generic", note: "Auto extraction + headless browser on Windows" },
];
