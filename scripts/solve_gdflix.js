const { connect } = require("puppeteer-real-browser");

async function main() {
  const args = process.argv.slice(2);
  const rawUrls = args.filter(a => a.startsWith("http"));
  if (rawUrls.length === 0) {
    const out = JSON.stringify({ ok: false, error: "No URLs provided", results: {} });
    process.stdout.write(out + "\n", () => process.exit(1));
    return;
  }

  let browserInstance = null;
  const results = {};
  let finalDomain = "";
  try {
    const { browser, page } = await connect({
      headless: "auto",
      turnstile: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process"
      ]
    });
    browserInstance = browser;

    const firstUrl = rawUrls[0];
    await page.goto(firstUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    finalDomain = new URL(page.url()).origin;

    for (const u of rawUrls) {
      const parsed = new URL(u);
      const pathname = parsed.pathname;
      try {
        const pageInfo = await page.evaluate(async (path) => {
          try {
            const res = await fetch(path);
            if (!res.ok) return { ok: false, status: res.status };
            const html = await res.text();

            // Extract file size
            const sizeMatch = html.match(/Size\s*:\s*([0-9.]+\s*[GMK]B)/i);
            const size = sizeMatch ? sizeMatch[1].replace(/\s+/g, " ").trim() : "";

            // Extract all link targets
            const hrefs = [];
            const regex = /href=["']([^"']+)["']/gi;
            let m;
            while ((m = regex.exec(html)) !== null) {
              hrefs.push(m[1]);
            }

            return {
              ok: true,
              size,
              hrefs
            };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        }, pathname);

        if (pageInfo && pageInfo.ok) {
          results[u] = {
            size: pageInfo.size || "",
            hrefs: pageInfo.hrefs || [],
            baseUrl: finalDomain
          };
        }
      } catch (e) {
        results[u] = { error: e.message };
      }
    }
  } catch (err) {
    results._error = err.message;
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

    const outputPayload = JSON.stringify({
      ok: Object.keys(results).some(k => !k.startsWith("_")),
      domain: finalDomain,
      results
    });

    process.stdout.write(outputPayload + "\n", () => {
      setTimeout(() => process.exit(0), 50);
    });
  }
}

main();
