/* JernihStatus — fully client-side. The FFmpeg.wasm engine is self-hosted
   under /vendor and loaded on first use. No network calls at all after the
   page loads. User media never leaves the device. */
import { FFmpeg } from "./vendor/ffmpeg/index.js";

/* Engine files are self-hosted under /vendor (npm @ffmpeg/ffmpeg 0.12.15 +
   @ffmpeg/core 0.12.10, dist/esm). Same-origin on purpose: a cross-origin
   Worker script is refused by the browser, which is what broke the CDN
   version. Paths are origin-absolute because the worker resolves coreURL
   against its own location. */
const VENDOR = new URL("./vendor", document.baseURI).href.replace(/\/$/, "");
const FREE_LIMIT = 3;
const LS_KEY = "js_entitlement_v1";

const $ = (id) => document.getElementById(id);
const els = {
  pill: $("usesPill"), home: $("screen-home"), tool: $("screen-tool"),
  toolTitle: $("toolTitle"), back: $("backBtn"), pickerLabel: $("pickerLabel"),
  fileInput: $("fileInput"), pickerFile: $("pickerFile"),
  setup: $("setupBox"), previewVideo: $("previewVideo"), previewImg: $("previewImg"),
  fileInfo: $("fileInfo"), aspectBox: $("aspectBox"), process: $("processBtn"),
  progressBox: $("progressBox"), progressLabel: $("progressLabel"),
  progressFill: $("progressFill"), progressPct: $("progressPct"),
  progressWrap: $("progressBarWrap"),
  error: $("errorBox"), result: $("resultBox"), resultVideo: $("resultVideo"), resultImg: $("resultImg"),
  cmpSizeBefore: $("cmpSizeBefore"), cmpSizeAfter: $("cmpSizeAfter"),
  cmpResBefore: $("cmpResBefore"), cmpResAfter: $("cmpResAfter"),
  savings: $("savingsLine"), download: $("downloadBtn"), share: $("shareBtn"),
  partsBox: $("partsBox"), partList: $("partList"), downloadAll: $("downloadAllBtn"),
  paywall: $("paywallBackdrop"), paywallClose: $("paywallClose"),
};

const TOOLS = {
  video: { title: "Kompres Video", accept: "video/*", label: "Pilih video dari perangkat", kind: "compress" },
  photo: { title: "Foto HD", accept: "image/*", label: "Pilih foto dari perangkat", kind: "photo" },
  split: { title: "Potong 30 Detik", accept: "video/*", label: "Pilih video dari perangkat", kind: "split" },
};

const state = { tool: "video", media: null, output: null, parts: [] };

/* ---------- free-use counter (localStorage, resets on local date change) ---------- */
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function loadEntitlement() {
  try {
    const e = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (e && e.usesDate === todayKey()) return e;
  } catch { /* fall through to fresh record */ }
  return { tier: "free", usesToday: 0, usesDate: todayKey() };
}
function saveEntitlement(e) { localStorage.setItem(LS_KEY, JSON.stringify(e)); }
function usesLeft() { return Math.max(0, FREE_LIMIT - loadEntitlement().usesToday); }
function consumeUse() {
  if (usesLeft() <= 0) return false;
  const e = loadEntitlement(); e.usesToday += 1; saveEntitlement(e); renderPill(); return true;
}
function refundUse() {
  const e = loadEntitlement();
  if (e.usesToday > 0) { e.usesToday -= 1; saveEntitlement(e); renderPill(); }
}
function renderPill() {
  const left = usesLeft();
  els.pill.textContent = `Sisa hari ini: ${left}`;
  els.pill.classList.toggle("empty", left === 0);
}

