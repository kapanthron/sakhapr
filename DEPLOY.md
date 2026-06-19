# Deploying SakhaPR to Cloudflare Pages

SakhaPR is a **no-build static site** (plain HTML/CSS/ES modules). The only way it
turns into a "hello world" placeholder is if Cloudflare is told to *build* it.
The rules below keep that from happening.

## The settings that matter (memorize these)

| Setting | Value | Why |
|---|---|---|
| Framework preset | **None** | Any preset injects a build command. |
| Build command | **(empty)** | There is nothing to compile. Never `npm run build`. |
| Build output directory | **`/`** (repo root) | The folder that contains `index.html`. |
| Root directory | **`/`** | App files live at the repo root. |

These are also pinned in `wrangler.toml` (`pages_build_output_dir = "."`) so the
CLI and dashboard agree.

> If you later nest the app under a subfolder (e.g. `sakhapr/`), set the output
> directory to that folder **and** update `pages_build_output_dir` to match, and
> keep `_headers` inside that folder.

## Route A — Git-connected (recommended)

1. Push the finished app to `kapanthron/sakhapr`.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** →
   select `kapanthron/sakhapr`.
3. Pick the production branch.
4. Build settings: **Framework preset = None, Build command = (blank),
   Output directory = `/`**.
5. **Save and Deploy.** The "build" just copies static files.
6. Open the `*.pages.dev` URL, hard-refresh, and confirm the **PDPA banner**
   renders — not a Cloudflare placeholder.

## Route B — Wrangler direct upload (no Git)

```
npx wrangler pages deploy . --project-name sakhapr
```

Run it from the folder that contains `index.html`. The directory you point at
**must** contain `index.html` — pointing at the wrong folder is the #1 cause of a
blank/placeholder page. **Do not** run `npm create cloudflare`.

## App-specific notes

- **CSP lives in `_headers`** (a real HTTP header), not only a `<meta>` tag.
  Tesseract.js needs a Web Worker + WASM, and Path A needs `mailto:` — all already
  allowed in the committed `_headers`. Widen one directive at a time per phase and
  record it in `PRIVACY.md` / `DPIA.md`.
- **Exclude `data/kode_wilayah_flat.json` from the deploy** (1.18 MB, **unused at
  runtime** — only `data/wilayah_nik.json` is fetched). Keeps the upload lean.
- Cloudflare Pages limits: 25 MB per file, 20,000 files. This app is well under both.
- Serve over HTTPS (Pages does this automatically).

## Pre-deploy checklist

- [ ] `index.html` is at the output-directory root.
- [ ] `_headers` is in the same folder as `index.html`.
- [ ] Framework preset = None, Build command empty.
- [ ] `kode_wilayah_flat.json` excluded (or accepted as dead weight).
- [ ] PDPA banner + consent gate visible on the live URL.
- [ ] Network tab shows `wilayah_nik.json` loading from `'self'`, no external origins.
