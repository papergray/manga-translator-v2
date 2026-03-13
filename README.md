# Manga Translator

> Translate Chinese, Japanese and Korean manga into any language — from `.cbz` files or directly from any manga website URL.

<div align="center">

![Android](https://img.shields.io/badge/Android-7.0%2B-green?style=flat-square&logo=android)
![Windows](https://img.shields.io/badge/Windows-10%2F11-blue?style=flat-square&logo=windows)
![License](https://img.shields.io/badge/license-MIT-gray?style=flat-square)
![Open Source](https://img.shields.io/badge/open%20source-yes-brightgreen?style=flat-square)

**[⬇ Download Latest Release](../../releases/latest)**

</div>

> 💡 **After pushing your first release**, add this badge by replacing `YOUR_USERNAME` with your GitHub username:
> ```
> ![Release](https://img.shields.io/github/v/release/YOUR_USERNAME/manga-translator?style=flat-square&color=d4a017)
> ```

---

## Features

- **Two input methods**: open a `.cbz` file *or* paste a manga chapter URL
- **URL scraping**: auto-downloads pages from MangaDex (full API) and most manga reader sites
- **Auto language detection**: Chinese (Simplified/Traditional), Japanese, Korean, and more
- **15 output languages**: English, Spanish, French, German, Japanese, Korean, Arabic, Russian, Hindi, Turkish, and more
- **On-device AI**: runs a local translation model on your device — no internet, no limits, no cost after the first ~150MB download
- **Multiple cloud AI engines**: Claude, Gemini, GPT-4o, Mistral
- **Clean text erasure**: samples bubble background color and triple-fills over original characters
- **4 manga font styles**: Bangers, Comic Neue, Caveat (handwritten), Permanent Marker
- **Webtoon reader**: vertical scroll with adjustable width

---

## AI Engines

| Engine | Cost | Internet | Notes |
|--------|------|----------|-------|
| 📱 **On-Device** | Free forever | First download only | Local AI on your device — no cloud, no limits |
| ✨ **Google Gemini** | Free (1,500/day) | Yes | Best free cloud option · [Get key](https://aistudio.google.com/app/apikey) |
| 🧠 **Anthropic Claude** | Paid | Yes | Powered by [Claude AI](https://anthropic.com) — excellent at understanding manga tone, humor, and honorifics · [Get key](https://console.anthropic.com/settings/keys) |
| 💬 **OpenAI GPT-4o** | Paid | Yes | [Get key](https://platform.openai.com/api-keys) |
| ⚡ **Mistral Pixtral** | Free tier | Yes | [Get key](https://console.mistral.ai/api-keys) |

> **Why Claude?** Anthropic's Claude understands manga-specific context — honorifics, SFX, character speech styles, and humor — producing translations that read naturally rather than literally.

---

## URL Scraping

Paste any manga chapter URL into the **URL / Website** tab:

| Site | Support |
|------|---------|
| **MangaDex** | ✅ Full API — best quality, no blocking |
| Any manga reader site | 🔄 Generic auto image extraction |

**Supported MangaDex URL format:**
```
https://mangadex.org/chapter/CHAPTER-UUID
```

---

## Download

Go to **[Releases](../../releases/latest)** for the latest builds:

| Platform | File |
|----------|------|
| 🤖 Android | `MangaTranslator-vX.X.X-Android.apk` |
| 🪟 Windows (installer) | `MangaTranslator-vX.X.X-Windows-Setup.exe` |
| 🪟 Windows (portable) | `MangaTranslator-vX.X.X-Windows-Portable.exe` |

> Replace `vX.X.X` with the version shown in the release, e.g. `v2.1.0`

---

## Building from source

```
manga-translator/
├── android/          ← Android app (React + Capacitor)
│   └── src/
│       ├── App.jsx       ← main UI (shared with Windows)
│       ├── scraper.js    ← URL scraping logic
│       └── ondevice.js   ← on-device OCR + translation
├── windows/          ← Windows app (React + Electron)
│   ├── electron/
│   │   └── main.js       ← Electron shell + IPC fetch handlers
│   └── src/
│       └── App.jsx       ← same UI, desktop tweaks
└── .github/workflows/
    └── release.yml       ← builds both + publishes release
```

### Android
```bash
cd android
npm install
npm run build
npx cap add android
npx cap sync android
cd android && ./gradlew assembleDebug
```

### Windows
```bash
cd windows
npm install
npm run dist    # → windows/release/*.exe
```

### Release (automated)
Push a version tag — both apps build automatically and attach to a GitHub Release:
```bash
git tag v2.0.0
git push origin v2.0.0
```

---

## Files changed vs v1

| File | Change |
|------|--------|
| `android/src/App.jsx` | New name, URL tab, Settings drawer, full rewrite |
| `windows/src/App.jsx` | Same as Android + desktop layout (wider grid, 70% default width) |
| `android/src/scraper.js` | **New** — URL scraping for MangaDex + generic sites |
| `windows/src/scraper.js` | Same as Android (uses Electron IPC for native fetch) |
| `windows/electron/main.js` | IPC handlers for CORS-free image/HTML fetching |
| `android/src/ondevice.js` | Unchanged |
| `android/package.json` | Added tesseract.js, @xenova/transformers |
| `windows/package.json` | Same + electron, electron-builder |
| `.github/workflows/release.yml` | Builds both apps, creates release |

---

## License

MIT — free to use, modify, and distribute.
