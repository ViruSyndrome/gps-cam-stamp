/* ===================================================
   GPS Cam Stamp â€” Core Script
   All processing is 100% client-side. No data leaves the browser.
   =================================================== */

'use strict';

// â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let gpsData        = null;   // { lat, lng, altitude, accuracy, heading }
let addressData    = null;   // { display_name, road, city, country }
let capturedImage  = null;   // HTMLImageElement of the current photo
let currentTab     = 'camera';
let currentTemplate = 'classic';
let camStream      = null;
let facingMode     = 'environment';
let addressCache   = {};     // lat,lng â†’ address to avoid repeat calls
let batchImages    = [];     // [{img, filename}] for batch mode
let mapTileImg  = null;   // OSM tile Image for map thumbnail
let mapTilePin  = null;   // {px, py} pin pixel position within 256Ã—256 tile
let appLogoImg  = null;   // Real SVG logo for the stamp
let customLogoImg = null; // User uploaded custom logo

const initLogo = new Image();
initLogo.onload = () => { appLogoImg = initLogo; };
initLogo.src = 'assets/favicon.svg';

let weatherData = null;   // {temp, unit, condition, icon}
let tempUnit    = 'C';    // 'C' | 'F' â€” auto-detected from locale/country
let coordFmt    = 'decimal'; // 'decimal' | 'dms'
let dateFmt     = 'dmy';  // 'dmy' | 'mdy' | 'iso' â€” auto-detected from locale

// â”€â”€ DOM refs (resolved after DOMContentLoaded) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let gpsBar, gpsStatus, camVideo, stampCanvas, previewWrap;

// â”€â”€ Init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  await startCamera();
  requestGPS();
  setupUpload();
  syncToggleStyles();
  
  const sampleImg = new Image();
  sampleImg.onload = () => {
    if (!capturedImage) {
      capturedImage = sampleImg;
      gpsData = { lat: 40.7580, lng: -73.9855, altitude: 12.5, accuracy: 5, _exifDate: new Date() };
      addressData = { city: "New York", suburb: "Manhattan", road: "Broadway", country: "United States" };
      weatherData = { temp: 22, unit: tempUnit, condition: "Sunny", icon: "â˜€ï¸" };
      updateFmtUI();
      redrawStamp();
    }
  };
  sampleImg.src = 'assets/og-image.webp';
});

// â”€â”€ GPS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function requestGPS() {
  if (!navigator.geolocation) {
    setGPSStatus('denied', 'GPS not supported by this browser');
    return;
  }
  setGPSStatus('fetching', 'Getting your locationâ€¦');
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
  setGPSStatus('found', `ðŸ“ ${lat}, ${lng}`);
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

// â”€â”€ Reverse Geocode (OpenStreetMap Nominatim â€” free, no key) â”€â”€
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
      setGPSStatus('found', `ðŸ“ ${[addressData.road, addressData.city, addressData.state].filter(Boolean).join(', ')}`);
    }
    // Refresh preview if already showing
    if (capturedImage && !previewWrap.classList.contains('hidden')) redrawStamp();
  } catch (_) {
    // Silently fail â€” lat/lng will still show on stamp
  }
}

// â”€â”€ Locale / format detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  return `${d}Â°${m}'${s}"${dir}`;
}

