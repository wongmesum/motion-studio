<!-- markdownlint-disable MD013 -->

# 🎬 Motion Studio — ChatGPT MCP + Higgsfield AI + DeepSeek Engineer + VPS Render Farm

Project produksi untuk membuat **Motion Graphics 1080p @ 60fps** secara deterministik menggunakan **JavaScript, Playwright + Chromium Headless, Canvas 2D, GSAP via CDN, Sharp, dan FFmpeg**, diorkestrasi dari **ChatGPT (via MCP)** dengan **Higgsfield AI** sebagai generator asset dan **DeepSeek Render Engineer** sebagai 5-Stage Automated Quality Gate di dalam VPS.

Gesture overlays use geometry from three bundled Lottie assets with local animation.
Two additional assets are catalog entries only. See [supported features and asset attribution](docs/gesture-lottie.md).

---

## 🗺️ Peta Arsitektur & 5 Pilar Stack

```text
┌──────────────┐
│  USER        │  "Bikin video promo 10 detik, background kota futuristik,
└──────┬───────┘   teks 'AI 2025' muncul dengan efek glitch"
       ▼
┌──────────────────────────────────────────────┐
│  ChatGPT (Director / Orchestrator)           │
└──────┬───────────────────────────────────────┘
       │ MCP Protocol (motion-mcp)
       ├─────────────────────────┬─────────────────────────┐
       ▼                         ▼                         ▼
┌──────────────┐        ┌──────────────────┐      ┌──────────────────┐
│ Higgsfield   │        │ VPS Render Farm  │      │ DeepSeek Engineer│
│ Image/Video  │        │ Express + BullMQ │      │ 5-Stage Gate:    │
└──────────────┘        └────────┬─────────┘      │ 1. Validate      │
                                 │                │ 2. Optimize      │
                                 ▼                │ 3. Test 3 Frame  │
                        ┌──────────────────┐      │ 4. Auto-Fix      │
                        │ Parallel Render  │◄─────┤ 5. Approve Hash  │
                        │ Playwright+FFmpeg│      └──────────────────┘
                        └────────┬─────────┘
                                 ▼
                         1080p @ 60fps MP4
```

### Peta Stack 5 Pilar yang Diimplementasikan

1. **[1] Render Engine**: Playwright + Chromium Headless (`--use-gl=swiftshader`, Parallel Chunked Workers).
2. **[2] Compositor**: FFmpeg (frame sequence JPEG/PNG → MP4, multi-codec, audio AAC opsional).
3. **[3] Encoder**: Multi-codec `libx264` (H.264), `libx265` (HEVC), `libsvtav1` (AV1), dan `h264_nvenc` (GPU).
4. **[4] Motion Layer**: GSAP Timeline via CDN (`tl.seek(t)`), Kinetic Glitch DOM/Canvas, Slideshow Ken Burns, dan Canvas 2D Video Mixer.
5. **[5] Asset Pipeline & Production Security**: Sharp image resizing/format conversion, Content-Addressable SHA-256 Cache, Token + HMAC Auth, Rate Limiting, HTML Sanitizer, Resource Limits, TTL Cleanup, Webhook Callback, dan Prometheus Metrics.

---

## 📂 Struktur Project

