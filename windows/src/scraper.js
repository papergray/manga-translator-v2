// ─── Manga URL Scraper ──────────────────────────────────────────────────────
const IS_ELECTRON = typeof window !== "undefined" && !!window.electronAPI;

const CHROME_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

// Multiple CORS proxies — rotate on failure
const CORS_PROXIES = [
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?",
  "https://api.codetabs.com/v1/proxy?quest=",
];

// ─── LZString loader (for ManhuaGui) ────────────────────────────────────────
let _lzString = null;
async function getLZString() {
  if (_lzString) return _lzString;
  if (typeof window !== "undefined" && window.LZString) {
    _lzString = window.LZString; return _lzString;
  }
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/lz-string/1.5.0/lz-string.min.js";
    s.onload = () => { _lzString = window.LZString; res(_lzString); };
    s.onerror = () => rej(new Error("Failed to load LZString"));
    document.head.appendChild(s);
  });
}

// ─── Platform-aware fetch (fix #2 #3: retry proxy on non-ok, multiple proxies) ─
async function platformFetch(url, extraHeaders = {}) {
  const headers = { "User-Agent": CHROME_UA, ...extraHeaders };

  if (IS_ELECTRON) {
    const r = await window.electronAPI.fetch(url, headers);
    if (r.error) throw new Error(r.error);
    return r.text;
  }

  // Try direct fetch first
  try {
    const r = await fetch(url, { headers });
    if (r.ok) return await r.text();
    // Non-ok → fall through to proxy (don't silently succeed with 403 page)
  } catch {}

  // Try each CORS proxy in order
  for (const proxy of CORS_PROXIES) {
    try {
      const r = await fetch(proxy + encodeURIComponent(url));
      if (r.ok) {
        const text = await r.text();
        // Some proxies wrap errors in JSON — check for that
        if (text.startsWith("{") && text.includes("error")) {
          try { const j = JSON.parse(text); if (j.error) continue; } catch {}
        }
        return text;
      }
    } catch {}
  }
  throw new Error(`Could not fetch ${new URL(url).hostname} (all proxies failed)`);
}

// ─── Image fetch → base64 data URL ──────────────────────────────────────────
async function fetchImage(imgUrl, referer = "") {
  if (IS_ELECTRON) {
    const r = await window.electronAPI.fetchImage(imgUrl, referer);
    if (r.error) throw new Error(r.error);
    return r.dataUrl;
  }
  // Try direct fetch, then each proxy
  const attempts = [
    () => fetch(imgUrl, referer ? { headers: { Referer: referer } } : {}),
    ...CORS_PROXIES.map(p => () => fetch(p + encodeURIComponent(imgUrl))),
  ];
  for (const attempt of attempts) {
    try {
      const r = await attempt();
      if (!r.ok) continue;
      const blob = await r.blob();
      return await blobToDataUrl(blob);
    } catch {}
  }
  throw new Error(`Could not download: ${imgUrl}`);
}

const blobToDataUrl = b => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = rej;
  r.readAsDataURL(b);
});

function getImageDimensions(dataUrl) {
  return new Promise(res => {
    const i = new Image();
    i.onload = () => res({ w: i.width, h: i.height });
    i.onerror = () => res({ w: 0, h: 0 });
    i.src = dataUrl;
  });
}

// ─── Headless Chrome (Electron only) ────────────────────────────────────────
async function electronBrowserScrape(url, onLog) {
  onLog("🖥️  Launching headless Chrome browser…");
  const result = await window.electronAPI.jsScrape(url);
  if (result.error) throw new Error(result.error);
  onLog(`   ✅ Found ${result.imageUrls.length} images`);
  return result.imageUrls;
}

// ─── Download image list → data URL array ────────────────────────────────────
// Fix #5: guard onLog against null
async function downloadImages(imageUrls, referer, onLog) {
  const log = onLog || (() => {});
  const dataUrls = [];
  let skipped = 0;
  for (let i = 0; i < imageUrls.length; i++) {
    log(`   ⬇️  ${i + 1}/${imageUrls.length}`);
    try {
      const dataUrl = await fetchImage(imageUrls[i], referer);
      const { w, h } = await getImageDimensions(dataUrl);
      if (w >= 100 && h >= 100) { dataUrls.push(dataUrl); }
      else { skipped++; }
    } catch (e) { skipped++; log(`   ⚠️  ${e.message}`); }
  }
  if (skipped > 0) log(`   ℹ️  ${skipped} image(s) skipped`);
  return dataUrls;
}