// â”€â”€ Map Tile (OpenStreetMap â€” free, attribution required) â”€â”€
const WMO_MAP = {
  0: ['â˜€', 'Clear'], 1: ['ðŸŒ¤', 'Mostly Clear'], 2: ['â›…', 'Partly Cloudy'], 3: ['â˜', 'Overcast'],
  45: ['ðŸŒ«', 'Fog'], 48: ['ðŸŒ«', 'Icy Fog'],
  51: ['ðŸŒ¦', 'Light Drizzle'], 53: ['ðŸŒ¦', 'Drizzle'], 55: ['ðŸŒ§', 'Heavy Drizzle'],
  61: ['ðŸŒ§', 'Light Rain'], 63: ['ðŸŒ§', 'Rain'], 65: ['ðŸŒ§', 'Heavy Rain'],
  71: ['ðŸŒ¨', 'Light Snow'], 73: ['ðŸŒ¨', 'Snow'], 75: ['â„', 'Heavy Snow'],
  80: ['ðŸŒ¦', 'Showers'], 81: ['ðŸŒ§', 'Heavy Showers'], 82: ['â›ˆ', 'Violent Showers'],
  95: ['â›ˆ', 'Thunderstorm'], 96: ['â›ˆ', 'Hail Storm'], 99: ['â›ˆ', 'Hail Storm']
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
    // Map tile unavailable (offline/CORS) â€” stamp works without thumbnail
  }
}

// â”€â”€ Weather (open-meteo.com â€” free, no API key) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function fetchWeather(lat, lng) {
  try {
    const url  = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current_weather=true&timezone=auto`;
    const res  = await fetch(url);
    const json = await res.json();
    const cw   = json.current_weather;
    if (!cw) return;
    const [icon, condition] = WMO_MAP[cw.weathercode] || ['ðŸŒ¡', 'Unknown'];
    weatherData = { temp: Math.round(cw.temperature), unit: 'Â°C', condition, icon };
    if (capturedImage && !previewWrap.classList.contains('hidden')) redrawStamp();
  } catch (_) {
    // Weather unavailable â€” stamp works without weather data
  }
}

// â”€â”€ Camera â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function startCamera() {
  stopCamera();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    if (!camVideo) return; // guard: DOM not ready
    camVideo.srcObject = camStream;
    try { await camVideo.play(); } catch (_) {} // explicit play for Android
  } catch (err) {
    // Camera unavailable (desktop without cam, permission denied)
    const panel = document.getElementById('panel-camera');
    if (panel) panel.innerHTML = `<div style="padding:2rem;text-align:center;color:var(--text-muted)">
      <div style="font-size:2.5rem;margin-bottom:1rem">ðŸ“·</div>
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

// â”€â”€ Upload / Drag-drop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // For single-file upload, try to read EXIF GPS + datetime first
  if (imageFiles.length === 1) {
    readExifFromFile(imageFiles[0]).then(exif => {
      if (exif) applyExifData(exif);
    });
  }

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

// â”€â”€ EXIF reader (no dependency â€” native DataView) â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        // RATIONAL is 8 bytes, never fits the 4-byte inline field â€” always stored at offset
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
  if (!exif.lat && !exif.datetime) return;

  let notice = [];

  if (exif.lat !== undefined && exif.lng !== undefined) {
    // Override GPS data with photo's embedded coordinates
    gpsData = {
      lat: exif.lat, lng: exif.lng,
      altitude: exif.altitude || gpsData?.altitude || null,
      accuracy: null, heading: null, speed: null
    };
    notice.push('GPS from photo EXIF');
    // Fetch address + map + weather for the photo's location
    fetchAddress(exif.lat, exif.lng);
    fetchMapTile(exif.lat, exif.lng);
    fetchWeather(exif.lat, exif.lng);
  }

  if (exif.datetime) {
    // Override the timestamp with the photo's original capture time
    gpsData = gpsData || {};
    gpsData._exifDate = exif.datetime;
    notice.push('date from photo EXIF');
  }

  if (notice.length) {
    setGPSStatus('found', `ðŸ“· ${notice.join(' + ')} â€” location updated`);
    redrawStamp();
  }
}

// â”€â”€ Preview & Stamp â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showPreview() {
  document.getElementById('tool').style.display = 'none';
  previewWrap.classList.remove('hidden');
  redrawStamp();
  window.scrollTo(0, 0);
}

function redrawStamp() {
  if (!capturedImage) return;
  drawStampedImage(capturedImage, stampCanvas);
}