/* ---------- formatting helpers ---------- */
const fmtBytes = (b) => b >= 1048576 ? (b / 1048576).toFixed(2) + " MB"
  : b >= 1024 ? (b / 1024).toFixed(0) + " KB" : b + " B";
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/* ---------- FFmpeg engine (lazy singleton) ---------- */
let ffmpeg = null, ffmpegReady = null;
function loadFFmpeg() {
  if (!ffmpegReady) {
    ffmpegReady = (async () => {
      ffmpeg = new FFmpeg();
      ffmpeg.on("progress", ({ progress }) => setProgress(progress));
      await ffmpeg.load({
        classWorker: `${VENDOR}/ffmpeg/worker.js`,
        coreURL: `${VENDOR}/core/ffmpeg-core.js`,
        wasmURL: `${VENDOR}/core/ffmpeg-core.wasm`,
      });
      return ffmpeg;
    })();
  }
  return ffmpegReady;
}
function setProgress(ratio) {
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  els.progressFill.style.width = pct + "%";
  els.progressPct.textContent = pct + "%";
  els.progressWrap.setAttribute("aria-valuenow", String(pct));
}
async function runFFmpeg(args) {
  const code = await ffmpeg.exec(args);
  if (code !== 0) throw new Error("FFmpeg gagal memproses berkas (kode " + code + ").");
}
async function writeInput(media) {
  const ext = media.file.type.includes("webm") ? ".webm"
    : media.file.type.includes("quicktime") ? ".mov"
    : media.file.type.startsWith("image/") ? (media.file.type.includes("png") ? ".png" : ".jpg")
    : ".mp4";
  const name = "input" + ext;
  await ffmpeg.writeFile(name, new Uint8Array(await media.file.arrayBuffer()));
  return name;
}
async function readOutput(name, outName) {
  const data = await ffmpeg.readFile(name);
  const blob = new Blob([data.buffer], { type: "video/mp4" });
  return { blob, name: outName, sizeBytes: blob.size };
}

/* ---------- media probing (browser-native metadata) ---------- */
function probeMedia(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    if (file.type.startsWith("video/")) {
      const v = document.createElement("video");
      v.preload = "metadata"; v.muted = true; v.src = url;
      v.onloadedmetadata = () => resolve({
        type: "video", file, url, sizeBytes: file.size,
        width: v.videoWidth, height: v.videoHeight, durationS: v.duration || 0,
      });
      v.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Format video tidak didukung browser ini.")); };
    } else if (file.type.startsWith("image/")) {
      const img = new Image();
      img.onload = () => resolve({
        type: "photo", file, url, sizeBytes: file.size,
        width: img.naturalWidth, height: img.naturalHeight, durationS: null,
      });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Format foto tidak didukung browser ini.")); };
      img.src = url;
    } else {
      URL.revokeObjectURL(url);
      reject(new Error("Jenis berkas ini tidak didukung. Pilih video atau foto."));
    }
  });
}
function probeOutputDims(blob) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata"; v.muted = true;
    v.src = URL.createObjectURL(blob);
    v.onloadedmetadata = () => resolve({ width: v.videoWidth, height: v.videoHeight, durationS: v.duration || 0 });
    v.onerror = () => resolve({ width: 0, height: 0, durationS: 0 });
  });
}

/* ---------- processing recipes ---------- */
/* Original aspect: preserve the exact source frame. Only downscale when the
   source exceeds the 720x1280 cap; only fix odd dimensions (H.264 needs even).
   Never pad, never crop — this is where the original app has its known bug. */
function originalScaleFilter(w, h) {
  if (w > 720 || h > 1280) return "scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos";
  if (w % 2 || h % 2) return "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos";
  return null;
}
const X264 = ["-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];

async function compressVideo(media, aspect) {
  const input = await writeInput(media);
  const args = ["-i", input];
  if (aspect === "916") {
    args.push("-vf", "scale=720:1280:force_original_aspect_ratio=decrease:flags=lanczos,pad=720:1280:(ow-iw)/2:(oh-ih)/2");
  } else {
    const vf = originalScaleFilter(media.width, media.height);
    if (vf) args.push("-vf", vf);
  }
  args.push(...X264, "-crf", "24", "-maxrate", "2500k", "-bufsize", "5000k",
    "-c:a", "aac", "-b:a", "128k", "output.mp4");
  await runFFmpeg(args);
  return readOutput("output.mp4", "jernihstatus-video.mp4");
}

/* Foto HD: the photo STAYS a photo. Fit it into the 1080x1920 HD box with a
   high-quality resample (two-step when the scale jump is large), then encode
   once as JPEG q0.92. No FFmpeg on purpose: instant, and no video container. */
async function photoToHD(media) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Foto tidak bisa dibaca browser ini."));
    i.src = media.url;
  });
  const BOX_W = 1080, BOX_H = 1920;
  const scale = Math.min(BOX_W / media.width, BOX_H / media.height);
  const tw = Math.max(1, Math.round(media.width * scale));
  const th = Math.max(1, Math.round(media.height * scale));
  const draw = (src, w, h) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, w, h);
    return c;
  };
  let canvas;
  if (scale > 1.6 || scale < 0.45) {
    const f = Math.sqrt(scale);
    canvas = draw(draw(img, Math.round(media.width * f), Math.round(media.height * f)), tw, th);
  } else {
    canvas = draw(img, tw, th);
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob) throw new Error("Gagal membuat foto HD.");
  return { blob, name: "jernihstatus-foto-hd.jpg", sizeBytes: blob.size, width: tw, height: th };
}