// ─── Bot-block detection ─────────────────────────────────────────────────────
// Fix #7: don't treat short responses as bot-blocked (could be short JSON/redirects)
function isBotBlock(html) {
  if (!html) return true;
  // Only trigger on unmistakeable CF/DDoS-guard pages, not short responses
  return (
    html.includes("cf-browser-verification") ||
    html.includes("cdn-cgi/challenge-platform") ||
    html.includes("_cf_chl_opt") ||
    html.includes("ddos-guard") ||
    html.includes("DDoS-GUARD") ||
    html.includes("Enable JavaScript and cookies to continue") ||
    (html.includes("Just a moment...") && html.includes("cloudflare")) ||
    (html.includes("Checking if the site connection is secure") && html.includes("cloudflare"))
  );
}

// ─── Image URL extraction (fix #1: was mutating combined while iterating) ────
function extractImageUrlsFromHtml(html, pageUrl) {
  // Single-pass: collect all candidates with their position, then deduplicate
  const candidates = [];

  // Attribute patterns in document order
  const attrPatterns = [
    /\bdata-src=["']([^"']{3,}?)["']/gi,
    /\bdata-original=["']([^"']{3,}?)["']/gi,
    /\bdata-url=["']([^"']{3,}?)["']/gi,
    /\bdata-lazy-src=["']([^"']{3,}?)["']/gi,
    /\bdata-cfsrc=["']([^"']{3,}?)["']/gi,
    /\bsrc=["']([^"']{3,}?)["']/gi,
  ];
  for (const pat of attrPatterns) {
    for (const m of html.matchAll(pat)) {
      candidates.push({ idx: m.index, url: m[1] });
    }
  }
  // Bare image URLs in JS/JSON (protocol-relative and absolute)
  for (const m of html.matchAll(/["'`]((?:https?:)?\/\/[^"'`<>\s]{10,}?\.(?:jpg|jpeg|png|webp)(?:[^"'`<>\s]*?))["'`]/gi)) {
    candidates.push({ idx: m.index, url: m[1] });
  }

  // Sort by document position, resolve, deduplicate
  candidates.sort((a, b) => a.idx - b.idx);
  const results = [];
  const seen = new Set();
  for (let { url } of candidates) {
    if (!url || url.startsWith("data:")) continue;
    if (url.startsWith("//")) url = "https:" + url;
    // Must have image extension before any query string
    if (!/\.(jpg|jpeg|png|webp)(\?|$)/i.test(url.split("#")[0])) continue;
    if (/\b(?:logo|avatar|icon|favicon|banner|sprite|1x1|blank|placeholder|loading)\b/i.test(url)) continue;
    try {
      const abs = new URL(url, pageUrl).href;
      if (!seen.has(abs)) { seen.add(abs); results.push(abs); }
    } catch {
      if (!seen.has(url)) { seen.add(url); results.push(url); }
    }
  }
  return results;
}