function drawStampedImage(img, targetCanvas) {
  const ctx  = targetCanvas.getContext('2d');
  const maxW = 1920; // Downscale to 1080p width to prevent iOS Safari from crashing due to memory limits
  const scale = img.width > maxW ? maxW / img.width : 1;
  targetCanvas.width  = Math.round(img.width  * scale);
  targetCanvas.height = Math.round(img.height * scale);
  ctx.drawImage(img, 0, 0, targetCanvas.width, targetCanvas.height);
  drawStamp(ctx, targetCanvas.width, targetCanvas.height);
}

function drawStamp(ctx, W, H) {
  const lines   = buildStampLines();
  const showMap = chk('tog-map') && mapTileImg && mapTilePin;
  const tmpl    = currentTemplate;
  // Card template renders its own graceful fallback ("Location Unknown") â€” never bail early
  if (!lines.length && !showMap && tmpl !== 'card') return;

  const baseSize = Math.max(16, Math.round(W / 35));
  const lineH    = Math.round(baseSize * 1.55);
  const padX     = Math.round(W * 0.022);
  const padY     = Math.round(H * 0.018);

  if (tmpl === 'minimal') {
    drawMinimal(ctx, lines, W, H, baseSize, lineH, padX, padY, showMap);
  } else if (tmpl === 'pro') {
    drawPro(ctx, lines, W, H, baseSize, lineH, padX, padY, showMap);
  } else if (tmpl === 'card') {
    drawCard(ctx, W, H, baseSize, padX, padY, showMap);
  } else if (tmpl === 'enterprise') {
    drawEnterprise(ctx, lines, W, H, baseSize, lineH, padX, padY, showMap);
  } else {
    drawClassic(ctx, lines, W, H, baseSize, lineH, padX, padY, showMap);
  }
}

// Classic â€” dark bar at bottom, map thumbnail on right when enabled
function drawClassic(ctx, lines, W, H, sz, lH, pX, pY, showMap) {
  const isLight = document.getElementById('themeToggle')?.value === 'light';
  
  ctx.font = `${sz}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
  const mapSz = showMap ? Math.round(sz * 4) : 0;
  const textMaxW = (W - mapSz - pX * 2);
  
  const wrappedLines = [];
  lines.forEach(line => {
    const wrapped = wrapText(ctx, line, textMaxW);
    wrappedLines.push(...wrapped);
  });
  
  const barH = Math.max(wrappedLines.length * lH + pY * 2, mapSz);
  
  ctx.fillStyle = isLight ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, H - barH, W, barH);
  
  ctx.fillStyle = isLight ? '#0284c7' : '#0ea5e9';
  ctx.fillRect(0, H - barH, W, 2);
  
  if (showMap) drawMapThumb(ctx, W - barH, H - barH, barH, barH, mapTileImg, mapTilePin);
  
  ctx.textBaseline = 'top';
  
  if (!isLight) {
    ctx.shadowColor   = 'rgba(0,0,0,0.95)';
    ctx.shadowBlur    = Math.max(3, Math.round(sz * 0.15));
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
  }
  
  wrappedLines.forEach((line, i) => {
    ctx.font = `${i === 0 ? 'bold ' : ''}${sz}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
    ctx.fillStyle = isLight ? (i === 0 ? '#0284c7' : '#1e293b') : (i === 0 ? '#38bdf8' : '#f1f5f9');
    ctx.fillText(line, pX, H - barH + pY + i * lH);
  });
  ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
}

