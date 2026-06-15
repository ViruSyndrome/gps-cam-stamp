/* ===================================================
   GPS Cam Stamp — Core Script
   All processing is 100% client-side. No data leaves the browser.
   =================================================== */

'use strict';

// ── State ────────────────────────────────────────────────
let gpsData        = null;   // { lat, lng, altitude, accuracy, heading }
let addressData    = null;   // { display_name, road, city, country }
let capturedImage  = null;   // HTMLImageElement of the current photo
let currentTab     = 'camera';
let currentTemplate = 'classic';
let camStream      = null;
let facingMode     = 'environment';
let addressCache   = {};     // lat,lng → address to avoid repeat calls
let batchImages    = [];     // [{img, filename}] for batch mode
let mapTileImg  = null;   // OSM tile Image for map thumbnail
let mapTilePin  = null;   // {px, py} pin pixel position within 256×256 tile
let weatherData = null;   // {temp, unit, condition, icon}
let tempUnit    = 'C';    // 'C' | 'F' — auto-detected from locale/country
let coordFmt    = 'decimal'; // 'decimal' | 'dms'
let dateFmt     = 'dmy';  // 'dmy' | 'mdy' | 'iso' — auto-detected from locale

// ── DOM refs (resolved after DOMContentLoaded) ───────────
let gpsBar, gpsStatus, camVideo, stampCanvas, previewWrap;

// ── Init ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  gpsBar      = document.getElementById('gpsBar');
  gpsStatus   = document.getElementById('gpsStatus');
  camVideo    = document.getElementById('camVideo');
  stampCanvas = document.getElementById('stampCanvas');
  previewWrap = document.getElementById('previewWrap');

  detectLocaleDefaults();
  requestGPS();
  startCamera();
  setupUpload();
  syncToggleStyles();
});

// ── GPS ───────────────────────────────────────────────────
function requestGPS() {
  if (!navigator.geolocation) {
    setGPSStatus('denied', 'GPS not supported by this browser');
    return;
  }
  setGPSStatus('fetching', 'Getting your location…');
  navigator.geolocation.getCurrentPosition(onGPSSuccess, onGPSError, {
    enableHighAccuracy: true,
    timeout: 12000,
    maximumAge: 30000
  });
}

function onGPSSuccess(pos) {
  gpsData = {
    lat:      pos.coords.latitude,
    lng:      pos.coords.longitude,
    altitude: pos.coords.altitude,
    accuracy: pos.coords.accuracy,
    heading:  pos.coords.heading,
    speed:    pos.coords.speed
  };
  const lat = gpsData.lat.toFixed(5);
  const lng = gpsData.lng.toFixed(5);
  setGPSStatus('found', `📍 ${lat}, ${lng}`);
  fetchAddress(gpsData.lat, gpsData.lng);
  fetchMapTile(gpsData.lat, gpsData.lng);
  fetchWeather(gpsData.lat, gpsData.lng);
}

function onGPSError(err) {
  const msgs = {
    1: 'Location permission denied. Please allow location access and refresh.',
    2: 'Location unavailable. Check GPS signal.',
    3: 'Location request timed out. Try again outdoors.'
  };
  setGPSStatus('denied', msgs[err.code] || 'Location error');
}

function setGPSStatus(state, text) {
  gpsBar.className = 'gps-bar ' + state;
  gpsStatus.textContent = text;
}

