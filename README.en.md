# VS Code Marketplace Mirror

A single-file Cloudflare Worker that reverse-proxies the VS Code Marketplace onto your own domain. Edit `product.json` once, and extension **search, download, update and icon loading** all go through your own URL.

English · [简体中文](README.md)

## Why

- The official `serviceUrl` is unreliable on some networks — VS Code shows no search results, or downloads stall halfway.
- **Editing your hosts file does not work.** Extension metadata lives on `marketplace.visualstudio.com`, but the `.vsix` itself, the icons, the README and the signature file all live on a *different* domain, `*.vsassets.io`. The marketplace returns an `assetUri` pointing straight there, so the client bypasses any middle layer that only proxies the API.
- The Cloudflare Workers free plan is enough: serverless, one file, no dependencies, no KV / R2 / D1.

## Routing

| Worker path | Forwards to | `product.json` field |
| --- | --- | --- |
| `/gallery/*` | `https://marketplace.visualstudio.com/_apis/public/gallery/*` | `serviceUrl` |
| `/items*` | `https://marketplace.visualstudio.com/items*` | `itemUrl` |
| `/index/*` | `https://vscode.blob.core.windows.net/gallery/index/*` | `cacheUrl` (older VS Code) |
| `/vsassets/{host}/*` | `https://{host}/*` | none — produced by body rewriting |
| everything else | `https://marketplace.visualstudio.com/*` | none — static assets of the item page |

Two notes:

- The `{host}` segment after `/vsassets/` is whitelisted: only `*.gallerycdn.vsassets.io` / `*.gallery.vsassets.io` shaped hostnames are accepted, anything else gets a `400`. This keeps the endpoint from becoming an open reverse proxy.
- Paths match on "exactly equal, or prefix + `/`", so `/galleryfoo` does not match `/gallery` and falls through to the catch-all.

A request to the root path `/` returns a small setup page with a copy-pasteable snippet; it is not forwarded to the marketplace homepage.

## The two mechanisms that matter

**Path forwarding alone is not enough.** Two pieces of logic are easy to miss:

### 1. Rewriting asset URLs inside response bodies

The JSON returned by `extensionquery` (the search API) points `assetUri` / `fallbackAssetUri` at `*.vsassets.io`:

```json
"assetUri": "https://ms-python.gallerycdn.vsassets.io/extensions/ms-python/python/2026.7.2026092301/1790160504786",
"fallbackAssetUri": "https://ms-python.gallery.vsassets.io/_apis/public/gallery/publisher/ms-python/extension/python/2026.7.2026092301/assetbyname"
```

VS Code downloads the `.vsix` straight from that URL. **Without rewriting, downloads bypass the proxy and hit the official CDN directly** — all the forwarding above is wasted. So the Worker replaces those URLs in text responses with `https://your-domain/vsassets/{host}/...`.

### 2. Byte-for-byte passthrough for `/index` and `/vsassets/`

Responses under these two prefixes are **never rewritten**. A `.vsix` contains a signature file (`.signature.p7s`) that VS Code verifies on install — a single changed byte breaks validation. Binaries are streamed through untouched, with `content-length` preserved so the client can show download progress.

### Side note: why outgoing requests drop `accept-encoding`

Rewriting a body requires treating it as a string safely. The Worker deletes `accept-encoding` on the outgoing request, so upstream returns **uncompressed** content: `content-length` always matches the body, and there is no risk of byte-level rewriting corrupting a gzip stream. On rewritten responses, `content-length` is dropped so the runtime recomputes it.

## Deployment

Everything happens in the Cloudflare dashboard — **no Node, no wrangler, no local build step**.