// Minimal â€” text tag in bottom-left, map thumbnail in bottom-right
function drawMinimal(ctx, lines, W, H, sz, lH, pX, pY, showMap) {
  const isLight = document.getElementById('themeToggle')?.value === 'light';
  const minSz = Math.max(10, Math.round(sz * 0.85));
  const minLH = Math.round(minSz * 1.5);
  
  ctx.font = `${minSz}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
  
  // Fixed width panel: 48-52% of image width
  const tagW = Math.round(W * (showMap ? 0.48 : 0.52));
  
  const wrappedLines = [];
  lines.forEach(line => {
    const wrapped = wrapText(ctx, line, tagW - pX * 2);
    wrappedLines.push(...wrapped);
  });
  
  const tagH  = Math.max(wrappedLines.length * minLH + pY * 1.5, showMap ? Math.round(sz * 4) : 0);
  const x = pX, y = H - tagH - pY;
  
  ctx.fillStyle = isLight ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.65)';
  roundRect(ctx, x, y, tagW, tagH, 6);
  ctx.fill();
  ctx.strokeStyle = isLight ? 'rgba(2,132,199,0.8)' : 'rgba(14,165,233,0.6)';
  ctx.lineWidth = 1.2;
  roundRect(ctx, x, y, tagW, tagH, 6);
  ctx.stroke();
  
  ctx.textBaseline = 'top';
  wrappedLines.forEach((line, i) => {
    ctx.font = `${minSz}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
    ctx.fillStyle = isLight ? (i === 0 ? '#0284c7' : '#334155') : (i === 0 ? '#38bdf8' : '#cbd5e1');
    ctx.fillText(line, x + pX * 0.75, y + pY * 0.75 + i * minLH);
  });
  
  if (showMap) {
    const mapSz = tagH;
    drawMapThumb(ctx, W - mapSz - pX, y, mapSz, mapSz, mapTileImg, mapTilePin);
  }
}

