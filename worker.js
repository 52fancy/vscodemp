/**
 * VS Code 插件市场镜像 —— Cloudflare Worker
 *
 * 转发规则（括号内是对应的 product.json 字段）：
 *   /gallery/*          -> https://marketplace.visualstudio.com/_apis/public/gallery/*   (serviceUrl)
 *   /items*             -> https://marketplace.visualstudio.com/items*                   (itemUrl)
 *   /index/*            -> https://vscode.blob.core.windows.net/gallery/index/*          (cacheUrl，旧版遗留)
 *   /vsassets/{host}/*  -> https://{host}/*      host 限定为 *.gallerycdn.vsassets.io
 *                                                           或 *.gallery.vsassets.io
 *   其余路径            -> https://marketplace.visualstudio.com/*  (插件详情页的静态资源)
 *
 * 两条关键机制（只做路径转发是不够的，见 README）：
 *   1. extensionquery 的响应正文里 assetUri / fallbackAssetUri 指向 *.vsassets.io，
 *      必须改写成本 Worker 的地址，否则 .vsix 仍然从官方 CDN 下载，代理形同虚设。
 *   2. /index 和 /vsassets 的响应逐字节透传，改写会破坏插件签名校验。
 */

const MARKETPLACE = 'https://marketplace.visualstudio.com';
const GALLERY_API = `${MARKETPLACE}/_apis/public/gallery`;
const ITEM_PAGE = `${MARKETPLACE}/items`;
const BLOB_INDEX = 'https://vscode.blob.core.windows.net/gallery/index';

/** [本地路径前缀, 上游地址]，按先后顺序匹配 */
const ROUTES = [
  ['/gallery', GALLERY_API],
  ['/index', BLOB_INDEX],
  ['/items', ITEM_PAGE],
];

/** 上面几条都没命中时，整体转发到官方市场 */
const FALLBACK = ['', MARKETPLACE];

/** 插件文件（含 .vsix 本体、图标、README、签名）的真实来源，全部收在 /vsassets/{host}/ 下 */
const VSASSETS_PREFIX = '/vsassets/';
const VSASSETS_HOST = /^[a-z0-9.-]+\.(?:gallerycdn|gallery)\.vsassets\.io$/;

/** 这些路径下的响应必须逐字节透传：签名文件被改写就验签失败 */
const NO_REWRITE = ['/index', VSASSETS_PREFIX];

/**
 * 文本正文里需要改写的上游地址。长前缀在前，避免被短前缀抢先匹配。
 * vsassets 是带捕获组的正则，单独处理。
 */
const VSASSETS_URL = /https:\/\/([a-z0-9.-]+\.(?:gallerycdn|gallery)\.vsassets\.io)/g;
const REWRITES = [
  [GALLERY_API, '/gallery'],
  [BLOB_INDEX, '/index'],
  [ITEM_PAGE, '/items'],
  [MARKETPLACE, ''],
];

/** 只有文本类响应需要改写正文；.vsix 等二进制一律原样透传 */
const TEXT_RESPONSE = /json|javascript|ecmascript|text\/|xml|svg/i;

/**
 * 转发时要摘掉的请求头：逐跳头、Cloudflare 自有头，
 * 以及 accept-encoding —— 摘掉后上游返回未压缩内容，
 * 正文长度与 content-encoding 始终一致，改写正文不会拿到乱码。
 */
const DROP_HEADERS = [
  'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'accept-encoding',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker', 'cf-ew-via',
  'cdn-loop', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
];

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*',
};

const ONE_YEAR = 60 * 60 * 24 * 365;

