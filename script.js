/* ===================================================
   GPS Cam Stamp — Core Script
   All processing is 100% client-side. No data leaves the browser.
   =================================================== */

'use strict';

// Cookie Consent — Accept grants analytics/ads storage
function acceptCookies() {
  try { localStorage.setItem('cookieConsent', 'true'); } catch (e) {}
  var banner = document.getElementById('cookieConsent');
  if (banner) banner.classList.add('hidden');
  if (typeof gtag === 'function') {
    gtag('consent', 'update', {
      ad_storage: 'granted',
      analytics_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted'
    });
  }
}

window.addEventListener('load', function () {
  var banner = document.getElementById('cookieConsent');
  if (!banner) return;
  try {
    if (localStorage.getItem('cookieConsent') === 'true') {
      banner.classList.add('hidden');
      if (typeof gtag === 'function') {
        gtag('consent', 'update', {
          ad_storage: 'granted',
          analytics_storage: 'granted',
          ad_user_data: 'granted',
          ad_personalization: 'granted'
        });
      }
    }
  } catch (e) {}
});

// ── State ────────────────────────────────────────────────
let gpsData        = null;   // { lat, lng, altitude, accuracy, heading, _fixTime, _source }
let addressData    = null;   // { display_name, road, city, country }
let capturedImage  = null;   // HTMLImageElement of the current photo
let currentTab     = 'camera';
let currentTemplate = 'classic';
let camStream      = null;
let facingMode     = 'environment';
let addressCache   = {};     // lat,lng → address to avoid repeat calls
let batchImages    = [];     // [{img, filename, jpegBinary?}] for batch mode
let mapTileImg  = null;   // Map tile Image for map thumbnail (Esri World Imagery)
let sourceJpegBinary = null; // original uploaded JPEG binary string (for EXIF preserve)
let mapTilePin  = null;   // {px, py} pin pixel position within 256×256 tile
let appLogoImg  = null;   // Real SVG logo for the stamp
let customLogoImg = null; // User uploaded custom logo
let gpsWatchId  = null;   // watchPosition id while camera is live
let showingDemo = false;  // marketing sample preview — never used for real stamps

// Demo-only sample (marketing preview). Never assigned into gpsData/addressData/weatherData.
let demoGpsData     = null;
let demoAddressData = null;
let demoWeatherData = null;
let demoImage       = null;

const initLogo = new Image();
initLogo.onload = () => { appLogoImg = initLogo; };
initLogo.src = 'assets/favicon-64.png';

let weatherData = null;   // {temp, unit, condition, icon}
let tempUnit    = 'C';    // 'C' | 'F' — auto-detected from locale/country
let coordFmt    = 'decimal'; // 'decimal' | 'dms'
let dateFmt     = 'dmy';  // 'dmy' | 'mdy' | 'iso' — auto-detected from locale

function hasValidGps() {
  return !!(gpsData && gpsData.lat != null && gpsData.lng != null &&
    Number.isFinite(gpsData.lat) && Number.isFinite(gpsData.lng));
}

/** Decimal coords with hemisphere: Lat 40.758000° N  Long 73.985500° W */
function formatDecimalCoords(lat, lng, precision) {
  const p = precision == null ? 6 : precision;
  const latH = lat >= 0 ? 'N' : 'S';
  const lngH = lng >= 0 ? 'E' : 'W';
  return `Lat ${fmt(Math.abs(lat), p)}\u00B0 ${latH}  Long ${fmt(Math.abs(lng), p)}\u00B0 ${lngH}`;
}

function clearLocationDerivedData() {
  addressData = null;
  weatherData = null;
  mapTileImg = null;
  mapTilePin = null;
}

function updateStampActionButtons() {
  const captureBtn = document.getElementById('btnCapture');
  const downloadBtn = document.querySelector('.preview-wrap .btn-primary');
  const canStamp = hasValidGps() && !showingDemo;
  if (captureBtn) {
    // Allow Capture to open the permission flow when camera is not live yet
    const camLive = camVideo && camVideo.classList.contains('is-live');
    captureBtn.disabled = camLive && !hasValidGps();
    if (camLive && !hasValidGps()) captureBtn.title = 'Location not available — wait for GPS';
    else captureBtn.title = '';
  }
  if (downloadBtn) {
    downloadBtn.disabled = !canStamp || !capturedImage;
    downloadBtn.title = canStamp ? '' : 'Location not available — cannot stamp';
  }
}

// ── DOM refs (resolved after DOMContentLoaded) ───────────
let gpsBar, gpsStatus, camVideo, stampCanvas, previewWrap;

// ── Init ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  gpsBar      = document.getElementById('gpsBar');
  gpsStatus   = document.getElementById('gpsStatus');
  camVideo    = document.getElementById('camVideo');
  stampCanvas = document.getElementById('stampCanvas');
  previewWrap = document.getElementById('previewWrap');

  const logoInput = document.getElementById('customLogoInput');
  if (logoInput) {
    logoInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          const img = new Image();
          img.onload = () => { customLogoImg = img; redrawStamp(); };
          img.src = evt.target.result;
        };
        reader.readAsDataURL(e.target.files[0]);
        document.getElementById('clearLogoBtn').style.display = 'block';
      }
    });
  }

  detectLocaleDefaults();
});

window.clearCustomLogo = function() {
  customLogoImg = null;
  const logoInput = document.getElementById('customLogoInput');
  if (logoInput) logoInput.value = '';
  const clearBtn = document.getElementById('clearLogoBtn');
  if (clearBtn) clearBtn.style.display = 'none';
  redrawStamp();
};

window.addEventListener('load', async () => {
  setupUpload();
  syncToggleStyles();
  updateCompassAvailability();
  updateStampActionButtons();
  setGPSStatus('idle', 'Camera & location needed — tap Allow below');
  setCamPlaceholder(true,
    'This tool needs <strong>camera</strong> and <strong>location</strong> to stamp photos. Browsers only ask after you tap Allow.');

  // Demo sample stays in demo* vars only — never contaminates real stamp state
  const sampleImg = new Image();
  sampleImg.onload = () => {
    demoImage = sampleImg;
    demoGpsData = { lat: 40.7580, lng: -73.9855, altitude: 12.5, accuracy: 5, heading: 42, _exifDate: new Date(), _source: 'demo', _fixTime: Date.now() };
    demoAddressData = { city: 'New York', suburb: 'Manhattan', road: 'Broadway', country: 'United States' };
    demoWeatherData = { temp: 22, unit: tempUnit, condition: 'Sunny', icon: '☀️' };
    if (!capturedImage && !permissionsStarted) {
      showingDemo = true;
      capturedImage = demoImage;
      updateFmtUI();
      redrawStamp();
    }
  };
  sampleImg.src = 'assets/og-image.webp';
});

let permissionsStarted = false;

async function enablePermissions() {
  const btn = document.getElementById('btnEnablePerms');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Waiting for browser…';
  }
  permissionsStarted = true;
  setCamPlaceholder(true, 'Waiting for camera permission…');
  setGPSStatus('fetching', 'Requesting camera & location…');

  // Camera first (user-gesture prompt), then GPS — browsers often defer GPS until after interaction
  await startCamera();
  requestGPS({ watch: true });

  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Allow Camera & Location';
    // Hide CTA once camera is live; keep it if denied so they can retry
    if (camVideo && camVideo.classList.contains('is-live')) btn.classList.add('hidden');
  }
}
window.enablePermissions = enablePermissions;

