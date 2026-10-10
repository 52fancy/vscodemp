# VS Code 插件市场镜像

一个单文件的 Cloudflare Worker，把 VS Code 官方插件市场完整代理到你的域名下：改一次 `product.json`，之后插件**搜索、下载、更新、图标加载**全部走你自己的地址。

[English](README.en.md) · 简体中文

## 为什么需要它

- 官方 `serviceUrl` 在部分网络环境下不稳定，表现为 VS Code 里搜不出插件、或装到一半断流。
- **只改 hosts 是没用的**：插件元数据在 `marketplace.visualstudio.com`，但 `.vsix` 本体、图标、README、签名文件全在另一个域名 `*.vsassets.io` 上，市场返回的 `assetUri` 直接指向那里 —— 客户端会绕过任何只代理了 API 的中间层。
- Cloudflare Worker 免费计划就够用：无服务器、单文件、零依赖，不需要 KV / R2 / D1。

## 转发规则

| Worker 路径 | 转发到 | 对应的 `product.json` 字段 |
| --- | --- | --- |
| `/gallery/*` | `https://marketplace.visualstudio.com/_apis/public/gallery/*` | `serviceUrl` |
| `/items*` | `https://marketplace.visualstudio.com/items*` | `itemUrl` |
| `/index/*` | `https://vscode.blob.core.windows.net/gallery/index/*` | `cacheUrl`（旧版 VS Code 用） |
| `/vsassets/{host}/*` | `https://{host}/*` | 无（由响应正文改写产生） |
| 其余全部路径 | `https://marketplace.visualstudio.com/*` | 无（插件详情页的静态资源） |

两点说明：

- `/vsassets/` 后面的 `{host}` 走白名单，只接受 `*.gallerycdn.vsassets.io` / `*.gallery.vsassets.io` 形态的主机名，其余返回 `400` —— 避免这个接口被当成任意反向代理。
- 路径匹配规则是「完全相等，或前缀 + `/`」，所以 `/galleryfoo` 不会命中 `/gallery`，会落到兜底规则。

访问根路径 `/` 返回一张配置说明页（含可直接复制的片段），不会转发到市场首页。

## 两个关键机制

**只做路径转发是不够的**，这个 Worker 里有两处容易漏掉的逻辑：

### 1. 改写响应正文里的资源地址

`extensionquery`（搜索接口）返回的 JSON 里，`assetUri` / `fallbackAssetUri` 指向 `*.vsassets.io`：

```json
"assetUri": "https://ms-python.gallerycdn.vsassets.io/extensions/ms-python/python/2026.7.2026092301/1790160504786",
"fallbackAssetUri": "https://ms-python.gallery.vsassets.io/_apis/public/gallery/publisher/ms-python/extension/python/2026.7.2026092301/assetbyname"
```

VS Code 会直接拿这个地址去下载 `.vsix`。**不改写，下载就绕过代理直连官方 CDN**，前面所有转发都白做。所以 Worker 会把文本响应里的这些地址替换成 `https://你的域名/vsassets/{host}/...`。

### 2. `/index` 和 `/vsassets/` 逐字节透传

这两个前缀下的响应**不做任何正文改写**。`.vsix` 内含签名文件（`.signature.p7s`），VS Code 安装时会校验，正文被动过一个字节就会验签失败。二进制一律流式原样透传，并保留 `content-length` 以便客户端显示下载进度。

### 附带细节：外发请求为什么摘掉 `accept-encoding`

改写正文的前提是能安全地把响应当字符串处理。Worker 在外发请求时删掉了 `accept-encoding`，上游因此返回**未压缩**内容，`content-length` 与正文长度始终一致，不存在「按字节改写 gzip 流导致乱码」的问题；改写后的响应再删掉 `content-length` 交给运行时重算。

## 部署

全程在 Cloudflare 控制台完成，**不需要装 Node / wrangler，也不需要本地构建**。