const USAGE = `<!doctype html>
<meta charset="utf-8">
<title>VS Code 插件市场镜像</title>
<style>body{font:14px/1.7 ui-monospace,Menlo,Consolas,monospace;max-width:54em;margin:3em auto;padding:0 1.5em}
pre{background:#f4f4f5;padding:1em;border-radius:6px;overflow-x:auto}code{background:#f4f4f5;padding:.1em .3em}</style>
<h2>VS Code 插件市场镜像已就绪</h2>
<p>编辑 VS Code 安装目录下的 <code>resources/app/product.json</code>，
找到 <code>extensionsGallery</code> 段并替换成：</p>
<pre>"extensionsGallery": {
  "serviceUrl": "${'${origin}'}/gallery",
  "cacheUrl":   "${'${origin}'}/index",
  "itemUrl":    "${'${origin}'}/items"
}</pre>
<p>保存后<strong>完全退出</strong> VS Code 再启动。<br>`;

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/') {
      return new Response(USAGE.replaceAll('${origin}', url.origin), {
        headers: { 'content-type': 'text/html; charset=utf-8', ...CORS_HEADERS },
      });
    }

    const route = resolveUpstream(url.pathname);
    if (!route) {
      return new Response('非法的 vsassets 主机名', { status: 400, headers: CORS_HEADERS });
    }
    const { prefix, base } = route;
    const upstreamUrl = new URL(base + url.pathname.slice(prefix.length) + url.search);

    const headers = new Headers(request.headers);
    for (const name of DROP_HEADERS) {
      headers.delete(name);
    }

    const init = { method: request.method, headers, redirect: 'follow' };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }

    // /vsassets 下的路径都带版本号或资源 ID，内容不会变；
    // 交给 Cloudflare 边缘缓存处理（.vsix 可达上百 MB，由 CDN 流式处理，不占 Worker 内存）
    const immutable = request.method === 'GET'
      && (prefix.startsWith(VSASSETS_PREFIX) || url.pathname.endsWith('/vspackage'));
    if (immutable) {
      init.cf = { cacheEverything: true, cacheTtl: ONE_YEAR };
    }

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, init);
    } catch (err) {
      return new Response(`无法访问上游 ${upstreamUrl.host}：${err.message}`, {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS_HEADERS },
      });
    }

    const shouldRewrite = upstream.status === 200
      && !NO_REWRITE.some(p => prefix.startsWith(p))
      && TEXT_RESPONSE.test(upstream.headers.get('content-type') ?? '');

    const response = shouldRewrite
      ? await rewriteBody(upstream, url.origin)
      : passthrough(upstream);

    if (immutable && response.ok) {
      response.headers.set('cache-control', `public, max-age=${ONE_YEAR}, immutable`);
    }

    return response;
  },
};

function resolveUpstream(pathname) {
  if (pathname.startsWith(VSASSETS_PREFIX)) {
    const rest = pathname.slice(VSASSETS_PREFIX.length);
    const slash = rest.indexOf('/');
    const host = slash === -1 ? rest : rest.slice(0, slash);
    // 主机名走白名单，避免这个接口被当成任意反向代理使用
    if (!VSASSETS_HOST.test(host)) {
      return null;
    }
    return { prefix: `${VSASSETS_PREFIX}${host}`, base: `https://${host}` };
  }

  for (const [prefix, base] of ROUTES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return { prefix, base };
    }
  }
  return { prefix: FALLBACK[0], base: FALLBACK[1] };
}

/**
 * 把响应正文里的官方地址换成本 Worker 的地址。
 * extensionquery 返回的 JSON 里 assetUri / fallbackAssetUri 写的是 *.vsassets.io，
 * VS Code 会直接拿它下载 .vsix，不改写的话请求全部绕过代理直连官方 CDN。
 */
async function rewriteBody(upstream, origin) {
  const headers = new Headers(upstream.headers);
  headers.delete('content-length');

  let text = await upstream.text();
  text = text.replace(VSASSETS_URL, (match, host) => `${origin}${VSASSETS_PREFIX}${host}`);
  for (const [from, to] of REWRITES) {
    if (text.includes(from)) {
      text = text.split(from).join(origin + to);
    }
  }

  applyCors(headers);
  return new Response(text, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** 二进制(.vsix)等原样流式透传，保留 content-length 以便客户端显示下载进度 */
function passthrough(upstream) {
  const response = new Response(upstream.body, upstream);
  applyCors(response.headers);
  return response;
}

function applyCors(headers) {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    headers.set(name, value);
  }
}