// ── GPS ───────────────────────────────────────────────────
function stopGPSWatch() {
  if (gpsWatchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
}

/** Request a GPS fix. Pass { watch: true } to keep updating while the camera is live. */
function requestGPS(opts = {}) {
  if (!navigator.geolocation) {
    setGPSStatus('denied', 'GPS not supported by this browser');
    updateStampActionButtons();
    return;
  }
  setGPSStatus('fetching', 'Getting your location… (may take a few seconds)');
  const geoOpts = {
    enableHighAccuracy: true,
    timeout: 20000,
    maximumAge: 0
  };
  navigator.geolocation.getCurrentPosition(onGPSSuccess, onGPSError, geoOpts);
  if (opts.watch) {
    stopGPSWatch();
    gpsWatchId = navigator.geolocation.watchPosition(onGPSSuccess, onGPSError, {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 5000
    });
  }
}

function onGPSSuccess(pos) {
  const prevHeading = (gpsData && gpsData.heading != null && !Number.isNaN(gpsData.heading)) ? gpsData.heading : null;
  // Fresh live fix — drop stale address/weather/map from any previous location
  clearLocationDerivedData();
  if (showingDemo) {
    showingDemo = false;
    // Never stamp real GPS onto the marketing sample image
    if (capturedImage === demoImage) {
      capturedImage = null;
      if (previewWrap) previewWrap.classList.add('hidden');
    }
  }
  gpsData = {
    lat:      pos.coords.latitude,
    lng:      pos.coords.longitude,
    altitude: pos.coords.altitude,
    accuracy: pos.coords.accuracy,
    heading:  (pos.coords.heading != null && !Number.isNaN(pos.coords.heading)) ? pos.coords.heading : prevHeading,
    speed:    pos.coords.speed,
    _fixTime: Date.now(),
    _source:  'live'
  };
  const lat = gpsData.lat.toFixed(5);
  const lng = gpsData.lng.toFixed(5);
  const acc = gpsData.accuracy != null ? ` (±${Math.round(gpsData.accuracy)} m)` : '';
  setGPSStatus('found', `📍 ${lat}, ${lng}${acc}`);
  fetchAddress(gpsData.lat, gpsData.lng);
  fetchMapTile(gpsData.lat, gpsData.lng);
  fetchWeather(gpsData.lat, gpsData.lng);
  updateCompassAvailability();
  updateStampActionButtons();
  if (capturedImage && previewWrap && !previewWrap.classList.contains('hidden')) redrawStamp();
}

function onGPSError(err) {
  const msgs = {
    1: 'Location permission denied. Please allow location access and refresh.',
    2: 'Location unavailable. Check GPS signal.',
    3: 'Location request timed out. Try again outdoors.'
  };
  setGPSStatus('denied', msgs[err.code] || 'Location error');
  updateCompassAvailability();
  updateStampActionButtons();
}

/** Returns { ok, warn, msg } for stamp/capture quality checks. */
function checkGpsQuality() {
  if (!hasValidGps()) {
    return { ok: false, warn: false, msg: 'Location not available. Allow location access or use a photo with EXIF GPS.' };
  }
  if (gpsData._source === 'exif') return { ok: true, warn: false, msg: '' };
  const ageMs = Date.now() - (gpsData._fixTime || 0);
  if (ageMs > 60000) {
    return { ok: false, warn: false, msg: 'GPS fix is older than 60 seconds. Wait for a fresh location, then try again.' };
  }
  if (gpsData.accuracy != null && gpsData.accuracy > 100) {
    return {
      ok: true,
      warn: true,
      msg: `GPS accuracy is ±${Math.round(gpsData.accuracy)} m (weaker than 100 m). Stamp anyway?`
    };
  }
  return { ok: true, warn: false, msg: '' };
}

// Compass heading from DeviceOrientation (geolocation.heading is often null when stationary)
let compassListening = false;
function updateCompassAvailability() {
  const hint = document.getElementById('compassHint');
  const label = document.getElementById('compassToggleLabel');
  const hasHeading = gpsData && gpsData.heading != null && !Number.isNaN(gpsData.heading);
  if (hint) {
    hint.textContent = hasHeading
      ? `${Math.round(gpsData.heading)}°`
      : (compassListening ? 'Move phone to calibrate' : 'Needs phone sensors');
  }
  if (label) label.classList.toggle('is-unavailable', !hasHeading);
}

async function onCompassToggle(cb) {
  if (!cb.checked) {
    updateCompassAvailability();
    return;
  }
  await ensureCompassHeading();
  updateCompassAvailability();
  redrawStamp();
}
window.onCompassToggle = onCompassToggle;

async function ensureCompassHeading() {
  if (!hasValidGps()) {
    const hint = document.getElementById('compassHint');
    if (hint) hint.textContent = 'Needs a GPS fix first';
    return false;
  }
  if (gpsData.heading != null && !Number.isNaN(gpsData.heading)) return true;
  if (typeof DeviceOrientationEvent === 'undefined') {
    const hint = document.getElementById('compassHint');
    if (hint) hint.textContent = 'Not supported on this device';
    return false;
  }
  try {
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== 'granted') {
        const hint = document.getElementById('compassHint');
        if (hint) hint.textContent = 'Sensor permission denied';
        return false;
      }
    }
  } catch (_) {
    return false;
  }
  if (!compassListening) {
    compassListening = true;
    window.addEventListener('deviceorientationabsolute', onDeviceOrientation, true);
    window.addEventListener('deviceorientation', onDeviceOrientation, true);
  }
  return true;
}

function onDeviceOrientation(e) {
  let heading = null;
  if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
    heading = e.webkitCompassHeading;
  } else if (e.absolute === true && typeof e.alpha === 'number' && e.alpha != null) {
    heading = (360 - e.alpha) % 360;
  } else if (typeof e.alpha === 'number' && e.alpha != null) {
    heading = (360 - e.alpha) % 360;
  }
  if (heading == null || Number.isNaN(heading)) return;
  // Never invent a GPS fix from compass alone
  if (!hasValidGps()) return;
  const prev = gpsData.heading;
  gpsData.heading = heading;
  updateCompassAvailability();
  if (document.getElementById('tog-compass')?.checked && capturedImage && previewWrap && !previewWrap.classList.contains('hidden')) {
    if (prev == null || Math.abs(prev - heading) >= 2) redrawStamp();
  }
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
    const res  = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'GPSCamStamp/1.0 (https://www.gpscamstamp.com; hello@gpscamstamp.com)' } });
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
      setGPSStatus('found', `📍 ${[addressData.road, addressData.city, addressData.state].filter(Boolean).join(', ')}`);
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

