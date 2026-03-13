const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const https = require("https");
const http  = require("http");

const isDev = process.env.NODE_ENV === "development";

// ─── Native fetch helpers (no CORS) ──────────────────────────────────────────
function nativeFetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod    = parsed.protocol === "https:" ? https : http;
    const opts   = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   "GET",
      headers:  {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        ...headers,
      },
      timeout: 30000,
    };

    const req = mod.request(opts, res => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        nativeFetch(res.headers.location, headers).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end",  () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks), headers: res.headers }));
    });

    req.on("error",   reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    req.end();
  });
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

// Renderer calls window.electronAPI.fetch(url, headers) → gets text back
ipcMain.handle("fetch-url", async (_event, url, extraHeaders = {}) => {
  try {
    const result = await nativeFetch(url, extraHeaders);
    if (result.status >= 400) return { error: `HTTP ${result.status}` };
    return { text: result.buffer.toString("utf-8"), status: result.status };
  } catch (e) {
    return { error: e.message };
  }
});

// Renderer calls window.electronAPI.fetchImage(url, referer) → gets base64 data URL
ipcMain.handle("fetch-image", async (_event, url, referer = "") => {
  try {
    const headers = {};
    if (referer) headers["Referer"] = referer;
    const result = await nativeFetch(url, headers);
    if (result.status >= 400) return { error: `HTTP ${result.status}` };

    const ct = result.headers["content-type"] || "";
    let mime = "image/jpeg";
    if (ct.includes("png"))  mime = "image/png";
    if (ct.includes("webp")) mime = "image/webp";
    if (/\.png(\?|$)/i.test(url))  mime = "image/png";
    if (/\.webp(\?|$)/i.test(url)) mime = "image/webp";

    return { dataUrl: `data:${mime};base64,${result.buffer.toString("base64")}` };
  } catch (e) {
    return { error: e.message };
  }
});

// Renderer calls window.electronAPI.jsScrape(url) → runs page in hidden window, returns image URLs
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
        images: false, // don't load images — we just want URLs
      },
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Page load timed out")), 25000);
      scrapeWin.webContents.once("did-finish-load", () => { clearTimeout(timeout); resolve(); });
      scrapeWin.webContents.once("did-fail-load", (_, code, desc) => {
        clearTimeout(timeout); reject(new Error(`Page failed: ${desc}`));
      });
      scrapeWin.loadURL(url, {
        userAgent:
          "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        extraHeaders: `Referer: ${new URL(url).origin}/\n`,
      });
    });

    // Wait for JS to render (SPA sites need time after DOM ready)
    await new Promise(r => setTimeout(r, 3000));

    // Execute JS in the page context to extract all image URLs
    const imageUrls = await scrapeWin.webContents.executeJavaScript(`
      (function() {
        const urls = new Set();
        const isImg = s => s && /\\.(jpg|jpeg|png|webp)/i.test(s.split('?')[0]);
        const isManga = s => !/\\b(logo|icon|avatar|banner|sprite|thumb)\\b/i.test(s);

        // All img elements
        document.querySelectorAll('img').forEach(el => {
          ['src','dataset.src','dataset.original','dataset.url','dataset.lazySrc'].forEach(k => {
            const v = k.includes('.') ? el[k.split('.')[0]]?.[k.split('.')[1]] : el[k];
            if (v && isImg(v) && isManga(v)) urls.add(new URL(v, location.href).href);
          });
        });

        // Background images
        document.querySelectorAll('[style]').forEach(el => {
          const m = el.style.backgroundImage.match(/url\\(["']?([^"')]+)["']?\\)/);
          if (m && isImg(m[1]) && isManga(m[1])) urls.add(new URL(m[1], location.href).href);
        });

        // Scan window variables for image arrays
        const scanObj = (obj, depth) => {
          if (depth > 3 || !obj || typeof obj !== 'object') return;
          if (Array.isArray(obj)) {
            obj.forEach(item => {
              if (typeof item === 'string' && isImg(item) && isManga(item)) urls.add(item);
              else if (item && typeof item === 'object') {
                ['url','src','img','path','image'].forEach(k => {
                  if (item[k] && typeof item[k] === 'string' && isImg(item[k])) urls.add(item[k]);
                });
              }
            });
          }
          for (const k of ['images','imgs','pages','scans','picList','pageArr','imgList']) {
            if (obj[k]) scanObj(obj[k], depth + 1);
          }
        };
        try { scanObj(window.__DATA__, 0); } catch {}
        try { scanObj(window.__NUXT__, 0); } catch {}
        try { scanObj(window.__NEXT_DATA__?.props?.pageProps, 0); } catch {}

        return [...urls].sort();
      })()
    `);

    return { imageUrls: imageUrls || [] };
  } catch (e) {
    return { error: e.message };
  } finally {
    if (scrapeWin && !scrapeWin.isDestroyed()) scrapeWin.destroy();
  }
});

// ─── Preload script (inline) — exposes electronAPI to renderer ────────────────
// Written to a temp file at startup
const PRELOAD_CODE = `
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("electronAPI", {
  fetch: (url, extraHeaders) => ipcRenderer.invoke("fetch-url", url, extraHeaders),
  fetchImage: (url, referer) => ipcRenderer.invoke("fetch-image", url, referer),
  jsScrape: (url) => ipcRenderer.invoke("js-scrape", url),
  isElectron: true,
});
`;

const os   = require("os");
const fs   = require("fs");
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
      webSecurity:      false, // allow loading local resources in prod build
    },
    icon: path.join(__dirname, "../public/icon.png"),
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color:       "#161616",
      symbolColor: "#d4a017",
      height:      44,
    },
  });

  // Open all external links in the system browser
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