// ─── Extract image array from arbitrary JSON ─────────────────────────────────
function extractImageArray(data, depth = 0) {
  if (depth > 6 || !data) return [];
  if (Array.isArray(data)) {
    const urls = data.map(i => {
      if (typeof i === "string" && /^https?:\/\/.+\.(jpg|jpeg|png|webp)/i.test(i)) return i;
      if (typeof i === "object" && i) {
        for (const k of ["url", "src", "img", "path", "image", "file", "src2", "u", "b2key"]) {
          if (typeof i[k] === "string" && /^https?:\/\//.test(i[k])) return i[k];
        }
      }
      return null;
    }).filter(Boolean);
    if (urls.length > 0) return urls;
    for (const item of data) {
      if (typeof item === "object" && item) {
        const r = extractImageArray(item, depth + 1);
        if (r.length > 0) return r;
      }
    }
  }
  if (typeof data === "object") {
    for (const k of ["images", "imgs", "pages", "scans", "picList", "imgList",
                     "pageArr", "md_images", "data", "result", "chapter", "chapterImages"]) {
      if (data[k]) { const r = extractImageArray(data[k], depth + 1); if (r.length > 0) return r; }
    }
    for (const v of Object.values(data)) {
      if (typeof v === "object" && v) {
        const r = extractImageArray(v, depth + 1);
        if (r.length > 0) return r;
      }
    }
  }
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════
// SITE PARSERS
// ═══════════════════════════════════════════════════════════════════════════

// ─── ManhuaGui (漫画柜) ───────────────────────────────────────────────────────
async function buildManhuaGuiUrls(jsonStr, onLog) {
  const data = JSON.parse(jsonStr);
  const { host, path, files, sl } = data;
  if (!files?.length) throw new Error("ManhuaGui: no files in imgData.");
  const suffix = sl ? `?e=${sl.e}&m=${sl.m}` : "";
  const urls = files.map(f => `${host}${path}${f}${suffix}`);
  onLog(`✅ ${urls.length} pages`);
  return downloadImages(urls, "https://www.manhuagui.com/", onLog);
}

async function scrapeManhuaGui(url, onLog) {
  onLog("📡 Fetching ManhuaGui chapter…");
  const html = await platformFetch(url, {
    Referer: "https://www.manhuagui.com/",
    Cookie: "isAdult=1",
  });
  if (isBotBlock(html)) {
    if (IS_ELECTRON) return downloadImages(await electronBrowserScrape(url, onLog), url, onLog);
    throw new Error("NEEDS_CF_BYPASS:" + url);
  }
  // LZString-encoded imgData
  const lzMatch = html.match(/(?:window\["eval"\]|window\['eval'\]|eval)\s*\(\s*LZString\.decompressFromBase64\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)/);
  if (lzMatch) {
    onLog("🔓 Decoding LZString chapter data…");
    const LZString = await getLZString();
    const decompressed = LZString.decompressFromBase64(lzMatch[1]);
    const m = decompressed.match(/SMH\.imgData\((\{[\s\S]+?\})\)/);
    if (m) return buildManhuaGuiUrls(m[1], onLog);
  }
  // Plain imgData fallback
  const plain = html.match(/SMH\.imgData\((\{[\s\S]+?\})\)/);
  if (plain) return buildManhuaGuiUrls(plain[1], onLog);
  if (IS_ELECTRON) return downloadImages(await electronBrowserScrape(url, onLog), url, onLog);
  throw new Error("ManhuaGui: could not decode image data. Chapter may require login.");
}

// ─── DM5 (动漫屋) ─────────────────────────────────────────────────────────────
async function scrapeDM5(url, onLog) {
  if (IS_ELECTRON) {
    onLog("🖥️  DM5 requires JS execution — using headless Chrome…");
    return downloadImages(await electronBrowserScrape(url, onLog), url, onLog);
  }
  onLog("📡 Fetching DM5 chapter…");
  const html = await platformFetch(url, {
    Cookie: "isAdult=1; fastshow=true",
    Referer: "https://www.dm5.com/",
  });
  if (!isBotBlock(html)) {
    const imgs = extractImageUrlsFromHtml(html, url);
    if (imgs.length > 0) return downloadImages(imgs, url, onLog);
  }
  throw new Error("DM5 requires JavaScript to load images.\n💡 Use the Windows app, or download the chapter and use the File tab.");
}

// ─── DMZJ (动漫之家) ──────────────────────────────────────────────────────────
async function scrapeDMZJ(url, onLog) {
  onLog("📡 Fetching DMZJ chapter…");
  const html = await platformFetch(url, { Referer: "https://m.dmzj.com/" });
  if (!isBotBlock(html)) {
    for (const pat of [
      /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]+?)<\/script>/,
      /window\.__NUXT__\s*=\s*(\{[\s\S]+?\});\s*<\/script>/,
    ]) {
      const m = html.match(pat);
      if (m) {
        try {
          const data = JSON.parse(m[1]);
          const imgs = extractImageArray(data);
          if (imgs.length > 0) { onLog(`✅ ${imgs.length} images`); return downloadImages(imgs, url, onLog); }
        } catch {}
      }
    }
    const imgs = extractImageUrlsFromHtml(html, url);
    if (imgs.length > 0) return downloadImages(imgs, url, onLog);
  }
  if (IS_ELECTRON) {
    onLog("🖥️  Trying headless browser for DMZJ…");
    return downloadImages(await electronBrowserScrape(url, onLog), url, onLog);
  }
  throw new Error("DMZJ uses client-side rendering.\n💡 Use the Windows app, or download and use the File tab.");
}

