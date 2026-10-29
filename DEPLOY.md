# Deploy notes (GPS Cam Stamp)

## GitHub Pages publishes the whole repo

`.gitignore` entries for `docs/`, `scripts/`, `script_clean.js`, `assets/alternativeto/`, and `*.csv` only stop *new* untracked files from being added. Already-tracked files are still served if Pages deploys from the branch root.

To stop serving tooling: publish from `/docs`, or use a GitHub Action that copies only HTML/CSS/JS and public `assets/` images.

## Keep

- `CNAME` — `www.gpscamstamp.com`
