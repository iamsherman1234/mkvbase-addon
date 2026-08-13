"use strict";

const crypto = require("crypto");
const fetch = require("node-fetch");

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const DEFAULT_REFERER = "https://mkvbase.site/";
const MOBILE_UAS = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36"
];
const GOFILE_API = "https://api.gofile.io";
const GOFILE_BROWSER_LANGUAGE = "en-US";
const GOFILE_SECRET = "9844d94d963d30";

function pushUniqueUrl(list, url) {
  if (!url) return;
  try {
    url = new URL(url).href;
  } catch {
    return;
  }
  if (!list.includes(url)) list.push(url);
}

function getCandidateUrl(candidate) {
  return typeof candidate === "string" ? candidate : candidate && candidate.url;
}

function getCandidateHeaders(candidate) {
  return typeof candidate === "string" ? null : candidate && candidate.headers;
}

function pushUniqueCandidate(list, candidate) {
  const url = getCandidateUrl(candidate);
  if (!url) return;
  try { new URL(url); } catch { return; }
  if (!list.some((item) => getCandidateUrl(item) === url)) list.push(candidate);
}

function originOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return "";
  }
}

function appendSyncParam(url) {
  if (!url || !/^https?:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (/r2\.cloudflarestorage\.com$/i.test(parsed.hostname) || parsed.searchParams.has("X-Amz-Signature")) {
      return url;
    }
  } catch {}
  const value = String(1 + new Date().getMinutes());
  return url.includes("?") ? `${url}&s=${value}` : `${url}?s=${value}`;
}

function mobileHeaders(referer = DEFAULT_REFERER) {
  return {
    "User-Agent": MOBILE_UAS[Math.floor(Math.random() * MOBILE_UAS.length)],
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "identity",
    "Referer": referer || DEFAULT_REFERER,
    "Cookie": "xla=s4t",
  };
}

function pushReadyCandidate(list, url, headers, title) {
  if (!url) return;
  const normalized = normalizeDownloadUrl(url, DEFAULT_REFERER);
  if (!normalized || !isReadyForPlayback(normalized)) return;
  pushUniqueCandidate(list, { url: normalized, headers, title });
}

function formatResolvedUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname + parsed.pathname;
  } catch {
    return String(url || "");
  }
}

function normalizeDownloadUrl(rawUrl, baseUrl) {
  if (!rawUrl) return null;
  let url;
  try {
    url = new URL(rawUrl, baseUrl).href;
  } catch {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("gamerxyt.com") && parsed.pathname.includes("dl.php")) {
      const link = parsed.searchParams.get("link");
      if (link) return decodeURIComponent(link);
    }
    if (parsed.hostname.includes("pixeldrain.dev") && parsed.pathname.includes("/api/file/")) {
      parsed.hostname = "pixeldrain.com";
      return parsed.href;
    }
    if ((parsed.hostname.includes("pixeldrain.dev") || parsed.hostname.includes("pixeldrain.com")) && parsed.pathname.includes("/u/")) {
      const fileId = parsed.pathname.split("/").filter(Boolean).pop();
      return fileId ? "https://pixeldrain.com/api/file/" + fileId : url;
    }
    if (/fastdl-[^.]+\.pages\.dev$/i.test(parsed.hostname)) {
      const wrapped = parsed.searchParams.get("url");
      if (wrapped) return decodeURIComponent(wrapped);
    }
  } catch {}

  return url;
}

function isKnownDownloadHost(url) {
  return /gdflix\.(?:dev|io)\/file\/|new\d*\.gdflix\.io\/(?:file|wfile|cflare|cloud)\/|instant\.busycdn\.xyz|hubcloud\.[^/]+\/(?:video|drive)\/|(?:gamerxyt\.com|sportverse\.cc|hubcloud\.[^/]+)\/hubcloud\.php|gpdl\d*\.|(?:store\d*\.gofile\.io|gofile\.io\/download|gofile\.io\/d\/)|video-downloads\.googleusercontent\.com|pixeldrain\.com\/api\/file\/|hubcloud\.cloudflarefb\.workers\.dev|vcloud\.zip\/|r2\.cloudflarestorage\.com|\.r2\.dev|workers\.dev/i.test(url || "");
}

