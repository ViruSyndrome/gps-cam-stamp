/* ===================================================
   GPS Cam Stamp — Core Script
   All processing is 100% client-side. No data leaves the browser.
   =================================================== */

'use strict';

// Cookie Consent — Accept grants analytics/ads storage
function grantGtagConsent() {
  if (typeof gtag === 'function') {
    gtag('consent', 'update', {
      ad_storage: 'granted',
      analytics_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted'
    });
  }
}

function acceptCookies() {
  try { localStorage.setItem('cookieConsent', 'true'); } catch (e) {}
  var banner = document.getElementById('cookieConsent');
  if (banner) banner.classList.add('hidden');
  grantGtagConsent();
}
window.acceptCookies = acceptCookies;

function initCookieBanner() {
  var consented = false;
  try { consented = localStorage.getItem('cookieConsent') === 'true'; } catch (e) {}
  var banner = document.getElementById('cookieConsent');
  if (consented) {
    if (banner) banner.classList.add('hidden');
    grantGtagConsent();
    return;
  }
  if (!banner && document.body) {
    banner = document.createElement('div');
    banner.id = 'cookieConsent';
    banner.className = 'cookie-banner';
    var isGuidesSubdir = /\/guides\//i.test(window.location.pathname || '');
    var privacyHref = isGuidesSubdir ? '../privacy.html' : 'privacy.html';
    var p = document.createElement('p');
    p.innerHTML = 'We use cookies for analytics and advertising. By continuing, you accept our <a href="' + privacyHref + '">Privacy Policy</a>.';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Accept';
    btn.addEventListener('click', acceptCookies);
    banner.appendChild(p);
    banner.appendChild(btn);
    document.body.insertBefore(banner, document.body.firstChild);
  }
}

// ── State ────────────────────────────────────────────────
let gpsData         = null;   // { lat, lng, altitude, accuracy, heading, _fixTime, _source }
let liveGpsData     = null;   // Latest live geolocation fix (never overwritten by EXIF)
let pendingExifDate = null;   // Preserved DateTimeOriginal when uploaded photo has no EXIF GPS
let addressData     = null;   // { display_name, road, city, country }
let capturedImage   = null;   // HTMLImageElement of the current photo
let currentTab      = 'camera';
let currentTemplate = 'classic';
let camStream       = null;
let facingMode      = 'environment';
let addressCache    = {};     // lat,lng → address to avoid repeat calls
let batchImages     = [];     // [{img, filename, jpegBinary?, exif?}] for batch mode
let mapTileImg      = null;   // Map tile Image for map thumbnail (Esri World Imagery)
let sourceJpegBinary = null;  // original uploaded JPEG binary string (for EXIF preserve)
let mapTilePin      = null;   // {px, py} pin pixel position within 256×256 tile
let appLogoImg      = null;   // Real SVG/PNG logo for the stamp
let customLogoImg   = null;   // User uploaded custom logo
let gpsWatchId      = null;   // watchPosition id while camera is live
let showingDemo     = false;  // marketing sample preview — never used for real stamps

// Demo-only sample (marketing preview). Never assigned into gpsData/addressData/weatherData.
let demoGpsData     = null;
let demoAddressData = null;
let demoWeatherData = null;
let demoImage       = null;

let weatherData = null;   // {temp, unit, condition, icon}
let tempUnit    = 'C';    // 'C' | 'F' — auto-detected from locale/country
let coordFmt    = 'decimal'; // 'decimal' | 'dms'
let dateFmt     = 'dmy';  // 'dmy' | 'mdy' | 'iso' — auto-detected from locale

function hasValidGps() {
  return !!(gpsData && gpsData.lat != null && gpsData.lng != null &&
    Number.isFinite(gpsData.lat) && Number.isFinite(gpsData.lng));
}

