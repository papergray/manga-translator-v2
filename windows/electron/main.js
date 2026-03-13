const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path   = require("path");
const https  = require("https");
const http   = require("http");
const zlib   = require("zlib");  // Fix #17: decompress gzip/deflate responses

const isDev = process.env.NODE_ENV === "development";

// ─── Native fetch helpers ─────────────────────────────────────────────────────
// Fix #10: redirect counter, fix #17: accept-encoding + decompress
function nativeFetch(url, headers = {}, _redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (_redirectCount > 10) return reject(new Error("Too many redirects"));

    const parsed = new URL(url);
    const mod    = parsed.protocol === "https:" ? https : http;
    const opts   = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   "GET",
      headers:  {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",  // Fix #17
        ...headers,
      },
      timeout: 30000,
    };

    const req = mod.request(opts, res => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        // Preserve cookies across redirects
        const redirectUrl = res.headers.location.startsWith("http")
          ? res.headers.location
          : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
        const setCookie = res.headers["set-cookie"];
        const cookieHeaders = { ...headers };
        if (setCookie) {
          const existing = headers["Cookie"] || "";
          const newCookies = setCookie.map(c => c.split(";")[0]).join("; ");
          cookieHeaders["Cookie"] = existing ? `${existing}; ${newCookies}` : newCookies;
        }
        nativeFetch(redirectUrl, cookieHeaders, _redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const encoding = res.headers["content-encoding"] || "";

        // Fix #17: decompress if needed
        const decompress = (buf, cb) => {
          if (encoding === "br") {
            zlib.brotliDecompress(buf, cb);
          } else if (encoding === "gzip") {
            zlib.gunzip(buf, cb);
          } else if (encoding === "deflate") {
            zlib.inflate(buf, cb);
          } else {
            cb(null, buf);
          }
        };

        decompress(raw, (err, buffer) => {
          if (err) {
            // Decompression failed — return raw buffer (might still be readable)
            resolve({ status: res.statusCode, buffer: raw, headers: res.headers });
          } else {
            resolve({ status: res.statusCode, buffer, headers: res.headers });
          }
        });
      });
    });

    req.on("error",   reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    req.end();
  });
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────
ipcMain.handle("fetch-url", async (_event, url, extraHeaders = {}) => {
  try {
    const result = await nativeFetch(url, extraHeaders);
    if (result.status >= 400) return { error: `HTTP ${result.status}`, status: result.status };
    return { text: result.buffer.toString("utf-8"), status: result.status };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("fetch-image", async (_event, url, referer = "") => {
  try {
    const headers = { "Accept": "image/webp,image/apng,image/*,*/*;q=0.8" };
    if (referer) headers["Referer"] = referer;
    const result = await nativeFetch(url, headers);
    if (result.status >= 400) return { error: `HTTP ${result.status}` };

    const ct = result.headers["content-type"] || "";
    let mime = "image/jpeg";
    if (ct.includes("png"))  mime = "image/png";
    if (ct.includes("webp")) mime = "image/webp";
    if (ct.includes("gif"))  mime = "image/gif";
    if (/\.png(\?|$)/i.test(url))  mime = "image/png";
    if (/\.webp(\?|$)/i.test(url)) mime = "image/webp";

    return { dataUrl: `data:${mime};base64,${result.buffer.toString("base64")}` };
  } catch (e) {
    return { error: e.message };
  }
});

// Fix #11: increase JS wait time to 6s for heavy SPAs, improve image extraction
ipcMain.handle("js-scrape", async (_event, url) => {
  let scrapeWin = null;
  try {
    scrapeWin = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        javascript: true,
        webSecurity: false,
        images: false,
      },
    });

    // Wait for page to load
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 30000); // resolve even on timeout
      scrapeWin.webContents.once("did-finish-load", () => { clearTimeout(timeout); resolve(); });
      scrapeWin.webContents.once("did-fail-load", (_, code, desc) => {
        // Only reject on hard failures, not soft ones
        if (code < -3) { clearTimeout(timeout); reject(new Error(`Page failed: ${desc} (${code})`)); }
        else { clearTimeout(timeout); resolve(); }
      });
      scrapeWin.loadURL(url, {
        userAgent:
          "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        extraHeaders: `Referer: ${new URL(url).origin}/\n`,
      });
    });

    // Fix #11: wait 6 seconds for Vue/React SPAs to fetch and render chapter data
    await new Promise(r => setTimeout(r, 6000));

    const imageUrls = await scrapeWin.webContents.executeJavaScript(`
      (function() {
        const urls = new Set();
        const isImg = s => s && /\\.(?:jpg|jpeg|png|webp)(\\?|$)/i.test(s.split('?')[0]);
        const isJunk = s => /\\b(logo|icon|avatar|banner|sprite|thumb|placeholder|loading|1x1)\\b/i.test(s);

        // Collect from all img elements
        document.querySelectorAll('img').forEach(el => {
          const srcs = [
            el.src,
            el.dataset && el.dataset.src,
            el.dataset && el.dataset.original,
            el.dataset && el.dataset.url,
            el.dataset && el.dataset.lazySrc,
            el.dataset && el.dataset.bgset,
            el.getAttribute('data-src'),
            el.getAttribute('data-original'),
          ].filter(Boolean);
          srcs.forEach(v => {
            if (isImg(v) && !isJunk(v)) {
              try { urls.add(new URL(v, location.href).href); } catch {}
            }
          });
        });

        // Background images
        document.querySelectorAll('[style]').forEach(el => {
          const bg = el.style.backgroundImage || '';
          const m = bg.match(/url\\([\"']?([^\"')]+)[\"']?\\)/);
          if (m && isImg(m[1]) && !isJunk(m[1])) {
            try { urls.add(new URL(m[1], location.href).href); } catch {}
          }
        });

        // Picture sources
        document.querySelectorAll('source[srcset], source[src]').forEach(el => {
          const src = el.srcset || el.src;
          if (src) {
            src.split(',').forEach(part => {
              const u = part.trim().split(' ')[0];
              if (isImg(u) && !isJunk(u)) {
                try { urls.add(new URL(u, location.href).href); } catch {}
              }
            });
          }
        });

        // Scan window objects for image arrays
        const scanObj = (obj, depth) => {
          if (depth > 4 || !obj || typeof obj !== 'object') return;
          if (Array.isArray(obj)) {
            obj.forEach(item => {
              if (typeof item === 'string' && isImg(item) && !isJunk(item)) urls.add(item);
              else if (item && typeof item === 'object') {
                ['url','src','img','path','image','file','src2'].forEach(k => {
                  if (item[k] && typeof item[k] === 'string' && isImg(item[k]) && !isJunk(item[k])) {
                    urls.add(item[k]);
                  }
                });
              }
            });
            return;
          }
          const keys = ['images','imgs','pages','scans','picList','pageArr','imgList','chapterImages'];
          keys.forEach(k => { if (obj[k]) scanObj(obj[k], depth + 1); });
        };

        // Try common window variables
        ['__DATA__','__NUXT__','__NEXT_DATA__','__pageProps__','pageData','chapterData'].forEach(k => {
          try { if (window[k]) scanObj(window[k], 0); } catch {}
        });
        try { scanObj(window.__NEXT_DATA__ && window.__NEXT_DATA__.props && window.__NEXT_DATA__.props.pageProps, 0); } catch {}

        // Sort by URL path (images are often numbered)
        // Natural numeric sort so page2.jpg comes before page10.jpg
        const arr = [...urls].filter(u => isImg(u) && !isJunk(u));
        arr.sort((a, b) => {
          // Extract path for comparison, ignore domain
          const pa = (() => { try { return new URL(a).pathname; } catch { return a; } })();
          const pb = (() => { try { return new URL(b).pathname; } catch { return b; } })();
          return pa.localeCompare(pb, undefined, { numeric: true, sensitivity: 'base' });
        });
        return arr;
      })()
    `);

    return { imageUrls: imageUrls || [] };
  } catch (e) {
    return { error: e.message };
  } finally {
    if (scrapeWin && !scrapeWin.isDestroyed()) scrapeWin.destroy();
  }
});

// ─── Preload ──────────────────────────────────────────────────────────────────
const PRELOAD_CODE = `
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("electronAPI", {
  fetch:      (url, extraHeaders) => ipcRenderer.invoke("fetch-url", url, extraHeaders),
  fetchImage: (url, referer)      => ipcRenderer.invoke("fetch-image", url, referer),
  jsScrape:   (url)               => ipcRenderer.invoke("js-scrape", url),
  isElectron: true,
});
`;

const os  = require("os");
const fs  = require("fs");
const preloadPath = path.join(os.tmpdir(), "manga-translator-preload.js");
fs.writeFileSync(preloadPath, PRELOAD_CODE);

// ─── Window creation ──────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth:  900,
    minHeight: 600,
    title: "Manga Translator",
    backgroundColor: "#0e0e0e",
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload:          preloadPath,
      webSecurity:      false,
    },
    icon: path.join(__dirname, "../public/icon.png"),
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#161616", symbolColor: "#d4a017", height: 44 },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://") && !url.startsWith("http://localhost")) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
