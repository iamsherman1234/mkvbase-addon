"use strict";

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const LOCAL_URLS_FILE = path.join(__dirname, "..", "urls.json");
const DYNAMIC_URLS_SOURCE = process.env.URLS_JSON_URL || "https://raw.githubusercontent.com/iamsherman1234/sudoaddon/main/urls.json";
const REFRESH_INTERVAL_MS = Number(process.env.DOMAINS_REFRESH_INTERVAL_MS || 2 * 60 * 60 * 1000); // 2 hours

let cachedDomains = {
  mkvbase: "https://mkvbase.site",
  hubcloud: "https://hubcloud.cx",
  vcloud: "https://vcloud.fit"
};

function loadLocalUrls() {
  try {
    if (fs.existsSync(LOCAL_URLS_FILE)) {
      const data = JSON.parse(fs.readFileSync(LOCAL_URLS_FILE, "utf8"));
      if (data && typeof data === "object") {
        cachedDomains = { ...cachedDomains, ...data };
        return true;
      }
    }
  } catch (e) {
    console.warn(`[DynamicDomains] Failed to parse local urls.json: ${e.message}`);
  }
  return false;
}

async function refreshDynamicDomains() {
  loadLocalUrls();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(DYNAMIC_URLS_SOURCE, { signal: controller.signal });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === "object") {
        let updated = false;
        for (const [rawK, rawV] of Object.entries(data)) {
          const k = String(rawK || "").toLowerCase().trim();
          const v = String(rawV || "").trim().replace(/\/+$/, "");
          if (["mkvbase", "hubcloud", "vcloud"].includes(k) && v.startsWith("http") && cachedDomains[k] !== v) {
            cachedDomains[k] = v;
            updated = true;
          }
        }
        if (updated) {
          try {
            fs.writeFileSync(LOCAL_URLS_FILE, JSON.stringify(cachedDomains, null, 2), "utf8");
          } catch (_) {}
        }
      }
    }
  } catch (_) {}
  try {
    const { refreshPixeldrainProxies } = require("./pixeldrainHelper");
    refreshPixeldrainProxies().catch(() => {});
  } catch (_) {}
  return cachedDomains;
}

function getDomain(key, fallback = null) {
  const normKey = String(key || "").toLowerCase().trim();
  const val = cachedDomains[normKey];
  if (val && typeof val === "string" && val.trim().length > 0) {
    return val.replace(/\/+$/, "");
  }
  return fallback ? String(fallback).replace(/\/+$/, "") : "";
}

loadLocalUrls();
refreshDynamicDomains().catch(() => {});

const refreshTimer = setInterval(() => {
  refreshDynamicDomains().catch(() => {});
}, REFRESH_INTERVAL_MS);
if (refreshTimer && typeof refreshTimer.unref === "function") {
  refreshTimer.unref();
}

module.exports = { getDomain, refreshDynamicDomains, loadLocalUrls };
