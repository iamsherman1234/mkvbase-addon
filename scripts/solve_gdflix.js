const { connect } = require("puppeteer-real-browser");

async function main() {
  const args = process.argv.slice(2);
  const rawUrls = args.filter(a => a.startsWith("http"));
  if (rawUrls.length === 0) {
    console.log(JSON.stringify({ ok: false, error: "No URLs provided", results: {} }));
    process.exit(1);
  }

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

  const results = {};

  try {
    const firstUrl = rawUrls[0];
    await page.goto(firstUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    const domain = new URL(page.url()).origin;

    for (const u of rawUrls) {
      const parsed = new URL(u);
      const pathname = parsed.pathname;
      try {
        const pageInfo = await page.evaluate(async (path) => {
          try {
            const res = await fetch(path);
            if (!res.ok) return { ok: false, status: res.status };
            const html = await res.text();
            return {
              ok: true,
              length: html.length,
              html: html
            };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        }, pathname);

        if (pageInfo && pageInfo.ok && pageInfo.html) {
          results[u] = { html: pageInfo.html, baseUrl: domain };
        }
      } catch (e) {
        results[u] = { error: e.message };
      }
    }

    console.log(JSON.stringify({ ok: true, domain, results }));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message, results }));
  } finally {
    await browser.close();
    process.exit(0);
  }
}

main();
