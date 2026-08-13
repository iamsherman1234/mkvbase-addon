# MkvBase Stremio Addon

A standalone Stremio addon for finding and streaming movies and series from MkvBase.

## Installation

```bash
git clone <repository_url>
cd mkvbase-addon
npm install
```

## Running the Addon

```bash
npm start
```

## Environment Variables

The following environment variables can be configured:

- `PORT` - The port to run the addon on (default: `7099`)
- `FLARESOLVERR_URL` - URL to a FlareSolverr instance to bypass Cloudflare
- `MKVBASE_DEBUG` - Enable debug logging if set
- `MKVBASE_FLARESOLVERR_ENABLED` - Enable FlareSolverr usage (default: `true`)
- `CHROME_PATH` - Path to Google Chrome executable for puppeteer

## Installing in Stremio

Once the addon is running, you can install it in Stremio by entering the following URL in the Stremio search bar or addons page:

```
http://127.0.0.1:7099/manifest.json
```