// ── Reverse Geocode (OpenStreetMap Nominatim — free, no key) ──
async function fetchAddress(lat, lng) {
  const key = lat.toFixed(4) + ',' + lng.toFixed(4);
  if (addressCache[key]) { addressData = addressCache[key]; return; }
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1`;
    const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const json = await res.json();
    addressData = {
      display_name: json.display_name || '',
      road:    json.address?.road || json.address?.suburb || '',
      city:    json.address?.city || json.address?.town || json.address?.village || '',
      state:   json.address?.state || '',
      country: json.address?.country || '',
      postcode: json.address?.postcode || ''
    };
    addressCache[key] = addressData;
    refineTempUnit(addressData.country);
    // Update GPS bar with address
    if (addressData.road) {
      setGPSStatus('found', `📍 ${addressData.road}${addressData.city ? ', ' + addressData.city : ''}`);
    }
    // Refresh preview if already showing
    if (capturedImage && !previewWrap.classList.contains('hidden')) redrawStamp();
  } catch (_) {
    // Silently fail — lat/lng will still show on stamp
  }
}

// ── Locale / format detection ────────────────────────────
function detectLocaleDefaults() {
  try {
    // Detect date order from browser locale
    const parts = new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(2023, 2, 4));
    const order = parts.filter(p => p.type !== 'literal').map(p => p.type);
    if (order[0] === 'year') dateFmt = 'iso';
    else if (order[0] === 'month') dateFmt = 'mdy';
    else dateFmt = 'dmy';
  } catch (_) { dateFmt = 'dmy'; }
  // Initial temp guess from language (refined to country when address loads)
  tempUnit = (navigator.language || '').startsWith('en-US') ? 'F' : 'C';
  updateFmtUI();
}

function refineTempUnit(country) {
  if (!country) return;
  const fahr = ['United States', 'Liberia', 'Myanmar'];
  const prev = tempUnit;
  tempUnit = fahr.some(c => country.includes(c)) ? 'F' : 'C';
  if (tempUnit !== prev) { updateFmtUI(); if (capturedImage && !previewWrap.classList.contains('hidden')) redrawStamp(); }
}

function updateFmtUI() {
  document.getElementById('fmt-c')?.classList.toggle('active', tempUnit === 'C');
  document.getElementById('fmt-f')?.classList.toggle('active', tempUnit === 'F');
  document.getElementById('fmt-dec')?.classList.toggle('active', coordFmt === 'decimal');
  document.getElementById('fmt-dms')?.classList.toggle('active', coordFmt === 'dms');
  ['dmy','mdy','iso'].forEach(f => {
    document.getElementById('fmt-' + f)?.classList.toggle('active', dateFmt === f);
  });
}

function setTempUnit(u) { tempUnit = u; updateFmtUI(); redrawStamp(); }
function setCoordFmt(f) { coordFmt = f; updateFmtUI(); redrawStamp(); }
function setDateFmt(f)  { dateFmt  = f; updateFmtUI(); redrawStamp(); }

function toDMS(deg, axis) {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = Math.round(((abs - d) * 60 - m) * 60);
  const dir = axis === 'lat' ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');
  return `${d}°${m}'${s}"${dir}`;
}

// ── Map Tile (OpenStreetMap — free, attribution required) ──
const WMO_MAP = {
  0: ['☀', 'Clear'], 1: ['🌤', 'Mostly Clear'], 2: ['⛅', 'Partly Cloudy'], 3: ['☁', 'Overcast'],
  45: ['🌫', 'Fog'], 48: ['🌫', 'Icy Fog'],
  51: ['🌦', 'Light Drizzle'], 53: ['🌦', 'Drizzle'], 55: ['🌧', 'Heavy Drizzle'],
  61: ['🌧', 'Light Rain'], 63: ['🌧', 'Rain'], 65: ['🌧', 'Heavy Rain'],
  71: ['🌨', 'Light Snow'], 73: ['🌨', 'Snow'], 75: ['❄', 'Heavy Snow'],
  80: ['🌦', 'Showers'], 81: ['🌧', 'Heavy Showers'], 82: ['⛈', 'Violent Showers'],
  95: ['⛈', 'Thunderstorm'], 96: ['⛈', 'Hail Storm'], 99: ['⛈', 'Hail Storm']
};

function latLngToTilePixel(lat, lng, zoom) {
  const n    = Math.pow(2, zoom);
  const tx   = Math.floor((lng + 180) / 360 * n);
  const latR = lat * Math.PI / 180;
  const ty   = Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n);
  const xFrac = (lng + 180) / 360 * n - tx;
  const yFrac = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n - ty;
  return { tx, ty, px: Math.round(xFrac * 256), py: Math.round(yFrac * 256) };
}

async function fetchMapTile(lat, lng) {
  const zoom = 14;
  const { tx, ty, px, py } = latLngToTilePixel(lat, lng, zoom);
  mapTilePin = { px, py };
  try {
    const res     = await fetch(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`);
    const blob    = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const img     = new Image();
    img.onload    = () => {
      mapTileImg = img;
      if (capturedImage && !previewWrap.classList.contains('hidden')) redrawStamp();
    };
    img.src = blobUrl;
  } catch (_) {
    // Map tile unavailable (offline/CORS) — stamp works without thumbnail
  }
}

// ── Weather (open-meteo.com — free, no API key) ───────────
async function fetchWeather(lat, lng) {
  try {
    const url  = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current_weather=true&timezone=auto`;
    const res  = await fetch(url);
    const json = await res.json();
    const cw   = json.current_weather;
    if (!cw) return;
    const [icon, condition] = WMO_MAP[cw.weathercode] || ['🌡', 'Unknown'];
    weatherData = { temp: Math.round(cw.temperature), unit: '°C', condition, icon };
    if (capturedImage && !previewWrap.classList.contains('hidden')) redrawStamp();
  } catch (_) {
    // Weather unavailable — stamp works without weather data
  }
}

// ── Camera ────────────────────────────────────────────────
async function startCamera() {
  stopCamera();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    camVideo.srcObject = camStream;
  } catch (err) {
    // Camera unavailable (desktop without cam, permission denied)
    const panel = document.getElementById('panel-camera');
    panel.innerHTML = `<div style="padding:2rem;text-align:center;color:var(--text-muted)">
      <div style="font-size:2.5rem;margin-bottom:1rem">📷</div>
      <p>Camera not available or permission denied.<br>Use the <strong>Upload Photo</strong> tab instead.</p>
    </div>`;
  }
}