```text
motion-studio/
├── README.md
├── package.json
├── docker-compose.yml
├── .env.example
├── render.js                       # Standalone CLI Renderer (node render.js)
├── preview-studio.html             # Shell Video Builder (/studio) — prompt, scene, aset
├── studio-assets/                  # Modul ES front-end builder (disajikan lewat /api/studio/ui)
│   ├── api.js                      # Session, CSRF, fetch, pemetaan error
│   ├── state.js                    # Project state immutable, undo/redo, recovery draft
│   ├── prompt-panel.js             # Composer prompt + draft scene dari AI
│   ├── assets-panel.js             # Upload, daftar, drag, hapus aset
│   ├── timeline.js                 # Daftar scene, reorder, binding aset
│   ├── inspector.js                # Properti elemen terpilih
│   ├── preview-frame.js            # Iframe sandbox + transport postMessage
│   ├── render-panel.js             # Pengaturan render, submit, polling
│   ├── icons.js                    # Ikon SVG inline
│   ├── main.js                     # Wiring, keyboard, init
│   └── style.css                   # Design token + komponen
├── build.sh                        # Script pembuat motion-studio.zip (Linux/macOS)
├── build.ps1                       # Script pembuat motion-studio.zip (Windows PowerShell)
│
├── mcp-server/                     # MCP Connector untuk ChatGPT / Claude / Cursor
│   ├── package.json
│   ├── Dockerfile
│   ├── index.js                    # 6 MCP Tools utama
│   └── tools/
│       ├── higgsfield.js           # Generate Image & Video AI (dengan demo fallback)
│       ├── vps-render.js           # Client ke VPS Server (Token + HMAC Signature)
│       └── deepseek.js             # Animation Fixer/Generator (provider-aware via AI_PROVIDER)
│
├── vps-server/                     # Production Render Farm Server (Level 4 CPU/GPU)
│   ├── package.json
│   ├── Dockerfile
│   ├── server.js                   # Express API (/render, /jobs, /templates, /health, /metrics)
│   ├── queue.js                    # BullMQ + Redis Queue (dengan In-Memory Fallback otomatis)
│   ├── renderer.js                 # Parallel Chunked Playwright + Multi-codec FFmpeg
│   ├── studio-routes.js            # Router /api/studio (project, prompt, aset, compile, render)
│   ├── studio/                     # Domain video builder
│   │   ├── project-schema.js       # Skema project versioned + validasi ketat
│   │   ├── project-store.js        # CRUD atomik + revision conflict
│   │   ├── asset-store.js          # Penyimpanan aset upload + metadata
│   │   ├── upload-middleware.js    # Streaming upload (busboy) + validasi berlapis
│   │   ├── compile-project.js      # Compiler deterministik project -> HTML
│   │   ├── preview-assets.js       # Capability URL HMAC untuk aset preview
│   │   ├── scene-ai.js             # generateSceneDraft (provider-aware)
│   │   └── json-extract.js         # Ekstraksi JSON dari keluaran AI
│   ├── deepseek-engineer.js        # 5-Stage Gate: Validate → Optimize → Test → Fix → Approve
│   ├── deepseek-fixer.js           # Alias ekspor fixer
│   ├── cache.js                    # Content-Addressable SHA-256 Cache & Asset Deduplication
│   ├── storage.js                  # Sharp Asset Pipeline + MinIO S3 / Local Output Publisher
│   ├── cleanup.js                  # Cron TTL Cleanup otomatis (24 jam)
│   ├── webhook.js                  # HMAC-signed Webhook Callback
│   ├── logger.js                   # Structured JSON Logger + Prometheus Metrics
│   ├── middleware/
│   │   ├── auth.js                 # Token Auth, HMAC Verification, Rate Limiter
│   │   └── limits.js               # Validasi batas durasi, FPS, resolusi, ukuran HTML
│   ├── security/
│   │   └── sanitize.js             # Sanitasi keamanan HTML sebelum masuk Playwright
│   └── workers/
│       └── worker.js               # Dedicated BullMQ Worker Node
│
├── render-engine/                  # Template Animasi Deterministik 1080p @ 60fps
│   ├── templates/
│   │   ├── base.html               # GSAP Timeline + Glowing Bokeh Orbs
│   │   ├── kinetic-text.html       # Futuristic Neon City + Glitch "AI 2025"
│   │   ├── image-slideshow.html    # Ken Burns Zoom/Pan + Crossfade & Lower-Third
│   │   └── video-mixer.html        # Canvas Wireframe Tunnel + Dual PiP Video + Audio Spectrum
│
├── scripts/
│   ├── install-vps.sh              # Auto-installer Ubuntu 22.04/24.04
│   ├── build-ffmpeg.sh             # Installer FFmpeg Static Build (BtbN GPL)
│   ├── verify-stack.sh             # Verifikasi 5 Pilar Stack
│   ├── health-check.sh             # Monitoring & Auto-restart container
│   ├── backup-vps.sh               # Backup data, output, dan snapshot Redis
│   ├── restore-vps.sh              # Verifikasi checksum dan staging restore
│   └── enable-ssh-post-quantum.sh  # Uji lalu aktifkan hybrid PQ SSH KEX
│
└── examples/
    ├── demo-job.json               # Contoh payload JSON untuk POST /render
    └── chatgpt-system-prompt.md    # System Prompt siap pakai untuk ChatGPT
```