async function splitVideo(media) {
  const input = await writeInput(media);
  const total = media.durationS || 0;
  const count = Math.max(1, Math.ceil(total / 30));
  // Pass 1: stream copy — instant when keyframes allow it.
  const copyCode = await ffmpeg.exec(["-i", input, "-f", "segment", "-segment_time", "30",
    "-reset_timestamps", "1", "-c", "copy", "part%02d.mp4"]);
  let names = [];
  if (copyCode === 0) {
    const entries = await ffmpeg.listDir("/");
    names = entries.filter((e) => !e.isDir && /^part\d+\.mp4$/.test(e.name)).map((e) => e.name).sort();
  }
  // Pass 2: re-encode per segment (exact 30 s boundaries) if copy failed.
  if (names.length === 0) {
    for (let i = 0; i < count; i++) {
      const name = `part${String(i).padStart(2, "0")}.mp4`;
      await runFFmpeg(["-ss", String(i * 30), "-i", input, "-t", "30", ...X264,
        "-crf", "24", "-maxrate", "2500k", "-bufsize", "5000k",
        "-c:a", "aac", "-b:a", "128k", name]);
      names.push(name);
      setProgress(names.length / count);
    }
  }
  const parts = [];
  for (let i = 0; i < names.length; i++) {
    const part = await readOutput(names[i], `jernihstatus-bagian-${i + 1}.mp4`);
    part.partIndex = i;
    part.durationS = Math.min(30, Math.max(0, total - i * 30));
    parts.push(part);
  }
  return parts;
}

/* ---------- download / share ---------- */
function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function shareOutput(output) {
  const file = new File([output.blob], output.name, { type: "video/mp4" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e && e.name === "AbortError") return; }
  }
  downloadBlob(output.blob, output.name); // fallback: save instead
}

/* ---------- UI flow ---------- */
function showError(msg) { els.error.textContent = msg; els.error.hidden = !msg; }
function resetToolUI() {
  state.media = null; state.output = null; state.parts = [];
  els.setup.hidden = true; els.progressBox.hidden = true;
  els.result.hidden = true; els.partsBox.hidden = true;
  els.partList.innerHTML = ""; showError("");
  els.pickerFile.hidden = true; els.fileInput.value = "";
  els.previewVideo.hidden = true; els.previewImg.hidden = true;
}
function openTool(tool) {
  state.tool = tool;
  const cfg = TOOLS[tool];
  els.toolTitle.textContent = cfg.title;
  els.pickerLabel.textContent = cfg.label;
  els.fileInput.accept = cfg.accept;
  els.aspectBox.hidden = tool !== "video";
  els.process.textContent = tool === "split" ? "Potong Sekarang" : "Mulai Proses";
  resetToolUI();
  els.home.hidden = true; els.tool.hidden = false;
  window.scrollTo(0, 0);
}
function goHome() { els.tool.hidden = true; els.home.hidden = false; renderPill(); }

async function onFileChosen() {
  const file = els.fileInput.files && els.fileInput.files[0];
  if (!file) return;
  showError("");
  try {
    const media = await probeMedia(file);
    state.media = media;
    els.pickerFile.textContent = `${file.name} — ${fmtBytes(file.size)}`;
    els.pickerFile.hidden = false;
    if (media.type === "video") {
      els.previewVideo.src = media.url; els.previewVideo.hidden = false; els.previewImg.hidden = true;
    } else {
      els.previewImg.src = media.url; els.previewImg.hidden = false; els.previewVideo.hidden = true;
    }
    els.fileInfo.textContent = media.type === "video"
      ? `${media.width}×${media.height} · ${fmtDur(media.durationS)} · ${fmtBytes(media.sizeBytes)}`
      : `${media.width}×${media.height} · ${fmtBytes(media.sizeBytes)}`;
    els.setup.hidden = false;
  } catch (e) {
    showError(e.message || "Berkas tidak bisa dibaca.");
  }
}

