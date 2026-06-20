# Deploying SakhaPR to Cloudflare

SakhaPR is a **no-build static site** (plain HTML/CSS/ES modules). It serves the
repo root as static assets; `_headers` carries the strict CSP. There are two
Cloudflare flows — pick the one that matches how your project was created.

## Flow in use: Workers Builds (Deploy command `npx wrangler deploy`)

If the project's **Deploy command** is `npx wrangler deploy` (Workers Builds),
the config is the `[assets]` block in `wrangler.toml`:

```toml
name = "sakhapr"
compatibility_date = "2026-06-20"

[assets]
directory = "./"
```

- **Build command:** None (nothing to compile).
- **Deploy command:** `npx wrangler deploy` (default — leave it).
- **Root directory:** `/`.
- `wrangler deploy` uploads the asset directory; `_headers` (CSP) is applied by
  Workers Assets; `.assetsignore` keeps docs/config out of the public site.

> Common failure: a `wrangler.toml` that only has `pages_build_output_dir` makes
> `wrangler deploy` fail with **"Missing entry-point to Worker script or to
> assets directory"** — because that key is Pages-only. The `[assets]` block
> above is what `wrangler deploy` needs.

## Alternative: classic Pages

| Setting | Value |
|---|---|
| Framework preset | **None** |
| Build command | **(empty)** |
| Build output directory | **`/`** |

This flow uses `wrangler pages deploy . --project-name sakhapr` and the
`pages_build_output_dir = "."` key instead of `[assets]`.

## Route A — Git-connected (recommended)

1. Push the finished app to `kapanthron/sakhapr`.
2. Cloudflare dashboard → **Workers & Pages → Create → Connect to Git** →
   select `kapanthron/sakhapr`.
3. Pick the production branch (`main`).
4. Build command empty; keep the default Deploy command for the flow.
5. **Save and Deploy.**
6. Open the deployed URL, hard-refresh, and confirm the **PDPA banner** renders —
   not a Cloudflare placeholder.

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