function stopCamera() {
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
}

function switchCamera() {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  startCamera();
}

function capturePhoto() {
  if (!camVideo.srcObject) return;
  const canvas = document.createElement('canvas');
  canvas.width  = camVideo.videoWidth  || 1280;
  canvas.height = camVideo.videoHeight || 720;
  canvas.getContext('2d').drawImage(camVideo, 0, 0);
  const img = new Image();
  img.onload = () => {
    capturedImage = img;
    batchImages = [{ img, filename: 'photo' }];
    showPreview();
  };
  img.src = canvas.toDataURL('image/jpeg', 0.92);
}

// ── Upload / Drag-drop ────────────────────────────────────
function setupUpload() {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');

  fileInput.addEventListener('change', e => handleFiles(e.target.files));

  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });
}

function handleFiles(files) {
  const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
  if (!imageFiles.length) return;
  batchImages = [];
  let loaded = 0;
  imageFiles.forEach(file => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        batchImages.push({ img, filename: file.name.replace(/\.[^.]+$/, '') });
        loaded++;
        if (loaded === imageFiles.length) {
          capturedImage = batchImages[0].img;
          showPreview();
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Preview & Stamp ───────────────────────────────────────
function showPreview() {
  previewWrap.classList.remove('hidden');
  redrawStamp();
}

function redrawStamp() {
  if (!capturedImage) return;
  drawStampedImage(capturedImage, stampCanvas);
}

function drawStampedImage(img, targetCanvas) {
  const ctx  = targetCanvas.getContext('2d');
  const maxW = 1080;
  const scale = img.width > maxW ? maxW / img.width : 1;
  targetCanvas.width  = Math.round(img.width  * scale);
  targetCanvas.height = Math.round(img.height * scale);
  ctx.drawImage(img, 0, 0, targetCanvas.width, targetCanvas.height);
  drawStamp(ctx, targetCanvas.width, targetCanvas.height);
}

function drawStamp(ctx, W, H) {
  const lines   = buildStampLines();
  const showMap = chk('tog-map') && mapTileImg && mapTilePin;
  if (!lines.length && !showMap) return;

  const tmpl = currentTemplate;
  const baseSize = Math.max(11, Math.round(W / 52));
  const lineH    = Math.round(baseSize * 1.55);
  const padX     = Math.round(W * 0.022);
  const padY     = Math.round(H * 0.018);

  if (tmpl === 'minimal') {
    drawMinimal(ctx, lines, W, H, baseSize, lineH, padX, padY, showMap);
  } else if (tmpl === 'pro') {
    drawPro(ctx, lines, W, H, baseSize, lineH, padX, padY, showMap);
  } else {
    drawClassic(ctx, lines, W, H, baseSize, lineH, padX, padY, showMap);
  }
}

// Classic — dark bar at bottom, map thumbnail on right when enabled
function drawClassic(ctx, lines, W, H, sz, lH, pX, pY, showMap) {
  const barH = Math.max(lines.length * lH + pY * 2, showMap ? Math.round(sz * 4) : 0);
  const mapSz = showMap ? barH : 0;
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, H - barH, W, barH);
  ctx.fillStyle = '#0ea5e9';
  ctx.fillRect(0, H - barH, W, 2);
  if (showMap) drawMapThumb(ctx, W - mapSz, H - barH, mapSz, mapTileImg, mapTilePin);
  ctx.font = `bold ${sz}px Courier New, monospace`;
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => {
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillText(line, pX + 1, H - barH + pY + i * lH + 1);
    ctx.fillStyle = i === 0 ? '#38bdf8' : '#f1f5f9';
    ctx.fillText(line, pX, H - barH + pY + i * lH);
  });
  ctx.font = `${Math.round(sz * 0.75)}px sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.textAlign = 'right';
  ctx.fillText('gpscamstamp.com', W - mapSz - pX, H - barH + pY);
  ctx.textAlign = 'left';
}

// Minimal — text tag in bottom-left, map thumbnail in bottom-right
function drawMinimal(ctx, lines, W, H, sz, lH, pX, pY, showMap) {
  const minSz = Math.max(10, Math.round(sz * 0.85));
  const minLH = Math.round(minSz * 1.5);
  const tagW  = Math.round(W * (showMap ? 0.48 : 0.52));
  const tagH  = Math.max(lines.length * minLH + pY * 1.5, showMap ? Math.round(sz * 4) : 0);
  const x = pX, y = H - tagH - pY;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  roundRect(ctx, x, y, tagW, tagH, 6);
  ctx.fill();
  ctx.strokeStyle = 'rgba(14,165,233,0.6)';
  ctx.lineWidth = 1.2;
  roundRect(ctx, x, y, tagW, tagH, 6);
  ctx.stroke();
  ctx.font = `${minSz}px Courier New, monospace`;
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => {
    ctx.fillStyle = i === 0 ? '#38bdf8' : '#cbd5e1';
    ctx.fillText(line, x + pX * 0.6, y + pY * 0.75 + i * minLH);
  });
  if (showMap) {
    const mapSz = tagH;
    drawMapThumb(ctx, W - mapSz - pX, y, mapSz, mapTileImg, mapTilePin);
  }
}

// Pro — side panel on right with branded header and map thumbnail at bottom
function drawPro(ctx, lines, W, H, sz, lH, pX, pY, showMap) {
  const panelW = Math.round(W * 0.38);
  const mapSz  = showMap ? Math.min(panelW - pX * 2, Math.round(W * 0.28)) : 0;
  ctx.fillStyle = 'rgba(8,14,26,0.85)';
  ctx.fillRect(W - panelW, 0, panelW, H);
  ctx.fillStyle = '#0ea5e9';
  ctx.fillRect(W - panelW, 0, panelW, Math.round(sz * 2.2));
  ctx.font = `bold ${Math.round(sz * 0.9)}px sans-serif`;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText('📍 GPS CAM STAMP', W - panelW + pX, sz * 1.1);
  ctx.font = `${sz}px Courier New, monospace`;
  ctx.textBaseline = 'top';
  const startY = Math.round(sz * 2.5);
  lines.forEach((line, i) => {
    ctx.fillStyle = i === 0 ? '#38bdf8' : '#94a3b8';
    ctx.fillText(line, W - panelW + pX, startY + i * lH * 1.2);
  });
  ctx.fillStyle = 'rgba(14,165,233,0.2)';
  ctx.fillRect(W - panelW, Math.round(sz * 2.2), panelW, 1);
  if (showMap) {
    const mapX = W - panelW + Math.round((panelW - mapSz) / 2);
    const mapY = H - mapSz - pY;
    drawMapThumb(ctx, mapX, mapY, mapSz, mapTileImg, mapTilePin);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawMapThumb(ctx, x, y, size, tileImg, pin) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.clip();
  // Scale OSM tile (256px source) centered on pin location
  const scale = size / 256;
  ctx.drawImage(tileImg, x + size / 2 - pin.px * scale, y + size / 2 - pin.py * scale, 256 * scale, 256 * scale);
  // Red pin marker at center
  const r = Math.max(4, Math.round(size * 0.07));
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, r, 0, Math.PI * 2);
  ctx.fillStyle = '#ef4444';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(1, size * 0.025);
  ctx.stroke();
  ctx.restore();
  // Border
  ctx.strokeStyle = 'rgba(14,165,233,0.7)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, size, size);
  // OSM attribution (required by OpenStreetMap tile usage policy)
  ctx.font = `${Math.max(7, Math.round(size * 0.09))}px sans-serif`;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('© OpenStreetMap', x + size - 2, y + size - 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// Build array of stamp text lines based on toggles + GPS data
function buildStampLines() {
  const lines = [];
  const now = new Date();

  if (chk('tog-address') && addressData) {
    const addr = [addressData.road, addressData.city, addressData.country].filter(Boolean).join(', ');
    if (addr) lines.push(truncate('📍 ' + addr, 52));
  }

  if (chk('tog-coords') && gpsData) {
    if (coordFmt === 'dms') {
      lines.push(`🌐 ${toDMS(gpsData.lat,'lat')}  ${toDMS(gpsData.lng,'lng')}`);
    } else {
      const lat = fmt(gpsData.lat, 5) + (gpsData.lat >= 0 ? 'N' : 'S');
      const lng = fmt(Math.abs(gpsData.lng), 5) + (gpsData.lng >= 0 ? 'E' : 'W');
      lines.push(`🌐 ${lat}  ${lng}`);
    }
  }

  if (chk('tog-altitude') && gpsData && gpsData.altitude != null) {
    lines.push(`⬆ Altitude: ${Math.round(gpsData.altitude)} m`);
  }

  if (chk('tog-datetime')) {
    lines.push(`🕐 ${fmtDate(now)}  ${fmtTime(now)}`);
  }

  if (chk('tog-accuracy') && gpsData) {
    lines.push(`◎ Accuracy: ±${Math.round(gpsData.accuracy || 0)} m`);
  }

  if (chk('tog-compass') && gpsData && gpsData.heading != null) {
    lines.push(`🧭 ${headingLabel(gpsData.heading)} (${Math.round(gpsData.heading)}°)`);
  }

  if (chk('tog-speed') && gpsData && gpsData.speed != null) {
    const spd = tempUnit === 'F'
      ? Math.round(gpsData.speed * 2.237) + ' mph'
      : Math.round(gpsData.speed * 3.6) + ' km/h';
    lines.push(`⚡ Speed: ${spd}`);
  }

  if (chk('tog-weather') && weatherData) {
    const wTemp = tempUnit === 'F'
      ? Math.round(weatherData.temp * 9/5 + 32) + '°F'
      : weatherData.temp + '°C';
    lines.push(`${weatherData.icon} ${wTemp}  ${weatherData.condition}`);
  }

  const note = document.getElementById('customNote')?.value?.trim();
  if (note) lines.push('✦ ' + note);

  return lines;
}

function chk(id) { return document.getElementById(id)?.checked; }
function fmt(n, d) { return Number(n).toFixed(d); }
function truncate(s, max) { return s.length > max ? s.slice(0, max - 1) + '…' : s; }

function fmtDate(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  if (dateFmt === 'mdy') return `${mm}/${dd}/${yy}`;
  if (dateFmt === 'iso') return `${yy}-${mm}-${dd}`;
  return `${dd}/${mm}/${yy}`;
}
function fmtTime(d) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mn = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mn}`;
}
function headingLabel(h) {
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(h / 45) % 8];
}