function isBlockedMediaUrl(url) {
  return /\.(?:gif|png|jpe?g|webp|svg|zip|rar)(?:[?#]|$)/i.test(url || "");
}

function isReadyForPlayback(url) {
  if (isBlockedMediaUrl(url)) return false;
  return /video-downloads\.googleusercontent\.com|pixeldrain\.com\/api\/file\/|store\d*\.gofile\.io|gofile\.io\/download|r2\.cloudflarestorage\.com|\.r2\.dev|workers\.dev/i.test(url || "");
}


function safeBase64Decode(value) {
  try { return Buffer.from(String(value || ""), "base64").toString("utf8"); } catch { return ""; }
}

function extractDoubleAtobUrl(html, pageUrl) {
  const match = String(html || "").match(/var\s+url\s*=\s*atob\s*\(\s*atob\s*\(\s*["']([^"']+)["']\s*\)\s*\)/i)
    || String(html || "").match(/atob\s*\(\s*atob\s*\(\s*["']([^"']+)["']\s*\)\s*\)/i);
  if (!match) return null;
  const decoded = safeBase64Decode(safeBase64Decode(match[1]));
  return normalizeDownloadUrl(decoded, pageUrl);
}

function extractScriptUrl(html, pageUrl) {
  const match = String(html || "").match(/var\s+url\s*=\s*["']([^"']+)["']/i);
  return match ? normalizeDownloadUrl(match[1], pageUrl) : null;
}

function extractPixeldrainVar(html, pageUrl) {
  const match = String(html || "").match(/var\s+pxl\s*=\s*["']([^"']+)["']/i);
  if (!match) return null;
  return normalizeDownloadUrl(match[1], pageUrl);
}

function extractDownloadLinks(html, pageUrl) {
  const links = [];
  const text = String(html || "");

  for (const scripted of [extractDoubleAtobUrl(text, pageUrl), extractScriptUrl(text, pageUrl), extractPixeldrainVar(text, pageUrl)]) {
    if (scripted && isKnownDownloadHost(scripted)) pushUniqueUrl(links, scripted);
  }

  const absoluteMatches = text.match(/https?:\/\/[^"'\s<>]+/gi) || [];
  for (const match of absoluteMatches) {
    const clean = match.replace(/[),.;]+$/, "");
    if (/instant\.busycdn\.xyz|gdflix\.(?:dev|io)\/file\/|new\d*\.gdflix\.io\/(?:file|wfile|cflare|cloud)\/|video-downloads\.googleusercontent\.com|hubcloud\.php|gpdl\d*\.|gofile\.io\/d\/|r2\.cloudflarestorage\.com|\.r2\.dev|workers\.dev|pixeldrain\.(?:dev|com)\/u\/|pixeldrain\.com\/api\/file\/|hubcloud\.cloudflarefb\.workers\.dev|vcloud\.zip\//i.test(clean)) {
      pushUniqueUrl(links, normalizeDownloadUrl(clean, pageUrl));
    }
  }

  const hrefMatches = text.matchAll(/href=["']([^"']+)["']/gi);
  for (const match of hrefMatches) {
    const clean = normalizeDownloadUrl(match[1], pageUrl);
    if (/instant\.busycdn\.xyz|gdflix\.(?:dev|io)\/file\/|new\d*\.gdflix\.io\/(?:file|wfile|cflare|cloud)\/|video-downloads\.googleusercontent\.com|hubcloud\.php|gpdl\d*\.|gofile\.io\/d\/|r2\.cloudflarestorage\.com|\.r2\.dev|workers\.dev|pixeldrain\.com\/api\/file\/|hubcloud\.cloudflarefb\.workers\.dev|vcloud\.zip\//i.test(clean || "")) {
      pushUniqueUrl(links, clean);
    }
  }

  return links;
}

async function fetchWithTimeout(url, opts = {}, timeout = 9000) {
  try {
    return await Promise.race([
      fetch(url, {
        ...opts,
        headers: {
          "User-Agent": DEFAULT_UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          ...(opts.headers || {})
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeout))
    ]);
  } catch {
    return null;
  }
}

async function fetchHtml(url, referer, timeout = 9000) {
  const res = await fetchWithTimeout(url, { headers: { Referer: referer || DEFAULT_REFERER } }, timeout);
  if (!res || !res.ok) return { url, html: "" };
  return { url: res.url || url, html: await res.text() };
}

async function fetchHtmlWithHeaders(url, headers = {}, timeout = 9000) {
  const res = await fetchWithTimeout(url, { headers }, timeout);
  if (!res || !res.ok) return { url, html: "" };
  return { url: res.url || url, html: await res.text() };
}

function directLinkRank(url) {
  if (/r2\.cloudflarestorage\.com|\.r2\.dev|workers\.dev/i.test(url)) return 0;
  if (/pixeldrain\.com\/api\/file\//i.test(url)) return 1;
  if (/store\d*\.gofile\.io|gofile\.io\/download/i.test(url)) return 2;
  if (/gofile\.io\/d\//i.test(url)) return 3;
  if (/video-downloads\.googleusercontent\.com/i.test(url)) return 4;
  if (/hubcloud\.cloudflarefb\.workers\.dev/i.test(url)) return 5;
  if (/vcloud\.zip\//i.test(url)) return 6;
  if (/gpdl\d*\./i.test(url)) return 7;
  if (/(?:gamerxyt\.com|sportverse\.cc)\/hubcloud\.php/i.test(url)) return 8;
  if (/(?:gamerxyt\.com|sportverse\.cc|hubcloud\.[^/]+)\/hubcloud\.php/i.test(url)) return 9;
  if (/hubcloud\.[^/]+\/(?:video|drive)\//i.test(url)) return 10;
  return 10;
}


function sha256(input) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function generateGofileWebsiteToken(accountToken = "") {
  const timeSlot = Math.floor(Date.now() / 1000 / 14400);
  return sha256(`${DEFAULT_UA}::${GOFILE_BROWSER_LANGUAGE}::${accountToken}::${timeSlot}::${GOFILE_SECRET}`);
}

function extractGofileId(url) {
  const match = String(url || "").match(/(?:\?c=|\/d\/)([\da-zA-Z-]+)/);
  return match ? match[1] : null;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "";
  if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(2) + " MB";
  return (value / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

async function resolveGofile(gofileUrl, options = {}) {
  const id = extractGofileId(gofileUrl);
  if (!id) return [];
  try {
    const accountRes = await fetchWithTimeout(`${GOFILE_API}/accounts`, {
      method: "POST",
      headers: {
        "X-Website-Token": generateGofileWebsiteToken(""),
        "X-BL": GOFILE_BROWSER_LANGUAGE,
      }
    }, options.timeout || 12000);
    if (!accountRes || !accountRes.ok) return [];
    const accountJson = await accountRes.json();
    const token = accountJson && accountJson.data && accountJson.data.token;
    if (!token) return [];

    const contentRes = await fetchWithTimeout(`${GOFILE_API}/contents/${id}?cache=true&sortField=createTime&sortDirection=1`, {
      headers: {
        "Referer": "https://gofile.io/",
        "Authorization": `Bearer ${token}`,
        "X-BL": GOFILE_BROWSER_LANGUAGE,
        "X-Website-Token": generateGofileWebsiteToken(token),
      }
    }, options.timeout || 12000);
    if (!contentRes || !contentRes.ok) return [];
    const contentJson = await contentRes.json();
    const children = contentJson && contentJson.data && contentJson.data.children;
    if (!children || typeof children !== "object") return [];

    const results = [];
    for (const file of Object.values(children)) {
      if (!file || file.type !== "file" || !file.link) continue;
      pushUniqueCandidate(results, {
        url: file.link,
        title: [file.name, formatBytes(file.size)].filter(Boolean).join(" "),
        headers: { Cookie: `accountToken=${token}` },
      });
    }
    return results;
  } catch {
    return [];
  }
}

async function fetchHtmlWithFlareSolverr(url, options = {}) {
  const solverUrl = process.env.FLARESOLVERR_URL || "http://127.0.0.1:8191/v1";
  const timeout = options.timeout || 45000;
  try {
    const res = await fetchWithTimeout(solverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "request.get", url, maxTimeout: timeout })
    }, timeout + 5000);
    if (!res || !res.ok) return { url, html: "" };
    const data = await res.json();
    if (data.status !== "ok" || !data.solution) return { url, html: "" };
    return { url: data.solution.url || url, html: data.solution.response || "", cookies: data.solution.cookies || [] };
  } catch {
    return { url, html: "" };
  }
}

function absoluteUrl(url, baseUrl) {
  try { return new URL(url, baseUrl).href; } catch { return null; }
}

function gdflixWfileUrlFromFileUrl(url) {
  try {
    const parsed = new URL(url);
    const id = parsed.pathname.split("/").filter(Boolean).pop();
    if (!id) return null;
    return `${parsed.origin}/wfile/${id}`;
  } catch {
    return null;
  }
}

async function validateReadyPlaybackUrl(url, headers = {}, timeout = 7000) {
  if (!url || !isReadyForPlayback(url)) return false;
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        ...headers,
        Range: "bytes=0-511"
      }
    }, timeout);
    if (!res) return false;
    const contentType = res.headers && res.headers.get ? String(res.headers.get("content-type") || "") : "";
    try { if (res.body && res.body.cancel) await res.body.cancel(); } catch {}
    return res.status === 206 || (res.ok && /video|octet-stream|matroska/i.test(contentType));
  } catch {
    return false;
  }
}

async function pushValidatedReadyCandidate(list, url, headers, title, options = {}) {
  if (!url) return;
  const normalized = normalizeDownloadUrl(url, DEFAULT_REFERER);
  if (!normalized || !isReadyForPlayback(normalized)) return;
  const ok = await validateReadyPlaybackUrl(normalized, headers || {}, options.validationTimeout || 7000);
  if (ok) pushUniqueCandidate(list, { url: normalized, headers, title });
}

async function resolveBusycdn(busycdnUrl, referer, options = {}) {
  try {
    const page = await fetchHtmlWithHeaders(busycdnUrl, mobileHeaders(referer), options.timeout || 12000);
    const finalUrl = normalizeDownloadUrl(page.url, busycdnUrl);
    if (finalUrl && isReadyForPlayback(finalUrl)) {
      return { url: finalUrl, headers: mobileHeaders(page.url || busycdnUrl), title: "Instant" };
    }

    const match = String(page.html || "").match(/new URLSearchParams\(window\.location\.search\).*?get\(["']url["']\)/i);
    if (match) {
      const parsed = new URL(page.url || busycdnUrl);
      const wrapped = parsed.searchParams.get("url");
      if (wrapped) {
        const normalized = normalizeDownloadUrl(wrapped, page.url || busycdnUrl);
        if (normalized && isReadyForPlayback(normalized)) return { url: normalized, headers: mobileHeaders(page.url || busycdnUrl), title: "Instant" };
      }
    }
  } catch {}
  return null;
}

async function resolveGdflix(gdflixUrl, options = {}) {
  const ready = [];
  const filePage = await fetchHtmlWithFlareSolverr(gdflixUrl, { timeout: options.timeout || 45000 });
  if (!filePage.html) return ready;
  const headers = mobileHeaders(filePage.url || gdflixUrl);

  const pageLinks = extractDownloadLinks(filePage.html, filePage.url || gdflixUrl);
  for (const link of pageLinks) {
    if (/instant\.busycdn\.xyz/i.test(link)) {
      const resolvedBusycdn = await resolveBusycdn(link, filePage.url || gdflixUrl, options);
      if (resolvedBusycdn) await pushValidatedReadyCandidate(ready, resolvedBusycdn.url, resolvedBusycdn.headers || headers, resolvedBusycdn.title || "Instant", options);
    }
  }

  const wfileLinks = [];
  for (const match of String(filePage.html).matchAll(/href=["']([^"']*\/wfile\/[^"']+)["']/gi)) {
    const wfile = absoluteUrl(match[1], filePage.url || gdflixUrl);
    if (wfile && !wfileLinks.includes(wfile)) wfileLinks.push(wfile);
  }
  const guessedWfile = gdflixWfileUrlFromFileUrl(filePage.url || gdflixUrl);
  if (guessedWfile && !wfileLinks.includes(guessedWfile)) wfileLinks.push(guessedWfile);

  for (const wfileUrl of wfileLinks.slice(0, 2)) {
    const wfilePage = await fetchHtmlWithFlareSolverr(wfileUrl, { timeout: options.timeout || 45000 });
    if (!wfilePage.html) continue;
    for (const link of extractDownloadLinks(wfilePage.html, wfilePage.url || wfileUrl)) {
      if (/workers\.dev|\.r2\.dev|r2\.cloudflarestorage\.com/i.test(link)) {
        const candidateHeaders = mobileHeaders(wfilePage.url || wfileUrl);
        await pushValidatedReadyCandidate(ready, appendSyncParam(link), candidateHeaders, "GDIndex", options);
      }
    }
  }

  return ready.sort((a, b) => directLinkRank(getCandidateUrl(a)) - directLinkRank(getCandidateUrl(b)));
}

async function resolveGeneratedHubcloud(generateUrl, referer) {
  const links = [];
  try {
    const page = await fetchHtml(generateUrl, referer, 12000);
    pushUniqueUrl(links, normalizeDownloadUrl(page.url, generateUrl));
    const pageLinks = extractDownloadLinks(page.html, page.url);
    for (const link of pageLinks) {
      pushUniqueUrl(links, link);
    }

    for (const link of pageLinks.filter((url) => /gpdl\d*\./i.test(url)).slice(0, 2)) {
      const resolved = await fetchHtml(link, page.url, 12000);
      pushUniqueUrl(links, normalizeDownloadUrl(resolved.url, link));
      for (const nested of extractDownloadLinks(resolved.html, resolved.url)) {
        pushUniqueUrl(links, nested);
      }
    }
  } catch {}
  return links.sort((a, b) => directLinkRank(a) - directLinkRank(b));
}



function extractBridgeUrl(html, pageUrl) {
  return extractDoubleAtobUrl(html, pageUrl) || extractScriptUrl(html, pageUrl) || null;
}

function extractButtonLinks(html, pageUrl) {
  const text = String(html || "");
  const links = [];
  const anchorMatches = text.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
  for (const match of anchorMatches) {
    const href = normalizeDownloadUrl(match[1], pageUrl);
    const label = String(match[2] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!href || href === "#" || /telegram|gdflix|dropgalaxy|\.zip/i.test(href + " " + label)) continue;
    links.push({ url: href, label });
  }
  return links;
}

async function resolveBridgePage(bridgeUrl, referer, options = {}) {
  const ready = [];
  const page = await fetchHtmlWithHeaders(bridgeUrl, mobileHeaders(referer), options.timeout || 12000);
  if (!page.html) return ready;
  const headers = mobileHeaders(bridgeUrl);

  const scriptUrl = extractScriptUrl(page.html, page.url);
  if (scriptUrl && /workers\.dev/i.test(scriptUrl)) {
    pushReadyCandidate(ready, appendSyncParam(scriptUrl), headers, "Worker");
  }

  for (const { url, label } of extractButtonLinks(page.html, page.url)) {
    if (/fslv?2?|worker/i.test(label) || /r2\.cloudflarestorage\.com|\.r2\.dev|workers\.dev/i.test(url)) {
      const finalUrl = /\.r2\.dev|workers\.dev/i.test(url) ? appendSyncParam(url) : url;
      pushReadyCandidate(ready, finalUrl, headers, label);
    }
  }

  const fslMatch = page.html.match(/id=["']fsl["'][^>]*href=["']([^"']+)["']/i) || page.html.match(/href=["']([^"']+)["'][^>]*id=["']fsl["']/i);
  if (fslMatch) pushReadyCandidate(ready, appendSyncParam(normalizeDownloadUrl(fslMatch[1], page.url)), headers, "FSL");

  for (const link of extractDownloadLinks(page.html, page.url)) {
    pushReadyCandidate(ready, link, headers, "Direct");
  }

  return ready;
}

async function resolveHubVcloudReady(url, options = {}) {
  const ready = [];
  const referer = options.referer || DEFAULT_REFERER;
  const page = await fetchHtmlWithHeaders(url, mobileHeaders(referer), options.timeout || 12000);
  if (!page.html) return ready;
  const headers = mobileHeaders(url);

  const bridgeUrl = extractBridgeUrl(page.html, page.url);
  if (bridgeUrl) {
    if (/workers\.dev/i.test(bridgeUrl)) {
      pushReadyCandidate(ready, appendSyncParam(bridgeUrl), headers, "Worker");
    } else {
      const absoluteBridge = normalizeDownloadUrl(bridgeUrl, page.url);
      for (const candidate of await resolveBridgePage(absoluteBridge, url, options)) pushUniqueCandidate(ready, candidate);
    }
  }

  const downloadHref = (page.html.match(/id=["']download["'][^>]*href=["']([^"']+)["']/i) || page.html.match(/href=["']([^"']+)["'][^>]*id=["']download["']/i) || [])[1];
  if (downloadHref) {
    const absoluteDownload = normalizeDownloadUrl(downloadHref, page.url);
    if (/(?:gamerxyt\.com|sportverse\.cc|hubcloud\.[^/]+)\/hubcloud\.php|token|dl/i.test(absoluteDownload || "")) {
      for (const candidate of await resolveBridgePage(absoluteDownload, url, options)) pushUniqueCandidate(ready, candidate);
    }
  }

  for (const { url: buttonUrl, label } of extractButtonLinks(page.html, page.url)) {
    if (/fslv?2?|worker/i.test(label) || /r2\.cloudflarestorage\.com|\.r2\.dev|workers\.dev/i.test(buttonUrl)) {
      const finalUrl = /\.r2\.dev|workers\.dev/i.test(buttonUrl) ? appendSyncParam(buttonUrl) : buttonUrl;
      pushReadyCandidate(ready, finalUrl, headers, label);
    }
  }

  return ready;
}

async function resolvePlayableCandidates(candidate, options = {}, seen = new Set(), depth = 0) {
  const rawUrl = getCandidateUrl(candidate);
  const url = normalizeDownloadUrl(rawUrl, options.referer || DEFAULT_REFERER);
  if (!url || depth > (options.maxDepth || 5)) return [];

  if (isReadyForPlayback(url)) {
    if (typeof candidate === "string") return [url];
    return [{ ...candidate, url }];
  }

  if (seen.has(url)) return [];
  seen.add(url);

  const referer = options.referer || DEFAULT_REFERER;
  const next = [];

  if (/gdflix\.(?:dev|io)\/file\/|new\d*\.gdflix\.io\/(?:file|wfile)\//i.test(url)) {
    const readyLinks = await resolveGdflix(url, options);
    if (readyLinks.length) return readyLinks;
  } else if (/gofile\.io\/d\//i.test(url)) {
    for (const item of await resolveGofile(url, options)) pushUniqueCandidate(next, item);
  } else if (/hubcloud\.[^/]+\/(?:video|drive)\//i.test(url)) {
    const readyLinks = await resolveHubVcloudReady(url, options);
    if (readyLinks.length) return readyLinks.sort((a, b) => directLinkRank(getCandidateUrl(a)) - directLinkRank(getCandidateUrl(b)));
    const links = await resolveHubcloud(url, { ...options, includeOriginal: false, readyOnly: false });
    for (const item of links) pushUniqueCandidate(next, item);
  } else if (/(?:gamerxyt\.com|sportverse\.cc|hubcloud\.[^/]+)\/hubcloud\.php/i.test(url)) {
    for (const link of await resolveGeneratedHubcloud(url, referer)) pushUniqueCandidate(next, link);
  } else if (/gpdl\d*\./i.test(url)) {
    const page = await fetchHtmlWithHeaders(url, mobileHeaders(referer), options.timeout || 12000);
    pushUniqueUrl(next, normalizeDownloadUrl(page.url, url));
    for (const link of extractDownloadLinks(page.html, page.url)) pushUniqueUrl(next, link);
  } else if (/vcloud\.zip\//i.test(url)) {
    const readyLinks = await resolveHubVcloudReady(url, options);
    if (readyLinks.length) return readyLinks.sort((a, b) => directLinkRank(getCandidateUrl(a)) - directLinkRank(getCandidateUrl(b)));
    for (const link of await resolveVcloud(url, { ...options, readyOnly: false })) pushUniqueCandidate(next, link);
  } else {
    const page = await fetchHtml(url, referer, options.timeout || 9000);
    pushUniqueUrl(next, normalizeDownloadUrl(page.url, url));
    for (const link of extractDownloadLinks(page.html, page.url)) pushUniqueUrl(next, link);
  }

  const ready = [];
  for (const item of next) {
    for (const resolved of await resolvePlayableCandidates(item, options, seen, depth + 1)) {
      pushUniqueCandidate(ready, resolved);
    }
  }
  return ready.sort((a, b) => directLinkRank(getCandidateUrl(a)) - directLinkRank(getCandidateUrl(b)));
}

async function resolveHubcloud(hubUrl, options = {}) {
  const referer = options.referer || DEFAULT_REFERER;
  const includeOriginal = options.includeOriginal !== false;
  try {
    const page = await fetchHtml(hubUrl, referer, options.timeout || 9000);
    if (!page.html) return includeOriginal ? [hubUrl] : [];

    const links = [];
    if (includeOriginal) pushUniqueUrl(links, hubUrl);
    for (const link of extractDownloadLinks(page.html, page.url)) {
      pushUniqueUrl(links, link);
    }

    const generateLinks = [];
    const hrefMatches = page.html.matchAll(/href=["']([^"']*(?:gamerxyt\.com|sportverse\.cc)\/hubcloud\.php[^"']*)["']/gi);
    for (const match of hrefMatches) {
      const generateUrl = normalizeDownloadUrl(match[1], page.url);
      pushUniqueUrl(generateLinks, generateUrl);
      pushUniqueUrl(links, generateUrl);
    }
    const inlineMatches = page.html.match(/https?:\/\/(?:gamerxyt\.com|sportverse\.cc)\/hubcloud\.php[^"'\s<>]+/gi) || [];
    for (const match of inlineMatches) {
      const generateUrl = normalizeDownloadUrl(match, page.url);
      pushUniqueUrl(generateLinks, generateUrl);
      pushUniqueUrl(links, generateUrl);
    }

    for (const generateUrl of generateLinks.slice(0, options.maxGenerateLinks || 2)) {
      const generated = await resolveGeneratedHubcloud(generateUrl, page.url);
      for (const link of generated) pushUniqueUrl(links, link);
    }

    const candidates = [];
    for (const link of links.filter(isKnownDownloadHost)) {
      pushUniqueCandidate(candidates, link);
      if (/gofile\.io\/d\//i.test(link) && options.resolveGofile !== false) {
        for (const gofileCandidate of await resolveGofile(link, options)) {
          pushUniqueCandidate(candidates, gofileCandidate);
        }
      }
    }

    if (options.readyOnly) {
      const ready = [];
      for (const candidate of candidates) {
        for (const resolved of await resolvePlayableCandidates(candidate, options)) {
          pushUniqueCandidate(ready, resolved);
        }
      }
      return ready.sort((a, b) => directLinkRank(getCandidateUrl(a)) - directLinkRank(getCandidateUrl(b)));
    }

    return candidates.sort((a, b) => directLinkRank(getCandidateUrl(a)) - directLinkRank(getCandidateUrl(b)));
  } catch {
    return includeOriginal ? [hubUrl] : [];
  }
}


async function resolveVcloud(vcloudUrl, options = {}) {
  const referer = options.referer || DEFAULT_REFERER;
  const links = [];
  pushUniqueUrl(links, vcloudUrl);
  try {
    const page = await fetchHtmlWithHeaders(vcloudUrl, mobileHeaders(referer), options.timeout || 9000);
    if (page.html) {
      for (const link of extractDownloadLinks(page.html, page.url)) pushUniqueUrl(links, link);
    }

    const direct = await resolveVcloudApi(vcloudUrl, options);
    pushUniqueUrl(links, direct);

    const tokenUrl = await resolveVcloudToken(vcloudUrl, options);
    pushUniqueUrl(links, tokenUrl);
    if (tokenUrl) {
      const tokenPage = await fetchHtmlWithHeaders(tokenUrl, mobileHeaders(vcloudUrl), options.timeout || 9000);
      if (tokenPage.html) {
        for (const link of extractDownloadLinks(tokenPage.html, tokenPage.url)) pushUniqueUrl(links, link);
      }
    }
  } catch {}
  const candidates = links.filter(isKnownDownloadHost).sort((a, b) => directLinkRank(a) - directLinkRank(b));
  if (!options.readyOnly) return candidates;
  const ready = [];
  for (const candidate of candidates) {
    for (const resolved of await resolvePlayableCandidates(candidate, options)) pushUniqueCandidate(ready, resolved);
  }
  return ready.sort((a, b) => directLinkRank(getCandidateUrl(a)) - directLinkRank(getCandidateUrl(b)));
}

async function resolveVcloudApi(url, options = {}) {
  const page = await fetchHtml(url, options.referer || DEFAULT_REFERER, options.timeout || 9000);
  if (!page.html) return null;
  const match = page.html.match(/<a\s+href=["'](https:\/\/vcloud\.zip\/[^"']+)["'][^>]*>Direct\s+Download/i);
  return match ? match[1].trim() : null;
}

async function resolveVcloudToken(url, options = {}) {
  const page = await fetchHtml(url, options.referer || DEFAULT_REFERER, options.timeout || 9000);
  if (!page.html) return null;
  const match = page.html.match(/atob\s*\(\s*atob\s*\(\s*["']([^"']+)["']\s*\)\s*\)/);
  if (!match) return null;
  try { return atob(atob(match[1])); } catch { return null; }
}

module.exports = {
  directLinkRank,
  extractDownloadLinks,
  fetchHtml,
  fetchHtmlWithHeaders,
  fetchWithTimeout,
  formatResolvedUrl,
  getCandidateHeaders,
  getCandidateUrl,
  isKnownDownloadHost,
  isReadyForPlayback,
  isBlockedMediaUrl,
  normalizeDownloadUrl,
  pushUniqueUrl,
  resolveGeneratedHubcloud,
  resolveGdflix,
  resolveGofile,
  resolveHubVcloudReady,
  resolveHubcloud,
  resolvePlayableCandidates,
  resolveVcloud,
  resolveVcloudApi,
  resolveVcloudToken,
};