function isSameGpsCoords(lat, lng) {
  return !!(gpsData && Number.isFinite(gpsData.lat) && Number.isFinite(gpsData.lng) &&
    Math.abs(gpsData.lat - lat) < 1e-5 && Math.abs(gpsData.lng - lng) < 1e-5);
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

// ── DOM refs (resolved safely after DOMContentLoaded) ────
let gpsBar, gpsStatus, camVideo, stampCanvas, previewWrap;

function resolveDomRefs() {
  gpsBar      = gpsBar      || document.getElementById('gpsBar');
  gpsStatus   = gpsStatus   || document.getElementById('gpsStatus');
  camVideo    = camVideo    || document.getElementById('camVideo');
  stampCanvas = stampCanvas || document.getElementById('stampCanvas');
  previewWrap = previewWrap || document.getElementById('previewWrap');
}

// ── Init ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initCookieBanner();
  resolveDomRefs();

  if (!document.getElementById('tool')) return;

  const initLogo = new Image();
  initLogo.onload = () => { appLogoImg = initLogo; };
  initLogo.src = 'assets/favicon-64.png';

  // Bind toggle checkbox listeners once (prevents quadratic listener leak)
  document.querySelectorAll('.toggle-label input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      cb.closest('.toggle-label')?.classList.toggle('checked', cb.checked);
    });
  });
  syncToggleStyles();

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
        const clearBtn = document.getElementById('clearLogoBtn');
        if (clearBtn) clearBtn.style.display = 'block';
      }
    });
  }

  detectLocaleDefaults();

  if (window._pendingEnablePermissions) {
    window._pendingEnablePermissions = false;
    enablePermissions();
  }
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
  initCookieBanner();
  resolveDomRefs();
  if (!document.getElementById('tool')) return;

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
  resolveDomRefs();
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
    if (!opts.silent) setGPSStatus('denied', 'GPS not supported by this browser');
    updateStampActionButtons();
    return;
  }
  if (!opts.silent) {
    setGPSStatus('fetching', 'Getting your location… (may take a few seconds)');
  }
  const geoOpts = {
    enableHighAccuracy: true,
    timeout: 20000,
    maximumAge: 0
  };
  navigator.geolocation.getCurrentPosition(onGPSSuccess, opts.silent ? () => {} : onGPSError, geoOpts);
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
  const prevHeading = (liveGpsData && liveGpsData.heading != null && !Number.isNaN(liveGpsData.heading))
    ? liveGpsData.heading
    : ((gpsData && gpsData.heading != null && !Number.isNaN(gpsData.heading)) ? gpsData.heading : null);

  const freshLive = {
    lat:      pos.coords.latitude,
    lng:      pos.coords.longitude,
    altitude: pos.coords.altitude,
    accuracy: pos.coords.accuracy,
    heading:  (pos.coords.heading != null && !Number.isNaN(pos.coords.heading)) ? pos.coords.heading : prevHeading,
    speed:    pos.coords.speed,
    _fixTime: Date.now(),
    _source:  'live'
  };
  liveGpsData = freshLive;

  // Never let background watchPosition overwrite an already-captured or EXIF-stamped preview
  const previewLocked = !showingDemo && capturedImage && previewWrap &&
    !previewWrap.classList.contains('hidden') && hasValidGps();
  if (previewLocked) return;

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
  gpsData = { ...freshLive };
  if (pendingExifDate && capturedImage) {
    gpsData._exifDate = pendingExifDate;
  }
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
let hasAbsoluteOrientation = false;
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
  const hasWebkit = typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading);
  const isAbsolute = e.type === 'deviceorientationabsolute' || e.absolute === true || hasWebkit;
  if (isAbsolute) {
    hasAbsoluteOrientation = true;
  } else if (hasAbsoluteOrientation) {
    // Do not let relative deviceorientation overwrite deviceorientationabsolute
    return;
  }

  let heading = null;
  if (hasWebkit) {
    heading = e.webkitCompassHeading;
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
  resolveDomRefs();
  if (gpsBar) gpsBar.className = 'gps-bar ' + state;
  if (gpsStatus) gpsStatus.textContent = text;
}

// ── Reverse Geocode (OpenStreetMap Nominatim — free, no key) ──
async function fetchAddress(lat, lng) {
  const key = lat.toFixed(4) + ',' + lng.toFixed(4);
  if (addressCache[key]) {
    if (!isSameGpsCoords(lat, lng)) return;
    addressData = addressCache[key];
    refineTempUnit(addressData.country);
    if (addressData.road) {
      setGPSStatus('found', `📍 ${[addressData.road, addressData.city, addressData.state].filter(Boolean).join(', ')}`);
    }
    if (capturedImage && previewWrap && !previewWrap.classList.contains('hidden')) redrawStamp();
    return;
  }
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1`;
    const res  = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'GPSCamStamp/1.0 (https://www.gpscamstamp.com; hello@gpscamstamp.com)' } });
    if (!res.ok) return;
    const json = await res.json();
    if (!isSameGpsCoords(lat, lng)) return;
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
    if (capturedImage && previewWrap && !previewWrap.classList.contains('hidden')) redrawStamp();
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
  if (tempUnit !== prev) { updateFmtUI(); if (capturedImage && previewWrap && !previewWrap.classList.contains('hidden')) redrawStamp(); }
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
  if (!isSameGpsCoords(lat, lng)) return;
  mapTilePin = { px, py };
  try {
    const res = await fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${ty}/${tx}`);
    if (!res.ok || !isSameGpsCoords(lat, lng)) return;
    const blob    = await res.blob();
    if (!isSameGpsCoords(lat, lng)) return;
    const blobUrl = URL.createObjectURL(blob);
    await new Promise(resolve => {
      const img     = new Image();
      img.onload    = () => {
        URL.revokeObjectURL(blobUrl);
        if (isSameGpsCoords(lat, lng)) {
          mapTileImg = img;
          mapTilePin = { px, py };
          if (capturedImage && previewWrap && !previewWrap.classList.contains('hidden')) redrawStamp();
        }
        resolve();
      };
      img.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        resolve();
      };
      img.src = blobUrl;
    });
  } catch (_) {
    // Map tile unavailable (offline/CORS) — stamp works without thumbnail
  }
}