// ── Download ──────────────────────────────────────────────
function downloadPhoto() {
  if (batchImages.length <= 1) {
    // Single download
    downloadCanvas(stampCanvas, (batchImages[0]?.filename || 'photo') + '_gpsstamped.jpg');
  } else {
    // Batch — download each with a delay to avoid browser blocking
    batchImages.forEach(({ img, filename }, i) => {
      setTimeout(() => {
        const c = document.createElement('canvas');
        drawStampedImage(img, c);
        downloadCanvas(c, filename + '_gpsstamped.jpg');
      }, i * 400);
    });
  }
}

function downloadCanvas(canvas, filename) {
  const a = document.createElement('a');
  a.href     = canvas.toDataURL('image/jpeg', 0.92);
  a.download = filename;
  a.click();
}

// ── UI Helpers ────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  ['camera', 'upload'].forEach(t => {
    document.getElementById('panel-' + t).classList.toggle('hidden', t !== tab);
    const btn = document.getElementById('tab-' + t);
    btn.classList.toggle('active', t === tab);
    btn.setAttribute('aria-selected', t === tab ? 'true' : 'false');
  });
  if (tab === 'camera') startCamera(); else stopCamera();
  // Reset preview
  previewWrap.classList.add('hidden');
  capturedImage = null;
  batchImages = [];
}

function setTemplate(name) {
  currentTemplate = name;
  document.querySelectorAll('.tmpl-btn').forEach(btn => {
    const active = btn.textContent.toLowerCase().startsWith(name);
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  redrawStamp();
}

function resetTool() {
  previewWrap.classList.add('hidden');
  capturedImage = null;
  batchImages = [];
  document.getElementById('customNote').value = '';
  if (currentTab === 'camera') startCamera();
  else document.getElementById('fileInput').value = '';
}

function toggleFaq(btn) {
  const item = btn.closest('.faq-item');
  const isOpen = item.classList.toggle('open');
  btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

// Keep toggle label styles in sync with checkbox state
function syncToggleStyles() {
  document.querySelectorAll('.toggle-label input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      cb.closest('.toggle-label').classList.toggle('checked', cb.checked);
    });
  });
}