// ── Map Tile (Esri World Imagery — attribution required) ──
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
  const zoom = 18; // Increased from 16 for a more zoomed-in street/building level view
  const { tx, ty, px, py } = latLngToTilePixel(lat, lng, zoom);
  mapTilePin = { px, py };
  try {
    const res     = await fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${ty}/${tx}`);
    const blob    = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const img     = new Image();
    img.onload    = () => {
      URL.revokeObjectURL(blobUrl);
      mapTileImg = img;
      if (capturedImage && !previewWrap.classList.contains('hidden')) redrawStamp();
    };
    img.onerror = () => URL.revokeObjectURL(blobUrl);
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
function setCamPlaceholder(visible, message) {
  const ph = document.getElementById('camPlaceholder');
  const wrap = document.getElementById('videoWrap') || document.querySelector('#panel-camera .video-wrap');
  if (!ph) return;
  ph.classList.toggle('hidden', !visible);
  if (wrap) wrap.classList.toggle('is-live', !visible);
  if (message) {
    const p = document.getElementById('camPlaceholderText') || ph.querySelector('p');
    if (p) p.innerHTML = message;
  }
}

async function startCamera() {
  stopCamera();
  setCamPlaceholder(true, 'Waiting for camera permission…');
  if (camVideo) camVideo.classList.remove('is-live');
  const wrap = document.getElementById('videoWrap');
  if (wrap) wrap.classList.remove('is-live');
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    if (!camVideo) return;
    camVideo.srcObject = camStream;
    try { await camVideo.play(); } catch (_) {}
    camVideo.classList.add('is-live');
    if (wrap) wrap.classList.add('is-live');
    setCamPlaceholder(false);
    const btn = document.getElementById('btnEnablePerms');
    if (btn) btn.classList.add('hidden');
    // Keep a live GPS watch while the camera is active
    if (permissionsStarted) requestGPS({ watch: true });
    updateStampActionButtons();
  } catch (err) {
    setCamPlaceholder(true,
      'Camera permission denied or unavailable.<br>Tap <strong>Allow</strong> again, or use the <strong>Upload</strong> tab.');
    const btn = document.getElementById('btnEnablePerms');
    if (btn) {
      btn.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Allow Camera & Location';
    }
    if (camVideo) {
      camVideo.srcObject = null;
      camVideo.classList.remove('is-live');
    }
    if (wrap) wrap.classList.remove('is-live');
    updateStampActionButtons();
  }
}

function stopCamera() {
  stopGPSWatch();
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  if (camVideo) {
    camVideo.srcObject = null;
    camVideo.classList.remove('is-live');
  }
  updateStampActionButtons();
}

function switchCamera() {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  startCamera();
}

function capturePhoto() {
  if (!camVideo || !camVideo.srcObject) {
    enablePermissions();
    return;
  }
  const quality = checkGpsQuality();
  if (!quality.ok) {
    setGPSStatus('denied', quality.msg);
    // Refresh GPS and refuse to stamp with a stale/missing fix
    requestGPS({ watch: true });
    updateStampActionButtons();
    return;
  }
  if (quality.warn && !confirm(quality.msg)) return;

  showingDemo = false;
  sourceJpegBinary = null;
  const canvas = document.createElement('canvas');
  canvas.width  = camVideo.videoWidth  || 1280;
  canvas.height = camVideo.videoHeight || 720;
  canvas.getContext('2d').drawImage(camVideo, 0, 0);
  const img = new Image();
  img.onload = () => {
    capturedImage = img;
    batchImages = [{ img, filename: 'photo', jpegBinary: null }];
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

function arrayBufferToBinaryString(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return binary;
}

function isJpegFile(file) {
  return file && (file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name || ''));
}

function handleFiles(files) {
  const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
  if (!imageFiles.length) return;
  showingDemo = false;
  batchImages = [];
  sourceJpegBinary = null;
  let loaded = 0;

  const afterImagesReady = async () => {
    capturedImage = batchImages[0].img;
    sourceJpegBinary = batchImages[0].jpegBinary || null;
    showPreview();

    const needLiveGps = () => {
      if (!hasValidGps()) return true;
      if (gpsData._source === 'exif') return false;
      return !checkGpsQuality().ok;
    };

    // Single-file: prefer EXIF GPS; otherwise request live location
    if (imageFiles.length === 1) {
      const exif = await readExifFromFile(imageFiles[0]);
      if (exif && exif.lat != null && exif.lng != null) {
        applyExifData(exif);
      } else {
        if (exif && exif.datetime) applyExifData(exif);
        if (needLiveGps()) {
          setGPSStatus('fetching', 'No GPS in photo — requesting your current location…');
          requestGPS();
        }
      }
    } else if (needLiveGps()) {
      setGPSStatus('fetching', 'Requesting location to stamp uploaded photos…');
      requestGPS();
    }
    updateStampActionButtons();
  };

  imageFiles.forEach(file => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = async () => {
        let jpegBinary = null;
        if (isJpegFile(file)) {
          try {
            jpegBinary = arrayBufferToBinaryString(await file.arrayBuffer());
          } catch (_) { jpegBinary = null; }
        }
        batchImages.push({ img, filename: file.name.replace(/\.[^.]+$/, ''), jpegBinary });
        loaded++;
        if (loaded === imageFiles.length) afterImagesReady();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── EXIF reader (no dependency — native DataView) ─────────
function readExifFromFile(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => resolve(parseExifGPS(e.target.result));
    reader.onerror = () => resolve(null);
    // Only need the first 128KB to find EXIF in most JPEGs
    reader.readAsArrayBuffer(file.slice(0, 131072));
  });
}

function parseExifGPS(buffer) {
  const view = new DataView(buffer);
  // Must start with JPEG SOI marker FF D8
  if (view.getUint16(0) !== 0xFFD8) return null;
  let offset = 2;
  while (offset < view.byteLength - 2) {
    const marker = view.getUint16(offset);
    if (marker === 0xFFE1) { // APP1 = EXIF
      return parseApp1(view, offset + 4);
    }
    if ((marker & 0xFF00) !== 0xFF00) break;
    offset += 2 + view.getUint16(offset + 2);
  }
  return null;
}

function parseApp1(view, start) {
  // Check for "Exif\0\0" header
  const exifHeader = String.fromCharCode(
    view.getUint8(start), view.getUint8(start+1),
    view.getUint8(start+2), view.getUint8(start+3)
  );
  if (exifHeader !== 'Exif') return null;
  const tiffStart = start + 6;
  const littleEndian = view.getUint16(tiffStart) === 0x4949;
  const readUint16 = o => view.getUint16(tiffStart + o, littleEndian);
  const readUint32 = o => view.getUint32(tiffStart + o, littleEndian);

  // IFD0 offset
  const ifd0 = readUint32(4);
  const ifd0Entries = readUint16(ifd0);
  let gpsIFDOffset = null, subIFDOffset = null;

  for (let i = 0; i < ifd0Entries; i++) {
    const eOff = ifd0 + 2 + i * 12;
    const tag = readUint16(eOff);
    if (tag === 0x8825) gpsIFDOffset = readUint32(eOff + 8);  // GPS IFD
    if (tag === 0x8769) subIFDOffset = readUint32(eOff + 8);  // Exif SubIFD
  }

  const result = {};

  // Parse GPS IFD
  if (gpsIFDOffset !== null) {
    const gpsEntries = readUint16(gpsIFDOffset);
    const gps = {};
    for (let i = 0; i < gpsEntries; i++) {
      const eOff = gpsIFDOffset + 2 + i * 12;
      const tag  = readUint16(eOff);
      const type = readUint16(eOff + 2);
      const count = readUint32(eOff + 4);
      const valOff = eOff + 8;
      if (type === 5) { // RATIONAL
        // RATIONAL is 8 bytes, never fits the 4-byte inline field — always stored at offset
        const dataOff = readUint32(valOff);
        const readRat = (o) => {
          const n = view.getUint32(tiffStart + o, littleEndian);
          const d = view.getUint32(tiffStart + o + 4, littleEndian);
          return d ? n / d : 0;
        };
        if (tag === 2) gps.lat = [readRat(dataOff), readRat(dataOff+8), readRat(dataOff+16)]; // GPSLatitude
        if (tag === 4) gps.lng = [readRat(dataOff), readRat(dataOff+8), readRat(dataOff+16)]; // GPSLongitude
        if (tag === 6) gps.alt = readRat(dataOff);                                              // GPSAltitude
      }
      if (type === 2) { // ASCII
        const strOff = count <= 4 ? valOff : readUint32(valOff);
        let str = '';
        for (let c = 0; c < count - 1; c++) str += String.fromCharCode(view.getUint8(tiffStart + strOff + c));
        if (tag === 1) gps.latRef = str;  // N/S
        if (tag === 3) gps.lngRef = str;  // E/W
        if (tag === 5) gps.altRef = view.getUint8(valOff); // 0=above, 1=below
      }
    }
    if (gps.lat && gps.lng) {
      const toDecimal = (dms) => dms[0] + dms[1]/60 + dms[2]/3600;
      result.lat = toDecimal(gps.lat) * (gps.latRef === 'S' ? -1 : 1);
      result.lng = toDecimal(gps.lng) * (gps.lngRef === 'W' ? -1 : 1);
      if (gps.alt !== undefined) result.altitude = gps.alt * (gps.altRef === 1 ? -1 : 1);
    }
  }

  // Parse Exif SubIFD for DateTimeOriginal (tag 0x9003)
  if (subIFDOffset !== null) {
    const subEntries = readUint16(subIFDOffset);
    for (let i = 0; i < subEntries; i++) {
      const eOff = subIFDOffset + 2 + i * 12;
      const tag  = readUint16(eOff);
      if (tag === 0x9003) { // DateTimeOriginal
        const count = readUint32(eOff + 4);
        const strOff = count <= 4 ? eOff + 8 : readUint32(eOff + 8);
        let str = '';
        for (let c = 0; c < count - 1; c++) str += String.fromCharCode(view.getUint8(tiffStart + strOff + c));
        // Format: "YYYY:MM:DD HH:MM:SS"
        const m = str.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
        if (m) result.datetime = new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
        break;
      }
    }
  }

  return Object.keys(result).length ? result : null;
}

function applyExifData(exif) {
  if (exif.lat == null && !exif.datetime) return;

  let notice = [];

  if (exif.lat !== undefined && exif.lng !== undefined) {
    clearLocationDerivedData();
    showingDemo = false;
    gpsData = {
      lat: exif.lat, lng: exif.lng,
      altitude: exif.altitude != null ? exif.altitude : null,
      accuracy: null, heading: null, speed: null,
      _fixTime: Date.now(),
      _source: 'exif'
    };
    notice.push('GPS from photo EXIF');
    fetchAddress(exif.lat, exif.lng);
    fetchMapTile(exif.lat, exif.lng);
    fetchWeather(exif.lat, exif.lng);
  }

  if (exif.datetime) {
    if (!hasValidGps()) {
      // Date-only EXIF must not invent coordinates
      gpsData = gpsData || null;
    }
    if (gpsData) {
      gpsData._exifDate = exif.datetime;
      notice.push('date from photo EXIF');
    }
  }

  if (notice.length) {
    setGPSStatus('found', `📷 ${notice.join(' + ')} — location updated`);
    updateStampActionButtons();
    redrawStamp();
  }
}

// ── Preview & Stamp ───────────────────────────────────────
function showPreview() {
  previewWrap.classList.remove('hidden');
  redrawStamp();
  updateStampActionButtons();
  setTimeout(() => previewWrap.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
}

function redrawStamp() {
  if (!capturedImage || !stampCanvas) return;

  // Marketing demo: draw with demo* data only (never touches real gpsData)
  if (showingDemo && demoImage && demoGpsData) {
    drawDemoStamp();
    updateStampActionButtons();
    return;
  }

  if (!hasValidGps()) {
    drawLocationUnavailable(capturedImage, stampCanvas);
    updateStampActionButtons();
    return;
  }

  drawStampedImage(capturedImage, stampCanvas);
  updateStampActionButtons();
}

/** Sync draw using demo state without contaminating real gps/address/weather. */
function drawDemoStamp() {
  const savedGps = gpsData;
  const savedAddr = addressData;
  const savedWeather = weatherData;
  const savedMap = mapTileImg;
  const savedPin = mapTilePin;
  gpsData = demoGpsData;
  addressData = demoAddressData;
  weatherData = demoWeatherData;
  mapTileImg = null;
  mapTilePin = null;
  try {
    drawStampedImage(demoImage, stampCanvas);
  } finally {
    gpsData = savedGps;
    addressData = savedAddr;
    weatherData = savedWeather;
    mapTileImg = savedMap;
    mapTilePin = savedPin;
  }
}

function drawLocationUnavailable(img, targetCanvas) {
  const ctx  = targetCanvas.getContext('2d');
  const maxW = 1920; // Preview always capped for memory safety
  const scale = img.width > maxW ? maxW / img.width : 1;
  targetCanvas.width  = Math.round(img.width  * scale);
  targetCanvas.height = Math.round(img.height * scale);
  ctx.drawImage(img, 0, 0, targetCanvas.width, targetCanvas.height);
  const W = targetCanvas.width;
  const H = targetCanvas.height;
  const barH = Math.max(48, Math.round(H * 0.08));
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, H - barH, W, barH);
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${Math.max(14, Math.round(W / 28))}px ${STAMP_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Location not available — allow GPS or use a photo with EXIF GPS', W / 2, H - barH / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawStampedImage(img, targetCanvas, opts) {
  const ctx  = targetCanvas.getContext('2d');
  // Preview stays at ~1920. Download may pass { fullRes: true } when the checkbox is on.
  const wantFull = !!(opts && opts.fullRes && document.getElementById('tog-full-res')?.checked);
  const maxW = wantFull ? Infinity : 1920;
  const scale = img.width > maxW ? maxW / img.width : 1;
  targetCanvas.width  = Math.round(img.width  * scale);
  targetCanvas.height = Math.round(img.height * scale);
  ctx.drawImage(img, 0, 0, targetCanvas.width, targetCanvas.height);
  if (!hasValidGps()) return;
  drawStamp(ctx, targetCanvas.width, targetCanvas.height);
}

function drawStamp(ctx, W, H) {
  const lines   = buildStampLines({ skipCompassText: true });
  const showMap = chk('tog-map') && mapTileImg && mapTilePin;
  const showCompass = chk('tog-compass');
  const tmpl    = currentTemplate;
  if (!lines.length && !showMap && !showCompass && tmpl !== 'card') return;

  const baseSize = Math.max(16, Math.round(W / 35));
  const lineH    = Math.round(baseSize * 1.55);
  const padX     = Math.round(W * 0.022);
  const padY     = Math.round(H * 0.018);

  if (tmpl === 'minimal') {
    drawMinimal(ctx, lines, W, H, baseSize, lineH, padX, padY, showMap, showCompass);
  } else if (tmpl === 'pro') {
    drawPro(ctx, lines, W, H, baseSize, lineH, padX, padY, showMap, showCompass);
  } else if (tmpl === 'card') {
    drawCard(ctx, W, H, baseSize, padX, padY, showMap, showCompass);
  } else if (tmpl === 'enterprise') {
    drawEnterprise(ctx, lines, W, H, baseSize, lineH, padX, padY, showMap, showCompass);
  } else {
    drawClassic(ctx, lines, W, H, baseSize, lineH, padX, padY, showMap, showCompass);
  }
}

const STAMP_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const BRAND_NAME = 'GPS Cam Stamp';

function getHeadingDeg() {
  if (!gpsData || gpsData.heading == null || Number.isNaN(gpsData.heading)) return null;
  return gpsData.heading;
}

/** Rival-style circular compass dial with needle + degree readout */
function drawCompassDial(ctx, cx, cy, r, heading, isLight) {
  const ring = isLight ? '#94a3b8' : '#64748b';
  const face = isLight ? 'rgba(255,255,255,0.92)' : 'rgba(15,23,42,0.92)';
  const ink  = isLight ? '#0f172a' : '#f8fafc';
  const mute = isLight ? '#64748b' : '#94a3b8';

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = face;
  ctx.fill();
  ctx.strokeStyle = ring;
  ctx.lineWidth = Math.max(1.5, r * 0.06);
  ctx.stroke();

  // Tick marks
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const inner = r * (i % 3 === 0 ? 0.72 : 0.82);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    ctx.lineTo(cx + Math.cos(a) * (r * 0.92), cy + Math.sin(a) * (r * 0.92));
    ctx.strokeStyle = i % 3 === 0 ? ink : mute;
    ctx.lineWidth = i % 3 === 0 ? Math.max(1.5, r * 0.05) : 1;
    ctx.stroke();
  }

  const labSz = Math.max(8, Math.round(r * 0.28));
  ctx.font = `bold ${labSz}px ${STAMP_FONT}`;
  ctx.fillStyle = mute;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy - r * 0.55);
  ctx.fillText('S', cx, cy + r * 0.55);
  ctx.fillText('E', cx + r * 0.55, cy);
  ctx.fillText('W', cx - r * 0.55, cy);

  if (heading != null) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((heading * Math.PI) / 180);
    // Needle
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.62);
    ctx.lineTo(r * 0.12, r * 0.08);
    ctx.lineTo(0, r * 0.18);
    ctx.lineTo(-r * 0.12, r * 0.08);
    ctx.closePath();
    ctx.fillStyle = '#ef4444';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, r * 0.18);
    ctx.lineTo(r * 0.08, r * 0.48);
    ctx.lineTo(-r * 0.08, r * 0.48);
    ctx.closePath();
    ctx.fillStyle = isLight ? '#94a3b8' : '#475569';
    ctx.fill();
    ctx.restore();
  }

  // Hub
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(2, r * 0.08), 0, Math.PI * 2);
  ctx.fillStyle = '#0ea5e9';
  ctx.fill();

  // Degree inside face (below hub) so it never clips the stamp bar
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = ink;
  ctx.font = `bold ${Math.max(8, Math.round(r * 0.28))}px ${STAMP_FONT}`;
  ctx.fillText(heading != null ? `${Math.round(heading)}°` : '—', cx, cy + r * 0.42);
  ctx.restore();
}


// Classic — dark bar at bottom, compass dial + map when enabled
function drawClassic(ctx, lines, W, H, sz, lH, pX, pY, showMap, showCompass) {
  const isLight = document.getElementById('themeToggle')?.value === 'light';
  const heading = getHeadingDeg();
  const compassSz = showCompass ? Math.round(sz * 4.2) : 0;
  const mapSz = showMap ? Math.round(sz * 4) : 0;
  const gap = Math.round(pX * 0.6);

  ctx.font = `${sz}px ${STAMP_FONT}`;
  const textMaxW = W - mapSz - compassSz - pX * 2 - (showMap ? gap : 0) - (showCompass ? gap : 0);

  const wrappedLines = [];
  lines.forEach(line => wrappedLines.push(...wrapText(ctx, line, textMaxW)));

  const barH = Math.max(wrappedLines.length * lH + pY * 2, mapSz, compassSz + pY);

  ctx.fillStyle = isLight ? 'rgba(255,255,255,0.88)' : 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, H - barH, W, barH);
  ctx.fillStyle = isLight ? '#0284c7' : '#0ea5e9';
  ctx.fillRect(0, H - barH, W, 2);

  let rightX = W - pX;
  if (showMap) {
    const m = Math.min(mapSz, barH - 4);
    rightX -= m;
    drawMapThumb(ctx, rightX, H - barH + (barH - m) / 2, m, m, mapTileImg, mapTilePin);
    rightX -= gap;
  }
  if (showCompass) {
    const r = Math.min(compassSz, barH - pY) * 0.42;
    const cx = rightX - compassSz / 2;
    const cy = H - barH / 2;
    drawCompassDial(ctx, cx, cy, r, heading, isLight);
  }

  ctx.textBaseline = 'top';
  if (!isLight) {
    ctx.shadowColor = 'rgba(0,0,0,0.95)';
    ctx.shadowBlur = Math.max(3, Math.round(sz * 0.15));
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
  }
  wrappedLines.forEach((line, i) => {
    ctx.font = `${i === 0 ? 'bold ' : ''}${sz}px ${STAMP_FONT}`;
    ctx.fillStyle = isLight ? (i === 0 ? '#0284c7' : '#1e293b') : (i === 0 ? '#38bdf8' : '#f1f5f9');
    ctx.fillText(line, pX, H - barH + pY + i * lH);
  });
  ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
}

// Minimal — compact tag + optional compass/map
function drawMinimal(ctx, lines, W, H, sz, lH, pX, pY, showMap, showCompass) {
  const isLight = document.getElementById('themeToggle')?.value === 'light';
  const heading = getHeadingDeg();
  const minSz = Math.max(10, Math.round(sz * 0.85));
  const minLH = Math.round(minSz * 1.5);
  const compassSz = showCompass ? Math.round(sz * 3.6) : 0;

  ctx.font = `${minSz}px ${STAMP_FONT}`;
  const tagW = Math.round(W * (showMap || showCompass ? 0.46 : 0.52));

  const wrappedLines = [];
  lines.forEach(line => wrappedLines.push(...wrapText(ctx, line, tagW - pX * 2)));

  const tagH = Math.max(wrappedLines.length * minLH + pY * 1.5, showMap ? Math.round(sz * 4) : 0, compassSz);
  const x = pX, y = H - tagH - pY;

  ctx.fillStyle = isLight ? 'rgba(255,255,255,0.88)' : 'rgba(0,0,0,0.65)';
  roundRect(ctx, x, y, tagW, tagH, 6);
  ctx.fill();
  ctx.strokeStyle = isLight ? 'rgba(2,132,199,0.8)' : 'rgba(14,165,233,0.6)';
  ctx.lineWidth = 1.2;
  roundRect(ctx, x, y, tagW, tagH, 6);
  ctx.stroke();

  ctx.textBaseline = 'top';
  wrappedLines.forEach((line, i) => {
    ctx.font = `${minSz}px ${STAMP_FONT}`;
    ctx.fillStyle = isLight ? (i === 0 ? '#0284c7' : '#334155') : (i === 0 ? '#38bdf8' : '#cbd5e1');
    ctx.fillText(line, x + pX * 0.75, y + pY * 0.75 + i * minLH);
  });

  let rx = W - pX;
  if (showMap) {
    const mapSz = tagH;
    rx -= mapSz;
    drawMapThumb(ctx, rx, y, mapSz, mapSz, mapTileImg, mapTilePin);
    rx -= pX * 0.5;
  }
  if (showCompass) {
    const side = Math.min(compassSz, tagH);
    const r = side * 0.42;
    drawCompassDial(ctx, rx - side / 2, y + tagH / 2, r, heading, isLight);
  }
}

// Pro — rival-style right side panel (GPS Map Camera Pro layout)
function drawPro(ctx, lines, W, H, sz, lH, pX, pY, showMap, showCompass) {
  const isLight = document.getElementById('themeToggle')?.value === 'light';
  const heading = getHeadingDeg();
  // Slightly wider on tall phone shots so text/map still fit like rival apps
  const panelW = Math.max(220, Math.min(520, Math.round(W * (H > W ? 0.36 : 0.32))));
  const headerH = Math.round(sz * 2.1);
  const compassSz = showCompass ? Math.round(Math.min(panelW - pX * 2, sz * 4.5)) : 0;

  ctx.fillStyle = isLight ? 'rgba(255,255,255,0.94)' : 'rgba(8,14,26,0.88)';
  ctx.fillRect(W - panelW, 0, panelW, H);
  ctx.fillStyle = isLight ? '#0284c7' : '#0ea5e9';
  ctx.fillRect(W - panelW, 0, panelW, headerH);

  const displayLogo = customLogoImg || appLogoImg;
  const logoSz = Math.round(sz * 1.25);
  const headerText = customLogoImg
    ? (document.getElementById('projectName')?.value?.trim() || 'PROJECT SITE')
    : BRAND_NAME;
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(sz * 0.82)}px ${STAMP_FONT}`;
  ctx.textBaseline = 'middle';
  let hx = W - panelW + pX;
  if (displayLogo) {
    try { ctx.drawImage(displayLogo, hx, (headerH - logoSz) / 2, logoSz, logoSz); } catch (_) {}
    hx += logoSz + sz * 0.3;
  }
  ctx.fillText(headerText, hx, headerH / 2);

  ctx.font = `${sz}px ${STAMP_FONT}`;
  const wrapped = [];
  lines.forEach(line => wrapped.push(...wrapText(ctx, line, panelW - pX * 2.2)));

  let y = headerH + pY;
  ctx.textBaseline = 'top';
  wrapped.forEach((line, i) => {
    ctx.font = `${i === 0 ? 'bold ' : ''}${sz}px ${STAMP_FONT}`;
    ctx.fillStyle = isLight ? (i === 0 ? '#0284c7' : '#334155') : (i === 0 ? '#7dd3fc' : '#cbd5e1');
    ctx.fillText(line, W - panelW + pX, y);
    y += lH * 1.05;
  });

  if (showCompass) {
    y += sz * 0.4;
    const r = compassSz * 0.4;
    drawCompassDial(ctx, W - panelW / 2, y + compassSz / 2, r, heading, isLight);
    y += compassSz + sz * 0.3;
  }

  if (showMap) {
    const mapAvail = H - y - pY;
    if (mapAvail > 24) {
      const side = Math.min(panelW - pX * 2, mapAvail);
      const mx = W - panelW + Math.round((panelW - side) / 2);
      drawMapThumb(ctx, mx, y, side, side, mapTileImg, mapTilePin);
    }
  }
}