// ─── CopyManga / 拷贝漫画 ──────────────────────────────────────────────────────
async function scrapeCopyManga(url, onLog) {
  onLog("📡 Fetching CopyManga chapter…");
  const html = await platformFetch(url, { Referer: "https://www.copymanga.site/" });
  if (isBotBlock(html)) throw new Error("NEEDS_CF_BYPASS:" + url);

  // Strategy 1: imageList / picList JSON array embedded in page
  for (const pat of [
    /"imageList"\s*:\s*(\[[\s\S]+?\])/,
    /imageList\s*=\s*(\[[\s\S]+?\]);/,
    /"picList"\s*:\s*(\[[\s\S]+?\])/,
  ]) {
    const m = html.match(pat);
    if (!m) continue;
    try {
      const imgs = JSON.parse(m[1]);
      const urls = imgs.map(i =>
        typeof i === "string" ? i : (i.url || i.src || i.path || i.pic_path || "")
      ).filter(u => /^https?:\/\//.test(u));
      if (urls.length > 0) { onLog(`✅ ${urls.length} images`); return downloadImages(urls, url, onLog); }
    } catch {}
  }

  // Strategy 2: individual "pic_path":"https://..." properties (no /g in match loop!)
  const picPaths = [...html.matchAll(/"pic_path"\s*:\s*"([^"]+)"/g)]
    .map(m => m[1]).filter(u => /^https?:\/\//.test(u));
  if (picPaths.length > 0) { onLog(`✅ ${picPaths.length} images (pic_path)`); return downloadImages(picPaths, url, onLog); }

  // Strategy 3: CDN URLs in page source
  const cdnUrls = extractImageUrlsFromHtml(html, url).filter(u =>
    u.includes("copymanga") || u.includes("mangacopy") || u.includes("bookmangacdn")
  );
  if (cdnUrls.length > 0) { onLog(`✅ ${cdnUrls.length} images (CDN)`); return downloadImages(cdnUrls, url, onLog); }

  throw new Error("FALLBACK");
}

// ─── SenManga Raw (raw.senmanga.com) ─────────────────────────────────────────
async function scrapeSenManga(url, onLog) {
  onLog("📡 Fetching SenManga chapter index…");
  const html = await platformFetch(url, {
    Referer: "https://raw.senmanga.com/",
    Cookie: "viewer=1",
  });

  const pageUrls = [];
  const base = new URL(url);
  for (const m of html.matchAll(/<option[^>]+value="([^"]+)"[^>]*>/gi)) {
    try {
      const pageUrl = new URL(m[1], base.origin).href;
      if (!pageUrls.includes(pageUrl)) pageUrls.push(pageUrl);
    } catch {}
  }

  if (pageUrls.length === 0) {
    const imgs = extractImageUrlsFromHtml(html, url);
    if (imgs.length > 0) { onLog(`✅ ${imgs.length} images`); return downloadImages(imgs, url, onLog); }
    throw new Error("SenManga: could not find page list.");
  }

  onLog(`📄 ${pageUrls.length} pages — fetching each…`);
  const imageUrls = [];
  for (let i = 0; i < pageUrls.length; i++) {
    onLog(`   📄 Page ${i + 1}/${pageUrls.length}`);
    try {
      const pageHtml = await platformFetch(pageUrls[i], { Referer: url });
      const m = pageHtml.match(/class="picture"[^>]+src="([^"]+)"/) ||
                pageHtml.match(/id="picture"[^>]+src="([^"]+)"/) ||
                pageHtml.match(/<img[^>]+class="[^"]*viewer[^"]*"[^>]+src="([^"]+)"/i);
      if (m) {
        let imgUrl = m[1];
        if (imgUrl.startsWith("//")) imgUrl = "https:" + imgUrl;
        imageUrls.push(imgUrl);
      }
    } catch (e) { onLog(`   ⚠️  Page ${i + 1}: ${e.message}`); }
  }
  if (!imageUrls.length) throw new Error("SenManga: could not extract images from pages.");
  onLog(`✅ ${imageUrls.length} images`);
  return downloadImages(imageUrls, "https://raw.senmanga.com/", onLog);
}

// ─── Naver Webtoon / comic.naver.com ─────────────────────────────────────────
async function scrapeNaverComic(url, onLog) {
  onLog("📡 Fetching Naver Webtoon episode…");
  const html = await platformFetch(url, {
    Referer: "https://comic.naver.com/",
    Cookie: "nstore_session=; NNB=;",
  });
  const imgs = extractImageUrlsFromHtml(html, url).filter(u =>
    u.includes("comic-image") || u.includes("cdn-comics") ||
    u.includes("pstatic.net") || u.includes("naver.net")
  );
  if (!imgs.length) {
    const nd = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
    if (nd) {
      try {
        const extracted = extractImageArray(JSON.parse(nd[1]));
        if (extracted.length > 0) return downloadImages(extracted, "https://comic.naver.com/", onLog);
      } catch {}
    }
    if (IS_ELECTRON) return downloadImages(await electronBrowserScrape(url, onLog), url, onLog);
    throw new Error("Naver Webtoon: no images found. Episode may require login.");
  }
  onLog(`✅ ${imgs.length} panels`);
  return downloadImages(imgs, "https://comic.naver.com/", onLog);
}

