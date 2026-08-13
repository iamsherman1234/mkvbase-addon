const crypto = require("crypto");
const express = require("express");
const fetch = require("node-fetch");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const mkvbase = require("./providers/mkvbase");

const STREAM_CACHE_TTL_MS = Number(process.env.STREAM_CACHE_TTL_MS || 20 * 60 * 1000);
const STREAM_STALE_CACHE_TTL_MS = Number(process.env.STREAM_STALE_CACHE_TTL_MS || 2 * 60 * 60 * 1000);
const STREAM_RESOLVE_CONCURRENCY = Number(process.env.STREAM_RESOLVE_CONCURRENCY || 2);
const STREAM_QUEUE_TIMEOUT_MS = Number(process.env.STREAM_QUEUE_TIMEOUT_MS || 25000);
const STREAM_EMPTY_CACHE_TTL_MS = Number(process.env.STREAM_EMPTY_CACHE_TTL_MS || 2 * 60 * 1000);
const STREAM_CACHE_MAX_ENTRIES = Number(process.env.STREAM_CACHE_MAX_ENTRIES || 500);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://mkvbase.sudoaddon.dpdns.org").replace(/\/$/, "");
const PROXY_TARGET_TTL_MS = Number(process.env.PROXY_TARGET_TTL_MS || STREAM_STALE_CACHE_TTL_MS);
const STREAM_PROXY_ENABLED = process.env.STREAM_PROXY_ENABLED === "1";
const streamCache = new Map();
const pendingStreams = new Map();
const resolveQueue = [];
const proxyTargets = new Map();
let activeResolves = 0;

function getCachedStreams(key) {
  const entry = streamCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return null;
  return entry.streams;
}

function getStaleStreams(key) {
  const entry = streamCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.staleExpiresAt) {
    streamCache.delete(key);
    return null;
  }
  return entry.streams;
}

function setCachedStreams(key, streams) {
  const now = Date.now();
  const hasStreams = Array.isArray(streams) && streams.length > 0;
  streamCache.set(key, {
    streams,
    expiresAt: now + (hasStreams ? STREAM_CACHE_TTL_MS : STREAM_EMPTY_CACHE_TTL_MS),
    staleExpiresAt: now + (hasStreams ? STREAM_STALE_CACHE_TTL_MS : STREAM_EMPTY_CACHE_TTL_MS)
  });
  while (streamCache.size > STREAM_CACHE_MAX_ENTRIES) {
    streamCache.delete(streamCache.keys().next().value);
  }
  return streams;
}

function pumpResolveQueue() {
  while (activeResolves < STREAM_RESOLVE_CONCURRENCY && resolveQueue.length) {
    const job = resolveQueue.shift();
    if (job.timeout) clearTimeout(job.timeout);
    activeResolves++;
    Promise.resolve()
      .then(job.run)
      .then(job.resolve, job.reject)
      .finally(() => {
        activeResolves--;
        pumpResolveQueue();
      });
  }
}

function runQueuedResolve(run) {
  return new Promise((resolve, reject) => {
    const job = { run, resolve, reject, timeout: null };
    job.timeout = setTimeout(() => {
      const index = resolveQueue.indexOf(job);
      if (index >= 0) {
        resolveQueue.splice(index, 1);
        reject(new Error("stream resolver queue timeout"));
      }
    }, STREAM_QUEUE_TIMEOUT_MS);
    resolveQueue.push(job);
    pumpResolveQueue();
  });
}

function proxyIdFor(url, headers) {
  return crypto.createHash("sha256").update(JSON.stringify({ url, headers })).digest("base64url").slice(0, 32);
}

function setProxyTarget(url, headers) {
  const id = proxyIdFor(url, headers || {});
  proxyTargets.set(id, { url, headers: headers || {}, expiresAt: Date.now() + PROXY_TARGET_TTL_MS });
  return id;
}

function getProxyTarget(id) {
  const target = proxyTargets.get(id);
  if (!target) return null;
  if (Date.now() > target.expiresAt) {
    proxyTargets.delete(id);
    return null;
  }
  return target;
}

function toClientStream(stream) {
  const requestHeaders = stream && stream.behaviorHints && stream.behaviorHints.proxyHeaders && stream.behaviorHints.proxyHeaders.request;
  if (!STREAM_PROXY_ENABLED || !requestHeaders || !stream.url) {
    return {
      name: stream.name,
      title: stream.title,
      url: stream.url,
      behaviorHints: stream.behaviorHints
    };
  }

  const proxyId = setProxyTarget(stream.url, requestHeaders);
  return {
    name: stream.name,
    title: `${stream.title} • Proxy`,
    url: `${PUBLIC_BASE_URL}/proxy/${proxyId}`,
    behaviorHints: { notWebReady: true }
  };
}

const manifest = {
  id: "community.mkvbase",
  version: "1.0.0",
  name: "MkvBase",
  description: "Search and stream from MkvBase",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"]
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async (args) => {
  const { id, type } = args;
  const parts = id.split(":");
  const imdbId = parts[0];
  let season = null;
  let episode = null;

  if (type === "series" && parts.length >= 3) {
    season = parseInt(parts[1], 10);
    episode = parseInt(parts[2], 10);
  }

  const cacheKey = [type, id].join(":");
  const cachedStreams = getCachedStreams(cacheKey);
  if (cachedStreams) return { streams: cachedStreams, cacheMaxAge: 0 };

  try {
    if (pendingStreams.has(cacheKey)) {
      const staleStreams = getStaleStreams(cacheKey);
      if (staleStreams) return { streams: staleStreams, cacheMaxAge: 0 };
      return { streams: await pendingStreams.get(cacheKey), cacheMaxAge: 0 };
    }

    const pending = runQueuedResolve(() => mkvbase.getStreams(imdbId, type, season, episode))
      .then(streams => setCachedStreams(cacheKey, streams.map(toClientStream)))
      .finally(() => pendingStreams.delete(cacheKey));

    pendingStreams.set(cacheKey, pending);

    const staleStreams = getStaleStreams(cacheKey);
    if (staleStreams) {
      pending.catch(error => console.error("Background stream refresh failed:", error));
      return { streams: staleStreams, cacheMaxAge: 0 };
    }

    return { streams: await pending, cacheMaxAge: 0 };
  } catch (error) {
    console.error("Error fetching streams from MkvBase:", error);
    return { streams: [], cacheMaxAge: 0 };
  }
});

const app = express();

app.get("/proxy/:id", async (req, res) => {
  const target = getProxyTarget(req.params.id);
  if (!target) {
    res.status(404).end("proxy target expired");
    return;
  }

  try {
    const upstreamHeaders = {
      ...target.headers,
      Range: req.headers.range || target.headers.Range || "bytes=0-"
    };
    const upstream = await fetch(target.url, { headers: upstreamHeaders });
    res.status(upstream.status);
    for (const [name, value] of upstream.headers.entries()) {
      if (["content-length", "content-type", "content-range", "accept-ranges"].includes(name.toLowerCase())) {
        res.setHeader(name, value);
      }
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    upstream.body.pipe(res);
  } catch (error) {
    console.error("Proxy stream failed:", error);
    res.status(502).end("proxy stream failed");
  }
});

app.use(getRouter(builder.getInterface()));
app.get("/", (_, res) => res.redirect("/manifest.json"));

const PORT = process.env.PORT || 7099;
app.listen(PORT, () => {
  console.log(`MkvBase Addon is running at http://127.0.0.1:${PORT}`);
  console.log(`HTTP addon accessible at: http://127.0.0.1:${PORT}/manifest.json`);
});