// Pro â€” side panel on right with branded header and map thumbnail at bottom
function drawPro(ctx, lines, W, H, sz, lH, pX, pY, showMap) {
  const isLight = document.getElementById('themeToggle')?.value === 'light';
  
  // Fixed width panel: 35% of image width (minimum 250px, max 600px)
  const panelW = Math.max(250, Math.min(600, Math.round(W * 0.35)));
  const mapSz  = showMap ? panelW - pX * 2 : 0;
  
  ctx.fillStyle = isLight ? 'rgba(255,255,255,0.95)' : 'rgba(8,14,26,0.85)';
  ctx.fillRect(W - panelW, 0, panelW, H);
  ctx.fillStyle = isLight ? '#0284c7' : '#0ea5e9';
  ctx.fillRect(W - panelW, 0, panelW, Math.round(sz * 2.2));
  ctx.font = `bold ${Math.round(sz * 0.9)}px sans-serif`;
  ctx.fillStyle = '#fff'; // header text is always white on blue
  ctx.textBaseline = 'middle';
  
  const displayLogo = customLogoImg || appLogoImg;
  const logoSz = Math.round(sz * 1.4);
  const headerText = customLogoImg ? (document.getElementById('projectName')?.value?.trim() || 'PROJECT SITE') : 'GPS CAM STAMP';
  
  if (displayLogo) {
    ctx.drawImage(displayLogo, W - panelW + pX, sz * 0.45, logoSz, logoSz);
    ctx.fillText(headerText, W - panelW + pX + logoSz + sz * 0.4, sz * 1.1);
  } else {
    ctx.fillText('ðŸŒ ' + headerText, W - panelW + pX, sz * 1.1);
  }
  
  ctx.font = `${sz}px Courier New, monospace`;
  ctx.textBaseline = 'top';
  
  // Wrap lines to fit within panel
  const wrappedLines = [];
  lines.forEach(line => {
    const wrapped = wrapText(ctx, line, panelW - pX * 2.5);
    wrappedLines.push(...wrapped);
  });
  
  const startY = Math.round(sz * 2.5);
  wrappedLines.forEach((line, i) => {
    ctx.fillStyle = isLight ? (i === 0 ? '#0284c7' : '#334155') : (i === 0 ? '#38bdf8' : '#94a3b8');
    ctx.fillText(line, W - panelW + pX, startY + i * lH * 1.1);
  });
  
  ctx.fillStyle = 'rgba(14,165,233,0.2)';
  ctx.fillRect(W - panelW, Math.round(sz * 2.2), panelW, 1);
  
  if (showMap) {
    const mapY = Math.round(startY + wrappedLines.length * lH * 1.1 + sz * 0.5);
    const mapAvailH = H - mapY - pY;
    if (mapAvailH > 20) {
      const mapSide = Math.min(panelW - pX * 2, mapAvailH);
      const mapOffX = Math.round((panelW - mapSide) / 2);
      drawMapThumb(ctx, W - panelW + mapOffX, mapY, mapSide, mapSide, mapTileImg, mapTilePin);
    }
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

function drawCard(ctx, W, H, sz, padX, padY, showMap) {
  const FONT    = `system-ui, -apple-system, 'Segoe UI', Arial, sans-serif`;
  const now     = (gpsData && gpsData._exifDate) ? gpsData._exifDate : new Date();
  const accentH = Math.max(4, Math.round(sz * 0.15));
  const mapPad  = Math.round(padY * 0.5);
  const cardW   = Math.round(W * 0.88);
  const cardX   = Math.round((W - cardW) / 2);
  const mapSz   = showMap ? Math.round(cardW * 0.30) : 0;
  const mapGap  = showMap ? Math.round(padX * 1.5) : 0; // generous gap between map and text
  const textAreaW = cardW - (showMap ? mapSz + mapGap : 0) - padX * 2;

  // â”€â”€ Text content â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let cityLine = '';
  let fullAddr = '';
  if (chk('tog-address') && addressData) {
    const locArr = [addressData.city || addressData.road, addressData.state, addressData.country].filter(Boolean);
    cityLine = locArr.join(', ');
    if (addressData.country && addressData.country.toLowerCase() === 'india') cityLine += ' \uD83C\uDDEE\uD83C\uDDF3';
    fullAddr = [addressData.road, addressData.city, addressData.state, addressData.postcode, addressData.country].filter(Boolean).join(', ');
  } else if (gpsData) {
    cityLine = `${fmt(Math.abs(gpsData.lat), 4)}\u00B0 ${fmt(Math.abs(gpsData.lng), 4)}\u00B0`;
  } else {
    cityLine = 'Location Unknown';
  }

  let coordLine = '';
  if (chk('tog-coords') && gpsData)
    coordLine = `Lat ${fmt(Math.abs(gpsData.lat), 6)}\u00B0  Long ${fmt(Math.abs(gpsData.lng), 6)}\u00B0`;

  let dateStr = '';
  if (chk('tog-datetime')) {
    try {
      const opts = { weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' };
      dateStr = now.toLocaleString('en-GB', opts).replace(/,\s+/, ' ');
    } catch (_) { dateStr = `${fmtDate(now)}  ${fmtTime(now)}`; }
  }

  const extraLines = buildExtraLines();

  // â”€â”€ Font sizes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const titleSz = Math.round(sz * 1.15);
  const bodySz  = Math.round(sz * 0.88);
  const smSz    = Math.round(sz * 0.80);

  ctx.font = `bold ${titleSz}px ${FONT}`;
  const titleLines = cityLine ? wrapText(ctx, cityLine, textAreaW) : [];
  ctx.font = `${bodySz}px ${FONT}`;
  const addrLines  = fullAddr ? wrapText(ctx, fullAddr, textAreaW) : [];

  const textH =
    titleLines.length * titleSz * 1.35 +
    (addrLines.length ? addrLines.length * bodySz * 1.25 + bodySz * 0.4 : 0) +
    (coordLine ? smSz * 1.35 : 0) +
    (dateStr   ? smSz * 1.35 : 0) +
    extraLines.length * smSz * 1.2 +
    padY * 0.4;

  const contentH = Math.max(textH, showMap ? mapSz : 0);
  const cardH    = Math.round(contentH + padY * 2 + accentH);
  const cardY    = H - cardH - Math.round(H * 0.018);

  // â”€â”€ Card: shadow + white background â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ctx.save();
  ctx.shadowColor   = 'rgba(0,0,0,0.42)';
  ctx.shadowBlur    = Math.round(sz * 1.4);
  ctx.shadowOffsetY = Math.round(sz * 0.35);
  ctx.fillStyle     = 'rgba(255,255,255,0.97)';
  roundRect(ctx, cardX, cardY, cardW, cardH, Math.round(sz * 0.5));
  ctx.fill();
  ctx.restore();

  // Blue accent bar at top
  ctx.fillStyle = '#0ea5e9';
  roundRect(ctx, cardX, cardY, cardW, accentH, Math.round(sz * 0.5));
  ctx.fill();

  // â”€â”€ Map thumbnail (left side) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (showMap && mapSz > 0) {
    const mX    = cardX + mapPad;
    const mY    = cardY + accentH + mapPad;
    const mSide = Math.min(mapSz, cardH - accentH - mapPad * 2);
    drawMapThumb(ctx, mX, mY, mSide, mSide, mapTileImg, mapTilePin);
  }

  // â”€â”€ Text â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const textX = cardX + padX + (showMap && mapSz > 0 ? mapSz + mapGap : 0);
  let   textY = cardY + accentH + padY * 0.7;
  ctx.textBaseline = 'top';

  if (titleLines.length) {
    ctx.font      = `bold ${titleSz}px ${FONT}`;
    ctx.fillStyle = '#111827';
    titleLines.forEach(l => { ctx.fillText(l, textX, textY, textAreaW); textY += titleSz * 1.35; });
    textY += bodySz * 0.25;
  }

  if (addrLines.length) {
    ctx.font      = `${bodySz}px ${FONT}`;
    ctx.fillStyle = '#374151';
    addrLines.forEach(l => { ctx.fillText(l, textX, textY, textAreaW); textY += bodySz * 1.25; });
    textY += bodySz * 0.2;
  }

  if (coordLine) {
    ctx.font      = `${smSz}px ${FONT}`;
    ctx.fillStyle = '#6b7280';
    ctx.fillText(coordLine, textX, textY, textAreaW);
    textY += smSz * 1.35;
  }

  if (dateStr) {
    ctx.font      = `${smSz}px ${FONT}`;
    ctx.fillStyle = '#6b7280';
    ctx.fillText(dateStr, textX, textY, textAreaW);
    textY += smSz * 1.35;
  }

  if (extraLines.length) {
    ctx.font      = `${smSz}px ${FONT}`;
    ctx.fillStyle = '#9ca3af';
    extraLines.forEach(l => {
      if (textY + smSz < cardY + cardH - mapPad) {
        ctx.fillText(l, textX, textY, textAreaW);
        textY += smSz * 1.2;
      }
    });
  }

  ctx.textBaseline = 'alphabetic';

  // â”€â”€ Branding badge (top-right of card) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ctx.font = `bold ${smSz}px ${FONT}`;
  const bLabel = 'GPS Cam Stamp';
  const bW     = ctx.measureText(bLabel).width + padX;
  const bH     = Math.round(smSz * 1.55);
  const bX     = cardX + cardW - bW - 5;
  const bY     = cardY + accentH + 5;
  ctx.fillStyle = '#0ea5e9';
  roundRect(ctx, bX, bY, bW, bH, 4);
  ctx.fill();
  ctx.fillStyle    = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(bLabel, bX + padX * 0.45, bY + bH * 0.5);
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
  
  // Map pin â€” clearly visible with drop shadow
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
function buildStampLines() {
  const lines = [];
  // Use EXIF original capture time if available, otherwise current time
  const now = (gpsData && gpsData._exifDate) ? gpsData._exifDate : new Date();

  if (chk('tog-address') && addressData) {
    const addr = [addressData.road, addressData.city, addressData.state, addressData.country].filter(Boolean).join(', ');
    if (addr) lines.push(addr);
  }

  if (chk('tog-coords') && gpsData) {
    if (coordFmt === 'dms') {
      lines.push(`${toDMS(gpsData.lat,'lat')}  ${toDMS(gpsData.lng,'lng')}`);
    } else {
      lines.push(`Lat ${fmt(Math.abs(gpsData.lat), 6)}\u00B0  Long ${fmt(Math.abs(gpsData.lng), 6)}\u00B0`);
    }
  }

  if (chk('tog-altitude') && gpsData && gpsData.altitude != null) {
    lines.push(`ALT: ${Math.round(gpsData.altitude)} m`);
  }

  if (chk('tog-datetime')) {
    lines.push(`${fmtDate(now)}  ${fmtTime(now)}`);
  }

  if (chk('tog-accuracy') && gpsData) {
    lines.push(`ACC: \u00B1${Math.round(gpsData.accuracy || 0)} m`);
  }

  if (chk('tog-compass') && gpsData && gpsData.heading != null) {
    lines.push(`DIR: ${headingLabel(gpsData.heading)} (${Math.round(gpsData.heading)}\u00B0)`);
  }

  if (chk('tog-speed') && gpsData && gpsData.speed != null) {
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

  const project = document.getElementById('projectName')?.value?.trim();
  if (project) lines.push('PROJECT: ' + project);

  const note = document.getElementById('customNote')?.value?.trim();
  if (note) lines.push('NOTE: ' + note);

  return lines;
}

// Extra stamp fields only (altitude, accuracy, compass, speed, weather, note)
// Used by drawCard which renders address / coords / date directly
function buildExtraLines() {
  const lines = [];
  if (chk('tog-altitude') && gpsData && gpsData.altitude != null)
    lines.push(`ALT: ${Math.round(gpsData.altitude)} m`);
  if (chk('tog-accuracy') && gpsData)
    lines.push(`ACC: \u00B1${Math.round(gpsData.accuracy || 0)} m`);
  if (chk('tog-compass') && gpsData && gpsData.heading != null)
    lines.push(`DIR: ${headingLabel(gpsData.heading)} (${Math.round(gpsData.heading)}\u00B0)`);
  if (chk('tog-speed') && gpsData && gpsData.speed != null) {
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
  const project = document.getElementById('projectName')?.value?.trim();
  if (project) lines.push('PROJECT: ' + project);

  const note = document.getElementById('customNote')?.value?.trim();
  if (note) lines.push('NOTE: ' + note);
  return lines;
}

function chk(id) { return document.getElementById(id)?.checked; }
function fmt(n, d) { return Number(n).toFixed(d); }
function truncate(s, max) { return s.length > max ? s.slice(0, max - 1) + 'â€¦' : s; }

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

// â”€â”€ Download â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function downloadPhoto() {
  if (!capturedImage) return; // nothing to download
  // Fire GA4 event for stamp generation
  if (typeof gtag === 'function') {
    gtag('event', 'stamp_generated', {
      event_category: 'engagement',
      event_label: currentTemplate,
      value: batchImages.length
    });
  }
  if (batchImages.length <= 1) {
    // Single download
    downloadCanvas(stampCanvas, (batchImages[0]?.filename || 'photo') + '_gpsstamped.jpg');
    // Auto-save to gallery
    saveToGalleryAfterDownload(stampCanvas);
  } else {
    // Batch â€” download each with a delay to avoid browser blocking
    batchImages.forEach(({ img, filename }, i) => {
      setTimeout(() => {
        const c = document.createElement('canvas');
        drawStampedImage(img, c);
        downloadCanvas(c, filename + '_gpsstamped.jpg');
        saveToGalleryAfterDownload(c);
      }, i * 400);
    });
  }
}

function downloadCanvas(canvas, filename) {
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  // iOS Safari ignores the `download` attribute â€” open in new tab so user can long-press â†’ Save
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && /safari/i.test(navigator.userAgent) && !/chrome|crios|fxios/i.test(navigator.userAgent);
  if (isIOS) {
    const w = window.open();
    if (!w) { alert('Please allow popups to view or save the photo.'); return; }
    w.document.write('<html><head><title>Save Photo</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;color:#fff;gap:16px;padding:16px;box-sizing:border-box}p{margin:0;font-size:15px;text-align:center;opacity:.85}</style></head><body><p>Long-press the image below â†’ <strong>Add to Photos</strong> to save</p><img src="' + dataUrl + '" style="max-width:100%;border-radius:8px"></body></html>');
    w.document.close();
    return;
  }
  const a = document.createElement('a');
  a.href     = dataUrl;
  a.download = filename;
  a.click();
  
  if (navigator.share) {
    setTimeout(() => {
        const shareBtn = document.createElement('button');
        shareBtn.textContent = 'Share stamped photo';
        shareBtn.style.cssText = 'position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#3b82f6; color:white; border:none; padding:12px 24px; border-radius:30px; box-shadow:0 10px 15px -3px rgba(0,0,0,0.1); font-weight:600; font-family:sans-serif; cursor:pointer; z-index:10000; transition: transform 0.2s;';
        shareBtn.onclick = () => {
            navigator.share({ title: 'GPS Cam Stamp', text: 'Check out my stamped photo!', url: window.location.href }).catch(console.error);
            shareBtn.remove();
        };
        document.body.appendChild(shareBtn);
        setTimeout(() => shareBtn.remove(), 10000);
    }, 1000);
  }
}

// â”€â”€ UI Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    previewWrap.classList.add('hidden');
    capturedImage = null;
    batchImages = [];
  }
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
  document.getElementById('tool').style.display = '';
  previewWrap.classList.add('hidden');
  capturedImage = null;
  batchImages = [];
  document.getElementById('customNote').value = '';
  document.getElementById('projectName').value = '';
  if (currentTab === 'camera') startCamera();
  else document.getElementById('fileInput').value = '';
  window.scrollTo(0, 0);
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



// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// â•â• MY PHOTOS â€” IndexedDB Gallery â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const GALLERY_DB_NAME    = 'gpscamstamp-photos';
const GALLERY_DB_VERSION = 1;
const GALLERY_STORE      = 'photos';
let _galleryDB = null;
let _sessionLabel = '';  // remembered label for this session

// â”€â”€ Open / create database â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Generate a small thumbnail â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Save a photo entry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Load all photos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Delete a photo â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Re-download a saved photo â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Render gallery grid â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        <div class="gallery-addr">ðŸ“ ${address}</div>
        <div class="gallery-date">${dateStr}</div>
      </div>
      <div class="gallery-actions">
        <button onclick="redownloadPhoto(${p.id})">â¬‡ Save</button>
        <button class="btn-delete" onclick="confirmDeletePhoto(${p.id})">ðŸ—‘ Delete</button>
      </div>
    </div>`;
  }).join('');
}

// â”€â”€ HTML escaper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// â”€â”€ Delete confirmation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function confirmDeletePhoto(id) {
  if (confirm('Delete this photo from your local library?')) {
    deleteGalleryPhoto(id);
  }
}

// â”€â”€ Label prompt modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function promptForLabel() {
  return new Promise((resolve) => {
    // If we already have a session label, reuse it
    if (_sessionLabel) { resolve(_sessionLabel); return; }

    const overlay = document.createElement('div');
    overlay.className = 'label-overlay';
    overlay.innerHTML = `
      <div class="label-modal">
        <h3>ðŸ“‹ Label this photo</h3>
        <p>Add a label like a property address, site name, or project to group your photos.</p>
        <input type="text" id="labelInput" placeholder="e.g. 123 Main St, Site B" maxlength="80" autofocus>
        <div class="modal-btns">
          <button class="btn-skip" id="labelSkip">Skip</button>
          <button class="btn-save" id="labelSave">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = document.getElementById('labelInput');
    const save  = document.getElementById('labelSave');
    const skip  = document.getElementById('labelSkip');

    function finish(val) {
      _sessionLabel = val;