function drawEnterprise(ctx, lines, W, H, sz, lH, pX, pY, showMap, showCompass) {
  const isLight = document.getElementById('themeToggle')?.value === 'light';
  const heading = getHeadingDeg();
  // Enterprise always shows compass dial (template identity); toggle still controls data
  const compassW = Math.round(sz * 6.2);
  const mapW = showMap ? Math.round(sz * 5) : 0;
  const textMaxW = W - compassW - mapW - pX * 4;

  ctx.font = `${sz}px ${STAMP_FONT}`;
  const wrappedLines = [];
  lines.forEach(line => wrappedLines.push(...wrapText(ctx, line, textMaxW)));
  const barH = Math.max(wrappedLines.length * lH + pY * 2.5, compassW + pY, mapW + pY * 2);

  ctx.fillStyle = isLight ? 'rgba(255,255,255,0.94)' : 'rgba(12,16,24,0.88)';
  ctx.fillRect(0, H - barH, W, barH);
  ctx.fillStyle = isLight ? '#0ea5e9' : '#38bdf8';
  ctx.fillRect(0, H - barH, W, 2);

  const cx = pX + compassW / 2, cy = H - barH / 2;
  drawCompassDial(ctx, cx, cy, compassW * 0.38, heading, isLight);

  // Small brand under dial area edge
  ctx.font = `600 ${Math.round(sz * 0.55)}px ${STAMP_FONT}`;
  ctx.fillStyle = isLight ? '#64748b' : '#94a3b8';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(BRAND_NAME, cx, H - pY * 0.9 - Math.round(sz * 0.55));
  ctx.textAlign = 'left';

  ctx.textBaseline = 'top';
  wrappedLines.forEach((line, i) => {
    ctx.font = `${i === 0 ? 'bold ' : ''}${sz}px ${STAMP_FONT}`;
    ctx.fillStyle = isLight ? (i === 0 ? '#0284c7' : '#1e293b') : (i === 0 ? '#38bdf8' : '#f1f5f9');
    ctx.fillText(line, compassW + pX * 2, H - barH + pY + i * lH);
  });

  if (showMap) {
    const mapX = W - mapW - pX;
    const mapY = H - barH + (barH - mapW) / 2;
    drawMapThumb(ctx, mapX, mapY, mapW, mapW, mapTileImg, mapTilePin);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function drawCard(ctx, W, H, sz, padX, padY, showMap, showCompass) {
  const FONT    = STAMP_FONT;
  const now     = (gpsData && gpsData._exifDate) ? gpsData._exifDate : new Date();
  const accentH = Math.max(4, Math.round(sz * 0.15));
  const mapPad  = Math.round(padY * 0.5);
  const cardW   = Math.round(W * 0.92);
  const cardX   = Math.round((W - cardW) / 2);
  const mapSz   = showMap ? Math.round(cardW * 0.28) : 0;
  const mapGap  = showMap ? Math.round(padX * 1.2) : 0;
  const heading = getHeadingDeg();
  const compassSz = showCompass ? Math.round(sz * 3.4) : 0;

  // Brand chip sized first so title never runs under it
  const smSz    = Math.round(sz * 0.72);
  const bodySz  = Math.round(sz * 0.88);
  const titleSz = Math.round(sz * 1.12);
  ctx.font = `600 ${smSz}px ${FONT}`;
  const brandPad = Math.round(smSz * 0.5);
  const brandW = ctx.measureText(BRAND_NAME).width + brandPad * 2;
  const brandH = Math.round(smSz * 1.55);
  const brandReserve = brandW + Math.round(padX * 0.8);

  const textAreaW = cardW - (showMap ? mapSz + mapGap : 0) - padX * 2;

  let cityLine = '';
  let fullAddr = '';
  if (chk('tog-address') && addressData) {
    const locArr = [addressData.city || addressData.road, addressData.state, addressData.country].filter(Boolean);
    cityLine = locArr.join(', ');
    if (addressData.country && addressData.country.toLowerCase() === 'india') cityLine += ' \uD83C\uDDEE\uD83C\uDDF3';
    fullAddr = [addressData.road, addressData.city, addressData.state, addressData.postcode, addressData.country].filter(Boolean).join(', ');
  } else if (hasValidGps()) {
    cityLine = formatDecimalCoords(gpsData.lat, gpsData.lng, 4);
  } else {
    cityLine = 'Location not available';
  }

  let coordLine = '';
  if (chk('tog-coords') && hasValidGps()) {
    coordLine = coordFmt === 'dms'
      ? `${toDMS(gpsData.lat, 'lat')}  ${toDMS(gpsData.lng, 'lng')}`
      : formatDecimalCoords(gpsData.lat, gpsData.lng, 6);
  }

  let dateStr = '';
  if (chk('tog-datetime')) {
    try {
      const opts = { weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' };
      dateStr = now.toLocaleString('en-GB', opts).replace(/,\s+/, ' ');
    } catch (_) { dateStr = `${fmtDate(now)}  ${fmtTime(now)}`; }
  }

  const extraLines = buildExtraLines({ skipCompassText: true });

  // Title wraps around the brand chip on the first line(s)
  ctx.font = `bold ${titleSz}px ${FONT}`;
  const titleLines = cityLine ? wrapText(ctx, cityLine, Math.max(40, textAreaW - brandReserve)) : [];
  ctx.font = `${bodySz}px ${FONT}`;
  const addrLines  = fullAddr ? wrapText(ctx, fullAddr, textAreaW) : [];

  const textH =
    Math.max(titleLines.length * titleSz * 1.35, brandH + titleSz * 0.2) +
    (addrLines.length ? addrLines.length * bodySz * 1.25 + bodySz * 0.35 : 0) +
    (coordLine ? smSz * 1.35 : 0) +
    (dateStr   ? smSz * 1.35 : 0) +
    extraLines.length * smSz * 1.2 +
    (showCompass ? compassSz * 0.15 : 0) +
    padY * 0.4;

  const contentH = Math.max(textH, showMap ? mapSz : 0, showCompass ? compassSz : 0);
  const cardH    = Math.round(contentH + padY * 2 + accentH);
  const cardY    = H - cardH - Math.round(H * 0.015);

  ctx.save();
  ctx.shadowColor   = 'rgba(0,0,0,0.42)';
  ctx.shadowBlur    = Math.round(sz * 1.4);
  ctx.shadowOffsetY = Math.round(sz * 0.35);
  ctx.fillStyle     = 'rgba(255,255,255,0.97)';
  roundRect(ctx, cardX, cardY, cardW, cardH, Math.round(sz * 0.45));
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = '#0ea5e9';
  roundRect(ctx, cardX, cardY, cardW, accentH, Math.round(sz * 0.45));
  ctx.fill();
  // Cover bottom radii of accent so it's a clean strip
  ctx.fillRect(cardX, cardY + accentH * 0.5, cardW, accentH * 0.55);

  if (showMap && mapSz > 0) {
    const mX = cardX + mapPad;
    const mY = cardY + accentH + mapPad;
    const mSide = Math.min(mapSz, cardH - accentH - mapPad * 2);
    drawMapThumb(ctx, mX, mY, mSide, mSide, mapTileImg, mapTilePin);
  }

  const textX = cardX + padX + (showMap && mapSz > 0 ? mapSz + mapGap : 0);
  let   textY = cardY + accentH + padY * 0.65;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  // Brand chip top-right of text column (never over title)
  const bX = cardX + cardW - brandW - Math.round(padX * 0.55);
  const bY = cardY + accentH + Math.round(padY * 0.35);
  ctx.fillStyle = '#0ea5e9';
  roundRect(ctx, bX, bY, brandW, brandH, 4);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${smSz}px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(BRAND_NAME, bX + brandPad, bY + brandH / 2);
  ctx.textBaseline = 'top';

  if (titleLines.length) {
    ctx.font = `bold ${titleSz}px ${FONT}`;
    ctx.fillStyle = '#111827';
    titleLines.forEach(l => { ctx.fillText(l, textX, textY); textY += titleSz * 1.35; });
    textY = Math.max(textY, bY + brandH + bodySz * 0.25);
    textY += bodySz * 0.15;
  }

  if (addrLines.length) {
    ctx.font = `${bodySz}px ${FONT}`;
    ctx.fillStyle = '#374151';
    addrLines.forEach(l => { ctx.fillText(l, textX, textY); textY += bodySz * 1.25; });
    textY += bodySz * 0.15;
  }

  if (coordLine) {
    ctx.font = `${smSz}px ${FONT}`;
    ctx.fillStyle = '#6b7280';
    ctx.fillText(coordLine, textX, textY);
    textY += smSz * 1.35;
  }

  if (dateStr) {
    ctx.font = `${smSz}px ${FONT}`;
    ctx.fillStyle = '#6b7280';
    ctx.fillText(dateStr, textX, textY);
    textY += smSz * 1.35;
  }

  if (extraLines.length) {
    ctx.font = `${smSz}px ${FONT}`;
    ctx.fillStyle = '#9ca3af';
    extraLines.forEach(l => {
      if (textY + smSz < cardY + cardH - mapPad) {
        ctx.fillText(l, textX, textY);
        textY += smSz * 1.2;
      }
    });
  }

  if (showCompass) {
    const r = compassSz * 0.42;
    const cx = cardX + cardW - padX - compassSz / 2;
    const cy = cardY + cardH - padY - compassSz / 2;
    drawCompassDial(ctx, cx, cy, r, heading, true);
  }

  ctx.textBaseline = 'alphabetic';
}

function drawMapThumb(ctx, x, y, w, h, tileImg, pin) {
  if (!pin || typeof pin.px === 'undefined' || typeof pin.py === 'undefined') return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  // Fill the entire bounding box with the tile so there's no empty space
  try {
    if (tileImg && tileImg.complete && tileImg.naturalWidth > 0) {
      ctx.drawImage(tileImg, x, y, w, h);
    }
  } catch(e) {
    // Silently fail if tileImg is invalid (e.g. corrupted on certain Android devices)
  }
  
  // Calculate relative pin position within the box
  // mapTilePin is 0-256 relative to the original tile
  const pinX = x + (pin.px / 256) * w;
  const pinY = y + (pin.py / 256) * h;
  
  // Map pin — clearly visible with drop shadow
  const minDim = Math.min(w, h);
  const r = Math.max(8, Math.round(minDim * 0.06));
  ctx.save();  // shadow save (nested inside clip save)
  ctx.shadowColor   = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur    = Math.max(4, Math.round(r * 0.6));
  ctx.shadowOffsetY = 2;
  ctx.beginPath();
  ctx.arc(pinX, pinY - r * 1.5, r, Math.PI, 0); // dome
  ctx.lineTo(pinX, pinY + r * 1.5);              // tip
  ctx.closePath();
  ctx.fillStyle = '#ef4444';
  ctx.fill();
  ctx.restore();  // clear shadow
  // White outline
  ctx.beginPath();
  ctx.arc(pinX, pinY - r * 1.5, r, Math.PI, 0);
  ctx.lineTo(pinX, pinY + r * 1.5);
  ctx.closePath();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = Math.max(1.5, Math.round(r * 0.28));
  ctx.stroke();
  // White dot inside dome
  ctx.beginPath();
  ctx.arc(pinX, pinY - r * 1.5, r * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.restore();  // un-clip (original save at top of drawMapThumb)
  // Border
  ctx.strokeStyle = 'rgba(14,165,233,0.7)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, w, h);
  // Map attribution (ArcGIS World Imagery tiles require Esri attribution)
  ctx.font = `${Math.max(7, Math.round(Math.min(w,h) * 0.09))}px sans-serif`;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('Powered by Esri', x + w - 2, y + h - 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// Build array of stamp text lines based on toggles + GPS data
function buildStampLines(opts = {}) {
  const lines = [];
  const skipCompassText = !!opts.skipCompassText;

  if (!hasValidGps()) {
    lines.push('Location not available');
    return lines;
  }

  // Use EXIF original capture time if available, otherwise current time
  const now = (gpsData && gpsData._exifDate) ? gpsData._exifDate : new Date();

  if (chk('tog-address') && addressData) {
    const addr = [addressData.road, addressData.city, addressData.state, addressData.country].filter(Boolean).join(', ');
    if (addr) lines.push(addr);
  }

  if (chk('tog-coords')) {
    if (coordFmt === 'dms') {
      lines.push(`${toDMS(gpsData.lat,'lat')}  ${toDMS(gpsData.lng,'lng')}`);
    } else {
      lines.push(formatDecimalCoords(gpsData.lat, gpsData.lng, 6));
    }
  }

  if (chk('tog-altitude') && gpsData.altitude != null) {
    lines.push(`ALT: ${Math.round(gpsData.altitude)} m`);
  }

  if (chk('tog-datetime')) {
    lines.push(`${fmtDate(now)}  ${fmtTime(now)}`);
  }

  if (chk('tog-accuracy')) {
    if (gpsData.accuracy != null && Number.isFinite(gpsData.accuracy)) {
      lines.push(`ACC: \u00B1${Math.round(gpsData.accuracy)} m`);
    } else {
      lines.push('ACC: n/a');
    }
  }

  if (!skipCompassText && chk('tog-compass') && gpsData.heading != null) {
    lines.push(`DIR: ${headingLabel(gpsData.heading)} (${Math.round(gpsData.heading)}\u00B0)`);
  }

  if (chk('tog-speed') && gpsData.speed != null) {
    const spd = tempUnit === 'F'
      ? Math.round(gpsData.speed * 2.237) + ' mph'
      : Math.round(gpsData.speed * 3.6) + ' km/h';
    lines.push(`SPD: ${spd}`);
  }

  if (chk('tog-weather') && weatherData) {
    const wTemp = tempUnit === 'F'
      ? Math.round(weatherData.temp * 9/5 + 32) + '\u00B0F'
      : weatherData.temp + '\u00B0C';
    lines.push(`${wTemp}  ${weatherData.condition}`);
  }

  if (gpsData._source === 'exif') lines.push('From photo EXIF');
  else if (gpsData._source === 'live') lines.push('Live GPS');

  const project = document.getElementById('projectName')?.value?.trim();
  if (project) lines.push('PROJECT: ' + project);

  const note = document.getElementById('customNote')?.value?.trim();
  if (note) lines.push('NOTE: ' + note);

  return lines;
}

// Extra stamp fields only (altitude, accuracy, compass, speed, weather, note)
// Used by drawCard which renders address / coords / date directly
function buildExtraLines(opts = {}) {
  const lines = [];
  const skipCompassText = !!opts.skipCompassText;
  if (!hasValidGps()) return lines;
  if (chk('tog-altitude') && gpsData.altitude != null)
    lines.push(`ALT: ${Math.round(gpsData.altitude)} m`);
  if (chk('tog-accuracy')) {
    if (gpsData.accuracy != null && Number.isFinite(gpsData.accuracy)) {
      lines.push(`ACC: \u00B1${Math.round(gpsData.accuracy)} m`);
    } else {
      lines.push('ACC: n/a');
    }
  }
  if (!skipCompassText && chk('tog-compass') && gpsData.heading != null)
    lines.push(`DIR: ${headingLabel(gpsData.heading)} (${Math.round(gpsData.heading)}\u00B0)`);
  if (chk('tog-speed') && gpsData.speed != null) {
    const spd = tempUnit === 'F'
      ? Math.round(gpsData.speed * 2.237) + ' mph'
      : Math.round(gpsData.speed * 3.6) + ' km/h';
    lines.push(`SPD: ${spd}`);
  }
  if (chk('tog-weather') && weatherData) {
    const wTemp = tempUnit === 'F'
      ? Math.round(weatherData.temp * 9/5 + 32) + '\u00B0F'
      : weatherData.temp + '\u00B0C';
    lines.push(`${wTemp}  ${weatherData.condition}`);
  }
  if (gpsData._source === 'exif') lines.push('From photo EXIF');
  else if (gpsData._source === 'live') lines.push('Live GPS');
  const project = document.getElementById('projectName')?.value?.trim();
  if (project) lines.push('PROJECT: ' + project);

  const note = document.getElementById('customNote')?.value?.trim();
  if (note) lines.push('NOTE: ' + note);
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
function formatExifDateTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function setExifWriteNote(msg) {
  const el = document.getElementById('exifWriteNote');
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.style.display = 'block';
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
}

/** Build piexif GPS (+ DateTimeOriginal) object; merge with source EXIF when available. */
function buildExifBytesForStamp(sourceBinary) {
  if (typeof piexif === 'undefined') throw new Error('piexif not loaded');
  let exifObj = null;
  if (sourceBinary) {
    try { exifObj = piexif.load(sourceBinary); } catch (_) { exifObj = null; }
  }
  if (!exifObj) {
    exifObj = { '0th': {}, Exif: {}, GPS: {}, '1st': {}, thumbnail: null };
  }
  if (!exifObj.GPS) exifObj.GPS = {};
  if (!exifObj.Exif) exifObj.Exif = {};
  if (!exifObj['0th']) exifObj['0th'] = {};

  const lat = gpsData.lat;
  const lng = gpsData.lng;
  exifObj.GPS[piexif.GPSIFD.GPSLatitudeRef] = lat >= 0 ? 'N' : 'S';
  exifObj.GPS[piexif.GPSIFD.GPSLatitude] = piexif.GPSHelper.degToDmsRational(Math.abs(lat));
  exifObj.GPS[piexif.GPSIFD.GPSLongitudeRef] = lng >= 0 ? 'E' : 'W';
  exifObj.GPS[piexif.GPSIFD.GPSLongitude] = piexif.GPSHelper.degToDmsRational(Math.abs(lng));
  if (gpsData.altitude != null && Number.isFinite(gpsData.altitude)) {
    const alt = Math.abs(gpsData.altitude);
    exifObj.GPS[piexif.GPSIFD.GPSAltitudeRef] = gpsData.altitude < 0 ? 1 : 0;
    exifObj.GPS[piexif.GPSIFD.GPSAltitude] = [Math.round(alt * 100), 100];
  }

  const dt = (gpsData && gpsData._exifDate) ? gpsData._exifDate : new Date();
  const dtStr = formatExifDateTime(dt);
  exifObj.Exif[piexif.ExifIFD.DateTimeOriginal] = dtStr;
  exifObj['0th'][piexif.ImageIFD.DateTime] = dtStr;

  return piexif.dump(exifObj);
}

function canvasToJpegBinary(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error('toBlob failed')); return; }
      blob.arrayBuffer().then((ab) => resolve(arrayBufferToBinaryString(ab))).catch(reject);
    }, 'image/jpeg', quality == null ? 0.92 : quality);
  });
}

function binaryStringToBlob(binary, mime) {
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  return new Blob([bytes], { type: mime || 'image/jpeg' });
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && /safari/i.test(navigator.userAgent) && !/chrome|crios|fxios/i.test(navigator.userAgent);
  if (isIOS) {
    const w = window.open();
    if (!w) { alert('Please allow popups to view or save the photo.'); URL.revokeObjectURL(url); return; }
    w.document.write('<html><head><title>Save Photo</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;color:#fff;gap:16px;padding:16px;box-sizing:border-box}p{margin:0;font-size:15px;text-align:center;opacity:.85}</style></head><body><p>Long-press the image below → <strong>Add to Photos</strong> to save</p><img src="' + url + '" style="max-width:100%;border-radius:8px"></body></html>');
    w.document.close();
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function downloadPhoto() {
  if (!capturedImage || showingDemo) return;
  const quality = checkGpsQuality();
  if (!quality.ok) {
    setGPSStatus('denied', quality.msg);
    updateStampActionButtons();
    return;
  }
  if (quality.warn && !confirm(quality.msg)) return;

  setExifWriteNote('');

  if (typeof gtag === 'function') {
    gtag('event', 'stamp_generated', {
      event_category: 'engagement',
      event_label: currentTemplate,
      value: batchImages.length
    });
  }

  const label = await promptForLabel();
  const fullRes = !!document.getElementById('tog-full-res')?.checked;
  const writeExif = !!document.getElementById('tog-exif-write')?.checked;

  if (batchImages.length <= 1) {
    const c = document.createElement('canvas');
    drawStampedImage(capturedImage, c, { fullRes });
    if (stampCanvas) {
      try { drawStampedImage(capturedImage, stampCanvas); } catch (_) {}
    }
    await downloadCanvas(c, (batchImages[0]?.filename || 'photo') + '_gpsstamped.jpg', {
      writeExif,
      sourceJpegBinary: batchImages[0]?.jpegBinary || sourceJpegBinary
    });
    try { await savePhotoToDB(c, label); } catch (e) { console.warn('[Gallery] Auto-save failed:', e); }
    updateGalleryTabCount();
  } else {
    for (let i = 0; i < batchImages.length; i++) {
      const { img, filename, jpegBinary } = batchImages[i];
      await new Promise(r => setTimeout(r, i === 0 ? 0 : 400));
      const c = document.createElement('canvas');
      drawStampedImage(img, c, { fullRes });
      await downloadCanvas(c, filename + '_gpsstamped.jpg', {
        skipSharePrompt: i > 0,
        writeExif,
        sourceJpegBinary: jpegBinary || null
      });
      try { await savePhotoToDB(c, label); } catch (e) { console.warn('[Gallery] Auto-save failed:', e); }
    }
    updateGalleryTabCount();
  }
}

async function updateGalleryTabCount() {
  try {
    const photos = await loadAllPhotos();
    const tabBtn = document.getElementById('tab-gallery');
    if (tabBtn && photos.length > 0) {
      tabBtn.textContent = '🖼️ My Photos (' + photos.length + ')';
    }
  } catch (_) { /* ignore */ }
}

async function downloadCanvas(canvas, filename, opts = {}) {
  const writeExif = !!opts.writeExif && hasValidGps();
  let blob = null;
  let exifFailed = false;

  if (writeExif) {
    try {
      let jpeg = await canvasToJpegBinary(canvas, 0.92);
      const exifBytes = buildExifBytesForStamp(opts.sourceJpegBinary || null);
      jpeg = piexif.insert(exifBytes, jpeg);
      blob = binaryStringToBlob(jpeg, 'image/jpeg');
    } catch (err) {
      console.warn('[EXIF] Write failed, downloading stamped JPEG without metadata:', err);
      exifFailed = true;
    }
  }

  if (!blob) {
    blob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92);
    });
  }

  if (!blob) {
    // Last resort: data URL path
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    a.click();
    if (exifFailed) setExifWriteNote('Stamped photo downloaded. EXIF GPS could not be written — visible stamp is still on the image.');
    if (!opts.skipSharePrompt) offerShareStampedPhoto(canvas, filename);
    return;
  }

  triggerBlobDownload(blob, filename);
  if (exifFailed) {
    setExifWriteNote('Stamped photo downloaded. EXIF GPS could not be written — visible stamp is still on the image.');
  } else if (writeExif) {
    setExifWriteNote('');
  }

  if (!opts.skipSharePrompt) {
    if (writeExif && !exifFailed) {
      offerShareBlob(blob, filename);
    } else {
      offerShareStampedPhoto(canvas, filename);
    }
  }
}

