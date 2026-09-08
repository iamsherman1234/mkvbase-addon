"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_SAVE_PATH = path.join(__dirname, "../.mkvbase_profile/session.json");
const SAVE_PATH = process.argv[2] || DEFAULT_SAVE_PATH;
const TARGET_URL = process.env.MKVBASE_URL || "https://mkvbase.site/";

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

function encodeQuery(query, timestamp) {
  if (!query) return "";
  const key = timestamp % 256;
  let encoded = "";
  for (let i = 0; i < query.length; i++) {
    encoded += (query.charCodeAt(i) ^ key).toString(16).padStart(2, "0");
  }
  return encoded;
}

function generateSignature(clientKey, message) {
  return crypto.createHmac("sha256", clientKey).update(message, "utf8").digest("hex");
}

async function testSearch(session, testQuery = "Avatar") {
  const parts = String(session.challenge || "").split(":");
  const challengePrefix = parts[0];
  const difficulty = parts[1] ? parseInt(parts[1], 10) : 2;
  const timestamp = Date.now();
  const encodedQ = encodeQuery(testQuery, timestamp);
  const nonce = solvePow(challengePrefix, difficulty, encodedQ);
  const ent = 10;
  const seq = session.seq || "1";
  const payloadStr = `${encodedQ}:${timestamp}:${seq}:${nonce}:${ent}`;
  const sig = generateSignature(session.clientKey, payloadStr);

  const searchUrl = `${TARGET_URL.replace(/\/+$/, "")}/api/links?q=${encodeURIComponent(encodedQ)}&t=${timestamp}&seq=${seq}&pow=${nonce}&ent=${ent}&sig=${sig}`;
  console.log(`[MkvBase Test] Verifying session with query '${testQuery}'...`);

  const res = await fetch(searchUrl, {
    headers: {
      "User-Agent": session.userAgent,
      "Cookie": session.cookieHeader,
      "Referer": TARGET_URL,
      "Accept": "application/json, text/plain, */*"
    }
  });

  if (!res.ok) {
    throw new Error(`Search validation failed with HTTP ${res.status}`);
  }

  const data = await res.json();
  const resultsCount = Array.isArray(data) ? data.length : (data && data.results && data.results.length) || 0;
  console.log(`[MkvBase Test] ✅ Validation successful! Found ${resultsCount} streams for "${testQuery}".`);
  return true;
}

async function run() {
  const { connect } = require("puppeteer-real-browser");
  const started = Date.now();
  console.log(`[MkvBase Solver] Launching on-demand browser for ${TARGET_URL}...`);

  let browserInstance = null;
  try {
    const { page, browser } = await connect({
      headless: false,
      turnstile: true,
      connectOption: { defaultViewport: { width: 1280, height: 800 } }
    });
    browserInstance = browser;

    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 35000 });

    let validSession = null;
    const deadline = Date.now() + 35000;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const cookies = await page.cookies();
      const cookieMap = {};
      for (const c of cookies) {
        cookieMap[c.name] = c.value;
      }

      if (cookieMap.mkv_client_key && cookieMap.mkv_challenge) {
        const userAgent = await page.evaluate(() => navigator.userAgent);
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        const decodedChallenge = decodeURIComponent(cookieMap.mkv_challenge || "");

        validSession = {
          cookieHeader,
          userAgent,
          clientKey: cookieMap.mkv_client_key,
          challenge: decodedChallenge,
          seq: cookieMap.mkv_seq || "1",
          savedAt: Date.now()
        };
        break;
      }
    }

    if (!validSession) {
      throw new Error("Timeout waiting for mkv_client_key and mkv_challenge cookies");
    }

    console.log(`[MkvBase Solver] ✅ Turnstile solved in ${Date.now() - started}ms!`);
    await testSearch(validSession, "Avatar");

    fs.mkdirSync(path.dirname(SAVE_PATH), { recursive: true });
    fs.writeFileSync(SAVE_PATH, JSON.stringify(validSession, null, 2), "utf8");
    console.log(`[MkvBase Solver] 💾 Saved active session to ${SAVE_PATH}`);

  } finally {
    try {
      if (browserInstance) {
        await browserInstance.close().catch(() => {});
      }
    } catch (_) {}
    try {
      const { execSync } = require("child_process");
      execSync("pkill -9 -f /usr/lib/chromium 2>/dev/null || true");
      execSync("pkill -9 -f '/tmp/lighthouse' 2>/dev/null || true");
      execSync("pkill -9 -f chrome_crashpad_handler 2>/dev/null || true");
      execSync("rm -rf /tmp/lighthouse.* 2>/dev/null || true");
    } catch (_) {}
  }
}

run()
  .then(() => {
    console.log("=== MkvBase Solve Completed Successfully ===");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ MkvBase Solve Error:", err.message);
    process.exit(1);
  });