### Struktur Test

```text
tests/
├── studio-project-schema.test.js   # Skema + validasi + normalisasi
├── studio-project-store.test.js    # CRUD atomik, ownership, revision conflict
├── studio-asset-store.test.js      # Penyimpanan + magic bytes + traversal
├── studio-asset-routes.test.js     # Route upload/list/content/delete
├── studio-upload-policy.test.js    # Batas ukuran + content type + probe
├── studio-compile.test.js          # Injeksi JSON, sanitasi, target preview/render
├── studio-preview-assets.test.js   # Capability URL HMAC + expiry + tamper
├── studio-prompt.test.js           # AI -> scene JSON + rate limit
├── studio-json-extract.test.js     # Ekstraksi objek JSON dari keluaran AI
├── studio-template-hooks.test.js   # __ASSETS_READY__ / __AWAIT_FRAME__
├── studio-state.test.js            # Store front-end, undo/redo, revision
├── studio-builder.e2e.test.js      # Playwright: alur builder, sandbox, a11y
├── studio-ui-routes.test.js        # Route /api/studio/ui + allowlist
└── studio-render-panel.test.js     # Submit render + polling + proyeksi aman
```

---

## 🚀 Cara Menjalankan

### 1. Mode Cepat (Standalone CLI tanpa Server/Docker)

Langsung merender template HTML menjadi video `MP4` 1080p @ 60fps:

```bash
npm install
npx playwright install chromium

# Render template Kinetic Text ("AI 2025" Neon City Glitch)
npm run render:kinetic

# Atau render cepat mode Preview (480p @ 15fps)
node render.js --template render-engine/templates/kinetic-text.html --preview
```

### Audio

Server menerima `audio_url` hanya dari URL HTTPS dengan hostname persis dalam
`RENDER_ALLOWED_HOSTS`. Format yang didukung: MP3, WAV, M4A, dan AAC. Unduhan
dibatasi oleh `MAX_AUDIO_BYTES` dan `MAX_AUDIO_DOWNLOAD_MS`, lalu divalidasi lewat
`Content-Type` serta magic bytes sebelum diteruskan ke FFmpeg. Audio yang gagal
validasi menggagalkan job; sistem tidak membuat video bisu sebagai fallback.

CLI menerima file lokal lewat `--audio`. Path wajib berada di dalam direktori proyek,
file wajib ada, ukuran wajib dalam batas, serta ekstensi dan magic bytes wajib cocok.

```bash
node render.js --template render-engine/templates/kinetic-text.html --audio assets/music.mp3
```

### 2. Mode Server VPS Lengkap (Docker Compose)

```bash
cp .env.example .env
# Edit .env dan masukkan API Key Higgsfield + API key provider AI yang dipakai.
# VPS_TOKEN, ADMIN_TOKEN, dan HMAC_SECRET kosong akan dibuat otomatis saat boot.
bash scripts/install-vps.sh
docker compose up -d --build
```

### 3. Login Video Builder

Set password admin langsung di terminal VPS. Script memakai prompt tersembunyi,
menyimpan hash scrypt saja ke `.env`, lalu membuat ulang container API:

```bash
sudo scripts/set-admin-password.sh
```

Password jangan dikirim lewat chat, disimpan di browser storage, atau ditulis sebagai
argumen command. Session yang sama membuka `/admin`, berlaku 8 jam, dan dapat diakhiri
lewat tombol logout.

### 4. Alur Video Builder

`/studio` adalah video builder, bukan lagi panel render template. Empat langkahnya:

1. **Prompt AI** — tulis ide video, pilih provider (`River AI` atau `DeepSeek`), tekan
   **Buat Struktur Scene**. Server mengubah prompt menjadi scene JSON yang tervalidasi
   skema, bukan HTML.
2. **Edit scene** — struktur masuk ke timeline. Tambah, duplikat, hapus, atau ubah urutan
   scene; pilih elemen lewat kartu timeline lalu ubah teks, warna, posisi, ukuran font,
   dan alignment di Inspector.
3. **Upload dan binding aset** — tarik file ke asset library atau pilih dari dialog.
   Tarik kartu aset ke kartu scene untuk mengikatnya, atau pakai tombol **+ Gambar** /
   **+ Video** di timeline. Inspector juga bisa mengganti aset pada elemen terpilih.
4. **Preview dan render** — preview iframe memuat HTML hasil compiler deterministik yang
   sama dengan yang dipakai renderer, jadi tampilan tidak dapat berbeda dari hasil video.
   Atur durasi, FPS, resolusi, dan codec, lalu tekan **Render Video**.

`useAiHtml` (**Poles HTML dengan AI**) bersifat opsional. Compiler deterministik selalu
jalan lebih dulu; bila HTML dari AI gagal sanitasi, ukuran, atau uji tiga frame, hasil
deterministik tetap dipakai dan alasannya muncul sebagai peringatan pada status preview.

