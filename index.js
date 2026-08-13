const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const mkvbase = require("./providers/mkvbase");

const STREAM_CACHE_TTL_MS = Number(process.env.STREAM_CACHE_TTL_MS || 20 * 60 * 1000);
const streamCache = new Map();
const pendingStreams = new Map();

function getCachedStreams(key) {
  const entry = streamCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    streamCache.delete(key);
    return null;
  }
  return entry.streams;
}

function setCachedStreams(key, streams) {
  streamCache.set(key, { streams, expiresAt: Date.now() + STREAM_CACHE_TTL_MS });
  return streams;
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
      return { streams: await pendingStreams.get(cacheKey) };
    }

    const pending = mkvbase.getStreams(imdbId, type, season, episode)
      .then(streams => setCachedStreams(cacheKey, streams.map(s => ({
        name: s.name,
        title: s.title,
        url: s.url,
        behaviorHints: s.behaviorHints
      }))))
      .finally(() => pendingStreams.delete(cacheKey));

    pendingStreams.set(cacheKey, pending);
    return { streams: await pending };
  } catch (error) {
    console.error("Error fetching streams from MkvBase:", error);
    return { streams: [] };
  }
});

const PORT = process.env.PORT || 7099;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`MkvBase Addon is running at http://127.0.0.1:${PORT}`);