function offerShareBlob(blob, filename) {
  if (!navigator.share) return;
  setTimeout(() => {
    const file = new File([blob], filename || 'gpsstamped.jpg', { type: 'image/jpeg' });
    const shareData = { files: [file], title: 'GPS Cam Stamp', text: 'Stamped photo from GPS Cam Stamp' };
    if (navigator.canShare && !navigator.canShare(shareData)) return;
    const existing = document.getElementById('shareStampBtn');
    if (existing) existing.remove();
    const shareBtn = document.createElement('button');
    shareBtn.id = 'shareStampBtn';
    shareBtn.type = 'button';
    shareBtn.textContent = 'Share stamped photo';
    shareBtn.style.cssText = 'position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#3b82f6; color:white; border:none; padding:12px 24px; border-radius:30px; box-shadow:0 10px 15px -3px rgba(0,0,0,0.1); font-weight:600; font-family:sans-serif; cursor:pointer; z-index:10000;';
    shareBtn.onclick = () => {
      navigator.share(shareData).catch(() => {});
      shareBtn.remove();
    };
    document.body.appendChild(shareBtn);
    setTimeout(() => shareBtn.remove(), 10000);
  }, 400);
}

/** Share the JPEG file when Web Share Level 2 is available; otherwise download already happened. */
function offerShareStampedPhoto(canvas, filename) {
  if (!navigator.share || typeof canvas.toBlob !== 'function') return;
  setTimeout(() => {
    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], filename || 'gpsstamped.jpg', { type: 'image/jpeg' });
      const shareData = { files: [file], title: 'GPS Cam Stamp', text: 'Stamped photo from GPS Cam Stamp' };
      const canFiles = !navigator.canShare || navigator.canShare(shareData);
      if (!canFiles) return;

      const existing = document.getElementById('shareStampBtn');
      if (existing) existing.remove();

      const shareBtn = document.createElement('button');
      shareBtn.id = 'shareStampBtn';
      shareBtn.type = 'button';
      shareBtn.textContent = 'Share stamped photo';
      shareBtn.style.cssText = 'position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#3b82f6; color:white; border:none; padding:12px 24px; border-radius:30px; box-shadow:0 10px 15px -3px rgba(0,0,0,0.1); font-weight:600; font-family:sans-serif; cursor:pointer; z-index:10000;';
      shareBtn.onclick = () => {
        navigator.share(shareData).catch(() => { /* user cancelled or unsupported */ });
        shareBtn.remove();
      };
      document.body.appendChild(shareBtn);
      setTimeout(() => shareBtn.remove(), 10000);
    }, 'image/jpeg', 0.92);
  }, 400);
}