`H.264` paling kompatibel untuk preview browser. `H.265` dan `AV1` bergantung pada
browser serta sistem operasi. `NVENC` memerlukan GPU NVIDIA dan driver yang cocok pada
worker. Aturan HTTPS, hostname, format, ukuran, serta timeout untuk `audio_url` mengikuti
bagian [Audio](#audio).

### 5. Batas Upload Aset

Aset disimpan di disk server (`vps-server/data/uploads/<ownerKey>/`), bukan object
storage. Owner directory memakai hash, dan nama file asli hanya tersimpan sebagai
metadata tampilan sehingga tidak pernah menjadi path.

| Jenis | Ekstensi | Ukuran maksimum | Validasi tambahan |
| --- | --- | --- | --- |
| Gambar | png, jpg, jpeg, webp | `MAX_UPLOAD_IMAGE_BYTES` (15 MB) | Magic bytes, `sharp.metadata()`, dimensi ≤ `MAX_UPLOAD_IMAGE_DIMENSION` |
| Video | mp4, webm | `MAX_UPLOAD_VIDEO_BYTES` (100 MB) | Magic bytes, FFprobe, durasi ≤ `MAX_UPLOAD_VIDEO_DURATION_SEC` |
| Audio | mp3, wav, m4a, aac | `MAX_UPLOAD_AUDIO_BYTES` (25 MB) | Mengikuti `audio-policy.js` |

Keseluruhan aset per owner dibatasi `MAX_UPLOAD_ASSETS_PER_OWNER` dan
`MAX_UPLOAD_OWNER_BYTES`. File ditulis ke `.tmp` lalu di-`rename` setelah validasi, dan
file sementara dihapus bila validasi gagal. Aturan TTL cleanup memakai `UPLOAD_TTL_HOURS`
(default 72 jam) untuk aset yang tidak lagi direferensikan project.

`deploy/nginx-app.bangalimin.com.conf` menaikkan `client_max_body_size` hanya pada
`/api/studio/assets`; route lain tetap pada batas kecil.

### 6. Preview Sandbox dan Capability URL Aset

Preview berjalan di `<iframe sandbox="allow-scripts">`. Tanpa `allow-same-origin`, frame
punya opaque origin: parent tidak dapat membaca `contentDocument`, dan subresource tidak
membawa cookie session. Karena itu:

- Aset preview dimuat lewat URL capability bertanda tangan HMAC-SHA256 yang berlaku
  singkat (default 10 menit) dan terikat pada satu actor serta satu asset id. Route
  `/api/studio/preview-assets/:id/content` memverifikasi tanda tangan dengan
  `crypto.timingSafeEqual` sebelum membaca metadata; gagal verifikasi selalu `404`.
- Transport preview dikendalikan satu arah lewat `postMessage`
  (`motion-preview-frame`) yang memanggil `window.renderFrame(t)` di dalam frame.
- Jembatan `postMessage` hanya disuntikkan pada target `preview`. HTML target `render`
  tidak pernah memuatnya.

Route aset terautentikasi (`/api/studio/assets/:id/content`) tetap memerlukan session dan
tidak berubah.

### 7. Uji Kirim Job Render via API

```bash
curl -X POST http://localhost:3000/render \
  -H "X-Token: $VPS_TOKEN" \
  -H "X-Signature: $(node -e 'const c=require("crypto");const fs=require("fs");const b=JSON.stringify(JSON.parse(fs.readFileSync("examples/demo-job.json","utf8")));const s=process.env.HMAC_SECRET;process.stdout.write(c.createHmac("sha256",s).update(b).digest("hex"))')" \
  -H "Content-Type: application/json" \
  -d @examples/demo-job.json
# Use generated values from vps-server/data/generated-secrets.json, or set explicit deployment secrets.
```

### 8. Cek Status & Hasil Video

```bash
curl http://localhost:3000/jobs/JOB_ID \
  -H "X-Token: $VPS_TOKEN"
```

Hasil video tersimpan di `./output/JOB_ID.mp4` atau melalui Signed URL MinIO S3.
Unduhan lokal lewat `GET /output/JOB_ID.mp4` juga wajib menyertakan `X-Token`.

### 9. Operasi Produksi

Backup mencakup `vps-server/data`, `output`, dan snapshot konsisten volume Redis.
Redis dihentikan singkat selama volume disalin lalu dijalankan kembali dengan verifikasi
healthcheck. `cache` serta `frames` tidak disimpan karena dapat dibuat ulang. Arsip dan
checksum SHA-256 ditulis dengan mode `0600`; retensi default 14 hari.

```bash
sudo install -m 700 scripts/backup-vps.sh /usr/local/sbin/motion-studio-backup
sudo install -m 700 scripts/restore-vps.sh /usr/local/sbin/motion-studio-restore
sudo install -m 644 deploy/systemd/motion-studio-backup.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now motion-studio-backup.timer
```

Uji restore selalu ke direktori staging kosong terlebih dahulu:

```bash
sudo env \
  RESTORE_ARCHIVE=/var/backups/motion-studio/motion-studio-TIMESTAMP.tar.gz \
  RESTORE_TARGET_DIR=/tmp/motion-studio-restore-test \
  /usr/local/sbin/motion-studio-restore
```

Restore tidak menimpa direktori yang sudah ada. `RESTORE_REDIS=1` sengaja terpisah
karena opsi itu menghentikan Redis dan mengganti isi volumenya.

Amazon Linux 2023 dapat menghapus hybrid post-quantum KEX dari OpenSSH lewat crypto
policy walaupun binary mendukungnya. Script berikut menguji `mlkem768x25519-sha256`
di sshd port sementara sebelum me-reload daemon utama:

```bash
sudo scripts/enable-ssh-post-quantum.sh
```

---

## 🤖 Provider AI (Dual Provider)

Motion Studio mendukung **dua provider AI terpisah** untuk 5-Stage Render Engineer,
admin playground, dan MCP client. Keduanya OpenAI-compatible, tetapi **tidak ada
fallback otomatis** antar-provider: provider aktif dipilih eksplisit, dan kegagalan
satu provider tidak pernah diam-diam dialihkan ke provider lain.

| Provider ID | Nama | API Base URL | Model Default | Autentikasi |
| --- | --- | --- | --- | --- |
| `river` | River AI gateway | `https://api.river.ai` | `deepseek-ai/DeepSeek-V4.1-Flash` | `Authorization: Bearer` + header `X-River-Conversation-Id` |
| `deepseek` | DeepSeek Official | `https://api.deepseek.com` | `deepseek-chat` | `Authorization: Bearer` saja |

### Membedakan URL dokumentasi dan URL API

- `https://api-docs.deepseek.com/` adalah **halaman dokumentasi**, bukan endpoint API.
- `https://api.deepseek.com` adalah **API base URL**. Endpoint chat dihitung otomatis
  menjadi `https://api.deepseek.com/v1/chat/completions`, jadi jangan menuliskan
  suffix `/v1/chat/completions` di dalam `DEEPSEEK_API_BASE_URL`.

### Perbedaan request per provider

River AI mengirim ekstensi khusus gateway:

```json
{
  "chat_template_kwargs": { "enable_thinking": false }
}
```

plus header `X-River-Conversation-Id`. DeepSeek Official **tidak** mengirim keduanya —
memakai body OpenAI standar (`model`, `stream`, `temperature`, `max_tokens`, `messages`).
Adapter di `vps-server/deepseek-engineer.js` (`buildAiChatRequest`) yang memutuskan
bentuk request berdasarkan provider aktif, sehingga pemanggil tidak perlu tahu detailnya.

### Memilih provider

Urutan prioritas konfigurasi:

1. Environment variable `AI_PROVIDER` (`river` atau `deepseek`).
2. Field `activeAiProvider` di `vps-server/data/admin-store.json` (diubah lewat
   Admin Dashboard).
3. Default: `river`.

Contoh `.env` untuk DeepSeek Official:

```bash
AI_PROVIDER=deepseek
DEEPSEEK_API_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=              # isi lewat secret store, jangan commit
DEEPSEEK_MODEL=deepseek-chat
```

### Migrasi dari konfigurasi lama

Store lama yang hanya punya `riverConfig` otomatis dimigrasikan saat boot: nilai
`baseUrl`, `apiKey`, dan `model` lama dipindahkan ke entri provider `river`, dan
`activeAiProvider` dipertahankan. Entry key vault lama mendapat `providerId: river`.
Compatibility field `riverConfig` masih dikembalikan ke klien dashboard lama selama
masa transisi, tetapi sumber kebenarannya adalah `aiProviders`.

### Rotasi dan pemisahan key

- Key vault kini provider-aware. Mengaktifkan key hanya menonaktifkan key lain
  **dalam provider yang sama**, dan tidak diam-diam memindahkan provider aktif.
- API key tidak pernah dikirim ke browser. Endpoint admin hanya mengembalikan
  proyeksi ter-mask (`maskedApiKey`), dan `PUT /api/admin/keys` mengabaikan nilai
  yang mengandung `••••` agar mask tidak tertulis balik sebagai key asli.

### Menguji provider

```bash
# Provider aktif
curl -X POST http://localhost:3000/api/admin/ai/test \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Tell me a story."}'

# Provider spesifik
curl -X POST http://localhost:3000/api/admin/ai/test \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"providerId":"deepseek","prompt":"Tell me a story."}'
```

Endpoint lama `POST /api/admin/river/test` tetap tersedia sebagai alias kompatibilitas
dan selalu menguji provider `river`. API key yang dikirim ke endpoint ini diabaikan dan
digantikan key dari server, sehingga browser tidak dapat memaksa pemakaian key arbitrer.