// ─── Kakao Webtoon ────────────────────────────────────────────────────────────
async function scrapeKakaoWebtoon(url, onLog) {
  if (IS_ELECTRON) {
    onLog("🖥️  Kakao Webtoon — launching headless browser…");
    return downloadImages(await electronBrowserScrape(url, onLog), url, onLog);
  }
  throw new Error("Kakao Webtoon requires login.\n💡 Use the Windows app, or download and use the File tab.");
}

// ─── MangaDex ─────────────────────────────────────────────────────────────────
async function scrapeMangaDex(url, onLog) {
  const m = url.match(/mangadex\.org\/chapter\/([a-f0-9-]{36})/i);
  if (!m) throw new Error("Could not extract MangaDex chapter ID from URL.");
  onLog("📡 Fetching MangaDex API…");
  const res = await fetch(`https://api.mangadex.org/at-home/server/${m[1]}`);
  if (!res.ok) throw new Error(`MangaDex API: HTTP ${res.status}`);
  const meta = await res.json();
  const urls = meta.chapter.data.map(p => `${meta.baseUrl}/data/${meta.chapter.hash}/${p}`);
  onLog(`📄 ${urls.length} pages`);
  return downloadImages(urls, "https://mangadex.org", onLog);
}

// ─── HappyMH (嗨皮漫画) ──────────────────────────────────────────────────────
async function scrapeHappyMH(url, onLog) {
  const match = url.match(/\/mangaread\/([^/]+?)\/(\d+)/);
  if (!match) throw new Error("Invalid HappyMH URL — expected m.happymh.com/mangaread/<manga>/<id>");
  const [, code, cid] = match;
  if (IS_ELECTRON) {
    onLog("🖥️  Using headless Chrome (Cloudflare bypass)…");
    return downloadImages(await electronBrowserScrape(url, onLog), url, onLog);
  }
  return callHappyMHApi(code, cid, url, onLog);
}

async function callHappyMHApi(code, cid, referer, onLog) {
  onLog("📡 Calling HappyMH API…");
  const apiUrl = `https://m.happymh.com/v2.0/apis/manga/reading?code=${code}&cid=${cid}&v=v3.1919111`;
  let res;
  try {
    res = await fetch(apiUrl, {
      credentials: "include",
      headers: {
        "accept": "application/json, text/plain, */*",
        "x-requested-id": String(Date.now()),
        "x-requested-with": "XMLHttpRequest",
        "referer": "https://m.happymh.com/",
        "User-Agent": CHROME_UA,
      },
    });
  } catch { throw new Error("NEEDS_CF_BYPASS:" + referer); }
  if (res.status === 403 || res.status === 503) throw new Error("NEEDS_CF_BYPASS:" + referer);
  if (res.status === 401) throw new Error("HappyMH: Login required.");
  if (!res.ok) throw new Error(`HappyMH API: HTTP ${res.status}`);
  let json;
  try { json = await res.json(); } catch { throw new Error("NEEDS_CF_BYPASS:" + referer); }
  if (json.status !== 0) {
    if (json.status === 403 || json.status === 503) throw new Error("NEEDS_CF_BYPASS:" + referer);
    throw new Error(`HappyMH API error: status ${json.status} — ${json.msg || "unknown"}`);
  }
  const imageUrls = (json.data?.scans || []).map(s => s.url).filter(Boolean);
  if (!imageUrls.length) throw new Error("HappyMH API returned 0 images — chapter may require login.");
  onLog(`✅ ${imageUrls.length} pages from API`);
  return downloadImages(imageUrls, "https://m.happymh.com/", onLog);
}