// ── UI Helpers ────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  ['camera', 'upload', 'gallery'].forEach(t => {
    const panel = document.getElementById('panel-' + t);
    if (panel) panel.classList.toggle('hidden', t !== tab);
    const btn = document.getElementById('tab-' + t);
    if (btn) {
      btn.classList.toggle('active', t === tab);
      btn.setAttribute('aria-selected', t === tab ? 'true' : 'false');
    }
  });
  if (tab === 'camera') startCamera(); else stopCamera();
  if (tab === 'gallery') renderGallery();
  // Reset preview when switching to camera/upload
  if (tab !== 'gallery') {
    if (previewWrap) previewWrap.classList.add('hidden');
    capturedImage = null;
    batchImages = [];
    showingDemo = false;
  }
  updateStampActionButtons();
}
window.switchTab = switchTab;

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
  if (previewWrap) previewWrap.classList.add('hidden');
  capturedImage = null;
  batchImages = [];
  sourceJpegBinary = null;
  showingDemo = false;
  setExifWriteNote('');
  document.getElementById('customNote').value = '';
  document.getElementById('projectName').value = '';
  if (currentTab === 'camera') startCamera();
  else document.getElementById('fileInput').value = '';
  updateStampActionButtons();
  document.getElementById('tool').scrollIntoView({ behavior: 'smooth', block: 'start' });
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