1. Open the [Cloudflare dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → choose **Worker** (the "Start with Hello World!" template is fine) → **Deploy**
2. Give it a name (e.g. `vscode-marketplace-mirror`); after deploying you get a `https://<name>.<account>.workers.dev` address
3. Click **Edit code** to open the online editor → select all (Ctrl/Cmd + A) and delete the template code → paste the whole of `worker.js` → click **Deploy**
4. Open the address from step 2 in a browser. Seeing the "VS Code Marketplace Mirror is ready" setup page means the deployment worked

No KV / R2 / Durable Object bindings are used, so the free plan is enough. To change the code later, go back to the Worker's **Edit code**, edit and hit **Deploy** again — it takes effect immediately.

### Custom domain (strongly recommended)

`*.workers.dev` is unreachable on some networks. Bind a domain you own instead:

Worker → **Settings** → **Domains & Routes** → **Add** → **Custom Domain** (the domain must already be on the same Cloudflare account).

## Client configuration

Two options — pick one depending on your client: **desktop VS Code** edits `product.json`, **code-server** takes an environment variable at startup and needs no file editing.

### Desktop VS Code: edit `product.json`

Edit `product.json` in your VS Code installation, find the `extensionsGallery` section and replace it with:

```json
"extensionsGallery": {
  "serviceUrl": "https://your-domain/gallery",
  "cacheUrl": "https://your-domain/index",
  "itemUrl": "https://your-domain/items"
}
```

Where `product.json` lives:

| Platform | Path |
| --- | --- |
| Windows | `<install dir>\resources\app\product.json` |
| macOS | `/Applications/Visual Studio Code.app/Contents/Resources/app/product.json` |
| Linux | `/usr/share/code/resources/app/product.json` (deb / rpm), or `resources/app/product.json` under an extracted tarball |

Then **fully quit** VS Code (closing the window is not enough — make sure the process is gone) and start it again.

> macOS note: modifying files inside the `.app` bundle can trip code-signing checks. If launch fails with "app is damaged", try `xattr -cr "/Applications/Visual Studio Code.app"`, or re-sign the app ad-hoc.

### code-server: the `EXTENSIONS_GALLERY` environment variable

code-server uses Open VSX by default, where many extensions are missing. Point the gallery at this mirror at startup — **no files to edit**:

```bash
EXTENSIONS_GALLERY='{"serviceUrl":"https://your-domain/gallery","itemUrl":"https://your-domain/items"}' code-server
```

A few notes:

- The JSON must be wrapped in **single quotes**, otherwise the shell eats the double quotes inside it.
- `serviceUrl` + `itemUrl` are enough. If your client also needs `cacheUrl` (older builds do), add `"cacheUrl":"https://your-domain/index"` to the JSON.
- If you don't start code-server from a shell, put the same value where your launcher expects it: systemd → `Environment=EXTENSIONS_GALLERY={"serviceUrl":"https://your-domain/gallery","itemUrl":"https://your-domain/items"}`; Docker → `-e EXTENSIONS_GALLERY='{...}'`.
- You can skip the environment variable and edit code-server's bundled `product.json` instead (usually `/usr/lib/code-server/lib/vscode/product.json`) — same fields as the desktop section above, same effect.

## Verifying

```bash
export MIRROR=https://your-domain   # your actual domain

# 1. Setup page
curl -s "$MIRROR/" | head -5

# 2. Search API: confirm the returned assetUri points at your domain
curl -s -X POST "$MIRROR/gallery/extensionquery" \
  -H 'Accept: application/json;api-version=7.2-preview.1' \
  -H 'Content-Type: application/json' \
  -d '{"filters":[{"criteria":[{"filterType":8,"value":"Microsoft.VisualStudio.Code"},{"filterType":10,"value":"python"}],"pageNumber":1,"pageSize":1}],"flags":914}' \
  | grep -o '"assetUri":"[^"]*"' | head -1
```

Expected output looks like:

```
"assetUri":"https://your-domain/vsassets/ms-python.gallerycdn.vsassets.io/extensions/ms-python/python/2026.7.2026092301/1790160504786"
```

Step 2 also reveals **which asset domain the marketplace returns to your Worker** — if the output contains `azure.cn`, see the FAQ below.

Finally, open VS Code, search for any extension and install it. If it installs, you are done.

## Implementation notes

- **Headers**: hop-by-hop headers (`connection`, `transfer-encoding`, `upgrade`, `te`, …), Cloudflare-specific headers (`cf-*`, `cdn-loop`) and `x-forwarded-for` / `x-real-ip` are stripped before forwarding, so the client IP is never leaked upstream.
- **CORS**: every response carries `access-control-allow-origin: *` and `OPTIONS` preflights return `204`, so opening a marketplace page (`/items`) in a browser works too.
- **Caching**: GETs under `/vsassets/*` and GETs whose path ends in `/vspackage` go through Cloudflare's edge cache (`cacheEverything` + one-year `cacheTtl`, plus `cache-control: public, max-age=31536000, immutable` on the response). Those paths are versioned or content-addressed, so they never change; `.vsix` files are often hundreds of MB and are streamed by the CDN, never buffered in the Worker (128 MB limit). Everything else (the search API, for instance) is left uncached, keeping upstream's `no-store` semantics.
- **Redirects**: `redirect: 'follow'` — upstream 302s are followed inside the Worker, the client only sees the final result.
- **Errors**: if upstream is unreachable you get a `502` and a plain-text message naming the upstream host, not an HTML stack trace.

## Known limitations

- **Upgrading VS Code overwrites `product.json`**, so you need to redo this after a major update — same for upgrades via brew / apt / winget.
- **Asset domains are region-dependent**: the marketplace returns a different asset domain depending on where the request comes from — mainland China gets `*.gallerycdn.azure.cn` (Azure China CDN, operated by 21Vianet), other regions get `*.gallerycdn.vsassets.io`. This implementation only handles `*.vsassets.io`; see the FAQ for the workaround.
- **Public marketplace only.** Out of scope: publishing extensions (uses a PAT and does not go through here), private / self-hosted galleries, sign-in and Settings Sync.
- **Free plan limits**: the Workers free plan allows 100,000 requests per day, and cache hits count toward it. Fine for personal use; worth watching if you share the mirror or pull extensions in CI.
- A very large `.vsix` that exceeds Cloudflare's per-file cache limit degrades to an origin fetch streamed through the Worker — still functional, just no edge caching.
- Make sure your usage complies with Microsoft's terms of service. This repository only provides the technical implementation.

## FAQ

**Q: Search works, but installs fail / downloads never finish.**

Check the Worker's live logs (dashboard → Worker → **Logs**) for any `.vsix` request. If you only see search requests and no `/vsassets/` download, the body rewriting did not take effect or no URL was replaced. Run step 2 of "Verifying" to see which domain `assetUri` actually carries.

**Q: The logs show `*.gallerycdn.azure.cn` and the `.vsix` still goes straight to the official CDN.**

That is the regional difference above: the marketplace returned an Azure China CDN domain, but the code only recognises `*.vsassets.io`, so no rewriting happens (and hitting `/vsassets/{azure.cn host}/...` directly returns `400`). Two options:

- Extend the two constants in `worker.js` to also accept `azure.cn`:

  ```js
  const VSASSETS_HOST = /^[a-z0-9.-]+\.(?:gallerycdn|gallery)\.(?:vsassets\.io|azure\.cn)$/;
  const VSASSETS_URL = /https:\/\/([a-z0-9.-]+\.(?:gallerycdn|gallery)\.(?:vsassets\.io|azure\.cn))/g;
  ```

- Or leave it alone — `azure.cn` *is* the mainland-China CDN, so a direct connection is often faster than a detour. The cost is that this traffic does not go through your proxy.

**Q: It installed, but VS Code reports a signature validation failure.**

Something modified the bytes of the `.vsix`. Check for any logic that rewrites bodies on `/vsassets/` or `/index` — the `NO_REWRITE` list in the code exists to protect exactly those two.

**Q: Why is the root path `/` not the marketplace homepage?**

`/` serves the setup page. Use `/items` or any other path to reach the marketplace; the catch-all rule forwards it.

**Q: Does it work with editors other than VS Code?**

Any distribution that reads `extensionsGallery` from its `product.json`, forks included. Forks such as VSCodium use the same field names, only the file location differs.

**Q: Is an ICP licence required (for use in mainland China)?**

The Worker runs on Cloudflare's network outside mainland China with no domestic server involved, so an ICP filing is normally not required. Confirm with your domain registrar and host.

## Layout

```
vscode-marketplace-mirror/
├── worker.js        # everything, in one file; pasted into the dashboard on deploy
├── LICENSE
├── README.md        # 简体中文
└── README.en.md     # English
```

## License

[MIT](LICENSE)
