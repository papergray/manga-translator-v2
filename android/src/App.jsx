import { useState, useRef, useEffect, useCallback } from "react";
import { scrapeURL, SUPPORTED_SITES } from "./scraper.js";
import { translatePageOnDevice, cleanupOnDevice, setMemoryTier, MEMORY_TIERS } from "./ondevice.js";

// ─── Fonts ────────────────────────────────────────────────────────────────────
async function loadFonts() {
  if (!document.getElementById("mt-fonts")) {
    const link = document.createElement("link");
    link.id = "mt-fonts";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Bangers&family=Comic+Neue:wght@700&family=Caveat:wght@700&family=Permanent+Marker&display=swap";
    document.head.appendChild(link);
  }
  try {
    if (document.fonts?.load) {
      await Promise.all([
        document.fonts.load("24px Bangers"),
        document.fonts.load("bold 24px 'Comic Neue'"),
        document.fonts.load("bold 24px Caveat"),
        document.fonts.load("24px 'Permanent Marker'"),
      ]);
    } else {
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch {}
}

// ─── JSZip ────────────────────────────────────────────────────────────────────
async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = () => res(window.JSZip);
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

const blobToDataUrl = blob => new Promise(res => {
  const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob);
});
const loadImg = src => new Promise((res, rej) => {
  const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
});

// ─── API Definitions ──────────────────────────────────────────────────────────
const APIS = {
  ondevice: {
    id: "ondevice", name: "On-Device (Offline)",
    badge: "100% FREE", badgeColor: "#4caf50",
    placeholder: "— no key needed —",
    hint: "Runs on your device · No internet after first model download (~150MB)",
    keyUrl: null, noKey: true, validate: () => null,
  },
  gemini: {
    id: "gemini", name: "Google Gemini",
    badge: "FREE", badgeColor: "#4caf50",
    placeholder: "AIzaSy...",
    hint: 'Free 1,500 req/day · Get key at aistudio.google.com',
    keyUrl: "https://aistudio.google.com/app/apikey",
    validate: k => k.startsWith("AIza") && k.length >= 35 ? null : 'Key should start with "AIza".',
  },
  claude: {
    id: "claude", name: "Anthropic Claude",
    badge: "PAID", badgeColor: "#d4a017",
    placeholder: "sk-ant-api03-...",
    hint: 'Starts with "sk-ant-" · console.anthropic.com',
    keyUrl: "https://console.anthropic.com/settings/keys",
    validate: k => k.startsWith("sk-ant-") && k.length > 30 ? null : 'Key should start with "sk-ant-".',
  },
  openai: {
    id: "openai", name: "OpenAI GPT-4o",
    badge: "PAID", badgeColor: "#d4a017",
    placeholder: "sk-proj-...",
    hint: 'Starts with "sk-" · platform.openai.com',
    keyUrl: "https://platform.openai.com/api-keys",
    validate: k => k.startsWith("sk-") && k.length > 20 ? null : 'Key should start with "sk-".',
  },
  mistral: {
    id: "mistral", name: "Mistral Pixtral",
    badge: "FREE TIER", badgeColor: "#4caf50",
    placeholder: "...",
    hint: "Free tier · console.mistral.ai",
    keyUrl: "https://console.mistral.ai/api-keys",
    validate: k => k.length > 10 ? null : "Key too short.",
  },
};

const LANGUAGES = [
  { code: "English",    label: "🇺🇸 English" },
  { code: "Spanish",    label: "🇪🇸 Spanish" },
  { code: "French",     label: "🇫🇷 French" },
  { code: "German",     label: "🇩🇪 German" },
  { code: "Portuguese", label: "🇧🇷 Portuguese" },
  { code: "Italian",    label: "🇮🇹 Italian" },
  { code: "Japanese",   label: "🇯🇵 Japanese" },
  { code: "Korean",     label: "🇰🇷 Korean" },
  { code: "Arabic",     label: "🇸🇦 Arabic" },
  { code: "Russian",    label: "🇷🇺 Russian" },
  { code: "Hindi",      label: "🇮🇳 Hindi" },
  { code: "Turkish",    label: "🇹🇷 Turkish" },
  { code: "Thai",       label: "🇹🇭 Thai" },
  { code: "Vietnamese", label: "🇻🇳 Vietnamese" },
  { code: "Indonesian", label: "🇮🇩 Indonesian" },
];

const FONT_STYLES = {
  bangers: { label: "Bangers",           css: sz => `${sz}px Bangers` },
  comic:   { label: "Comic Neue",        css: sz => `bold ${sz}px 'Comic Neue', cursive` },
  caveat:  { label: "Caveat",            css: sz => `bold ${sz}px Caveat, cursive` },
  marker:  { label: "Permanent Marker",  css: sz => `${sz}px 'Permanent Marker', cursive` },
};

// ─── Translation API calls ────────────────────────────────────────────────────
function buildPrompt(targetLang) {
  return `You are a professional manga/comic translator.

ONLY translate text that is INSIDE speech bubbles, thought bubbles, or narration boxes — the clearly enclosed dialogue containers drawn as part of the comic panel.

SKIP and IGNORE completely:
- Text on signs, posters, banners, or backgrounds
- Chapter titles, volume numbers, page numbers
- Author names, studio credits, watermarks
- Publisher logos or copyright text
- Sound effects (SFX) that are part of the artwork background (not in a bubble)
- Any text that is part of the drawn scenery rather than enclosed in a bubble/box

ONLY include text that is inside a clearly enclosed speech bubble, thought bubble, or rectangular narration caption box.

For each qualifying bubble return:
- x1,y1,x2,y2: bounding box of the TEXT AREA ONLY as fraction 0.0–1.0. Add ~0.005 padding each side.
- translated: natural ${targetLang} translation matching the character's tone and emotion
- font_size_frac: estimated height of original characters as fraction of image height (0.02–0.08)
- bg_sample_x, bg_sample_y: a point just outside the text but still inside the bubble/box, used to sample background color (as fraction)
- align: "center", "left", or "right"
- style: "speech" (normal dialogue), "shout" (yelling/bold), "whisper" (small/quiet), or "caption" (narration box)
- dark_bg: true if the bubble background is dark/black, false if light/white

Return ONLY valid JSON with no markdown fences:
{"bubbles":[{"x1":0.1,"y1":0.05,"x2":0.4,"y2":0.18,"translated":"Hello!","font_size_frac":0.04,"bg_sample_x":0.12,"bg_sample_y":0.03,"align":"center","style":"speech","dark_bg":false}]}

No qualifying bubbles on this page → {"bubbles":[]}.`;
}

async function callGemini(b64, apiKey, targetLang) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: "image/jpeg", data: b64 } },
        { text: buildPrompt(targetLang) }
      ]}],
      generationConfig: { maxOutputTokens: 2048, temperature: 0.1 }
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    const msg = e?.error?.message || `HTTP ${res.status}`;
    if (res.status === 429) throw new Error("RATE_LIMIT");
    if (res.status === 400 || res.status === 403) throw new Error("AUTH_FAILED:" + msg);
    throw new Error(msg);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callClaude(b64, apiKey, targetLang) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
        { type: "text", text: buildPrompt(targetLang) }
      ]}]
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("AUTH_FAILED:" + (e?.error?.message || ""));
    throw new Error(e?.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return (data.content || []).map(b => b.text || "").join("");
}

