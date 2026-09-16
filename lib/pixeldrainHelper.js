"use strict";

const fetch = require("node-fetch");

const PROXY_JSON_URL = "https://pixeldrain-bypass.gamedrive.org/api/proxy.json";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

let proxyListCache = ["pixeldrain.dev", "pixeldrain.com"];
let lastFetchTime = 0;

function extractPixeldrainId(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const match = rawUrl.match(/(?:pixeldrain\.(?:com|dev|net|org|eu\.cc)|pixeldra\.in)\/(?:api\/file\/|u\/|l\/|d\/)?([a-zA-Z0-9_-]+)/i);
  if (match && match[1]) {
    const id = match[1];
    if (["dummy", "sample", "placeholder", "negn6f"].includes(id.toLowerCase())) {
      return null;
    }
    return id;
  }
  return null;
}

function normalizeProxyEntry(entry) {
  if (!entry || typeof entry !== "string") return null;
  entry = entry.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(entry)) {
    return entry.replace(/^https?:\/\//i, "");
  }
  return entry;
}

async function refreshPixeldrainProxies() {
  const now = Date.now();
  if (proxyListCache.length > 2 && (now - lastFetchTime < CACHE_TTL_MS)) {
    return proxyListCache;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(PROXY_JSON_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      let list = [];
      if (data && Array.isArray(data.proxies)) list = data.proxies;
      else if (data && typeof data.proxy === "string") list = [data.proxy];
      else if (Array.isArray(data)) list = data;

      const normalized = list.map(normalizeProxyEntry).filter(Boolean);
      const combined = Array.from(new Set(["pixeldrain.dev", "pixeldrain.com", ...normalized]));
      if (combined.length > 0) {
        proxyListCache = combined;
        lastFetchTime = now;
        return proxyListCache;
      }
    }
  } catch (_) {}

  return proxyListCache;
}

function getPixeldrainCandidateUrls(urlOrId) {
  const fileId = extractPixeldrainId(urlOrId) || urlOrId;
  if (!fileId || typeof fileId !== "string" || fileId.includes("/")) {
    return [];
  }

  const list = [];
  list.push(`https://cdn.pixeldrain.eu.cc/${fileId}`);
  list.push(`https://pixeldrain.dev/api/file/${fileId}?download`);
  list.push(`https://pixeldrain.com/api/file/${fileId}?download`);

  for (const h of proxyListCache) {
    if (h.includes("eu.cc")) {
      list.push(`https://${h}/${fileId}`);
    } else {
      list.push(`https://${h}/api/file/${fileId}?download`);
    }
  }

  return Array.from(new Set(list));
}

async function fetchPixeldrainWithFailover(initialUrl, fetchOptions = {}) {
  const fileId = extractPixeldrainId(initialUrl);
  const candidateUrls = fileId ? getPixeldrainCandidateUrls(fileId) : [initialUrl];

  let lastError = null;
  let lastResponse = null;

  for (const candidateUrl of candidateUrls) {
    try {
      const res = await fetch(candidateUrl, fetchOptions);
      if (res.status === 200 || res.status === 206) {
        return { res, url: candidateUrl };
      }
      lastResponse = res;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastResponse) {
    return { res: lastResponse, url: candidateUrls[0] };
  }
  throw (lastError || new Error("Failed to fetch Pixeldrain stream"));
}

// Initial background sync
refreshPixeldrainProxies().catch(() => {});

module.exports = {
  extractPixeldrainId,
  refreshPixeldrainProxies,
  getPixeldrainCandidateUrls,
  fetchPixeldrainWithFailover,
};
