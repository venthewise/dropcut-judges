export const OFFLINE_MESSAGE = "Renderer is offline";
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
// Vercel functions reject request bodies over 4.5 MB; the browser downsizes photos before upload.
export const MAX_HOSTED_UPLOAD_BYTES = Math.floor(4.4 * 1024 * 1024);

export function uploadLimit() {
  return process.env.VERCEL ? MAX_HOSTED_UPLOAD_BYTES : MAX_PHOTO_BYTES;
}

export function sendJson(res, status, body, extra = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(buf.length),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
  if (res.req?.method === "HEAD") res.end();
  else res.end(buf);
}

export function sendOffline(res, status = 503) {
  sendJson(res, status, { error: OFFLINE_MESSAGE });
}

export function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const ok = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

export function readJson(req, limit = 65536) {
  return readRaw(req, limit).then((buf) => JSON.parse(buf.toString("utf8")));
}
