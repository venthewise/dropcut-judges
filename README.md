# DropCut — Cut Sheet demo

Video editor? In this economy? Drop in your photos and a song, and DropCut finds the beat, animates each shot and captions it. You get a reel that's ready to post in minutes.

**Samples** play three reels the engine already rendered. **Real** takes 5 to 10 photos, a song, a reel length, and a one-line brief, renders each shot through ComfyUI Cloud, then stitches the reel in the browser.

The engine (ComfyUI + LTX workflow, render queue, beat-synced export) lives at **[venthewise/dropcut](https://github.com/venthewise/dropcut)**.

## How to run DropCut yourself (Comfy Cloud)

### Part 1: Set up Comfy Cloud (one time)

1. Sign up at [Comfy Cloud](https://cloud.comfy.org/) on a paid plan. The free plan can't be used by apps.
2. Create an API key in your Comfy account and keep it private.
3. Download [dropcut-judges](https://github.com/venthewise/dropcut-judges) (green **Code** button, then **Download ZIP**) and unzip it.
4. In [Comfy Cloud](https://platform.comfy.org/), log in and create a new deployment from the file `workflows/ltx-i2v.api.json` in that folder. That's DropCut's LTX-2.5 image-to-video workflow.
5. Copy the deployment's endpoint URL once it's running. If you haven't created an API key yet, create one on the same page after the deployment succeeds.

### Part 2: Run DropCut on your computer

1. Install [Node.js](https://nodejs.org/).
2. In the DropCut folder, make a copy of `.env.example` and rename it `.env`.
3. Open `.env` and paste in your API key next to `COMFY_CLOUD_API_KEY` and your endpoint URL next to `COMFY_DEPLOYMENT_ENDPOINT`. For `SESSION_SECRET`, replace the placeholder with any long random string.
4. Open a terminal in the folder and run `node scripts/add-judge.mjs judge1` to make your login. The password is saved in `judges-credentials.txt` and isn't shown on screen.
5. Run `npm start` and open [http://127.0.0.1:5180](http://127.0.0.1:5180/).
6. Sign in with `judge1` and the password from that file.

### Part 3: Make a reel

1. Choose **Real**, then add your photos (5 to 10, depending on the length).
2. Pick a reel length (5, 10, 15, 30 or 60 s) and a sample song or your own.
3. Set the caption style and press **Generate**. Each photo is animated on your Comfy deployment and paid from your credits, and the final reel is put together in your browser.

**Just looking?** Skip Part 1 and choose **Samples** to watch the café, gig and listing examples without generating anything.

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