async function callOpenAI(b64, apiKey, targetLang) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini", max_tokens: 2048,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
        { type: "text", text: buildPrompt(targetLang) }
      ]}]
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("AUTH_FAILED:" + (e?.error?.message || ""));
    throw new Error(e?.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function callMistral(b64, apiKey, targetLang) {
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "pixtral-12b-2409", max_tokens: 2048,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
        { type: "text", text: buildPrompt(targetLang) }
      ]}]
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("AUTH_FAILED:" + (e?.error?.message || ""));
    throw new Error(e?.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function callAPI(b64, apiId, apiKey, targetLang) {
  let raw = "";
  if (apiId === "gemini")       raw = await callGemini(b64, apiKey, targetLang);
  else if (apiId === "claude")  raw = await callClaude(b64, apiKey, targetLang);
  else if (apiId === "openai")  raw = await callOpenAI(b64, apiKey, targetLang);
  else if (apiId === "mistral") raw = await callMistral(b64, apiKey, targetLang);
  raw = raw.trim().replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(raw); } catch { return { bubbles: [] }; }
}

// ─── Retry with exponential backoff ──────────────────────────────────────────
async function withRetry(fn, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); } catch (e) {
      if (e.message === "RATE_LIMIT" && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, [10000, 20000, 40000, 60000][attempt]));
        continue;
      }
      throw e;
    }
  }
}

// ─── Batch stitch ─────────────────────────────────────────────────────────────
async function stitchImages(dataUrls, maxW = 768) {
  const imgs = await Promise.all(dataUrls.map(loadImg));
  const scaled = imgs.map(img => {
    const s = Math.min(1, maxW / img.width);
    return { img, w: Math.round(img.width * s), h: Math.round(img.height * s) };
  });
  const totalH = scaled.reduce((s, p) => s + p.h, 0);
  const canvas = document.createElement("canvas");
  canvas.width = maxW; canvas.height = totalH;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, maxW, totalH);
  let y = 0;
  const offsets = [];
  for (const { img, w, h } of scaled) {
    ctx.drawImage(img, 0, y, w, h);
    offsets.push({ y, h }); y += h;
  }
  return { b64: canvas.toDataURL("image/jpeg", 0.60).split(",")[1], offsets, totalH };
}

function remapBubbles(bubbles, offsets, totalH) {
  const perPage = offsets.map(() => []);
  for (const b of bubbles) {
    const cy = ((b.y1 + b.y2) / 2) * totalH;
    let idx = offsets.findIndex(({ y, h }) => cy >= y && cy < y + h);
    if (idx === -1) continue;
    const { y: py, h: ph } = offsets[idx];
    perPage[idx].push({
      ...b,
      y1: Math.max(0, (b.y1 * totalH - py) / ph),
      y2: Math.min(1, (b.y2 * totalH - py) / ph),
      bg_sample_y: b.bg_sample_y != null
        ? Math.max(0, Math.min(1, (b.bg_sample_y * totalH - py) / ph)) : null,
    });
  }
  return perPage;
}

// ─── Canvas rendering ─────────────────────────────────────────────────────────
function sampleBg(ctx, sx, sy, W, H) {
  try {
    const px = Math.round(Math.max(0, Math.min(W - 1, (sx || 0) * W)));
    const py = Math.round(Math.max(0, Math.min(H - 1, (sy || 0) * H)));
    const d = ctx.getImageData(Math.max(0, px - 2), Math.max(0, py - 2), 5, 5).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; b += d[i+2]; n++; }
    r = Math.round(r/n); g = Math.round(g/n); b = Math.round(b/n);
    return { color: `rgb(${r},${g},${b})`, dark: (r*299+g*587+b*114)/1000 < 128 };
  } catch { return { color: "#fff", dark: false }; }
}

function wrapText(ctx, text, maxW) {
  const words = text.split(" "); const lines = []; let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width <= maxW) line = t;
    else { if (line) lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [text];
}

function fitText(ctx, text, bw, bh, fontFn, hintPx) {
  const maxSz = Math.min(Math.round(hintPx * 1.4), Math.round(bh * 0.85), 90);
  for (let sz = maxSz; sz >= 7; sz--) {
    ctx.font = fontFn(sz);
    const pad = Math.max(4, sz * 0.2);
    const lines = wrapText(ctx, text, bw - pad * 2);
    const lineH = sz * 1.25;
    if (lines.length * lineH <= bh - pad * 2 && Math.max(...lines.map(l => ctx.measureText(l).width)) <= bw - pad * 2)
      return { sz, lines, lineH, pad };
  }
  ctx.font = fontFn(7);
  return { sz: 7, lines: wrapText(ctx, text, bw - 8), lineH: 9, pad: 4 };
}