// --- PWA & UX Enhancements ---

// Android / Chrome desktop: capture install prompt and show button
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('install-btn');
  if (btn) btn.classList.remove('hidden');
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const btn = document.getElementById('install-btn');
  if (btn) btn.classList.add('hidden');
});
function installPWA() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.then(() => {
    deferredInstallPrompt = null;
    const btn = document.getElementById('install-btn');
    if (btn) btn.classList.add('hidden');
  });
}

// Expose handlers used by inline HTML onclick attributes
window.capturePhoto = capturePhoto;
window.switchCamera = switchCamera;
window.setTempUnit = setTempUnit;
window.setCoordFmt = setCoordFmt;
window.setDateFmt = setDateFmt;
window.setTemplate = setTemplate;
window.downloadPhoto = downloadPhoto;
window.resetTool = resetTool;
window.toggleFaq = toggleFaq;
window.installPWA = installPWA;

function haptic() {
  if (navigator.vibrate) navigator.vibrate(30);
}

// Override buttons with haptics
document.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', haptic);
});

// iOS Install Prompt Logic
window.addEventListener('load', () => {
  const isIos = () => {
    const userAgent = window.navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod/.test(userAgent);
  };
  const isStandalone = () => ('standalone' in window.navigator) && window.navigator.standalone;
  
  if (isIos() && !isStandalone()) {
    const hasSeenPrompt = sessionStorage.getItem('ios-prompt-seen');
    if (!hasSeenPrompt) {
      setTimeout(() => {
        document.getElementById('ios-prompt').classList.remove('hidden');
        sessionStorage.setItem('ios-prompt-seen', 'true');
      }, 3000);
    }
  }
});