// Fix #8: retryHappyMHAfterCF — HappyMH is a Vue/Nuxt SPA so HTML won't have images
// Look for __NUXT__ / nuxt-payload embedded data in the script tags instead
export async function retryHappyMHAfterCF(url, onLog) {
  onLog("📡 Fetching HappyMH page after CF bypass…");

  try {
    const html = await fetch(url, {
      credentials: "include",
      headers: { "User-Agent": CHROME_UA, "Referer": "https://m.happymh.com/", Accept: "text/html,*/*" },
    }).then(r => r.text());

    if (!isBotBlock(html)) {
      // Nuxt 3 embeds a payload script: <script id="__NUXT_DATA__" type="application/json">
      for (const pat of [
        /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]+?)<\/script>/,
        /window\.__NUXT__\s*=\s*(\{[\s\S]+?\});\s*<\/script>/,
        /<script[^>]*type="application\/json"[^>]*>([\s\S]+?)<\/script>/,
      ]) {
        const m = html.match(pat);
        if (!m) continue;
        try {
          const data = JSON.parse(m[1]);
          const imgs = extractImageArray(data);
          const validImgs = imgs.filter(u => /\.(jpg|jpeg|webp|png)/i.test(u));
          if (validImgs.length >= 3) {
            onLog(`✅ ${validImgs.length} pages from Nuxt data`);
            return downloadImages(validImgs, "https://m.happymh.com/", onLog);
          }
        } catch {}
      }
      // Look for scans array pattern in script tags
      for (const pat of [
        /"scans"\s*:\s*(\[[\s\S]{10,5000}?\])/,
        /"images"\s*:\s*(\[[\s\S]{10,5000}?\])/,
      ]) {
        const m = html.match(pat);
        if (m) {
          try {
            const arr = JSON.parse(m[1]);
            const urls = extractImageArray(arr).filter(u => /^https?:\/\//.test(u));
            if (urls.length >= 3) { onLog(`✅ ${urls.length} pages`); return downloadImages(urls, "https://m.happymh.com/", onLog); }
          } catch {}
        }
      }
    }
  } catch (e) { onLog(`   ⚠️  Page scrape: ${e.message}`); }

  // API fallback
  onLog("📡 Trying HappyMH API…");
  const match = url.match(/\/mangaread\/([^/]+?)\/(\d+)/);
  if (match) {
    try {
      return await callHappyMHApi(match[1], match[2], url, onLog);
    } catch (e) {
      onLog(`   ⚠️  API: ${e.message.replace("NEEDS_CF_BYPASS:", "CF block — ")}`);
    }
  }
  throw new Error("HappyMH: Could not load chapter after CF bypass.\n💡 Try again in a few seconds.");
}

// ─── Webtoons ─────────────────────────────────────────────────────────────────
async function scrapeWebtoons(url, onLog) {
  onLog("📡 Fetching Webtoons episode…");
  const html = await platformFetch(url, {
    Referer: "https://www.webtoons.com/",
    Cookie: "needCCPA=false; needCOPPA=false; needGDPR=false; pagGDPR=true",
  });
  const matches = [...html.matchAll(/data-url="([^"]+(?:webtoon-phinf|phinf\.naver)[^"]+)"/g)];
  let imageUrls = [...new Set(matches.map(m => m[1]))];
  if (!imageUrls.length) {
    imageUrls = extractImageUrlsFromHtml(html, url).filter(u => u.includes("phinf"));
  }
  if (!imageUrls.length) throw new Error("No Webtoons panels found. Episode may require login.");
  onLog(`🖼  ${imageUrls.length} panels`);
  return downloadImages(imageUrls, "https://www.webtoons.com/", onLog);
}

// ─── Comick.io ────────────────────────────────────────────────────────────────
async function scrapeComick(url, onLog) {
  onLog("📡 Fetching Comick chapter…");
  const html = await platformFetch(url, { Referer: "https://comick.io/" });
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
  if (!m) throw new Error("FALLBACK");
  const json = JSON.parse(m[1]);
  const mdImages = json?.props?.pageProps?.chapter?.md_images;
  if (!mdImages?.length) throw new Error("FALLBACK");
  const urls = mdImages.map(img => `https://meo.comick.pictures/${img.b2key}`);
  onLog(`✅ ${urls.length} pages`);
  return downloadImages(urls, "https://comick.io/", onLog);
}

// ─── Manganato (fix #4: greedy section match, not lazy) ──────────────────────
async function scrapeManganato(url, onLog) {
  onLog("📡 Fetching Manganato chapter…");
  const html = await platformFetch(url, { Referer: new URL(url).origin + "/" });
  if (isBotBlock(html)) throw new Error("NEEDS_CF_BYPASS:" + url);

  // Extract images from the reader section — use indexOf/lastIndexOf to find the real boundary
  // instead of a regex that stops at the first </div>
  const sectionStart = html.search(/class="container-chapter-reader"/i);
  const section = sectionStart >= 0 ? html.slice(sectionStart) : html;

  const all = extractImageUrlsFromHtml(section, url);
  const imgs = all.filter(u =>
    u.includes("mkklcdn") || u.includes("natomanga") || u.includes("manganato") ||
    u.includes("blogtruyenmoi") || /\/(chapter|chap|ch)[-_/\d]/i.test(new URL(u).pathname)
  );
  if (!imgs.length && all.length > 0) return downloadImages(all, url, onLog);
  if (!imgs.length) throw new Error("No images found on Manganato page.");
  onLog(`🖼  ${imgs.length} pages`);
  return downloadImages(imgs, url, onLog);
}

