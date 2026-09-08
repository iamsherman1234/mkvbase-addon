const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const fetch = require("node-fetch");
const { getDomain } = require("../lib/dynamicDomains");
const { extractDownloadLinks, fetchGdflixWithSolver, getCandidateHeaders, getCandidateUrl, isReadyForPlayback, resolveHubcloud, resolvePlayableCandidates, resolveVcloud, safeEncodeUrl } = require("../lib/hostResolver");

// ── Performance: In-memory caches ──
const streamCache = new Map();  // key: "movie:tt1234567" → { streams, ts }
const STREAM_CACHE_TTL_MS = Number(process.env.MKVBASE_CACHE_TTL_MS || 30 * 60 * 1000); // 30 min
const resolvedUrlCache = new Map(); // key: hubcloud URL → { candidates, ts }
const URL_CACHE_TTL_MS = 20 * 60 * 1000; // 20 min
const tmdbCache = new Map(); // key: imdbId → { info, ts }
const TMDB_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getCachedStreams(cacheKey) {
  const entry = streamCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.ts > STREAM_CACHE_TTL_MS) { streamCache.delete(cacheKey); return null; }
  return entry.streams;
}

function setCachedStreams(cacheKey, streams) {
  streamCache.set(cacheKey, { streams, ts: Date.now() });
  // Evict old entries if cache grows too large
  if (streamCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of streamCache) { if (now - v.ts > STREAM_CACHE_TTL_MS) streamCache.delete(k); }
  }
}

function getCachedResolvedUrl(url) {
  const entry = resolvedUrlCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.ts > URL_CACHE_TTL_MS) { resolvedUrlCache.delete(url); return null; }
  return entry.candidates;
}

function setCachedResolvedUrl(url, candidates) {
  resolvedUrlCache.set(url, { candidates, ts: Date.now() });
  if (resolvedUrlCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of resolvedUrlCache) { if (now - v.ts > URL_CACHE_TTL_MS) resolvedUrlCache.delete(k); }
  }
}

function encodeQuery(query, timestamp) {
  if (!query) return "";
  const key = timestamp % 256;
  let encoded = "";
  for (let i = 0; i < query.length; i++) {
    encoded += (query.charCodeAt(i) ^ key).toString(16).padStart(2, "0");
  }
  return encoded;
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function solvePow(challengePrefix, difficulty, encodedQuery) {
  const targetZeros = "0".repeat(difficulty);
  let nonce = 0;
  while (nonce <= 500000) {
    const hash1 = sha256Hex(challengePrefix + ":" + nonce);
    const finalHash = sha256Hex(hash1 + ":" + encodedQuery);
    if (finalHash.startsWith(targetZeros)) return nonce;
    nonce++;
  }
  return nonce;
}

function generateSignature(clientKey, message) {
  return crypto.createHmac("sha256", clientKey).update(message, "utf8").digest("hex");
}

function debugLog(...args) {
  if (MKVBASE_DEBUG) console.log("[MkvBase]", ...args);
}

function parseCookieHeader(cookieHeader) {
  const out = {};
  String(cookieHeader || "").split(";").map((part) => part.trim()).filter(Boolean).forEach((part) => {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx)] = part.slice(idx + 1);
  });
  return out;
}