function drawTranslations(canvas, img, bubbles, fontStyleId) {
  const ctx = canvas.getContext("2d");
  canvas.width = img.width; canvas.height = img.height;
  ctx.drawImage(img, 0, 0);
  const fontCss = FONT_STYLES[fontStyleId]?.css || FONT_STYLES.bangers.css;
  const EX = 0.008;

  for (const b of bubbles) {
    const text = b.translated || b.english;
    if (!text) continue;
    const x1 = Math.round(Math.max(0, (b.x1 - EX) * img.width));
    const y1 = Math.round(Math.max(0, (b.y1 - EX) * img.height));
    const x2 = Math.round(Math.min(img.width,  (b.x2 + EX) * img.width));
    const y2 = Math.round(Math.min(img.height, (b.y2 + EX) * img.height));
    const bw = x2 - x1, bh = y2 - y1;
    if (bw < 8 || bh < 8) continue;

    const { color: sampledBg, dark: sampledDark } = sampleBg(ctx, b.bg_sample_x, b.bg_sample_y, img.width, img.height);
    const isDark = b.dark_bg ?? sampledDark;
    const style = b.style || "speech";

    // Triple-pass fill to fully erase original text
    ctx.fillStyle = sampledBg;
    ctx.fillRect(x1, y1, bw, bh);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = isDark ? "#000" : style === "caption" ? "#f5f0e0" : sampledBg;
    ctx.fillRect(x1, y1, bw, bh);
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = isDark ? "#000" : style === "caption" ? "#f5f0e0" : sampledBg;
    ctx.fillRect(x1, y1, bw, bh);

    const effectiveFontFn = (style === "sfx" || style === "shout") ? FONT_STYLES.bangers.css : fontCss;
    const hintPx = b.font_size_frac ? Math.round(b.font_size_frac * img.height) : Math.round(bh * 0.42);
    const { sz, lines, lineH, pad } = fitText(ctx, text, bw, bh, effectiveFontFn, hintPx);

    ctx.font = effectiveFontFn(sz);
    ctx.fillStyle = isDark ? "#fff" : "#0a0a0a";
    ctx.textBaseline = "middle";
    ctx.textAlign = b.align || "center";

    if (style === "shout" || style === "sfx") {
      ctx.shadowColor = isDark ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.3)";
      ctx.shadowBlur = 2; ctx.shadowOffsetX = 1; ctx.shadowOffsetY = 1;
    }
    if (!isDark) { ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = sz * 0.14; ctx.lineJoin = "round"; }

    const totalH = lines.length * lineH;
    let curY = y1 + pad + (bh - pad * 2 - totalH) / 2 + lineH / 2;
    const tx = b.align === "right" ? x2 - pad : b.align === "left" ? x1 + pad : x1 + bw / 2;
    for (const line of lines) {
      if (!isDark && ctx.lineWidth > 0) ctx.strokeText(line, tx, curY, bw - pad * 2);
      ctx.fillText(line, tx, curY, bw - pad * 2);
      curY += lineH;
    }
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.lineWidth = 0;
  }
}

// ─── Colours & helpers ────────────────────────────────────────────────────────
const C = {
  gold: "#d4a017", bg: "#0e0e0e", surface: "#161616", surface2: "#1e1e1e",
  border: "#2a2a2a", text: "#e8e0d0", muted: "#555", faint: "#222",
  green: "#4caf50", red: "#e05050", blue: "#4a90d9",
};
const S = {
  btn: (active, color = C.gold) => ({
    background: active ? color : "transparent",
    color: active ? "#000" : C.muted,
    border: `1px solid ${active ? color : C.faint}`,
    padding: "6px 12px", fontSize: 10, letterSpacing: 1,
    cursor: "pointer", fontFamily: "'Courier New', monospace",
    borderRadius: 4, transition: "all 0.15s",
  }),
  card: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 },
  label: { fontSize: 10, color: C.muted, letterSpacing: 2, marginBottom: 8, display: "block" },
};

