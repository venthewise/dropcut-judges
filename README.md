# DropCut — Cut Sheet demo

Five photos, one song, a 9:16 reel that hard-cuts on the beat. This is the judges' build: a login-gated cut sheet with sample reels and a real render path.

**Samples** play three reels the engine already rendered. **Real** takes 5 to 10 photos, a song, a reel length, and a one-line brief, renders each shot through ComfyUI Cloud, then stitches the reel in the browser.

The engine (ComfyUI + LTX workflow, render queue, beat-synced export) lives at **[venthewise/dropcut](https://github.com/venthewise/dropcut)**.

## Judges (local)

A login gate in front of this demo. The local server listens on 127.0.0.1:5180 only.

```bash
node scripts/add-judge.mjs judge1
npm start
```

Open http://127.0.0.1:5180 and sign in. `add-judge` writes the password to `judges-credentials.txt` and does not print it. `judges.json` stores the scrypt hash and salt. Both files are gitignored. Sessions are signed cookies (HMAC-SHA256) that last 8 hours.

Choose **Samples** for the café, gig, and listing presets. Choose **Real** to upload photos (jpg, png, or webp, up to 25 MB each), pick a reel length (5, 10, 15, 30 or 60 s), use a sample song or your own audio, and generate. Photos over 3.5 MB are resized in the browser before upload. Songs never leave the browser; the reel is stitched locally with ffmpeg.wasm.

The renderer reads `COMFY_CLOUD_API_KEY` and `COMFY_DEPLOYMENT_ENDPOINT` from the environment or `.env`. If either is missing, or the deployment returns an error, the page says the renderer is offline and Samples still play.

## Deploy to Vercel

Import the repo in Vercel:

- Framework Preset: **Other**
- Root Directory: `./` (repo root)
- Build Command: leave empty (no build). Output Directory: leave empty (repo root is served as static files)
- Install Command: `npm install` (only installs `@vercel/functions` for the middleware)

`middleware.js` gates every request with the session cookie. `/login` and `/logout` are rewritten to `api/login.mjs` and `api/logout.mjs`; `/` is served by `api/page.mjs` with the judge name filled in. App files and `/media` return 401 when signed out; `/vendor` (ffmpeg.wasm and the Anton font) is public static.

### Environment variables

| Name | Value |
| --- | --- |
| `COMFY_CLOUD_API_KEY` | Comfy Cloud API key |
| `COMFY_DEPLOYMENT_ENDPOINT` | Comfy deployment endpoint URL |
| `SESSION_SECRET` | 32+ random characters: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `JUDGE_ACCOUNTS` | Output of `node scripts/add-judge.mjs --env` (JSON of scrypt hashes, no passwords) |

See `.env.example`. Changing `SESSION_SECRET` signs everyone out.

### Add a judge

```bash
node scripts/add-judge.mjs judge2      # password goes to judges-credentials.txt
node scripts/add-judge.mjs --env       # prints the new JUDGE_ACCOUNTS value
```

Paste the printed value into `JUDGE_ACCOUNTS` in Vercel and redeploy.

### Limits

- Vercel functions accept request bodies up to 4.5 MB, so photos are resized in the browser to fit under 3.5 MB.
- Login rate limiting and logout revocation are per function instance (best effort). Logging out always clears the cookie.
- The browser polls render status every 2 s, so no function stays open for a whole render.

## License

MIT © venthewise