// ─── Madara WordPress theme ───────────────────────────────────────────────────
async function scrapeMadara(url, onLog) {
  onLog("📡 Fetching Madara chapter…");
  const html = await platformFetch(url, { Referer: new URL(url).origin + "/" });
  if (isBotBlock(html)) {
    if (IS_ELECTRON) return downloadImages(await electronBrowserScrape(url, onLog), url, onLog);
    throw new Error("NEEDS_CF_BYPASS:" + url);
  }
  // Use indexOf to find the reader section start rather than a regex that stops too early
  const markerIdx = html.search(/class="[^"]*(?:reading-content|wp-manga-chapter|chapter-content|chapter-reader)[^"]*"/i);
  const section = markerIdx >= 0 ? html.slice(markerIdx) : html;
  const imgs = extractImageUrlsFromHtml(section, url);
  if (!imgs.length) throw new Error("FALLBACK");
  onLog(`🖼  ${imgs.length} pages`);
  return downloadImages(imgs, url, onLog);
}

// ─── React SPA (AsuraComic, ReaperScans, WeebCentral) ─────────────────────────
async function scrapeReactSPA(url, onLog, siteName) {
  if (IS_ELECTRON) {
    onLog(`🖥️  ${siteName} is a React SPA — using headless Chrome…`);
    return downloadImages(await electronBrowserScrape(url, onLog), url, onLog);
  }
  onLog(`📡 Trying ${siteName}…`);
  const html = await platformFetch(url, { Referer: new URL(url).origin + "/" });
  if (!isBotBlock(html)) {
    const nd = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
    if (nd) {
      try {
        const imgs = extractImageArray(JSON.parse(nd[1]));
        if (imgs.length > 0) return downloadImages(imgs, url, onLog);
      } catch {}
    }
    const imgs = extractImageUrlsFromHtml(html, url);
    if (imgs.length > 0) return downloadImages(imgs, url, onLog);
  }
  throw new Error(
    `${siteName} uses client-side rendering — images can't load without JavaScript.\n` +
    `💡 Use the Windows app, or download as .cbz and use the File tab.`
  );
}

// ─── Generic fallback ─────────────────────────────────────────────────────────
async function scrapeGeneric(url, onLog) {
  onLog("🔍 Auto-detecting page structure…");
  const html = await platformFetch(url, {
    Referer: new URL(url).origin + "/",
    Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
  });

  if (isBotBlock(html)) {
    if (IS_ELECTRON) {
      try {
        const jsUrls = await electronBrowserScrape(url, onLog);
        if (jsUrls.length > 0) return downloadImages(jsUrls, url, onLog);
      } catch (e) { onLog(`   ⚠️  ${e.message}`); }
    }
    throw new Error("NEEDS_CF_BYPASS:" + url);
  }

  // __NEXT_DATA__
  const nextData = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
  if (nextData) {
    try {
      const imgs = extractImageArray(JSON.parse(nextData[1]));
      if (imgs.length >= 2) { onLog(`📜 ${imgs.length} images from Next.js data`); return downloadImages(imgs, url, onLog); }
    } catch {}
  }

  // Embedded JS arrays in script tags
  for (const scriptMatch of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const pat of [
      /(?:images?|pages?|imgs?|scans?|picList|imgList|pageList|pageArr)\s*[=:]\s*(\[[\s\S]{10,3000}?\])/gi,
      /"(?:images?|pages?|imgs?|scans?|picList|pageArr)"\s*:\s*(\[[\s\S]{10,3000}?\])/gi,
    ]) {
      for (const m of scriptMatch[1].matchAll(pat)) {
        try {
          const urls = extractImageArray(JSON.parse(m[1]));
          const valid = urls.filter(u => /^https?:\/\/.+\.(jpg|jpeg|png|webp)/i.test(u));
          if (valid.length >= 2) { onLog(`📜 ${valid.length} images in embedded JS`); return downloadImages([...new Set(valid)], url, onLog); }
        } catch {}
      }
    }
  }

  const imgs = extractImageUrlsFromHtml(html, url);
  onLog(`🖼  ${imgs.length} candidate images`);
  if (!imgs.length) {
    if (IS_ELECTRON) {
      try { const j = await electronBrowserScrape(url, onLog); if (j.length > 0) return downloadImages(j, url, onLog); } catch {}
    }
    throw new Error("No images found.\n💡 This site may need JavaScript. Try the Windows app or .cbz File tab.");
  }
  return downloadImages(imgs, url, onLog);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ROUTER
// ═══════════════════════════════════════════════════════════════════════════