function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = words[0];

  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const width = ctx.measureText(currentLine + " " + word).width;
    if (width < maxWidth) {
      currentLine += " " + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }
  lines.push(currentLine);
  return lines;
}



// ══════════════════════════════════════════════════════════
// ══ MY PHOTOS — IndexedDB Gallery ═══════════════════════
// ══════════════════════════════════════════════════════════

const GALLERY_DB_NAME    = 'gpscamstamp-photos';
const GALLERY_DB_VERSION = 1;
const GALLERY_STORE      = 'photos';
let _galleryDB = null;
let _sessionLabel = '';  // remembered label for this session

// ── Open / create database ─────────────────────────────────
function openGalleryDB() {
  if (_galleryDB) return Promise.resolve(_galleryDB);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(GALLERY_DB_NAME, GALLERY_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(GALLERY_STORE)) {
        const store = db.createObjectStore(GALLERY_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('label', 'label', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    req.onsuccess = (e) => { _galleryDB = e.target.result; resolve(_galleryDB); };
    req.onerror   = ()  => { console.warn('[Gallery] IndexedDB not available'); reject(req.error); };
  });
}

// ── Generate a small thumbnail ─────────────────────────────
function generateThumbnail(canvas) {
  return new Promise((resolve) => {
    const THUMB_W = 240;
    const ratio = canvas.height / canvas.width;
    const tc = document.createElement('canvas');
    tc.width  = THUMB_W;
    tc.height = Math.round(THUMB_W * ratio);
    tc.getContext('2d').drawImage(canvas, 0, 0, tc.width, tc.height);
    tc.toBlob((blob) => resolve(blob), 'image/jpeg', 0.7);
  });
}

// ── Save a photo entry ─────────────────────────────────────
async function savePhotoToDB(canvas, label) {
  try {
    const db = await openGalleryDB();
    const [thumbBlob, fullBlob] = await Promise.all([
      generateThumbnail(canvas),
      new Promise(res => canvas.toBlob(b => res(b), 'image/jpeg', 0.92))
    ]);
    const entry = {
      blob:      fullBlob,
      thumbnail: thumbBlob,
      label:     label || 'Unlabelled',
      coords:    gpsData ? { lat: gpsData.lat, lng: gpsData.lng } : null,
      address:   addressData ? (addressData.road || addressData.display_name || '') : '',
      template:  currentTemplate,
      timestamp: new Date().toISOString(),
      width:     canvas.width
    };
    return new Promise((resolve, reject) => {
      const tx = db.transaction(GALLERY_STORE, 'readwrite');
      tx.objectStore(GALLERY_STORE).add(entry);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('[Gallery] Save failed:', e);
  }
}

// ── Load all photos ────────────────────────────────────────
async function loadAllPhotos() {
  try {
    const db = await openGalleryDB();
    return new Promise((resolve) => {
      const tx    = db.transaction(GALLERY_STORE, 'readonly');
      const store = tx.objectStore(GALLERY_STORE);
      const req   = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => resolve([]);
    });
  } catch (e) {
    return [];
  }
}

// ── Delete a photo ─────────────────────────────────────────
async function deleteGalleryPhoto(id) {
  try {
    const db = await openGalleryDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(GALLERY_STORE, 'readwrite');
      tx.objectStore(GALLERY_STORE).delete(id);
      tx.oncomplete = () => { renderGallery(); resolve(); };
      tx.onerror    = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('[Gallery] Delete failed:', e);
  }
}

// ── Re-download a saved photo ──────────────────────────────
function redownloadPhoto(id) {
  openGalleryDB().then(db => {
    const tx  = db.transaction(GALLERY_STORE, 'readonly');
    const req = tx.objectStore(GALLERY_STORE).get(id);
    req.onsuccess = () => {
      const entry = req.result;
      if (!entry || !entry.blob) return;
      const url = URL.createObjectURL(entry.blob);
      const a = document.createElement('a');
      a.href = url;
      const ts = (entry.timestamp || new Date().toISOString()).replace(/[:.]/g, '-').slice(0, 19);
      a.download = 'GPSCamStamp_' + ts + '.jpg';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    };
  });
}

// ── Render gallery grid ────────────────────────────────────
async function renderGallery() {
  const grid    = document.getElementById('galleryGrid');
  const empty   = document.getElementById('galleryEmpty');
  const countEl = document.getElementById('galleryCount');
  const storeEl = document.getElementById('galleryStorage');
  if (!grid) return;

  let photos = await loadAllPhotos();

  // Filter
  const query = (document.getElementById('gallerySearch')?.value || '').toLowerCase().trim();
  if (query) {
    photos = photos.filter(p => (p.label || '').toLowerCase().includes(query) ||
                                (p.address || '').toLowerCase().includes(query));
  }

  // Sort
  const sortBy = document.getElementById('gallerySort')?.value || 'newest';
  if (sortBy === 'newest') {
    photos.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } else if (sortBy === 'oldest') {
    photos.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  } else if (sortBy === 'label') {
    photos.sort((a, b) => (a.label || '').localeCompare(b.label || ''));
  }

  // Count & storage
  if (countEl) countEl.textContent = photos.length + ' photo' + (photos.length !== 1 ? 's' : '');
  const totalBytes = photos.reduce((sum, p) => {
    return sum + (p.blob ? p.blob.size : 0) + (p.thumbnail ? p.thumbnail.size : 0);
  }, 0);
  if (storeEl) {
    if (totalBytes > 1048576) {
      storeEl.textContent = (totalBytes / 1048576).toFixed(1) + ' MB';
    } else {
      storeEl.textContent = Math.round(totalBytes / 1024) + ' KB';
    }
  }

  // Empty state
  if (photos.length === 0) {
    grid.innerHTML = '';
    grid.style.display = 'none';
    if (empty) empty.style.display = '';
    return;
  }
  grid.style.display = '';
  if (empty) empty.style.display = 'none';

  // Render cards
  grid.innerHTML = photos.map(p => {
    const thumbUrl = p.thumbnail ? URL.createObjectURL(p.thumbnail) : '';
    const dateStr  = p.timestamp ? new Date(p.timestamp).toLocaleDateString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    }) : '';
    const label   = escapeHTML(p.label || 'Unlabelled');
    const address = escapeHTML(p.address || (p.coords ? p.coords.lat.toFixed(4) + ', ' + p.coords.lng.toFixed(4) : 'No location'));
    return `<div class="gallery-card">
      ${thumbUrl ? `<img class="gallery-thumb" src="${thumbUrl}" alt="${label}" loading="lazy">` : '<div class="gallery-thumb"></div>'}
      <div class="gallery-meta">
        <div class="gallery-label">${label}</div>
        <div class="gallery-addr">📍 ${address}</div>
        <div class="gallery-date">${dateStr}</div>
      </div>
      <div class="gallery-actions">
        <button onclick="redownloadPhoto(${p.id})">⬇ Save</button>
        <button class="btn-delete" onclick="confirmDeletePhoto(${p.id})">🗑 Delete</button>
      </div>
    </div>`;
  }).join('');
}

// ── HTML escaper ───────────────────────────────────────────
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Delete confirmation ────────────────────────────────────
function confirmDeletePhoto(id) {
  if (confirm('Delete this photo from your local library?')) {
    deleteGalleryPhoto(id);
  }
}

// ── Label prompt modal ─────────────────────────────────────
function promptForLabel() {
  return new Promise((resolve) => {
    // Reuse session label — ask once per batch/session
    if (_sessionLabel) { resolve(_sessionLabel); return; }

    // Clear any leftover overlays (prevents stacked dialogs locking the page)
    document.querySelectorAll('.label-overlay').forEach(el => el.remove());

    const overlay = document.createElement('div');
    overlay.className = 'label-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="label-modal">
        <h3>Label this photo</h3>
        <p>Add a label like a property address, site name, or project to group your photos.</p>
        <input type="text" class="label-input" placeholder="e.g. 123 Main St, Site B" maxlength="80" autofocus>
        <div class="modal-btns">
          <button type="button" class="btn-skip">Skip</button>
          <button type="button" class="btn-save">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    // Scope queries to this overlay — never use global duplicate IDs
    const input = overlay.querySelector('.label-input');
    const save  = overlay.querySelector('.btn-save');
    const skip  = overlay.querySelector('.btn-skip');

    function finish(val) {
      _sessionLabel = val;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    }
    function onKey(e) {
      if (e.key === 'Escape') finish('Unlabelled');
      if (e.key === 'Enter' && document.activeElement === input) {
        finish(input.value.trim() || 'Unlabelled');
      }
    }
    save.onclick = () => finish(input.value.trim() || 'Unlabelled');
    skip.onclick = () => finish('Unlabelled');
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => input && input.focus());
  });
}

// ── Auto-save after download (legacy helper; downloadPhoto now labels once) ──
async function saveToGalleryAfterDownload(canvas) {
  try {
    const label = await promptForLabel();
    await savePhotoToDB(canvas, label);
    await updateGalleryTabCount();
  } catch (e) {
    console.warn('[Gallery] Auto-save failed:', e);
  }
}