async function onProcess() {
  if (!state.media) return;
  if (!consumeUse()) { openPaywall(); return; }
  const kind = TOOLS[state.tool].kind;
  els.setup.hidden = true; els.result.hidden = true; els.partsBox.hidden = true;
  showError(""); setProgress(0);
  els.progressBox.hidden = false;
  els.progressLabel.textContent = kind === "photo" ? "Menyiapkan…" : "Memuat mesin pemroses… (unduhan pertama ±30 MB)";
  try {
    let output = null, parts = [];
    if (kind === "photo") {
      els.progressLabel.textContent = "Sedang memproses… jangan tutup halaman ini.";
      setProgress(0.4);
      output = await photoToHD(state.media);
      setProgress(1);
    } else {
      await loadFFmpeg();
      els.progressLabel.textContent = "Sedang memproses… jangan tutup halaman ini.";
      if (kind === "compress") {
        const aspect = document.querySelector('input[name="aspect"]:checked').value;
        output = await compressVideo(state.media, aspect === "916" ? "916" : "original");
      } else {
        parts = await splitVideo(state.media);
      }
    }
    els.progressBox.hidden = true;
    if (output) await showResult(output);
    else showParts(parts);
  } catch (e) {
    refundUse();
    els.progressBox.hidden = true;
    els.setup.hidden = false;
    showError("Proses gagal: " + (e.message || "terjadi kesalahan.") +
      " Kuota tidak terpotong. Coba berkas lain atau muat ulang halaman.");
  }
}

async function showResult(output) {
  state.output = output;
  const isImage = output.blob.type.startsWith("image/");
  const dims = output.width ? { width: output.width, height: output.height } : await probeOutputDims(output.blob);
  const outUrl = URL.createObjectURL(output.blob);
  els.resultVideo.hidden = isImage;
  els.resultImg.hidden = !isImage;
  if (isImage) els.resultImg.src = outUrl; else els.resultVideo.src = outUrl;
  els.cmpSizeBefore.textContent = fmtBytes(state.media.sizeBytes);
  els.cmpSizeAfter.textContent = fmtBytes(output.sizeBytes);
  els.cmpResBefore.textContent = `${state.media.width}×${state.media.height}`;
  els.cmpResAfter.textContent = dims.width ? `${dims.width}×${dims.height}` : "—";
  const saved = state.media.sizeBytes - output.sizeBytes;
  els.savings.textContent = isImage
    ? "Hasilnya tetap foto, resolusi HD — siap dipasang atau dibagikan."
    : saved > 0
    ? `Lebih ramping ${fmtBytes(saved)} dari berkas asli, resolusi dipertahankan.`
    : "Ukuran dijaga tetap ringkas di bawah batas Status WhatsApp.";
  els.result.hidden = false;
}

function showParts(parts) {
  state.parts = parts;
  els.partList.innerHTML = "";
  for (const part of parts) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `Bagian ${part.partIndex + 1}`;
    const meta = document.createElement("span");
    meta.className = "part-meta";
    meta.textContent = `${fmtDur(part.durationS)} · ${fmtBytes(part.sizeBytes)}`;
    const btn = document.createElement("button");
    btn.className = "btn secondary";
    btn.textContent = "Unduh";
    btn.addEventListener("click", () => downloadBlob(part.blob, part.name));
    li.append(label, meta, btn);
    els.partList.appendChild(li);
  }
  els.partsBox.hidden = false;
}

/* ---------- paywall modal ---------- */
let lastFocus = null;
function openPaywall() {
  lastFocus = document.activeElement;
  els.paywall.hidden = false;
  els.paywallClose.focus();
}
function closePaywall() {
  els.paywall.hidden = true;
  if (lastFocus) lastFocus.focus();
}

/* ---------- wiring ---------- */
document.querySelectorAll("[data-goto]").forEach((b) =>
  b.addEventListener("click", () => openTool(b.dataset.goto)));
els.back.addEventListener("click", goHome);
els.fileInput.addEventListener("change", onFileChosen);
els.process.addEventListener("click", onProcess);
els.download.addEventListener("click", () => { if (state.output) downloadBlob(state.output.blob, state.output.name); });
els.share.addEventListener("click", () => { if (state.output) shareOutput(state.output); });
els.downloadAll.addEventListener("click", () => {
  state.parts.forEach((p, i) => setTimeout(() => downloadBlob(p.blob, p.name), i * 400));
});
els.paywallClose.addEventListener("click", closePaywall);
els.paywall.addEventListener("click", (e) => { if (e.target === els.paywall) closePaywall(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !els.paywall.hidden) closePaywall(); });

renderPill();