// ── Weather (open-meteo.com — free, no API key) ───────────
async function fetchWeather(lat, lng) {
  try {
    const url  = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current_weather=true&timezone=auto`;
    const res  = await fetch(url);
    if (!res.ok) return;
    const json = await res.json();
    if (!isSameGpsCoords(lat, lng)) return;
    const cw   = json.current_weather;
    if (!cw) return;
    const [icon, condition] = WMO_MAP[cw.weathercode] || ['🌡', 'Unknown'];
    weatherData = { temp: Math.round(cw.temperature), unit: '°C', condition, icon };
    if (capturedImage && previewWrap && !previewWrap.classList.contains('hidden')) redrawStamp();
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
  pendingExifDate = null;
  sourceJpegBinary = null;
  // Snapshot live GPS onto the captured photo so background watchPosition doesn't mutate it
  if (gpsData) gpsData = { ...gpsData };
  const canvas = document.createElement('canvas');
  canvas.width  = camVideo.videoWidth  || 1280;
  canvas.height = camVideo.videoHeight || 720;
  canvas.getContext('2d').drawImage(camVideo, 0, 0);
  const img = new Image();
  img.onload = () => {
    capturedImage = img;
    batchImages = [{ img, filename: 'photo', jpegBinary: null, exif: null }];
    showPreview();
  };
  img.src = canvas.toDataURL('image/jpeg', 0.92);
}

// ── Upload / Drag-drop ────────────────────────────────────
function setupUpload() {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  if (!dropZone || !fileInput) return;

  fileInput.addEventListener('change', e => {
    const selected = Array.from(e.target.files || []);
    e.target.value = '';
    handleFiles(selected);
  });

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
  const imageFiles = Array.from(files || []).filter(f =>
    (f.type && f.type.startsWith('image/')) ||
    /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i.test(f.name || '')
  );
  if (!imageFiles.length) return;

  // Clear previous photo/EXIF state so Photo A's coordinates never leak onto Photo B or new batches
  showingDemo = false;
  capturedImage = null;
  batchImages = [];
  sourceJpegBinary = null;
  gpsData = null;
  pendingExifDate = null;
  clearLocationDerivedData();
  setExifWriteNote('');
  updateStampActionButtons();

  let settled = 0;
  let failedCount = 0;
  const loadedSlots = new Array(imageFiles.length);

  const finishOne = () => {
    settled++;
    if (settled === imageFiles.length) afterImagesReady();
  };

  const afterImagesReady = async () => {
    batchImages = loadedSlots.filter(Boolean);
    if (!batchImages.length) {
      if (previewWrap) previewWrap.classList.add('hidden');
      setGPSStatus('denied', 'Could not load image (unsupported format like HEIC, or corrupt file). Try JPG, PNG, or WEBP.');
      updateStampActionButtons();
      return;
    }

    capturedImage = batchImages[0].img;
    sourceJpegBinary = batchImages[0].jpegBinary || null;
    showPreview();

    const firstExif = batchImages[0].exif;
    const anyMissingGps = batchImages.some(item => !item.exif || item.exif.lat == null || item.exif.lng == null);

    if (firstExif && firstExif.lat != null && firstExif.lng != null) {
      applyExifData(firstExif);
      if (batchImages.length > 1 && anyMissingGps) {
        // Fetch live GPS silently for other batch photos that lack EXIF GPS
        requestGPS({ silent: true });
      }
    } else {
      if (firstExif && firstExif.datetime) {
        applyExifData(firstExif);
      }
      setGPSStatus('fetching', batchImages.length > 1
        ? 'Requesting location to stamp uploaded photos…'
        : 'No GPS in photo — requesting your current location…');
      requestGPS();
    }

    if (failedCount > 0) {
      setExifWriteNote(`${failedCount} file${failedCount > 1 ? 's' : ''} could not be decoded (unsupported format like HEIC or corrupt image) and ${failedCount > 1 ? 'were' : 'was'} skipped.`);
    }
    updateStampActionButtons();
  };

  imageFiles.forEach((file, idx) => {
    const reader = new FileReader();
    reader.onerror = () => {
      failedCount++;
      finishOne();
    };
    reader.onload = e => {
      const img = new Image();
      img.onerror = () => {
        failedCount++;
        finishOne();
      };
      img.onload = async () => {
        let jpegBinary = null;
        if (isJpegFile(file)) {
          try {
            jpegBinary = arrayBufferToBinaryString(await file.arrayBuffer());
          } catch (_) { jpegBinary = null; }
        }
        const exif = await readExifFromFile(file);
        loadedSlots[idx] = {
          img,
          filename: (file.name || 'photo').replace(/\.[^.]+$/, ''),
          jpegBinary,
          exif
        };
        finishOne();
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
    // Read up to 256KB to find EXIF even when XMP/ICC precedes it
    reader.readAsArrayBuffer(file.slice(0, 262144));
  });
}

function parseExifGPS(buffer) {
  try {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4) return null;
    const view = new DataView(buffer);
    // Must start with JPEG SOI marker FF D8
    if (view.getUint16(0) !== 0xFFD8) return null;
    let offset = 2;
    while (offset + 2 <= view.byteLength) {
      const marker = view.getUint16(offset);
      if ((marker & 0xFF00) !== 0xFF00) break;
      if (marker === 0xFFDA || marker === 0xFFD9) break; // SOS or EOI
      if (marker === 0xFF01 || (marker >= 0xFFD0 && marker <= 0xFFD8)) {
        offset += 2;
        continue;
      }
      if (offset + 4 > view.byteLength) break;
      const segLen = view.getUint16(offset + 2);
      if (segLen < 2 || offset + 2 + segLen > view.byteLength) break;
      if (marker === 0xFFE1) { // APP1 — may be EXIF or non-EXIF (e.g. XMP); keep scanning if non-EXIF
        const parsed = parseApp1(view, offset + 4, offset + 2 + segLen);
        if (parsed) return parsed;
      }
      offset += 2 + segLen;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function parseApp1(view, start, end) {
  try {
    const maxEnd = Math.min(end != null ? end : view.byteLength, view.byteLength);
    if (start < 0 || start + 14 > maxEnd) return null;

    // Check for "Exif\0\0" header (skip XMP or other APP1 markers)
    if (view.getUint32(start) !== 0x45786966 || view.getUint16(start + 4) !== 0x0000) return null;

    const tiffStart = start + 6;
    const byteOrder = view.getUint16(tiffStart);
    if (byteOrder !== 0x4949 && byteOrder !== 0x4D4D) return null;
    const littleEndian = byteOrder === 0x4949;

    const inBounds = (o, size) => o >= 0 && (tiffStart + o + size) <= maxEnd;
    const readUint8  = o => { if (!inBounds(o, 1)) throw new RangeError('EXIF OOB'); return view.getUint8(tiffStart + o); };
    const readUint16 = o => { if (!inBounds(o, 2)) throw new RangeError('EXIF OOB'); return view.getUint16(tiffStart + o, littleEndian); };
    const readUint32 = o => { if (!inBounds(o, 4)) throw new RangeError('EXIF OOB'); return view.getUint32(tiffStart + o, littleEndian); };

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
        if (type === 5 || type === 10) { // RATIONAL / SRATIONAL
          const dataOff = readUint32(valOff);
          const readRat = (o) => {
            const n = readUint32(o);
            const d = readUint32(o + 4);
            return d ? n / d : 0;
          };
          if (tag === 2 && count >= 3) gps.lat = [readRat(dataOff), readRat(dataOff + 8), readRat(dataOff + 16)]; // GPSLatitude
          if (tag === 4 && count >= 3) gps.lng = [readRat(dataOff), readRat(dataOff + 8), readRat(dataOff + 16)]; // GPSLongitude
          if (tag === 6 && count >= 1) gps.alt = readRat(dataOff);                                                // GPSAltitude
        } else if (type === 1) { // BYTE (GPSAltitudeRef per EXIF spec)
          if (tag === 5 && count >= 1) {
            gps.altRef = count <= 4 ? readUint8(valOff) : readUint8(readUint32(valOff));
          }
        } else if (type === 3) { // SHORT
          if (tag === 5 && count >= 1) {
            gps.altRef = count <= 2 ? readUint16(valOff) : readUint16(readUint32(valOff));
          }
        } else if (type === 2 && count > 0) { // ASCII
          const strOff = count <= 4 ? valOff : readUint32(valOff);
          let str = '';
          for (let c = 0; c < count; c++) {
            const ch = readUint8(strOff + c);
            if (ch === 0) break;
            str += String.fromCharCode(ch);
          }
          str = str.trim();
          if (tag === 1) gps.latRef = str;  // N/S
          if (tag === 3) gps.lngRef = str;  // E/W
          if (tag === 5) gps.altRef = parseInt(str, 10) || 0;
        }
      }
      if (gps.lat && gps.lng && gps.lat.every(Number.isFinite) && gps.lng.every(Number.isFinite)) {
        const toDecimal = (dms) => dms[0] + dms[1] / 60 + dms[2] / 3600;
        const lat = toDecimal(gps.lat) * (gps.latRef === 'S' ? -1 : 1);
        const lng = toDecimal(gps.lng) * (gps.lngRef === 'W' ? -1 : 1);
        if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
          result.lat = lat;
          result.lng = lng;
          if (gps.alt !== undefined && Number.isFinite(gps.alt)) {
            result.altitude = gps.alt * (gps.altRef === 1 ? -1 : 1);
          }
        }
      }
    }

    // Parse Exif SubIFD for DateTimeOriginal (tag 0x9003) — preserved even without GPS
    if (subIFDOffset !== null) {
      const subEntries = readUint16(subIFDOffset);
      for (let i = 0; i < subEntries; i++) {
        const eOff = subIFDOffset + 2 + i * 12;
        const tag  = readUint16(eOff);
        if (tag === 0x9003) { // DateTimeOriginal
          const count = readUint32(eOff + 4);
          if (count > 0) {
            const strOff = count <= 4 ? eOff + 8 : readUint32(eOff + 8);
            let str = '';
            for (let c = 0; c < count; c++) {
              const ch = readUint8(strOff + c);
              if (ch === 0) break;
              str += String.fromCharCode(ch);
            }
            // Format: "YYYY:MM:DD HH:MM:SS"
            const m = str.trim().match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
            if (m) result.datetime = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
          }
          break;
        }
      }
    }

    return Object.keys(result).length ? result : null;
  } catch (_) {
    return null;
  }
}

function applyExifData(exif) {
  if (!exif || (exif.lat == null && !exif.datetime)) return;

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
    // Preserve DateTimeOriginal even when photo has no GPS
    pendingExifDate = exif.datetime;
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
  resolveDomRefs();
  if (!previewWrap) return;
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

const MAX_CANVAS_PIXELS = 16000000; // ~16MP cap for iOS Safari canvas memory safety

function computeCanvasDimensions(img, maxW) {
  const scale = img.width > maxW ? maxW / img.width : 1;
  let w = Math.max(1, Math.round(img.width * scale));
  let h = Math.max(1, Math.round(img.height * scale));
  if (w * h > MAX_CANVAS_PIXELS) {
    const pixelScale = Math.sqrt(MAX_CANVAS_PIXELS / (w * h));
    w = Math.max(1, Math.floor(w * pixelScale));
    h = Math.max(1, Math.floor(h * pixelScale));
  }
  return { w, h };
}

function drawLocationUnavailable(img, targetCanvas) {
  const ctx = targetCanvas.getContext('2d');
  const { w, h } = computeCanvasDimensions(img, 1920);
  targetCanvas.width  = w;
  targetCanvas.height = h;
  ctx.drawImage(img, 0, 0, w, h);
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
  const ctx = targetCanvas.getContext('2d');
  // Preview stays at ~1920. Download may pass { fullRes: true } when the checkbox is on.
  const wantFull = !!(opts && opts.fullRes && document.getElementById('tog-full-res')?.checked);
  const maxW = wantFull ? Infinity : 1920;
  const { w, h } = computeCanvasDimensions(img, maxW);
  targetCanvas.width  = w;
  targetCanvas.height = h;
  ctx.drawImage(img, 0, 0, w, h);
  if (!hasValidGps()) return;
  drawStamp(ctx, w, h);
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
  // Scale panel proportionally with W (no 520px cap) so full-resolution exports match preview layout
  const panelW = Math.max(220, Math.round(W * (H > W ? 0.36 : 0.32)));
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
  const isLight = document.getElementById('themeToggle')?.value === 'light';
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
  const compassReserve = showCompass ? compassSz + Math.round(padX * 0.6) : 0;

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
  const bodyMaxW  = Math.max(60, textAreaW - compassReserve);

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

  // Title wraps around the brand chip on the first line(s); lower lines stay clear of compass dial
  ctx.font = `bold ${titleSz}px ${FONT}`;
  const titleLines = cityLine ? wrapText(ctx, cityLine, Math.max(40, textAreaW - brandReserve)) : [];
  ctx.font = `${bodySz}px ${FONT}`;
  const addrLines  = fullAddr ? wrapText(ctx, fullAddr, bodyMaxW) : [];
  ctx.font = `${smSz}px ${FONT}`;
  const coordLines = coordLine ? wrapText(ctx, coordLine, bodyMaxW) : [];
  const dateLines  = dateStr ? wrapText(ctx, dateStr, bodyMaxW) : [];
  const wrappedExtra = [];
  extraLines.forEach(l => wrappedExtra.push(...wrapText(ctx, l, bodyMaxW)));

  const textH =
    Math.max(titleLines.length * titleSz * 1.35, brandH + titleSz * 0.25) +
    (addrLines.length ? addrLines.length * bodySz * 1.25 + bodySz * 0.35 : 0) +
    coordLines.length * smSz * 1.35 +
    dateLines.length  * smSz * 1.35 +
    wrappedExtra.length * smSz * 1.2 +
    padY * 0.4;

  const rightColH = brandH + padY * 0.4 + (showCompass ? compassSz + padY * 0.35 : 0);
  const contentH = Math.max(textH, showMap ? mapSz : 0, rightColH);
  const cardH    = Math.round(contentH + padY * 2 + accentH);
  const cardY    = H - cardH - Math.round(H * 0.015);

  ctx.save();
  ctx.shadowColor   = 'rgba(0,0,0,0.42)';
  ctx.shadowBlur    = Math.round(sz * 1.4);
  ctx.shadowOffsetY = Math.round(sz * 0.35);
  ctx.fillStyle     = isLight ? 'rgba(255,255,255,0.97)' : 'rgba(15,23,42,0.92)';
  roundRect(ctx, cardX, cardY, cardW, cardH, Math.round(sz * 0.45));
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = isLight ? '#0284c7' : '#0ea5e9';
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
  ctx.fillStyle = isLight ? '#0284c7' : '#0ea5e9';
  roundRect(ctx, bX, bY, brandW, brandH, 4);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${smSz}px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(BRAND_NAME, bX + brandPad, bY + brandH / 2);
  ctx.textBaseline = 'top';

  if (titleLines.length) {
    ctx.font = `bold ${titleSz}px ${FONT}`;
    ctx.fillStyle = isLight ? '#111827' : '#f8fafc';
    titleLines.forEach(l => { ctx.fillText(l, textX, textY); textY += titleSz * 1.35; });
    textY = Math.max(textY, bY + brandH + bodySz * 0.25);
    textY += bodySz * 0.15;
  } else {
    textY = Math.max(textY, bY + brandH + bodySz * 0.25);
  }

  if (addrLines.length) {
    ctx.font = `${bodySz}px ${FONT}`;
    ctx.fillStyle = isLight ? '#374151' : '#cbd5e1';
    addrLines.forEach(l => { ctx.fillText(l, textX, textY); textY += bodySz * 1.25; });
    textY += bodySz * 0.15;
  }

  if (coordLines.length) {
    ctx.font = `${smSz}px ${FONT}`;
    ctx.fillStyle = isLight ? '#4b5563' : '#94a3b8';
    coordLines.forEach(l => { ctx.fillText(l, textX, textY); textY += smSz * 1.35; });
  }

  if (dateLines.length) {
    ctx.font = `${smSz}px ${FONT}`;
    ctx.fillStyle = isLight ? '#4b5563' : '#94a3b8';
    dateLines.forEach(l => { ctx.fillText(l, textX, textY); textY += smSz * 1.35; });
  }

  if (wrappedExtra.length) {
    ctx.font = `${smSz}px ${FONT}`;
    ctx.fillStyle = isLight ? '#6b7280' : '#94a3b8';
    wrappedExtra.forEach(l => {
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
    drawCompassDial(ctx, cx, cy, r, heading, isLight);
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
  // Map attribution (ArcGIS World Imagery tiles require Esri attribution) with contrast pill
  const attrText = 'Powered by Esri';
  const attrSz = Math.max(8, Math.round(Math.min(w, h) * 0.09));
  ctx.font = `600 ${attrSz}px ${STAMP_FONT}`;
  const attrPadX = Math.max(3, Math.round(attrSz * 0.4));
  const attrPadY = Math.max(2, Math.round(attrSz * 0.25));
  const pillW = Math.min(w - 2, ctx.measureText(attrText).width + attrPadX * 2);
  const pillH = attrSz + attrPadY * 2;
  ctx.fillStyle = 'rgba(0,0,0,0.68)';
  ctx.fillRect(x + w - pillW, y + h - pillH, pillW, pillH);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(attrText, x + w - attrPadX, y + h - attrPadY);
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
function buildExifBytesForStamp(sourceBinary, canvasWidth, canvasHeight) {
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

  // Canvas pixels are already oriented upright; clear/reset Orientation and stale thumbnail
  delete exifObj['0th'][piexif.ImageIFD.Orientation];
  exifObj['0th'][piexif.ImageIFD.Orientation] = 1;
  exifObj['1st'] = {};
  exifObj.thumbnail = null;
  if (canvasWidth) {
    exifObj['0th'][piexif.ImageIFD.ImageWidth] = canvasWidth;
    exifObj.Exif[piexif.ExifIFD.PixelXDimension] = canvasWidth;
  }
  if (canvasHeight) {
    exifObj['0th'][piexif.ImageIFD.ImageLength] = canvasHeight;
    exifObj.Exif[piexif.ExifIFD.PixelYDimension] = canvasHeight;
  }

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

async function prepareBatchLocationData(targetGps) {
  if (!targetGps) return;
  const tasks = [fetchAddress(targetGps.lat, targetGps.lng)];
  if (chk('tog-map')) tasks.push(fetchMapTile(targetGps.lat, targetGps.lng));
  if (chk('tog-weather')) tasks.push(fetchWeather(targetGps.lat, targetGps.lng));
  await Promise.all(tasks);
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
    const savedState = {
      gpsData,
      addressData,
      weatherData,
      mapTileImg,
      mapTilePin
    };
    let lastLocKey = hasValidGps() ? `${gpsData.lat.toFixed(5)},${gpsData.lng.toFixed(5)}` : '';
    let missingGpsCount = 0;

    try {
      for (let i = 0; i < batchImages.length; i++) {
        const { img, filename, jpegBinary, exif } = batchImages[i];
        await new Promise(r => setTimeout(r, i === 0 ? 0 : 400));

        let itemGps = null;
        if (exif && exif.lat != null && exif.lng != null) {
          itemGps = {
            lat: exif.lat,
            lng: exif.lng,
            altitude: exif.altitude != null ? exif.altitude : null,
            accuracy: null, heading: null, speed: null,
            _exifDate: exif.datetime || null,
            _fixTime: Date.now(),
            _source: 'exif'
          };
        } else if (liveGpsData) {
          itemGps = {
            ...liveGpsData,
            _exifDate: exif?.datetime || null
          };
        }

        const c = document.createElement('canvas');
        if (itemGps) {
          const locKey = `${itemGps.lat.toFixed(5)},${itemGps.lng.toFixed(5)}`;
          gpsData = itemGps;
          if (locKey !== lastLocKey) {
            clearLocationDerivedData();
            await prepareBatchLocationData(itemGps);
            lastLocKey = locKey;
          }
          drawStampedImage(img, c, { fullRes });
        } else {
          missingGpsCount++;
          gpsData = null;
          clearLocationDerivedData();
          lastLocKey = '';
          drawLocationUnavailable(img, c);
        }

        await downloadCanvas(c, filename + '_gpsstamped.jpg', {
          skipSharePrompt: i > 0,
          writeExif: writeExif && !!itemGps,
          sourceJpegBinary: jpegBinary || null
        });
        try { await savePhotoToDB(c, label); } catch (e) { console.warn('[Gallery] Auto-save failed:', e); }
      }
    } finally {
      gpsData = savedState.gpsData;
      addressData = savedState.addressData;
      weatherData = savedState.weatherData;
      mapTileImg = savedState.mapTileImg;
      mapTilePin = savedState.mapTilePin;
      if (stampCanvas && capturedImage) {
        try { redrawStamp(); } catch (_) {}
      }
    }
    if (missingGpsCount > 0) {
      setExifWriteNote(`${missingGpsCount} photo${missingGpsCount > 1 ? 's' : ''} had no EXIF GPS and no live GPS fix was available.`);
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
      const exifBytes = buildExifBytesForStamp(opts.sourceJpegBinary || null, canvas.width, canvas.height);
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
  if (tab === 'camera') {
    if (gpsData && gpsData._source === 'exif') {
      gpsData = liveGpsData ? { ...liveGpsData } : null;
      clearLocationDerivedData();
    }
    startCamera();
  } else {
    stopCamera();
  }
  if (tab === 'gallery') renderGallery();
  // Reset preview when switching to camera/upload
  if (tab !== 'gallery') {
    if (previewWrap) previewWrap.classList.add('hidden');
    capturedImage = null;
    batchImages = [];
    sourceJpegBinary = null;
    pendingExifDate = null;
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
  pendingExifDate = null;
  showingDemo = false;
  if (gpsData && gpsData._source === 'exif') {
    gpsData = liveGpsData ? { ...liveGpsData } : null;
    clearLocationDerivedData();
  }
  setExifWriteNote('');
  const noteEl = document.getElementById('customNote');
  if (noteEl) noteEl.value = '';
  const projEl = document.getElementById('projectName');
  if (projEl) projEl.value = '';
  clearCustomLogo();
  if (currentTab === 'camera') startCamera();
  else {
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
  }
  updateStampActionButtons();
  document.getElementById('tool')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toggleFaq(btn) {
  const item = btn.closest('.faq-item');
  const isOpen = item.classList.toggle('open');
  btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

// Keep toggle label styles in sync with checkbox state (listeners bound once in DOMContentLoaded)
function syncToggleStyles() {
  document.querySelectorAll('.toggle-label input[type="checkbox"]').forEach(cb => {
    cb.closest('.toggle-label')?.classList.toggle('checked', cb.checked);
  });
}
window.syncToggleStyles = syncToggleStyles;


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

// Delegated button haptics (avoids attaching duplicate listeners on secondary pages or dynamic UI)
document.addEventListener('click', (e) => {
  if (e.target && e.target.closest && e.target.closest('button')) haptic();
});

// iOS Install Prompt Logic
window.addEventListener('load', () => {
  const iosPrompt = document.getElementById('ios-prompt');
  if (!iosPrompt) return;
  const isIos = () => {
    const userAgent = window.navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod/.test(userAgent);
  };
  const isStandalone = () => ('standalone' in window.navigator) && window.navigator.standalone;
  
  if (isIos() && !isStandalone()) {
    try {
      const hasSeenPrompt = sessionStorage.getItem('ios-prompt-seen');
      if (!hasSeenPrompt) {
        setTimeout(() => {
          iosPrompt.classList.remove('hidden');
          sessionStorage.setItem('ios-prompt-seen', 'true');
        }, 3000);
      }
    } catch (_) {}
  }
});



function wrapText(ctx, text, maxWidth) {
  if (!text) return [];
  const str = String(text);
  if (!maxWidth || maxWidth <= 0) return [str];
  const words = str.split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const lines = [];
  let currentLine = '';

  const splitLongToken = (token) => {
    let chunk = '';
    for (let j = 0; j < token.length; j++) {
      const test = chunk + token[j];
      if (chunk && ctx.measureText(test).width > maxWidth) {
        lines.push(chunk);
        chunk = token[j];
      } else {
        chunk = test;
      }
    }
    return chunk;
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const candidate = currentLine ? currentLine + ' ' + word : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      currentLine = candidate;
    } else {
      if (currentLine) {
        lines.push(currentLine);
        currentLine = '';
      }
      if (ctx.measureText(word).width > maxWidth) {
        currentLine = splitLongToken(word);
      } else {
        currentLine = word;
      }
    }
  }
  if (currentLine) lines.push(currentLine);
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
let galleryThumbUrls = []; // track created object URLs so renderGallery() never leaks

function revokeGalleryThumbUrls() {
  while (galleryThumbUrls.length) {
    URL.revokeObjectURL(galleryThumbUrls.pop());
  }
}

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
      const ts = (entry.timestamp || new Date().toISOString()).replace(/[:.]/g, '-').slice(0, 19);
      triggerBlobDownload(entry.blob, 'GPSCamStamp_' + ts + '.jpg');
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

  // Revoke any previously created thumbnail object URLs before re-rendering
  revokeGalleryThumbUrls();

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
    let thumbUrl = '';
    if (p.thumbnail) {
      thumbUrl = URL.createObjectURL(p.thumbnail);
      galleryThumbUrls.push(thumbUrl);
    }
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
