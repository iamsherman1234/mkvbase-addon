const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const mkvbase = require("./providers/mkvbase");

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

  try {
    const streams = await mkvbase.getStreams(imdbId, type, season, episode);
    
    return { 
      streams: streams.map(s => ({
        name: s.name,
        title: s.title,
        url: s.url,
        behaviorHints: s.behaviorHints
      }))
    };
  } catch (error) {
    console.error("Error fetching streams from MkvBase:", error);
    return { streams: [] };
  }
});

const PORT = process.env.PORT || 7099;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`MkvBase Addon is running at http://127.0.0.1:${PORT}`);