1. 打开 [Cloudflare 控制台](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → 选 **Worker**（"Start with Hello World!" 模板即可）→ **Deploy**
2. 起个名字（例如 `vscode-marketplace-mirror`），部署后得到 `https://<名字>.<账号>.workers.dev` 地址
3. 点 **Edit code** 进入在线编辑器 → 全选（Ctrl/Cmd + A）删掉模板代码 → 把 `worker.js` 的内容整个粘贴进去 → 右上角 **Deploy**
4. 浏览器打开第 2 步的地址，看到「VS Code 插件市场镜像已就绪」说明页，即部署成功

代码里没有绑定任何 KV / R2 / Durable Object，免费计划即可。以后要改代码，回到这个 Worker 的 **Edit code** 改完再点一次 **Deploy** 就生效。

### 绑定自定义域名（国内网络强烈建议）

`*.workers.dev` 在部分网络下不可达，建议给 Worker 绑一个自己的域名：

Worker → **Settings** → **Domains & Routes** → **Add** → **Custom Domain**（域名需已托管在同一 Cloudflare 账号下）。

## 客户端配置

两种方式，按你用的客户端选一种：**桌面版 VS Code** 改 `product.json`，**code-server** 用启动时的环境变量、不用改文件。

### 桌面版 VS Code：改 `product.json`

编辑 VS Code 安装目录下的 `product.json`，找到 `extensionsGallery` 段，替换为：

```json
"extensionsGallery": {
  "serviceUrl": "https://你的域名/gallery",
  "cacheUrl": "https://你的域名/index",
  "itemUrl": "https://你的域名/items"
}
```

`product.json` 的位置：

| 平台 | 路径 |
| --- | --- |
| Windows | `<安装目录>\resources\app\product.json` |
| macOS | `/Applications/Visual Studio Code.app/Contents/Resources/app/product.json` |
| Linux | `/usr/share/code/resources/app/product.json`（deb / rpm），或解压目录下的 `resources/app/product.json` |

改完**完全退出** VS Code（不是关窗口，确认进程已结束）再启动。

> macOS 提示：修改 `.app` 包内文件可能触发签名校验告警。若启动时提示「应用已损坏」，可尝试 `xattr -cr "/Applications/Visual Studio Code.app"`，或对应用重新做一次 ad-hoc 签名。

### code-server：用 `EXTENSIONS_GALLERY` 环境变量

code-server 默认走 Open VSX，很多插件搜不到。启动时用这个环境变量把 gallery 指到本镜像即可，**不需要改任何文件**：

```bash
EXTENSIONS_GALLERY='{"serviceUrl":"https://你的域名/gallery","itemUrl":"https://你的域名/items"}' code-server
```

几点注意：

- JSON 必须整体用**单引号**包住，否则 shell 会把里面的双引号吃掉。
- `serviceUrl` + `itemUrl` 就够了。如果客户端还需要 `cacheUrl`（旧版会用到），在 JSON 里补上 `"cacheUrl":"https://你的域名/index"`。
- 不以命令行方式启动的话，把这一项加到对应位置即可：systemd 用 `Environment=EXTENSIONS_GALLERY={"serviceUrl":"https://你的域名/gallery","itemUrl":"https://你的域名/items"}`；Docker 用 `-e EXTENSIONS_GALLERY='{...}'`。
- 不想用环境变量也可以直接改 code-server 自带的 `product.json`（通常在 `/usr/lib/code-server/lib/vscode/product.json`），字段和上面桌面版一致，效果相同。

## 验证

```bash
export MIRROR=https://你的域名   # 换成你的实际域名

# 1. 说明页
curl -s "$MIRROR/" | head -5

# 2. 搜索接口：确认返回的 assetUri 已指向你的域名
curl -s -X POST "$MIRROR/gallery/extensionquery" \
  -H 'Accept: application/json;api-version=7.2-preview.1' \
  -H 'Content-Type: application/json' \
  -d '{"filters":[{"criteria":[{"filterType":8,"value":"Microsoft.VisualStudio.Code"},{"filterType":10,"value":"python"}],"pageNumber":1,"pageSize":1}],"flags":914}' \
  | grep -o '"assetUri":"[^"]*"' | head -1
```

正常输出形如：

```
"assetUri":"https://你的域名/vsassets/ms-python.gallerycdn.vsassets.io/extensions/ms-python/python/2026.7.2026092301/1790160504786"
```

第 2 条同时能看出**市场给你的 Worker 返回的是哪个资源域名** —— 如果输出里出现 `azure.cn`，见下方 FAQ。

最后打开 VS Code，搜索并安装任意插件，能正常装上即部署成功。

## 实现细节

- **请求头**：转发前摘掉逐跳头（`connection`、`transfer-encoding`、`upgrade`、`te` 等）、Cloudflare 自有头（`cf-*`、`cdn-loop`）以及 `x-forwarded-for` / `x-real-ip`，客户端 IP 不会泄漏给上游。
- **CORS**：所有响应带 `access-control-allow-origin: *`，`OPTIONS` 预检直接返回 `204`，浏览器里打开市场页面（`/items`）也能用。
- **缓存**：`/vsassets/*` 下的 GET，以及路径以 `/vspackage` 结尾的 GET，交给 Cloudflare 边缘缓存处理（`cacheEverything` + 一年 `cacheTtl`，响应头补 `cache-control: public, max-age=31536000, immutable`）。这些路径要么带版本号、要么带内容 ID，内容不会变；`.vsix` 常有上百 MB，全程由 CDN 流式处理，不会驻留 Worker 内存（128 MB 限制）。其余请求（如搜索接口）不额外缓存，保留上游的 `no-store` 语义。
- **重定向**：`redirect: 'follow'`，上游的 302 在 Worker 内部跟随，客户端只看到最终结果。
- **报错**：上游连不通时返回 `502` 和一条纯文本错误（含上游主机名），不吐 HTML 堆栈。

## 已知限制

- **VS Code 升级会覆盖 `product.json`**，大版本更新后需要重新改一次；通过 brew / apt / winget 升级同理。
- **资源域名与地区有关**：市场按请求来源地区返回不同的资源域名 —— 中国大陆来源拿到 `*.gallerycdn.azure.cn`（21Vianet 运营的 Azure 中国 CDN），其他地区拿到 `*.gallerycdn.vsassets.io`。当前实现只处理 `*.vsassets.io`，处理办法见 FAQ。
- **只代理公开市场**，不涉及：插件发布（走 PAT，不经过这里）、私有市场 / 自建 gallery、账号登录与设置同步。
- **免费计划限制**：Workers 免费版每天 10 万次请求，缓存命中的请求同样计入。个人日常使用远远够用，多人共享或 CI 批量拉取时需要注意。
- 超出 Cloudflare 单文件缓存上限的超大 `.vsix` 会退化为每次回源、由 Worker 透传 —— 功能不受影响，只是失去边缘缓存。
- 请自行确认使用方式符合微软的服务条款，本仓库只提供技术实现。

## FAQ

**Q：能搜到插件，但装不上 / 下载失败？**

看 Worker 的实时日志（控制台 → Worker → **Logs**）里有没有 `.vsix` 请求进来。如果只有搜索请求、没有 `/vsassets/` 的下载请求，说明正文改写没生效或地址没被替换。用上面「验证」第 2 条看看 `assetUri` 到底是什么域名。

**Q：日志里出现 `*.gallerycdn.azure.cn`，`.vsix` 仍然直连官方 CDN？**

这就是上面提到的地区差异：市场按来源地区返回了 Azure 中国 CDN 的域名，而当前代码只认 `*.vsassets.io`，于是改写不生效（并且直接访问 `/vsassets/{azure.cn 主机}/...` 会得到 `400`）。两条改法，任选其一：

- 扩展 `worker.js` 里的两个常量，同时接受 `azure.cn`：

  ```js
  const VSASSETS_HOST = /^[a-z0-9.-]+\.(?:gallerycdn|gallery)\.(?:vsassets\.io|azure\.cn)$/;
  const VSASSETS_URL = /https:\/\/([a-z0-9.-]+\.(?:gallerycdn|gallery)\.(?:vsassets\.io|azure\.cn))/g;
  ```

- 或者干脆不处理 —— `azure.cn` 本身就是中国大陆的 CDN，直连通常比绕一圈更快，代价是这部分流量不经过你的代理。

**Q：装上了，但 VS Code 报扩展签名校验失败？**

说明某处改动了 `.vsix` 的字节。检查是不是往 `/vsassets/` 或 `/index` 上加了会改正文的逻辑（代码里的 `NO_REWRITE` 列表就是用来保护这两条的）。

**Q：为什么根路径 `/` 不是市场首页？**

`/` 被用来返回配置说明页。想访问市场首页走 `/items` 或任意其他路径，兜底规则会转发过去。

**Q：VS Code 之外的编辑器能用吗？**

任何读取 `product.json` 中 `extensionsGallery` 的发行版都可以，包括各类 fork。VSCodium 等 fork 的字段名一致，只是 `product.json` 位置不同。

**Q：需要 ICP 备案吗？**

Worker 运行在 Cloudflare 的境外网络上，不涉及国内服务器，通常不需要 ICP 备案。具体要求以你的域名注册商和托管商为准。

## 项目结构

```
vscode-marketplace-mirror/
├── worker.js        # 全部实现，单文件；部署时整个粘贴到控制台
├── LICENSE
├── README.md        # 简体中文
└── README.en.md     # English
```

## 许可证

[MIT](LICENSE)
