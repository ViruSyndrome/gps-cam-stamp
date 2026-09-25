"""Capture clean AlternativeTo screenshots via Playwright (not Cursor browser)."""
from __future__ import annotations

import base64
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "alternativeto"
URL = "https://www.gpscamstamp.com/?v=20"


SETUP_JS = r"""
() => new Promise((resolve) => {
  document.querySelectorAll('.ad-slot').forEach((el) => { el.style.display = 'none'; });

  const allowBtn = [...document.querySelectorAll('button')]
    .find((b) => /Allow Camera/i.test(b.textContent || ''));
  if (allowBtn) {
    let box = allowBtn.parentElement;
    for (let i = 0; i < 5 && box; i++) {
      if (/Allow Camera/i.test(box.innerText || '')) {
        box.style.display = 'none';
        break;
      }
      box = box.parentElement;
    }
  }
  [...document.querySelectorAll('div,p,span')].forEach((el) => {
    if (el.childElementCount < 2 && /Camera & location needed/i.test(el.textContent || '')) {
      const row = el.closest('div');
      if (row && row.offsetHeight < 100) row.style.display = 'none';
    }
  });

  const makePhoto = (w, h) => {
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#3d6f98');
    g.addColorStop(0.4, '#b9ccd8');
    g.addColorStop(0.52, '#7d8c9a');
    g.addColorStop(1, '#2f363f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#24303a';
    const bw = w / 5.2;
    const baseY = h * 0.42;
    [[0.06, 0.48], [0.28, 0.38], [0.52, 0.44], [0.74, 0.34]].forEach(([fx, fh]) => {
      ctx.fillRect(w * fx, baseY, bw, h * fh);
    });
    ctx.fillStyle = '#1a2028';
    ctx.fillRect(0, h * 0.9, w, h * 0.1);
    ctx.strokeStyle = '#cfd4da';
    ctx.lineWidth = Math.max(3, w / 300);
    ctx.setLineDash([w / 30, w / 40]);
    ctx.beginPath();
    ctx.moveTo(w / 2, h * 0.9);
    ctx.lineTo(w / 2, h);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,228,150,0.55)';
    ctx.beginPath();
    ctx.arc(w * 0.82, h * 0.14, Math.min(w, h) * 0.06, 0, Math.PI * 2);
    ctx.fill();
    return off.toDataURL('image/jpeg', 0.92);
  };

  // Portrait for stamp exports / mobile; landscape fill for desktop tool preview
  const mode = window.__ALTTO_PHOTO_MODE || 'portrait';
  const src = mode === 'landscape' ? makePhoto(1600, 900) : makePhoto(1080, 1440);

  const img = new Image();
  img.onload = () => {
    capturedImage = img;
    gpsData = {
      lat: 12.9716,
      lng: 77.5946,
      altitude: 920,
      accuracy: 8,
      heading: 42,
      _exifDate: new Date('2026-09-25T13:24:00+05:30'),
    };
    addressData = {
      city: 'Bengaluru',
      state: 'Karnataka',
      country: 'India',
      road: 'MG Road',
      postcode: '560001',
      suburb: 'Ashok Nagar',
    };
    ['tog-address', 'tog-coords', 'tog-datetime', 'tog-map', 'tog-compass', 'tog-accuracy', 'tog-altitude']
      .forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.checked = true;
      });
    if (typeof syncToggleStyles === 'function') syncToggleStyles();
    document.getElementById('previewWrap')?.classList.remove('hidden');
    document.getElementById('panel-camera')?.classList.add('hidden');
    setTemplate(window.__ALTTO_TEMPLATE || 'classic');
    resolve(true);
  };
  img.src = src;
});
"""


def save_data_url(data_url: str, path: Path) -> None:
    raw = data_url.split(",", 1)[1]
    path.write_bytes(base64.b64decode(raw))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        page = browser.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
        page.goto(URL, wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(600)

        # Desktop tool shots: landscape photo fills preview (no letterbox)
        page.evaluate("() => { window.__ALTTO_PHOTO_MODE = 'landscape'; window.__ALTTO_TEMPLATE = 'classic'; }")
        page.evaluate(SETUP_JS)
        page.wait_for_timeout(400)
        page.screenshot(
            path=str(OUT / "altto-01-tool-classic.jpg"),
            type="jpeg",
            quality=90,
        )
        print("01 tool classic")

        page.evaluate("() => setTemplate('pro')")
        page.wait_for_timeout(250)
        page.screenshot(
            path=str(OUT / "altto-02-tool-pro.jpg"),
            type="jpeg",
            quality=90,
        )
        print("02 tool pro")

        # Stamp close-ups: portrait photo + correct template via setTemplate()
        page.evaluate("() => { window.__ALTTO_PHOTO_MODE = 'portrait'; }")
        page.evaluate(SETUP_JS)
        page.wait_for_timeout(300)
        for tpl, fname in [
            ("card", "altto-03-stamp-card.jpg"),
            ("classic", "altto-04-stamp-classic.jpg"),
            ("pro", "altto-02b-stamp-pro.jpg"),
        ]:
            data = page.evaluate(
                """(tpl) => {
                  setTemplate(tpl);
                  return stampCanvas.toDataURL('image/jpeg', 0.9);
                }""",
                tpl,
            )
            save_data_url(data, OUT / fname)
            print(fname, "canvas", page.evaluate("() => [stampCanvas.width, stampCanvas.height, currentTemplate]"))

        page.evaluate(
            """() => {
              document.querySelector('.compare-table')?.closest('section')
                ?.scrollIntoView({ block: 'start' });
            }"""
        )
        page.wait_for_timeout(350)
        box = page.evaluate(
            """() => {
              const sec = document.querySelector('.compare-table').closest('section');
              const r = sec.getBoundingClientRect();
              return {
                x: Math.max(0, Math.floor(r.x)),
                y: Math.max(0, Math.floor(r.y)),
                width: Math.min(Math.ceil(r.width), window.innerWidth),
                height: Math.min(Math.ceil(r.height), window.innerHeight - 16),
              };
            }"""
        )
        page.screenshot(
            path=str(OUT / "altto-06-comparison.jpg"),
            type="jpeg",
            quality=90,
            clip=box,
        )
        print("06 comparison", box)

        page.close()

        mobile = browser.new_page(
            viewport={"width": 390, "height": 844},
            device_scale_factor=2,
            is_mobile=True,
            has_touch=True,
        )
        mobile.goto(URL, wait_until="networkidle", timeout=60000)
        mobile.wait_for_timeout(500)
        mobile.evaluate("() => { window.__ALTTO_PHOTO_MODE = 'portrait'; window.__ALTTO_TEMPLATE = 'classic'; }")
        mobile.evaluate(SETUP_JS)
        mobile.wait_for_timeout(400)
        mobile.evaluate("() => window.scrollTo(0, 0)")
        # Crop to content width (avoid side letterboxing if any)
        mobile.screenshot(
            path=str(OUT / "altto-05-mobile.jpg"),
            type="jpeg",
            quality=90,
        )
        print("05 mobile")
        browser.close()

        # Prefer Pro stamp close-up for slot 02 if tool chrome is noisy — keep tool-pro as primary
        pro_stamp = OUT / "altto-02b-stamp-pro.jpg"
        if pro_stamp.exists():
            # Keep both; form still points at tool-pro. Optional: copy stamp over if preferred later.
            print("also wrote", pro_stamp.name)

    for name in sorted(os.listdir(OUT)):
        if name.startswith("altto-"):
            fp = OUT / name
            print(f"  {name}: {fp.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