export async function scrapeURL(url, onLog) {
  const trimmed = url.trim();
  let parsed;
  try { parsed = new URL(trimmed); } catch { throw new Error("Invalid URL — must start with https://"); }

  const host = parsed.hostname.toLowerCase().replace(/^(www\.|m\.|wap\.)/, "");
  onLog(`🌐 ${host}…`);

  if (host.includes("manhuagui.com") || host.includes("mhgui.com"))
    return scrapeManhuaGui(trimmed, onLog);

  if (host.includes("dm5.com") || host.includes("manhuaren.com"))
    return scrapeDM5(trimmed, onLog);

  if (host.includes("dmzj.com"))
    return scrapeDMZJ(trimmed, onLog);

  if (host.includes("copymanga") || host.includes("copy-manga"))
    return scrapeCopyManga(trimmed, onLog).catch(e => {
      if (e.message === "FALLBACK") return scrapeGeneric(trimmed, onLog);
      throw e;
    });

  if (host.includes("happymh.com"))
    return scrapeHappyMH(trimmed, onLog);

  if (host.includes("senmanga.com"))
    return scrapeSenManga(trimmed, onLog);

  if (host.includes("comic.naver.com") || host.includes("webtoon.naver.com"))
    return scrapeNaverComic(trimmed, onLog);

  if (host.includes("page.kakao.com") || host.includes("kakaowebtoon.com"))
    return scrapeKakaoWebtoon(trimmed, onLog);

  if (host.includes("mangadex.org"))
    return scrapeMangaDex(trimmed, onLog);

  if (host.includes("webtoons.com"))
    return scrapeWebtoons(trimmed, onLog);

  if (host.includes("comick.io") || host.includes("comick.cc"))
    return scrapeComick(trimmed, onLog).catch(e => {
      if (e.message === "FALLBACK") return scrapeGeneric(trimmed, onLog);
      throw e;
    });

  if (host.match(/\b(manganato|natomanga|readmanganato|manganelo|mangakakalot|nelomanga)\b/))
    return scrapeManganato(trimmed, onLog).catch(() => scrapeGeneric(trimmed, onLog));

  if (host.includes("asuracomic.net") || host.includes("asurascans.com"))
    return scrapeReactSPA(trimmed, onLog, "Asura Scans");
  if (host.includes("reaperscans.com"))
    return scrapeReactSPA(trimmed, onLog, "Reaper Scans");
  if (host.includes("weebcentral.com"))
    return scrapeReactSPA(trimmed, onLog, "WeebCentral");
  if (host.includes("flamecomics.xyz"))
    return scrapeReactSPA(trimmed, onLog, "Flame Comics");

  const isMadara =
    host.includes("toonily.") || host.includes("manhuafast.") ||
    host.includes("manhuaplus.") || host.includes("mangabuddy.") ||
    host.includes("isekaiscan.") || host.includes("zinmanga.") ||
    host.includes("mangatx.") || host.includes("topmanhua.") ||
    host.includes("manhuaus.") || host.includes("manhwatop.");
  if (isMadara)
    return scrapeMadara(trimmed, onLog).catch(e => {
      if (e.message === "FALLBACK") return scrapeGeneric(trimmed, onLog);
      throw e;
    });

  return scrapeGeneric(trimmed, onLog);
}

export const SUPPORTED_SITES = [
  { name: "ManhuaGui 漫画柜",  support: "✅",        note: "LZString decode + direct CDN" },
  { name: "DM5 动漫屋",         support: "🖥️ Windows", note: "Requires JS eval" },
  { name: "DMZJ 动漫之家",      support: "🖥️ Windows", note: "Vue SPA" },
  { name: "CopyManga 拷贝漫画", support: "✅",        note: "Embedded JSON" },
  { name: "HappyMH 嗨皮漫画",   support: "✅",        note: "Real API + CF bypass" },
  { name: "SenManga Raw",      support: "✅",        note: "Per-page fetch" },
  { name: "Naver Webtoon",     support: "✅",        note: "data-src extraction" },
  { name: "Kakao Webtoon",     support: "🖥️ Windows", note: "Requires login" },
  { name: "MangaDex",          support: "✅",        note: "Official API" },
  { name: "Webtoons",          support: "✅",        note: "data-url extraction" },
  { name: "Comick.io",         support: "✅",        note: "Next.js data" },
  { name: "Manganato",         support: "✅",        note: "SSR extraction" },
  { name: "Madara sites",      support: "✅",        note: "Toonily, ManhuaFast, MangaBuddy…" },
  { name: "AsuraComic",        support: "🖥️ Windows", note: "React SPA" },
  { name: "Any site",          support: "🔍",        note: "Auto-detect + headless fallback" },
];