// ─── Setup Screen ─────────────────────────────────────────────────────────────
function SetupScreen({ onSave }) {
  const [selectedApi, setSelectedApi] = useState("ondevice");
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const api = APIS[selectedApi];

  const handleSave = () => {
    if (api.noKey) {
      setSuccess(true);
      localStorage.setItem("mt_active_api", selectedApi);
      setTimeout(() => onSave(selectedApi, "ondevice"), 600);
      return;
    }
    const trimmed = key.trim();
    if (!trimmed) { setError("Paste your API key first."); return; }
    const err = api.validate(trimmed);
    if (err) { setError(err); return; }
    setSuccess(true);
    const stored = JSON.parse(localStorage.getItem("mt_keys") || "{}");
    stored[selectedApi] = trimmed;
    localStorage.setItem("mt_keys", JSON.stringify(stored));
    localStorage.setItem("mt_active_api", selectedApi);
    setTimeout(() => onSave(selectedApi, trimmed), 600);
  };

  return (
    <div style={{ height: "100vh", background: C.bg, color: C.text, fontFamily: "'Courier New', monospace", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ background: C.surface, borderBottom: `2px solid ${C.gold}`, height: 52, display: "flex", alignItems: "center", padding: "0 20px", gap: 12 }}>
        <span style={{ fontFamily: "Bangers, cursive", fontSize: 22, letterSpacing: 3, color: C.gold }}>Manga Translator</span>
        <span style={{ fontSize: 10, color: C.muted, letterSpacing: 2 }}>SETUP</span>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "20px 16px 32px" }}>
        <div style={{ fontFamily: "Bangers, cursive", fontSize: 17, letterSpacing: 3, color: C.gold, marginBottom: 16, textAlign: "center" }}>
          CHOOSE YOUR AI ENGINE
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
          {Object.values(APIS).map(a => (
            <div key={a.id}
              onClick={() => { setSelectedApi(a.id); setKey(""); setError(""); setSuccess(false); }}
              style={{ background: selectedApi === a.id ? "#1a1800" : C.surface, border: `2px solid ${selectedApi === a.id ? C.gold : C.faint}`, borderRadius: 10, padding: "12px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, transition: "all 0.15s" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: selectedApi === a.id ? C.gold : C.text, fontWeight: "bold", marginBottom: 2 }}>{a.name}</div>
                <div style={{ fontSize: 10, color: C.muted }}>{a.hint}</div>
              </div>
              <div style={{ background: a.badgeColor + "22", border: `1px solid ${a.badgeColor}55`, color: a.badgeColor, fontSize: 9, letterSpacing: 1, padding: "3px 8px", borderRadius: 20 }}>{a.badge}</div>
              {selectedApi === a.id && <div style={{ color: C.gold, fontSize: 16 }}>●</div>}
            </div>
          ))}
        </div>

        <div style={{ ...S.card, marginBottom: 14, border: `1px solid ${success ? C.green : error ? C.red : C.border}`, transition: "border-color 0.2s" }}>
          <span style={S.label}>{api.name.toUpperCase()} — AUTHENTICATION</span>

          {api.noKey ? (
            <div style={{ background: "#0a1a0a", border: `1px solid ${C.green}33`, borderRadius: 8, padding: 16, textAlign: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📱</div>
              <div style={{ fontSize: 13, color: C.green, fontFamily: "Bangers, cursive", letterSpacing: 2, marginBottom: 6 }}>NO API KEY NEEDED</div>
              <div style={{ fontSize: 11, color: "#888", lineHeight: 1.7 }}>Downloads a ~150MB translation model once on first use, then runs fully offline forever. No cost, no limits.</div>
            </div>
          ) : (
            <>
              {api.keyUrl && (
                <a href={api.keyUrl} target="_blank" rel="noopener noreferrer"
                  style={{ display: "block", background: "#0a1520", border: `1px solid ${C.blue}55`, color: C.blue, padding: "9px 12px", borderRadius: 7, fontSize: 13, textDecoration: "none", textAlign: "center", marginBottom: 12, fontFamily: "Bangers, cursive", letterSpacing: 2 }}>
                  🔗 GET FREE KEY →
                </a>
              )}
              <div style={{ position: "relative", marginBottom: 12 }}>
                <input type={show ? "text" : "password"} value={key}
                  onChange={e => { setKey(e.target.value); setError(""); setSuccess(false); }}
                  placeholder={api.placeholder} autoComplete="off"
                  style={{ width: "100%", background: C.bg, border: `1px solid ${C.faint}`, borderRadius: 7, padding: "12px 44px 12px 12px", color: C.text, fontSize: 12, fontFamily: "'Courier New', monospace", outline: "none" }} />
                <button onClick={() => setShow(s => !s)}
                  style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 17, padding: 0 }}>
                  {show ? "🙈" : "👁️"}
                </button>
              </div>
            </>
          )}

          {error   && <div style={{ background: "#1a0808", border: `1px solid ${C.red}33`, borderRadius: 6, padding: "8px 12px", fontSize: 11, color: C.red, marginBottom: 10 }}>⚠️ {error}</div>}
          {success && <div style={{ background: "#081a08", border: `1px solid ${C.green}33`, borderRadius: 6, padding: "8px 12px", fontSize: 11, color: C.green, textAlign: "center", marginBottom: 10 }}>✅ Saved! Opening app…</div>}

          <button onClick={handleSave} disabled={(!key.trim() && !api.noKey) || success}
            style={{ width: "100%", background: success ? C.green : (key.trim() || api.noKey) ? C.gold : C.faint, color: success || key.trim() || api.noKey ? "#000" : C.muted, border: "none", padding: "13px 0", fontFamily: "Bangers, cursive", fontSize: 15, letterSpacing: 3, cursor: (key.trim() || api.noKey) && !success ? "pointer" : "not-allowed", borderRadius: 8, transition: "all 0.2s" }}>
            {success ? "✅ OPENING…" : "SAVE & START →"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Settings Drawer ──────────────────────────────────────────────────────────
function SettingsDrawer({ activeApi, setActiveApi, keys, setKeys, targetLang, setTargetLang, fontStyle, setFontStyle, memoryTier, setMemoryTierVal, onClose }) {
  const [editApi, setEditApi] = useState(activeApi);
  const [keyInput, setKeyInput] = useState(keys[activeApi] ? "••••" + keys[activeApi].slice(-4) : "");
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState(false);

  const saveKey = () => {
    if (APIS[editApi].noKey) {
      setActiveApi(editApi);
      localStorage.setItem("mt_active_api", editApi);
      setSaved(true);
      setTimeout(() => { setSaved(false); onClose(); }, 600);
      return;
    }
    const t = keyInput.trim();
    if (t.startsWith("•")) {
      setActiveApi(editApi);
      localStorage.setItem("mt_active_api", editApi);
      setSaved(true);
      setTimeout(() => { setSaved(false); onClose(); }, 600);
      return;
    }
    const err = APIS[editApi].validate(t);
    if (err) { alert(err); return; }
    const newKeys = { ...keys, [editApi]: t };
    setKeys(newKeys);
    setActiveApi(editApi);
    localStorage.setItem("mt_keys", JSON.stringify(newKeys));
    localStorage.setItem("mt_active_api", editApi);
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 600);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 200, display: "flex", alignItems: "flex-end" }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ width: "100%", background: C.surface, borderRadius: "16px 16px 0 0", border: `1px solid ${C.border}`, padding: "18px 16px 32px", maxHeight: "88vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <span style={{ fontFamily: "Bangers, cursive", fontSize: 20, letterSpacing: 3, color: C.gold }}>SETTINGS</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.muted, fontSize: 22, cursor: "pointer" }}>✕</button>
        </div>

        {/* Target language */}
        <div style={{ marginBottom: 18 }}>
          <span style={S.label}>TRANSLATE INTO</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {LANGUAGES.map(l => (
              <button key={l.code} onClick={() => { setTargetLang(l.code); localStorage.setItem("mt_target_lang", l.code); }}
                style={{ ...S.btn(targetLang === l.code), fontSize: 11, padding: "5px 10px" }}>
                {l.label}
              </button>
            ))}
          </div>
        </div>

        {/* Font style */}
        <div style={{ marginBottom: 18 }}>
          <span style={S.label}>FONT STYLE</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {Object.entries(FONT_STYLES).map(([id, f]) => (
              <button key={id} onClick={() => { setFontStyle(id); localStorage.setItem("mt_font", id); }}
                style={{ ...S.btn(fontStyle === id), fontFamily: f.css(14).split(" ").slice(1).join(" "), fontSize: 13, padding: "7px 14px" }}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Memory tier */}
        {activeApi === "ondevice" && (
          <div style={{ marginBottom: 18 }}>
            <span style={S.label}>ON-DEVICE MEMORY LIMIT</span>
            <div style={{ display: "flex", gap: 8 }}>
              {Object.entries(MEMORY_TIERS).map(([id, t]) => (
                <button key={id} onClick={() => { setMemoryTierVal(id); localStorage.setItem("mt_memory", id); }}
                  style={{ flex: 1, ...S.btn(memoryTier === id, C.green), padding: "10px 6px", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                  <span style={{ fontSize: 11 }}>{t.label}</span>
                  <span style={{ fontSize: 9, opacity: 0.7 }}>{t.description}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* AI engine switcher */}
        <div style={{ marginBottom: 14 }}>
          <span style={S.label}>AI ENGINE</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
            {Object.values(APIS).map(a => (
              <div key={a.id} onClick={() => { setEditApi(a.id); setKeyInput(keys[a.id] ? "••••" + keys[a.id].slice(-4) : ""); setShow(false); }}
                style={{ background: editApi === a.id ? "#1a1800" : C.bg, border: `1px solid ${editApi === a.id ? C.gold : C.faint}`, borderRadius: 8, padding: "9px 12px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 12, color: editApi === a.id ? C.gold : C.text }}>{a.name}</div>
                  <div style={{ fontSize: 10, color: C.muted }}>{a.noKey ? "No key needed" : keys[a.id] ? "Key saved ✓" : "No key"}</div>
                </div>
                <div style={{ color: a.badgeColor, fontSize: 9, letterSpacing: 1 }}>{a.badge}</div>
              </div>
            ))}
          </div>

          {!APIS[editApi].noKey && (
            <div style={{ position: "relative", marginBottom: 8 }}>
              <input type={show ? "text" : "password"} value={keyInput}
                onChange={e => setKeyInput(e.target.value)}
                placeholder={APIS[editApi].placeholder}
                style={{ width: "100%", background: C.bg, border: `1px solid ${C.faint}`, borderRadius: 7, padding: "10px 44px 10px 12px", color: C.text, fontSize: 12, fontFamily: "'Courier New', monospace", outline: "none" }} />
              <button onClick={() => setShow(s => !s)}
                style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 16 }}>
                {show ? "🙈" : "👁️"}
              </button>
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            {APIS[editApi].keyUrl && (
              <a href={APIS[editApi].keyUrl} target="_blank" rel="noopener noreferrer"
                style={{ flex: 1, background: "#0a1520", border: `1px solid ${C.blue}55`, color: C.blue, padding: "9px", borderRadius: 7, fontSize: 11, textDecoration: "none", textAlign: "center", fontFamily: "Bangers, cursive", letterSpacing: 1 }}>
                GET KEY →
              </a>
            )}
            <button onClick={saveKey}
              style={{ flex: 2, background: saved ? C.green : C.gold, color: "#000", border: "none", padding: "9px", fontFamily: "Bangers, cursive", fontSize: 13, letterSpacing: 2, cursor: "pointer", borderRadius: 7 }}>
              {saved ? "✅ SAVED!" : `USE ${APIS[editApi].name.split(" ")[0].toUpperCase()}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── URL Scraper Tab ──────────────────────────────────────────────────────────
function URLTab({ onImagesReady }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState([]);
  const [error, setError] = useState("");
  const logRef = useRef(null);

  const addLog = msg => setLog(l => { const n = [...l, msg]; return n; });

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const handleScrape = async () => {
    if (!url.trim()) return;
    setLoading(true); setLog([]); setError("");
    try {
      addLog(`🌐 Connecting to ${new URL(url.trim()).hostname}…`);
      const dataUrls = await scrapeURL(url.trim(), addLog);
      if (!dataUrls.length) throw new Error("No manga pages found on this URL.");
      addLog(`✅ Downloaded ${dataUrls.length} page${dataUrls.length > 1 ? "s" : ""} — starting translation…`);
      onImagesReady(dataUrls, url.trim());
    } catch (e) {
      setError(e.message);
      addLog(`❌ ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const examples = [
    "https://mangadex.org/chapter/...",
    "https://any-manga-site.com/chapter-1",
  ];

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
      <div style={{ ...S.card, marginBottom: 14 }}>
        <span style={S.label}>MANGA CHAPTER URL</span>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === "Enter" && !loading && handleScrape()}
            placeholder="https://mangadex.org/chapter/..."
            style={{ flex: 1, background: C.bg, border: `1px solid ${C.faint}`, borderRadius: 7, padding: "11px 12px", color: C.text, fontSize: 12, fontFamily: "'Courier New', monospace", outline: "none" }}
          />
          <button onClick={handleScrape} disabled={loading || !url.trim()}
            style={{ background: loading || !url.trim() ? C.faint : C.gold, color: loading || !url.trim() ? C.muted : "#000", border: "none", padding: "11px 18px", fontFamily: "Bangers, cursive", fontSize: 14, letterSpacing: 2, cursor: loading || !url.trim() ? "not-allowed" : "pointer", borderRadius: 7, whiteSpace: "nowrap", transition: "all 0.15s" }}>
            {loading ? "⟳ LOADING…" : "FETCH →"}
          </button>
        </div>

        <div style={{ fontSize: 10, color: C.muted, lineHeight: 1.8 }}>
          ✅ <span style={{ color: C.green }}>MangaDex</span> — full API support, best quality<br/>
          🌐 <span style={{ color: "#aaa" }}>Any manga site</span> — auto image extraction
        </div>
      </div>

      {error && (
        <div style={{ background: "#1a0808", border: `1px solid ${C.red}33`, borderRadius: 10, padding: 14, marginBottom: 14, fontSize: 12, color: C.red, lineHeight: 1.7 }}>
          ⚠️ {error}
        </div>
      )}

      {log.length > 0 && (
        <div ref={logRef} style={{ background: "#080808", border: `1px solid ${C.faint}`, borderRadius: 8, padding: "10px 12px", maxHeight: 200, overflowY: "auto", marginBottom: 14 }}>
          {log.map((l, i) => <div key={i} style={{ fontSize: 11, lineHeight: 1.8, color: l.startsWith("❌") ? C.red : l.startsWith("✅") ? C.green : "#4a4a4a", borderBottom: "1px solid #111", padding: "1px 0" }}>{l}</div>)}
        </div>
      )}

      {/* Tips */}
      <div style={{ ...S.card, fontSize: 11, color: C.muted, lineHeight: 1.9 }}>
        <div style={{ color: C.gold, fontFamily: "Bangers, cursive", fontSize: 13, letterSpacing: 2, marginBottom: 8 }}>💡 TIPS</div>
        <div>• Paste a <span style={{ color: C.text }}>chapter page URL</span>, not the manga homepage</div>
        <div>• MangaDex URLs look like: <span style={{ color: "#aaa", fontFamily: "monospace" }}>mangadex.org/chapter/UUID</span></div>
        <div>• If a site blocks scraping, save the pages as a <span style={{ color: C.text }}>.cbz file</span> and use the File tab instead</div>
        <div>• Some sites require login — the app can't bypass that</div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const storedKeys = JSON.parse(localStorage.getItem("mt_keys") || "{}");
  const storedApi  = localStorage.getItem("mt_active_api") || "";

  const [keys, setKeys]           = useState(storedKeys);
  const [activeApi, setActiveApi] = useState(storedApi || "ondevice");
  const [setupDone, setSetupDone] = useState(!!(storedApi && (APIS[storedApi]?.noKey || storedKeys[storedApi])));
  const [targetLang, setTargetLang] = useState(localStorage.getItem("mt_target_lang") || "English");
  const [fontStyle, setFontStyle]   = useState(localStorage.getItem("mt_font") || "bangers");
  const [memoryTier, setMemoryTierVal] = useState(localStorage.getItem("mt_memory") || "medium");

  const [tab, setTab]         = useState("file"); // "file" | "url"
  const [view, setView]       = useState("translate"); // "translate" | "reader"
  const [pages, setPages]     = useState([]);
  const [status, setStatus]   = useState("idle");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [log, setLog]         = useState([]);
  const [viewerWidth, setViewerWidth] = useState(100);
  const [showSettings, setShowSettings] = useState(false);
  const [fontReady, setFontReady] = useState(false);

  const outputsRef = useRef([]);
  const logEndRef  = useRef(null);

  useEffect(() => { loadFonts().then(() => setFontReady(true)); }, []);
  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [log]);

  if (!setupDone) {
    return <SetupScreen onSave={(apiId, k) => {
      const newKeys = { ...keys, [apiId]: k };
      setKeys(newKeys); setActiveApi(apiId); setSetupDone(true);
    }} />;
  }

  const addLog = msg => setLog(l => [...l, msg]);
  const BATCH_SIZE = activeApi === "gemini" ? 3 : 6;

  // ── Core translate pipeline ──────────────────────────────────────────────────
  const translateDataUrls = async (dataUrls, sourceLabel) => {
    if (!fontReady) await loadFonts();
    setStatus("loading"); setLog([]); setPages([]); outputsRef.current = [];
    const apiKey = keys[activeApi];

    if (activeApi !== "ondevice" && !apiKey) {
      addLog("❌ No API key — open Settings");
      setStatus("error"); return;
    }

    const totalPages = dataUrls.length;
    addLog(`📚 ${sourceLabel} — ${totalPages} page${totalPages > 1 ? "s" : ""} → ${targetLang} via ${APIS[activeApi].name}`);
    setProgress({ current: 0, total: totalPages });
    const results = new Array(totalPages).fill(null);

    try {
      if (activeApi === "ondevice") {
        setMemoryTier(memoryTier);
        for (let i = 0; i < totalPages; i++) {
          setProgress({ current: i + 1, total: totalPages });
          addLog(`🔄 [${i+1}/${totalPages}] Page ${i + 1}`);
          let bubbles = [];
          try {
            const r = await translatePageOnDevice(dataUrls[i], "chi_sim", targetLang, addLog, addLog);
            bubbles = r.bubbles || [];
          } catch (e) { addLog(`   ⚠️  ${e.message}`); }
          const img = await loadImg(dataUrls[i]);
          const canvas = document.createElement("canvas");
          drawTranslations(canvas, img, bubbles, fontStyle);
          results[i] = { name: `page-${String(i+1).padStart(3,"0")}.jpg`, src: canvas.toDataURL("image/jpeg", 0.93) };
          outputsRef.current = results.filter(Boolean);
          setPages([...outputsRef.current]);
        }
        await cleanupOnDevice();
      } else {
        const numBatches = Math.ceil(totalPages / BATCH_SIZE);
        addLog(`📦 ${numBatches} batch${numBatches > 1 ? "es" : ""} of up to ${BATCH_SIZE} pages`);

        for (let bi = 0; bi < numBatches; bi++) {
          const start = bi * BATCH_SIZE;
          const end   = Math.min(start + BATCH_SIZE, totalPages);
          const batchUrls = dataUrls.slice(start, end);
          addLog(`🔄 Batch ${bi+1}/${numBatches} — pages ${start+1}–${end}`);

          const { b64, offsets, totalH } = await stitchImages(batchUrls);
          addLog(`   🖼  ${Math.round(b64.length * 0.75 / 1024)}KB stitched`);

          let perPage = batchUrls.map(() => []);
          try {
            const r = await withRetry(() => callAPI(b64, activeApi, apiKey, targetLang));
            const bubbles = r.bubbles || [];
            addLog(`   ✅ ${bubbles.length} bubbles across ${batchUrls.length} pages`);
            perPage = remapBubbles(bubbles, offsets, totalH);
          } catch (e) {
            if (e.message === "RATE_LIMIT") addLog("   ⏳ Rate limit hit even after retries");
            else if (e.message.startsWith("AUTH_FAILED")) addLog("   🔑 Key rejected — open Settings");
            else addLog(`   ⚠️  ${e.message}`);
          }

          for (let i = 0; i < batchUrls.length; i++) {
            const idx = start + i;
            const img = await loadImg(batchUrls[i]);
            const canvas = document.createElement("canvas");
            drawTranslations(canvas, img, perPage[i] || [], fontStyle);
            results[idx] = { name: `page-${String(idx+1).padStart(3,"0")}.jpg`, src: canvas.toDataURL("image/jpeg", 0.93) };
            setProgress({ current: idx + 1, total: totalPages });
            outputsRef.current = results.filter(Boolean);
            setPages([...outputsRef.current]);
          }

          if (bi < numBatches - 1 && activeApi === "gemini") {
            addLog("   ⏱  15s cool-down…");
            await new Promise(r => setTimeout(r, 15000));
          }
        }
      }

      setStatus("done");
      addLog(`✅ Done! ${totalPages} pages translated → ${targetLang}`);
    } catch (e) {
      setStatus("error"); addLog(`❌ ${e.message}`);
    }
  };

  // ── File tab handlers ────────────────────────────────────────────────────────
  const processCBZ = async file => {
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(file);
    const imageFiles = Object.keys(zip.files)
      .filter(n => /\.(jpg|jpeg|png)$/i.test(n) && !zip.files[n].dir).sort();
    if (!imageFiles.length) { addLog("❌ No images found in archive"); return; }
    addLog(`📦 Extracting ${imageFiles.length} pages…`);
    const dataUrls = [];
    for (const name of imageFiles) {
      const blob = await zip.files[name].async("blob");
      dataUrls.push(await blobToDataUrl(blob));
    }
    await translateDataUrls(dataUrls, file.name);
  };

  const pct = progress.total ? Math.round((progress.current / progress.total) * 100) : 0;
  const apiInfo = APIS[activeApi];
  const langLabel = LANGUAGES.find(l => l.code === targetLang)?.label || targetLang;

  // ── File Tab UI ──────────────────────────────────────────────────────────────
  const FileTab = (
    <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
      {/* Status bar */}
      <div style={{ background: C.surface, border: `1px solid ${C.faint}`, borderRadius: 8, padding: "8px 12px", marginBottom: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, color: C.muted }}>ENGINE</span>
        <span style={{ fontSize: 11, color: C.gold, fontFamily: "Bangers, cursive", letterSpacing: 2 }}>{apiInfo?.name}</span>
        <span style={{ fontSize: 10, color: C.muted }}>→</span>
        <span style={{ fontSize: 11, color: C.text }}>{langLabel}</span>
        <button onClick={() => setShowSettings(true)} style={{ marginLeft: "auto", ...S.btn(false), fontSize: 10, padding: "3px 9px" }}>⚙ Settings</button>
      </div>

      {/* Drop zone */}
      <div
        onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) processCBZ(f); }}
        onDragOver={e => e.preventDefault()}
        onClick={() => document.getElementById("cbz-input").click()}
        style={{ border: `2px dashed ${C.gold}`, padding: "28px 16px", textAlign: "center", cursor: "pointer", borderRadius: 10, background: C.bg, marginBottom: 12 }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>📚</div>
        <div style={{ fontFamily: "Bangers, cursive", fontSize: 20, letterSpacing: 3, color: C.gold }}>TAP TO OPEN CBZ</div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>or drag & drop · Auto-detects language</div>
        <input id="cbz-input" type="file" accept=".cbz,.zip" style={{ display: "none" }}
          onChange={e => e.target.files[0] && processCBZ(e.target.files[0])} />
      </div>

      {/* Progress */}
      {status !== "idle" && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.muted, marginBottom: 5, letterSpacing: 1 }}>
            <span>{status === "done" ? "COMPLETE" : "TRANSLATING"}</span>
            <span style={{ color: status === "done" ? C.green : C.gold }}>{progress.current}/{progress.total} — {pct}%</span>
          </div>
          <div style={{ height: 4, background: "#1a1a1a", borderRadius: 2 }}>
            <div style={{ height: "100%", width: `${pct}%`, background: status === "done" ? C.green : C.gold, borderRadius: 2, transition: "width 0.3s" }} />
          </div>
        </div>
      )}

      {/* Action buttons */}
      {status === "done" && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button onClick={() => setView("reader")}
            style={{ flex: 2, background: C.gold, color: "#000", border: "none", padding: "13px 0", fontFamily: "Bangers, cursive", fontSize: 14, letterSpacing: 2, cursor: "pointer", borderRadius: 8 }}>
            📖 READ
          </button>
          <button onClick={() => outputsRef.current.forEach(({ name, src }) => { const a = document.createElement("a"); a.href = src; a.download = name; a.click(); })}
            style={{ flex: 1, background: "transparent", color: "#888", border: `1px solid ${C.border}`, padding: "13px 0", fontFamily: "Bangers, cursive", fontSize: 12, letterSpacing: 2, cursor: "pointer", borderRadius: 8 }}>
            ↓ SAVE
          </button>
        </div>
      )}

      {/* Log */}
      {log.length > 0 && (
        <div style={{ background: "#080808", border: `1px solid ${C.faint}`, borderRadius: 8, padding: "8px 10px", maxHeight: 160, overflowY: "auto", marginBottom: 12 }}>
          {log.map((l, i) => <div key={i} ref={i === log.length - 1 ? logEndRef : null} style={{ fontSize: 10, lineHeight: 1.8, color: l.startsWith("❌") ? C.red : l.startsWith("✅") ? C.green : "#4a4a4a", borderBottom: "1px solid #111", padding: "1px 0" }}>{l}</div>)}
        </div>
      )}

      {/* Thumbnails */}
      {pages.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 7 }}>
          {pages.map(({ name, src }, i) => (
            <div key={name} onClick={() => { setView("reader"); setTimeout(() => document.getElementById(`pg-${i}`)?.scrollIntoView({ behavior: "smooth" }), 100); }}
              style={{ borderRadius: 6, overflow: "hidden", cursor: "pointer", border: `1px solid ${C.faint}` }}>
              <img src={src} alt={name} style={{ width: "100%", display: "block" }} />
            </div>
          ))}
        </div>
      )}

      {pages.length === 0 && status === "idle" && (
        <div style={{ textAlign: "center", padding: "32px 0", color: "#1c1c1c" }}>
          <div style={{ fontFamily: "Bangers, cursive", fontSize: 52, letterSpacing: 8 }}>漫画</div>
          <div style={{ fontSize: 10, letterSpacing: 3, marginTop: 6 }}>OPEN A FILE OR FETCH A URL TO BEGIN</div>
        </div>
      )}
    </div>
  );

  // ── Reader UI ────────────────────────────────────────────────────────────────
  const ReaderView = (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ background: "#181818", borderBottom: `1px solid ${C.faint}`, padding: "8px 14px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <span style={{ fontSize: 9, color: C.muted, letterSpacing: 2, whiteSpace: "nowrap" }}>WIDTH</span>
        <input type="range" min={40} max={100} value={viewerWidth}
          onChange={e => setViewerWidth(Number(e.target.value))}
          style={{ flex: 1, accentColor: C.gold }} />
        <span style={{ fontSize: 11, color: C.gold, fontFamily: "Bangers, cursive", letterSpacing: 2, minWidth: 38 }}>{viewerWidth}%</span>
        {[["S",60],["M",80],["L",100]].map(([l,w]) => (
          <button key={l} onClick={() => setViewerWidth(w)} style={{ ...S.btn(viewerWidth === w), padding: "3px 9px" }}>{l}</button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto", background: "#070707" }}>
        <div style={{ margin: "0 auto", width: `${viewerWidth}%` }}>
          {pages.map(({ name, src }, i) => (
            <img key={name} id={`pg-${i}`} src={src} alt={name}
              style={{ width: "100%", display: "block", margin: 0, padding: 0 }} />
          ))}
        </div>
      </div>
    </div>
  );

  // ── App Shell ────────────────────────────────────────────────────────────────
  return (
    <div style={{ height: "100vh", background: C.bg, color: C.text, fontFamily: "'Courier New', monospace", display: "flex", flexDirection: "column", overflow: "hidden" }}>

      {/* Top bar */}
      <div style={{ background: C.surface, borderBottom: `2px solid ${C.gold}`, height: 50, display: "flex", alignItems: "center", padding: "0 14px", gap: 10, flexShrink: 0 }}>
        <span style={{ fontFamily: "Bangers, cursive", fontSize: 20, letterSpacing: 2, color: C.gold }}>Manga Translator</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {view === "reader" && (
            <button onClick={() => setView("translate")} style={{ ...S.btn(false), fontSize: 10 }}>← BACK</button>
          )}
          {view === "translate" && (
            <button onClick={() => setView("reader")} disabled={pages.length === 0}
              style={{ ...S.btn(false), fontSize: 10, opacity: pages.length === 0 ? 0.3 : 1 }}>
              📖 READER
            </button>
          )}
          <button onClick={() => setShowSettings(true)}
            style={{ background: "transparent", border: `1px solid ${C.faint}`, color: C.muted, padding: "5px 9px", fontSize: 14, cursor: "pointer", borderRadius: 4 }}>
            ⚙️
          </button>
        </div>
      </div>

      {/* Tab bar — only shown in translate view */}
      {view === "translate" && (
        <div style={{ background: C.surface2, borderBottom: `1px solid ${C.faint}`, display: "flex", flexShrink: 0 }}>
          {[
            { id: "file", label: "📂 File / CBZ" },
            { id: "url",  label: "🌐 URL / Website" },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{ flex: 1, padding: "11px 0", background: "transparent", border: "none", borderBottom: `2px solid ${tab === t.id ? C.gold : "transparent"}`, color: tab === t.id ? C.gold : C.muted, fontFamily: "Bangers, cursive", fontSize: 13, letterSpacing: 2, cursor: "pointer", transition: "all 0.15s" }}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {view === "translate"
          ? tab === "file"
            ? FileTab
            : <URLTab onImagesReady={(dataUrls, srcUrl) => {
                setTab("file"); // switch to file tab to show progress
                translateDataUrls(dataUrls, srcUrl);
              }} />
          : ReaderView
        }
      </div>

      {showSettings && (
        <SettingsDrawer
          activeApi={activeApi} setActiveApi={setActiveApi}
          keys={keys} setKeys={setKeys}
          targetLang={targetLang} setTargetLang={setTargetLang}
          fontStyle={fontStyle} setFontStyle={setFontStyle}
          memoryTier={memoryTier} setMemoryTierVal={setMemoryTierVal}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
