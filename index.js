const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const mkvbase = require("./providers/mkvbase");

const STREAM_CACHE_TTL_MS = Number(process.env.STREAM_CACHE_TTL_MS || 20 * 60 * 1000);
const STREAM_STALE_CACHE_TTL_MS = Number(process.env.STREAM_STALE_CACHE_TTL_MS || 2 * 60 * 60 * 1000);
const STREAM_RESOLVE_CONCURRENCY = Number(process.env.STREAM_RESOLVE_CONCURRENCY || 2);
const STREAM_QUEUE_TIMEOUT_MS = Number(process.env.STREAM_QUEUE_TIMEOUT_MS || 25000);
const STREAM_EMPTY_CACHE_TTL_MS = Number(process.env.STREAM_EMPTY_CACHE_TTL_MS || 2 * 60 * 1000);
const STREAM_CACHE_MAX_ENTRIES = Number(process.env.STREAM_CACHE_MAX_ENTRIES || 500);
const streamCache = new Map();
const pendingStreams = new Map();
const resolveQueue = [];
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
  if (cachedStreams) return { streams: cachedStreams };

  try {
    if (pendingStreams.has(cacheKey)) {
      const staleStreams = getStaleStreams(cacheKey);
      if (staleStreams) return { streams: staleStreams };
      return { streams: await pendingStreams.get(cacheKey) };
    }

    const pending = runQueuedResolve(() => mkvbase.getStreams(imdbId, type, season, episode))
      .then(streams => setCachedStreams(cacheKey, streams.map(s => ({
        name: s.name,
        title: s.title,
        url: s.url,
        behaviorHints: s.behaviorHints
      }))))
      .finally(() => pendingStreams.delete(cacheKey));

    pendingStreams.set(cacheKey, pending);

    const staleStreams = getStaleStreams(cacheKey);
    if (staleStreams) {
      pending.catch(error => console.error("Background stream refresh failed:", error));
      return { streams: staleStreams };
    }

    return { streams: await pending };
  } catch (error) {
    console.error("Error fetching streams from MkvBase:", error);
    return { streams: [] };
  }
});

const PORT = process.env.PORT || 7099;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`MkvBase Addon is running at http://127.0.0.1:${PORT}`);
