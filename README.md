<!-- markdownlint-disable MD013 -->

# 🎬 Motion Studio — ChatGPT MCP + Higgsfield AI + DeepSeek Engineer + VPS Render Farm

Project produksi untuk membuat **Motion Graphics 1080p @ 60fps** secara deterministik menggunakan **JavaScript, Playwright + Chromium Headless, Canvas 2D, GSAP via CDN, Sharp, dan FFmpeg**, diorkestrasi dari **ChatGPT (via MCP)** dengan **Higgsfield AI** sebagai generator asset dan **DeepSeek Render Engineer** sebagai 5-Stage Automated Quality Gate di dalam VPS.

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
├── preview-studio.html             # Interactive Web Studio & Live 60fps Previewer
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

### 3. Uji Kirim Job Render via API

```bash
curl -X POST http://localhost:3000/render \
  -H "X-Token: $VPS_TOKEN" \
  -H "X-Signature: $(node -e 'const c=require("crypto");const fs=require("fs");const b=JSON.stringify(JSON.parse(fs.readFileSync("examples/demo-job.json","utf8")));const s=process.env.HMAC_SECRET;process.stdout.write(c.createHmac("sha256",s).update(b).digest("hex"))')" \
  -H "Content-Type: application/json" \
  -d @examples/demo-job.json
# Use generated values from vps-server/data/generated-secrets.json, or set explicit deployment secrets.
```

### 4. Cek Status & Hasil Video

```bash
curl http://localhost:3000/jobs/JOB_ID \
  -H "X-Token: $VPS_TOKEN"
```

Hasil video tersimpan di `./output/JOB_ID.mp4` atau melalui Signed URL MinIO S3.
Unduhan lokal lewat `GET /output/JOB_ID.mp4` juga wajib menyertakan `X-Token`.

### 5. Operasi Produksi

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