function cookieHeaderFromCookies(cookies) {
  return (cookies || []).filter((cookie) => cookie && cookie.name && cookie.value).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function setCookieHeadersFromResponse(res) {
  if (!res || !res.headers) return [];
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  const combined = res.headers.get ? res.headers.get("set-cookie") : "";
  return combined ? combined.split(/,(?=\s*[^;,=\s]+=)/).map((item) => item.trim()).filter(Boolean) : [];
}

function mergeCookieHeader(existingCookieHeader, setCookieHeaders) {
  const cookies = parseCookieHeader(existingCookieHeader);
  for (const header of setCookieHeaders || []) {
    const firstPart = String(header || "").split(";")[0];
    const idx = firstPart.indexOf("=");
    if (idx > 0) cookies[firstPart.slice(0, idx)] = firstPart.slice(idx + 1);
  }
  return Object.entries(cookies).map(([name, value]) => name + "=" + value).join("; ");
}

function sessionLooksUsable(session) {
  if (!session || !session.cookieHeader || !session.clientKey || !session.challenge || !session.seq) return false;
  if (Date.now() - Number(session.savedAt || 0) > DIRECT_SESSION_TTL_MS) return false;
  return /cf_clearance=/.test(session.cookieHeader) && /mkv_client_key=/.test(session.cookieHeader);
}

function loadDirectSession() {
  try {
    const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
    return sessionLooksUsable(session) ? session : null;
  } catch {
    return null;
  }
}

function clearDirectSession() {
  try { fs.unlinkSync(SESSION_PATH); } catch (_) {}
}

function saveDirectSession(cookieHeader, userAgent) {
  const cookies = parseCookieHeader(cookieHeader);
  const session = {
    cookieHeader,
    userAgent: userAgent || UA,
    clientKey: cookies.mkv_client_key,
    challenge: decodeURIComponent(cookies.mkv_challenge || ""),
    seq: cookies.mkv_seq || "1",
    savedAt: Date.now()
  };
  if (!sessionLooksUsable(session)) return null;
  try {
    fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
    fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
  } catch (_) {}
  return session;
}

function buildMkvBaseApiPath(query, session) {
  const challenge = decodeURIComponent(String(session.challenge || ""));
  const parts = challenge.split(":");
  const challengePrefix = parts[0];
  const difficulty = parts[1] ? parseInt(parts[1], 10) : 2;
  if (!challengePrefix || !session.clientKey) return null;

  const timestamp = Date.now();
  const encodedQ = encodeQuery(query, timestamp);
  const nonce = solvePow(challengePrefix, difficulty, encodedQ);
  const ent = 10;
  const seq = session.seq || "1";
  const payloadStr = `${encodedQ}:${timestamp}:${seq}:${nonce}:${ent}`;
  const sig = generateSignature(session.clientKey, payloadStr);
  return `/api/links?q=${encodeURIComponent(encodedQ)}&t=${timestamp}&seq=${seq}&pow=${nonce}&ent=${ent}&sig=${sig}`;
}

function buildMkvBaseApiUrl(query, session) {
  const apiPath = buildMkvBaseApiPath(query, session);
  return apiPath ? `${getBaseUrl()}${apiPath}` : null;
}

async function fetchMkvBaseApiDirect(query, session = loadDirectSession()) {
  if (!sessionLooksUsable(session)) return { ok: false, results: [] };
  const apiUrl = buildMkvBaseApiUrl(query, session);
  if (!apiUrl) return { ok: false, results: [] };
  const started = Date.now();
  try {
    const res = await fetchSafe(apiUrl, {
      headers: {
        "User-Agent": session.userAgent || UA,
        "Cookie": session.cookieHeader,
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": `${getBaseUrl()}/`
      }
    }, 9000);
    if (!res || !res.ok) {
      debugLog("direct API failed", res && res.status);
      if (res && (res.status === 401 || res.status === 403)) clearDirectSession();
      return { ok: false, results: [] };
    }
    const updatedCookieHeader = mergeCookieHeader(session.cookieHeader, setCookieHeadersFromResponse(res));
    if (updatedCookieHeader && updatedCookieHeader !== session.cookieHeader) saveDirectSession(updatedCookieHeader, session.userAgent);
    const json = await res.json();
    const results = json && Array.isArray(json.results) ? json.results : [];
    debugLog("direct API", query, results.length, `${Date.now() - started}ms`);
    return { ok: true, results: results.map((item) => ({ title: item.title, url: item.url })).filter((item) => item.url) };
  } catch (error) {
    debugLog("direct API error", error.message);
    return { ok: false, results: [] };
  }
}

let solverLock = null;

async function bootstrapMkvBaseSession() {
  if (solverLock) return solverLock;
  solverLock = (async () => {
    const started = Date.now();
    try {
      const { execFile } = require("child_process");
      const scriptPath = path.join(__dirname, "../scripts/solve_mkvbase.js");
      await new Promise((resolve, reject) => {
        execFile("node", [scriptPath, SESSION_PATH], { timeout: 45000 }, (err, stdout, stderr) => {
          if (err) {
            console.error("[MkvBase] Solver error:", err.message, stderr);
            return reject(err);
          }
          resolve();
        });
      });
      const session = loadDirectSession();
      if (session) {
        console.log(`[MkvBase] ✅ On-demand session bootstrap successful (${Date.now() - started}ms)`);
        return session;
      }
    } catch (err) {
      console.warn("[MkvBase] Session bootstrap error:", err.message);
    } finally {
      solverLock = null;
    }
    return null;
  })();
  return solverLock;
}

async function fetchMkvBaseApiInPage(page, query, cookieHeader) {
  const cookies = parseCookieHeader(cookieHeader);
  const session = {
    cookieHeader,
    clientKey: cookies.mkv_client_key,
    challenge: decodeURIComponent(cookies.mkv_challenge || ""),
    seq: cookies.mkv_seq || "1",
    savedAt: Date.now()
  };
  if (!session.clientKey || !session.challenge) return [];
  const apiPath = buildMkvBaseApiPath(query, session);
  if (!apiPath) return [];

  try {
    const json = await page.evaluate(async (path) => {
      const res = await fetch(path, {
        headers: {
          "Accept": "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest"
        }
      });
      if (!res.ok) return null;
      return res.json();
    }, apiPath);
    const results = json && Array.isArray(json.results) ? json.results : [];
    debugLog("in-page API", query, results.length);
    return results.map((item) => ({ title: item.title, url: item.url })).filter((item) => item.url);
  } catch (error) {
    debugLog("in-page API error", error.message);
    return [];
  }
}

async function waitForMkvBaseReady(page, timeoutMs = 30000) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let lastState = null;
  let refreshCount = 0;
  while (Date.now() < deadline) {
    try {
      lastState = await page.evaluate(() => ({
        title: document.title || "",
        href: location.href || "",
        cookie: document.cookie || "",
        body: document.body ? document.body.innerText.slice(0, 300) : ""
      }));

      const hasClientCookies = /mkv_client_key=/.test(lastState.cookie) && /mkv_challenge=/.test(lastState.cookie);
      if (hasClientCookies) return lastState;

      const challengeText = (lastState.title + " " + lastState.body).toLowerCase();
      const looksLikeChallenge = challengeText.includes("just a moment") || challengeText.includes("enable javascript") || challengeText.includes("checking your browser");
      if (looksLikeChallenge && refreshCount < MKVBASE_CF_REFRESH_MAX && Date.now() - started > MKVBASE_CF_REFRESH_DELAY_MS * (refreshCount + 1)) {
        refreshCount++;
        debugLog("refreshing Cloudflare challenge page", refreshCount);
        try { await page.reload({ waitUntil: "domcontentloaded", timeout: 25000 }); } catch (_) {}
      }
    } catch (_) {}
    await sleep(1000);
  }
  debugLog("browser not ready", lastState);
  return lastState;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

const PROVIDER = "MkvBase";
const MKVBASE_FULL_ADDON_ENABLED = process.env.MKVBASE_FULL_ADDON_ENABLED === "1";
let mkvbaseBrowserBusy = false;
const getBaseUrl = () => getDomain("mkvbase", "https://mkvbase.site");
const SESSION_PATH = path.join(__dirname, "../.mkvbase_profile/session.json");
const DIRECT_SESSION_TTL_MS = Number(process.env.MKVBASE_DIRECT_SESSION_TTL_MS || 10 * 60 * 60 * 1000);
const MKVBASE_MAX_RESOLVE_ITEMS = Number(process.env.MKVBASE_MAX_RESOLVE_ITEMS || 16);
const MKVBASE_RESOLVE_CONCURRENCY = Number(process.env.MKVBASE_RESOLVE_CONCURRENCY || 12);
const MKVBASE_HOST_RESOLVE_TIMEOUT_MS = Number(process.env.MKVBASE_HOST_RESOLVE_TIMEOUT_MS || 4000);
const MKVBASE_HEADERLESS_STREAMS_ONLY = process.env.MKVBASE_HEADERLESS_STREAMS_ONLY === "1";
const MKVBASE_TARGET_STREAMS = Number(process.env.MKVBASE_TARGET_STREAMS || 16);
const MKVBASE_DEBUG = process.env.MKVBASE_DEBUG === "true";
const MKVBASE_BROWSER_WAIT_MS = Number(process.env.MKVBASE_BROWSER_WAIT_MS || 60000);
const MKVBASE_CF_REFRESH_DELAY_MS = Number(process.env.MKVBASE_CF_REFRESH_DELAY_MS || 8000);
const MKVBASE_CF_REFRESH_MAX = Number(process.env.MKVBASE_CF_REFRESH_MAX || 2);
const MKVBASE_FLARESOLVERR_ENABLED = process.env.MKVBASE_FLARESOLVERR_ENABLED !== "0";
const MKVBASE_FLARESOLVERR_TIMEOUT_MS = Number(process.env.MKVBASE_FLARESOLVERR_TIMEOUT_MS || 8000);
const MKVBASE_FLARESOLVERR_ATTEMPTS = Number(process.env.MKVBASE_FLARESOLVERR_ATTEMPTS || 1);
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "http://127.0.0.1:8191/v1";
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_KEY = "307b7b8ef035c6aa336900aef4e203bd";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// ── Performance: Direct CDN storage that is inherently reliable ──
const TRUSTED_HOST_RE = /r2\.cloudflarestorage\.com|\.r2\.dev/i;
function isTrustedHost(url) { return TRUSTED_HOST_RE.test(url || ""); }

function extractMainTitle(str) {
  if (!str) return "";
  let clean = str.replace(/^[a-zA-Z0-9\s]+'s\s+/i, "");
  return clean.split(/[:\-(]/)[0].replace(/['"&]/g, "").replace(/\s+/g, " ").trim();
}

function normalizeQ(q) {
  if (!q) return "HD";
  const l = q.toLowerCase();
  if (l === "4k" || l === "2160p") return "2160p";
  if (l === "1440p" || l === "2k") return "1440p";
  if (l === "1080p") return "1080p";
  if (l === "720p") return "720p";
  if (l === "480p") return "480p";
  return "HD";
}


function parseQuality(text) {
  const match = String(text || "").match(/(2160|1440|1080|720|480)\s*p/i);
  if (match) return match[1] + "p";
  if (/\b2k\b/i.test(text)) return "1440p";
  if (/4k|uhd/i.test(text)) return "2160p";
  if (/1080p|fullhd/i.test(text)) return "1080p";
  if (/720p|hd/i.test(text)) return "720p";
  if (/480p|sd/i.test(text)) return "480p";
  return "HD";
}

function stripSourcePrefix(text) {
  return String(text || "").replace(/^\s*[a-z0-9 ._-]{2,24}\s*\|\s*/i, "");
}

function normalizeReleaseText(text) {
  return stripSourcePrefix(text)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`‘]/g, "")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTitleTokens(title) {
  const stopWords = new Set(["and", "the", "a", "an", "of", "in", "to", "on", "with", "part", "vol", "volume"]);
  return normalizeReleaseText(title).split(/\s+/).filter((w) => w.length > 0 && !stopWords.has(w));
}

function buildSearchTokens(query) {
  return normalizeReleaseText(query).split(/\s+/).filter((t) => t.length > 2 || t === "4k" || t === "2k");
}

function extractReleaseYears(text) {
  const years = new Set();
  const matches = String(text || "").match(/\b(?:19|20)\d{2}\b/g) || [];
  for (const year of matches) years.add(year);
  return years;
}

function hasTvReleaseMarker(text) {
  const value = String(text || "");
  return /\bS\d{1,2}(?:E\d{1,3})?\b/i.test(value)
    || /\b\d{1,2}x\d{1,3}\b/i.test(value)
    || /\bSeason\s*\d{1,2}\b/i.test(value)
    || /\b(?:Complete|All)\s+Season(?:s)?\b/i.test(value)
    || /\bEpisode\s*\d{1,3}\b/i.test(value);
}

function movieTitleMatchesResult(itemTitle, targetTitle, targetYear) {
  const itemNorm = normalizeReleaseText(itemTitle);
  const targetNorm = normalizeReleaseText(targetTitle);
  if (!itemNorm || !targetNorm) return false;
  if (hasTvReleaseMarker(stripSourcePrefix(itemTitle))) return false;

  const targetTokens = getTitleTokens(targetTitle);
  const itemTokens = getTitleTokens(itemTitle);
  if (!targetTokens.length) return true;

  // Key target tokens must be present in the leading portion of item tokens
  const firstItemTokens = itemTokens.slice(0, targetTokens.length + 3);
  const allMatch = targetTokens.every((t) => firstItemTokens.includes(t));
  if (!allMatch) {
    // Fallback: check startsWith regex
    const titlePattern = new RegExp(`^${targetNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\b|$)`);
    if (!titlePattern.test(itemNorm)) return false;
  }

  if (targetYear) {
    const years = Array.from(extractReleaseYears(itemTitle));
    if (years.length > 0) {
      const targetY = parseInt(targetYear, 10);
      const matchesYear = years.some((y) => Math.abs(parseInt(y, 10) - targetY) <= 1);
      if (!matchesYear) return false;
    }
  }

  return true;
}

function normalizeStreamUrlForDedupe(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.searchParams.delete("s");
    return parsed.href;
  } catch {
    return String(url || "");
  }
}

function urlsAreSameResolvedFile(a, b) {
  const first = normalizeStreamUrlForDedupe(a);
  const second = normalizeStreamUrlForDedupe(b);
  if (!first || !second) return false;
  if (first === second) return true;

  const shorter = first.length <= second.length ? first : second;
  const longer = first.length <= second.length ? second : first;
  if (shorter.length < 80 || !longer.startsWith(shorter)) return false;

  try {
    const shortUrl = new URL(shorter);
    const longUrl = new URL(longer);
    if (shortUrl.origin !== longUrl.origin) return false;
    return /(?:workers\.dev|r2\.cloudflarestorage\.com|\.r2\.dev)$/i.test(shortUrl.hostname);
  } catch {
    return false;
  }
}

function addUniqueResolvedStream(streams, seenUrls, stream) {
  if (!stream || !stream.url) return;
  const normalized = normalizeStreamUrlForDedupe(stream.url);
  if (seenUrls.has(normalized)) return;

  const existingIndex = streams.findIndex((existing) => urlsAreSameResolvedFile(existing.url, stream.url));
  if (existingIndex >= 0) {
    const existing = streams[existingIndex];
    if (normalizeStreamUrlForDedupe(stream.url).length > normalizeStreamUrlForDedupe(existing.url).length) {
      seenUrls.delete(normalizeStreamUrlForDedupe(existing.url));
      streams[existingIndex] = stream;
      seenUrls.add(normalized);
    }
    return;
  }

  seenUrls.add(normalized);
  streams.push(stream);
}

function extractFileSize(text) {
  const match = String(text || "").match(/(?:^|\s|\[|\(|\b)(\d+(?:\.\d+)?)\s*(GB|GiB|MB|MiB)\b/i);
  if (!match) return "";
  const unit = match[2].toUpperCase().replace("IB", "B");
  return match[1] + " " + unit;
}

function extractFileSizeFromUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    // 1. Check query parameters like ?bytes=... or ?size=...
    const bytesParam = parsed.searchParams.get("bytes") || parsed.searchParams.get("size") || parsed.searchParams.get("length");
    if (bytesParam && /^\d+$/.test(bytesParam) && Number(bytesParam) > 1024 * 1024) {
      return formatFileSize(bytesParam);
    }
    // 2. Check path segment before filename like /<hash>/1398002376/filename.mkv
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    if (pathParts.length >= 2) {
      const secondToLast = pathParts[pathParts.length - 2];
      if (/^\d{6,13}$/.test(secondToLast)) {
        return formatFileSize(secondToLast);
      }
    }
  } catch {}
  return "";
}

function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "";
  if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(2) + " MB";
  return (value / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

async function validateResolvedPlaybackUrl(url, headers = {}) {
  if (!url) return false;
  // Direct Cloudflare R2 object storage is fast and reliable
  if (isTrustedHost(url)) return true;
  try {
    const cleanUrl = safeEncodeUrl(url);
    const res = await fetchSafe(cleanUrl, {
      headers: {
        ...(headers || {}),
        Range: "bytes=0-511"
      }
    }, 3500);
    if (!res) return false;
    if (res.status === 206) return true;
    if (res.ok) {
      const contentType = res.headers && res.headers.get ? String(res.headers.get("content-type") || "") : "";
      const contentLength = res.headers && res.headers.get ? Number(res.headers.get("content-length") || 0) : 0;
      return /video|octet-stream|matroska|mp4|mpegurl/i.test(contentType) || contentLength > 1024 * 1024;
    }
    return false;
  } catch {
    return false;
  }
}

async function probeResolvedFileSize(url, headers = {}) {
  try {
    const cleanUrl = safeEncodeUrl(url);
    const res = await fetchSafe(cleanUrl, {
      headers: {
        ...(headers || {}),
        Range: "bytes=0-0"
      }
    }, 3500);
    if (!res) return "";
    const contentRange = res.headers && res.headers.get ? String(res.headers.get("content-range") || "") : "";
    const totalBytes = contentRange.includes("/") ? contentRange.split("/").pop().trim() : "";
    if (totalBytes) return formatFileSize(totalBytes);
    const contentLength = res.headers && res.headers.get ? res.headers.get("content-length") : "";
    return formatFileSize(contentLength);
  } catch {
    return "";
  }
}

function qualityWeight(quality) {
  return ({ "2160p": 4, "1440p": 3, "1080p": 2, "720p": 1, "480p": 0, "HD": 0 })[quality] || 0;
}

function isAtLeast1080pTitle(text) {
  return qualityWeight(normalizeQ(parseQuality(text))) >= qualityWeight("1080p");
}

function deliveryHostLabel(url) {
  const value = String(url || "").toLowerCase();
  if (value.includes("video-downloads.googleusercontent.com")) return "GD";
  if (value.includes("r2.cloudflarestorage.com") || value.includes(".r2.dev")) return "R2";
  if (value.includes("workers.dev")) return "CF";
  if (value.includes("pixeldrain") || value.includes("pixeldra.in")) return "PX";
  if (value.includes("gofile.io") || /store\d*\.gofile\.io/i.test(value)) return "GF";
  if (value.includes("hubcloud")) return "Hubcloud";
  return "Direct";
}

function sourceHostLabel(url) {
  const value = String(url || "").toLowerCase();
  if (value.includes("gdflix")) return "GDFlix";
  if (value.includes("hubcloud") || value.includes("sportverse") || value.includes("gpdl")) return "Hubcloud";
  if (value.includes("gofile")) return "Gofile";
  if (value.includes("pixeldrain")) return "Pixeldrain";
  if (value.includes("vcloud")) return "VCloud";
  return "Direct";
}

function streamRouteLabel(sourceUrl, resolvedUrl) {
  const delivery = deliveryHostLabel(resolvedUrl);
  const source = sourceHostLabel(sourceUrl);
  if (delivery === source) return delivery;
  return `${delivery}-${source}`;
}

function formatQualityLabel(q) {
  if (q === "2160p") return "4K UHD";
  if (q === "1440p") return "2K QHD";
  if (q === "1080p") return "1080p FHD";
  return q || "HD";
}

function parseReleaseDetails(title) {
  const t = String(title || "").trim();
  const tags = [];

  if (/remux/i.test(t)) tags.push("REMUX");
  if (/bluray|blu-ray/i.test(t)) tags.push("BluRay");
  else if (/web-?dl|webrip/i.test(t)) tags.push("WEB-DL");
  else if (/hdtv/i.test(t)) tags.push("HDTV");

  if (/dolby\s*vision|[\b_.]dv[\b_.]/i.test(t)) tags.push("DV");
  if (/hdr10\+/i.test(t)) tags.push("HDR10+");
  else if (/hdr10|hdr/i.test(t)) tags.push("HDR");

  if (/10[-_]?bit/i.test(t)) tags.push("10-Bit");
  if (/hevc|x265|h\.?265/i.test(t)) tags.push("HEVC");
  else if (/x264|h\.?264|avc/i.test(t)) tags.push("x264");

  if (/atmos/i.test(t)) tags.push("Atmos");
  if (/truehd/i.test(t)) tags.push("TrueHD");
  else if (/dts-hd\s*ma/i.test(t)) tags.push("DTS-HD MA");
  else if (/ddp|dd\+|eac3/i.test(t)) tags.push("DDP 5.1");
  else if (/dts/i.test(t)) tags.push("DTS");

  if (/dual[-_ ]audio|multi[-_ ]audio/i.test(t)) tags.push("Multi-Audio");
  else if (/hindi/i.test(t) && /english/i.test(t)) tags.push("Hindi + English");

  return tags;
}

function dedupeItemsByUrl(items) {
  const seen = new Set();
  return (items || []).filter((item) => {
    if (!item || !item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSafe(url, opts = {}, timeout = 5000) {
  try {
    return await Promise.race([
      fetch(url, {
        ...opts,
        headers: {
          "User-Agent": UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          ...(opts.headers || {})
        }
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeout))
    ]);
  } catch {
    return null;
  }
}

async function fetchTmdbDetails(tmdbId, mediaType) {
  const lookupId = String(tmdbId || "").replace(/^tmdb:/, "");
  const cacheKey = `${mediaType}:${lookupId}`;

  // Check TMDB cache first
  const cached = tmdbCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TMDB_CACHE_TTL_MS) return cached.info;

  const isTv = mediaType === "tv" || mediaType === "series";
  const typeStr = isTv ? "series" : "movie";
  const isImdb = lookupId.startsWith("tt");

  let info = null;

  // 1. If IMDb ID, query TMDB find endpoint first (most accurate title and metadata)
  if (isImdb) {
    try {
      const tmdbFindRes = await fetchSafe(
        `${TMDB_BASE}/find/${lookupId}?api_key=${TMDB_KEY}&external_source=imdb_id`,
        { headers: { "User-Agent": UA } },
        4000
      );
      if (tmdbFindRes && tmdbFindRes.ok) {
        const data = await tmdbFindRes.json();
        const results = isTv ? (data.tv_results || []) : (data.movie_results || []);
        if (results.length > 0) {
          const item = results[0];
          info = {
            title: isTv ? item.name : item.title,
            year: (isTv ? item.first_air_date : item.release_date || "").substring(0, 4),
            imdbId: lookupId,
            alternateTitles: []
          };
          if (item.original_title && item.original_title !== info.title) {
            info.alternateTitles.push(item.original_title);
          }
        }
      }
    } catch (_) {}
  }

  // 2. Query Cinemeta as metadata source or alias enricher
  if (isImdb) {
    try {
      const cineRes = await fetchSafe(`https://v3-cinemeta.strem.io/meta/${typeStr}/${lookupId}.json`, {}, 3000);
      if (cineRes && cineRes.ok) {
        const cineData = await cineRes.json();
        if (cineData && cineData.meta && cineData.meta.name) {
          if (!info) {
            info = {
              title: cineData.meta.name,
              year: String(cineData.meta.year || "").substring(0, 4),
              imdbId: cineData.meta.imdb_id || lookupId,
              alternateTitles: []
            };
          } else if (cineData.meta.name !== info.title) {
            info.alternateTitles.push(cineData.meta.name);
          }
        }
      }
    } catch (_) {}
  }

  // 3. Fallback for direct TMDB numeric ID
  if (!info && !isImdb) {
    const endpoint = isTv ? "tv" : "movie";
    try {
      const res = await fetchSafe(
        `${TMDB_BASE}/${endpoint}/${lookupId}?api_key=${TMDB_KEY}&append_to_response=external_ids`,
        { headers: { "User-Agent": UA } },
        4000
      );
      if (res && res.ok) {
        const data = await res.json();
        info = {
          title: isTv ? data.name : data.title,
          year: (isTv ? data.first_air_date : data.release_date || "").substring(0, 4),
          imdbId: (data.external_ids && data.external_ids.imdb_id) || lookupId,
          alternateTitles: []
        };
        if (data.original_title && data.original_title !== info.title) {
          info.alternateTitles.push(data.original_title);
        }
      }
    } catch (_) {}
  }

  if (info) {
    tmdbCache.set(cacheKey, { info, ts: Date.now() });
    return info;
  }

  return null;
}

async function resolveGdflix(gdUrl) {
  // Pure HTTP resolver fallback (no browser)
  return null;
}

async function fetchMkvBaseApi(query, options = {}) {
  if (!options.skipDirect) {
    let session = loadDirectSession();
    if (!session) {
      session = await bootstrapMkvBaseSession();
    }
    const direct = await fetchMkvBaseApiDirect(query, session);
    if (direct.ok) return direct.results;

    // Direct failed or session expired; bootstrap fresh session
    const solverSession = await bootstrapMkvBaseSession();
    if (solverSession) {
      const solverResult = await fetchMkvBaseApiDirect(query, solverSession);
      if (solverResult.ok) return solverResult.results;
    }
  }
  return [];
}

async function getStreams(tmdbId, mediaType, season = null, episode = null, mediaTitle = null, mediaYear = null) {
  const totalStart = Date.now();
  const passedTitle = typeof mediaTitle === "string" ? mediaTitle : (mediaTitle && mediaTitle.title ? mediaTitle.title : null);
  const passedYear = mediaYear || (mediaTitle && mediaTitle.year ? String(mediaTitle.year) : null);

  // ── Check stream cache ──
  const cacheKey = `${mediaType}:${tmdbId}:${season || 0}:${episode || 0}`;
  const cachedStreams = getCachedStreams(cacheKey);
  if (cachedStreams) {
    console.log(`[MkvBase] ⚡ Cache hit for ${cacheKey} (${cachedStreams.length} streams, ${Date.now() - totalStart}ms)`);
    return cachedStreams;
  }

  // ── TMDB lookup & session check ──
  const t0 = Date.now();
  const info = (passedTitle && passedYear)
    ? { title: passedTitle, year: passedYear }
    : await fetchTmdbDetails(tmdbId, mediaType);
  const session = loadDirectSession();
  if (!session) {
    // Refresh session in background without stalling this request
    bootstrapMkvBaseSession().catch(() => {});
  }
  console.log(`[MkvBase] ⏱ TMDB: ${Date.now() - t0}ms (session: ${session ? "valid" : "missing"})`);
  const effectiveTitle = passedTitle || info?.title;
  const effectiveYear = passedYear || info?.year;
  if (!effectiveTitle) return [];

  const isTv = mediaType === "tv" || mediaType === "series";
  const movieYear = !isTv && effectiveYear ? String(effectiveYear) : "";

  const titleVariants = new Set();
  titleVariants.add(effectiveTitle);
  if (info?.title) titleVariants.add(info.title);
  if (Array.isArray(info?.alternateTitles)) {
    for (const alt of info.alternateTitles) {
      if (alt) titleVariants.add(alt);
    }
  }

  const searchQueries = [];
  for (const t of titleVariants) {
    const rawT = (t || "").toLowerCase()
      .replace(/\bpart\s+two\b/gi, "part 2")
      .replace(/\bpart\s+one\b/gi, "part 1")
      .replace(/\bpart\s+three\b/gi, "part 3")
      .replace(/[:\-(]/g, " ")
      .replace(/['"&]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const andT = (t || "").toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[:\-(]/g, " ")
      .replace(/['"]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (isTv && season && episode) {
      const sStr = String(season).padStart(2, "0");
      const eStr = String(episode).padStart(2, "0");
      searchQueries.push(`${andT} s${sStr}e${eStr}`);
      searchQueries.push(`${andT} season ${season}`);
      searchQueries.push(andT);
    } else if (!isTv && movieYear) {
      searchQueries.push(andT);
      searchQueries.push(`${andT} ${movieYear}`);
      if (rawT !== andT) searchQueries.push(rawT);
      if (rawT !== andT) searchQueries.push(`${rawT} ${movieYear}`);
    } else {
      searchQueries.push(andT);
      if (rawT !== andT) searchQueries.push(rawT);
    }
  }

  let allMatchingItems = [];

  for (const searchQuery of searchQueries) {
    console.log(`[MkvBase] query: '${searchQuery}' (Target: S${season}E${episode})`);
    const maxAttempts = 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      items = await fetchMkvBaseApi(searchQuery);
      console.log(`[MkvBase] fetchMkvBaseApi '${searchQuery}' attempt ${attempt} returned ${items.length} items`);
      if (items.length) break;
      if (attempt < maxAttempts) await sleep(1500);
    }

    if (!items.length) continue;

    let queryMatches = [];
    if (isTv && season && episode) {
      const sStr = String(season).padStart(2, "0");
      const eStr = String(episode).padStart(2, "0");
      const seToken = `s${sStr}e${eStr}`;
      const seAltToken = `s${sStr} e${eStr}`;
      const altToken = `${season}x${eStr}`;
      queryMatches = items.filter((item) => {
        const itemTitleLower = (item.title || "").toLowerCase();
        if (/\.zip\b|\.rar\b|\bzip\b|\brar\b/i.test(itemTitleLower)) return false;
        return itemTitleLower.includes(seToken) || itemTitleLower.includes(seAltToken) || itemTitleLower.includes(altToken);
      });
      console.log(`[MkvBase] series filter kept ${queryMatches.length}/${items.length} items for S${sStr}E${eStr}`);
    } else if (!isTv) {
      const strictMatches = items.filter((item) => {
        for (const t of titleVariants) {
          if (movieTitleMatchesResult(item.title, t, movieYear)) return true;
        }
        return false;
      });
      const targetY = movieYear ? parseInt(movieYear, 10) : null;
      const yearMatches = targetY
        ? strictMatches.filter((item) => {
            const years = Array.from(extractReleaseYears(item.title));
            if (!years.length) return true;
            return years.some((y) => Math.abs(parseInt(y, 10) - targetY) <= 1);
          })
        : strictMatches;
      queryMatches = yearMatches.length ? yearMatches : strictMatches;
      console.log(`[MkvBase] movie filter kept ${queryMatches.length}/${items.length} items for '${effectiveTitle}' ${movieYear || ""}`.trim());
    } else {
      queryMatches = items;
    }

    for (const match of queryMatches) {
      if (!allMatchingItems.some((existing) => existing.url === match.url || existing.title === match.title)) {
        allMatchingItems.push(match);
      }
    }

    if (allMatchingItems.length >= 10) break;
  }

  matchingItems = allMatchingItems;
  if (!matchingItems.length) return [];
  // Keep only 1080p and above (1080p, 1440p/2k, 2160p/4k/UHD)
  const highQualityItems = matchingItems.filter((item) => isAtLeast1080pTitle(item.title));
  if (highQualityItems.length) {
    matchingItems = highQualityItems;
  }
  matchingItems = dedupeItemsByUrl(matchingItems);

  const streams = [];
  const seenUrls = new Set();
  let earlyDone = false;

  const candidatesToResolve = matchingItems.slice(0, MKVBASE_MAX_RESOLVE_ITEMS);
  const t2 = Date.now();

  // Batch pre-solve GDFlix candidates if multiple are present
  const uncachedGdflixUrls = candidatesToResolve
    .map((i) => i.url)
    .filter((u) => u && /gdflix\.(?:dev|io)\/file\//i.test(u) && !getCachedResolvedUrl(u))
    .slice(0, MKVBASE_MAX_RESOLVE_ITEMS);

  if (uncachedGdflixUrls.length > 0) {
    try {
      const solverResults = await fetchGdflixWithSolver(uncachedGdflixUrls, 35000);
      for (const gUrl of uncachedGdflixUrls) {
        const resObj = solverResults[gUrl];
        const readyCandidates = [];
        if (resObj && (resObj.hrefs || resObj.html)) {
          const baseUrl = resObj.baseUrl || gUrl;
          const linksToCheck = [];
          if (Array.isArray(resObj.hrefs)) {
            for (const h of resObj.hrefs) {
              try { linksToCheck.push(new URL(h, baseUrl).href); } catch (_) { linksToCheck.push(h); }
            }
          }
          if (resObj.html) {
            linksToCheck.push(...extractDownloadLinks(resObj.html, baseUrl));
          }
          for (const link of linksToCheck) {
            if (/workers\.dev|\.r2\.dev|r2\.cloudflarestorage\.com|pixeldrain\.(?:com|dev)/i.test(link)) {
              readyCandidates.push({ url: safeEncodeUrl(link), headers: null, title: "Cloudflare R2", size: resObj.size || "" });
            }
          }
        }
        setCachedResolvedUrl(gUrl, readyCandidates);
      }
    } catch (_) {}
  }

  // ── Resolve candidate → stream with early-exit when enough streams collected ──
  async function resolveOneItem(item, idx) {
    if (!item.url || earlyDone) return [];
    const itemStart = Date.now();

    const rawTitleText = item.title ? item.title.split("\n")[0] : info.title;
    const quality = normalizeQ(parseQuality(rawTitleText));
    if (qualityWeight(quality) < qualityWeight("1080p")) return [];
    const size = extractFileSize(rawTitleText);
    const itemStreams = [];

    // Check URL resolution cache
    let resolvedHostLinks = getCachedResolvedUrl(item.url);
    if (!resolvedHostLinks) {
      if (earlyDone) return [];
      try {
        if (item.url.includes("hubcloud") || item.url.includes("vcloud")) {
          resolvedHostLinks = await resolvePlayableCandidates(item.url, { maxDepth: 4, timeout: MKVBASE_HOST_RESOLVE_TIMEOUT_MS });
        } else if (isReadyForPlayback(item.url)) {
          resolvedHostLinks = [item.url];
        } else {
          resolvedHostLinks = await resolvePlayableCandidates(item.url, { maxDepth: 4, timeout: MKVBASE_HOST_RESOLVE_TIMEOUT_MS });
        }
      } catch (e) { resolvedHostLinks = []; }
      if (resolvedHostLinks.length) setCachedResolvedUrl(item.url, resolvedHostLinks);
    }

    for (const candidate of resolvedHostLinks || []) {
      if (earlyDone) break;
      const rUrl = getCandidateUrl(candidate);
      if (!rUrl) continue;
      const safeUrl = safeEncodeUrl(rUrl);
      const requestHeaders = getCandidateHeaders(candidate);
      if (MKVBASE_HEADERLESS_STREAMS_ONLY && requestHeaders) continue;
      const behaviorHints = { notWebReady: true };
      if (!await validateResolvedPlaybackUrl(safeUrl, requestHeaders || {})) continue;
      if (requestHeaders) behaviorHints.proxyHeaders = { request: requestHeaders };

      const candidateTitle = (typeof candidate === "object" && candidate.title) ? candidate.title : "";
      const candidateObjSize = (typeof candidate === "object" && candidate.size) ? candidate.size : "";
      let displaySize = candidateObjSize || extractFileSize(candidateTitle) || extractFileSize(rawTitleText) || extractFileSizeFromUrl(safeUrl) || extractFileSizeFromUrl(item.url) || size;

      if (!displaySize) {
        displaySize = await probeResolvedFileSize(safeUrl, requestHeaders || {});
      }

      const rawTitle = (item.title || info.title || "Release").replace(/\n+/g, " ").trim();
      const tags = parseReleaseDetails(rawTitle);
      const qLabel = formatQualityLabel(quality);
      const routeLabel = streamRouteLabel(item.url, safeUrl);
      const sizeTag = displaySize ? `[💾 ${displaySize}] ` : "";
      const sizeSuffix = displaySize ? ` • 💾 ${displaySize}` : "";

      const badgeSuffix = [
        tags.includes("REMUX") ? "REMUX" : "",
        tags.includes("DV") ? "DV" : "",
        tags.includes("HDR") || tags.includes("HDR10+") ? "HDR" : ""
      ].filter(Boolean).join(" ");

      const streamName = `[MkvBase] ${qLabel}${badgeSuffix ? " " + badgeSuffix : ""}`;
      const streamTitle = `[${routeLabel}] ${sizeTag}${rawTitle}\n${tags.length > 0 ? tags.join(" • ") : qLabel}${sizeSuffix}`;

      itemStreams.push({
        name: streamName,
        title: streamTitle,
        url: safeUrl,
        quality,
        size: displaySize,
        behaviorHints
      });
    }

    debugLog(`item[${idx}] resolved ${itemStreams.length} streams in ${Date.now() - itemStart}ms: ${item.url.slice(0, 60)}`);
    return itemStreams;
  }

  // Race-based parallel resolution: collect streams as they arrive, stop early
  const resolvePromises = candidatesToResolve.map((item, idx) => resolveOneItem(item, idx));
  const settled = await Promise.allSettled(resolvePromises);

  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const stream of result.value || []) {
      addUniqueResolvedStream(streams, seenUrls, stream);
    }
    if (streams.length >= MKVBASE_TARGET_STREAMS) { earlyDone = true; }
  }
  console.log(`[MkvBase] ⏱ Resolve phase: ${Date.now() - t2}ms (${streams.length} streams from ${candidatesToResolve.length} candidates)`);

  // Quality sorting: 4K (2160p) > 2K (1440p) > 1080p (FHD), then by fastest direct host
  streams.sort((a, b) => {
    const weights = { "2160p": 5, "1440p": 4, "1080p": 3, "720p": 2, "480p": 1, "HD": 1 };
    const wDiff = (weights[b.quality] || 0) - (weights[a.quality] || 0);
    if (wDiff !== 0) return wDiff;

    const hostPriority = (url) => {
      const u = (url || "").toLowerCase();
      if (u.includes("workers.dev") || u.includes("r2.dev") || u.includes("cloudflarestorage")) return 4;
      if (u.includes("pixeldrain.com")) return 3;
      if (u.includes("googleusercontent.com")) return 2;
      if (u.includes("gofile.io")) return 1;
      return 0;
    };
    return hostPriority(b.url) - hostPriority(a.url);
  });

  // Cache the results
  setCachedStreams(cacheKey, streams);
  console.log(`[MkvBase] ✅ Total: ${Date.now() - totalStart}ms → ${streams.length} streams for ${cacheKey}`);
  return streams;
}

// ── Automated Background Session Keep-Alive ──
async function ensureSessionFreshness() {
  const session = loadDirectSession();
  const sessionAgeMs = session ? Date.now() - Number(session.savedAt || 0) : Infinity;
  // If session is missing or older than 2.5 hours, refresh it in the background
  if (!session || sessionAgeMs > 2.5 * 60 * 60 * 1000) {
    console.log("[MkvBase] 🔄 Session expired or approaching expiry, refreshing in background...");
    const newSession = await bootstrapMkvBaseSession();
    if (newSession) {
      console.log("[MkvBase] ♻️  Background session refreshed successfully");
    } else {
      console.log("[MkvBase] ⚠️  Background session refresh failed, will retry on next check");
    }
  } else {
    console.log(`[MkvBase] ♻️  Session is active and fresh (age: ${(sessionAgeMs / 1000 / 60).toFixed(1)} min)`);
  }
}

// ── Startup check + Background Keep-Alive Timer (every 2 hours) ──
setImmediate(() => {
  ensureSessionFreshness();
  const timer = setInterval(() => {
    ensureSessionFreshness();
  }, 2 * 60 * 60 * 1000);
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
});

module.exports = { lookupIdType: "imdb", getStreams, resolveGdflix, fetchMkvBaseApi };
