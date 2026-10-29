import fs from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const JUDGES_PATH = path.join(ROOT, "judges.json");
export const CREDENTIALS_PATH = path.join(ROOT, "judges-credentials.txt");
export const USERNAME_RE = /^[A-Za-z0-9._-]{1,32}$/;

const KEYLEN = 64;
const SCRYPT_OPTS = {
  cost: 16384,
  blockSize: 8,
  parallelization: 1,
  maxmem: 64 * 1024 * 1024,
};

// Stand-in digest so a missing account still runs scrypt and timingSafeEqual.
const DUMMY_SALT = randomBytes(16);
const DUMMY_HASH = scryptSync(randomBytes(32), DUMMY_SALT, KEYLEN, SCRYPT_OPTS);

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, SCRYPT_OPTS);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

export function passwordMatches(password, record) {
  const saltHex = record && typeof record.salt === "string" ? record.salt : "";
  const hashHex = record && typeof record.hash === "string" ? record.hash : "";
  const wellFormed = /^[0-9a-f]{32}$/.test(saltHex) && /^[0-9a-f]{128}$/.test(hashHex);
  const salt = wellFormed ? Buffer.from(saltHex, "hex") : DUMMY_SALT;
  const expected = wellFormed ? Buffer.from(hashHex, "hex") : DUMMY_HASH;
  const actual = scryptSync(String(password), salt, KEYLEN, SCRYPT_OPTS);
  return wellFormed && timingSafeEqual(actual, expected);
}

// Accounts come from the JUDGE_ACCOUNTS env var when set (Vercel), else from judges.json (local).
// JUDGE_ACCOUNTS holds the same JSON as judges.json: {"judge1":{"salt":"…","hash":"…"}}, raw or base64.
export const ACCOUNTS_ENV = "JUDGE_ACCOUNTS";

export function parseJudges(text, label = "judges.json") {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} could not be read`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object of accounts`);
  }
  const out = Object.create(null);
  for (const [name, rec] of Object.entries(parsed)) {
    if (!USERNAME_RE.test(name) || !rec || typeof rec !== "object") continue;
    if (typeof rec.salt !== "string" || typeof rec.hash !== "string") continue;
    out[name] = { salt: rec.salt, hash: rec.hash };
  }
  return out;
}

export function loadJudges(env = process.env) {
  const fromEnv = String(env[ACCOUNTS_ENV] || "").trim();
  if (fromEnv) {
    const text = fromEnv.startsWith("{") ? fromEnv : Buffer.from(fromEnv, "base64").toString("utf8");
    return parseJudges(text, ACCOUNTS_ENV);
  }
  return loadJudgesFile();
}

export function loadJudgesFile() {
  if (!fs.existsSync(JUDGES_PATH)) return Object.create(null);
  return parseJudges(fs.readFileSync(JUDGES_PATH, "utf8"));
}

export function saveJudge(username, salt, hash) {
  if (!USERNAME_RE.test(username)) throw new Error("Invalid username");
  if (!/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{128}$/.test(hash)) {
    throw new Error("Refusing to store a non-hash value");
  }
  const all = loadJudgesFile();
  all[username] = { salt, hash };
  const body = JSON.stringify({ ...all }, null, 2) + "\n";
  fs.writeFileSync(JUDGES_PATH, body, { encoding: "utf8", mode: 0o600 });
}

export function appendCredentials(username, password) {
  if (!USERNAME_RE.test(username)) throw new Error("Invalid username");
  if (typeof password !== "string" || password.length < 20 || /[\r\n\t]/.test(password)) {
    throw new Error("Refusing to store a weak password");
  }
  const line = `${username}\t${password}\n`;
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    const header = "# Local judge passwords. Do not commit.\n";
    fs.writeFileSync(CREDENTIALS_PATH, header + line, { encoding: "utf8", mode: 0o600 });
    return;
  }
  fs.appendFileSync(CREDENTIALS_PATH, line, { encoding: "utf8" });
}

export function generatePassword() {
  let password = "";
  do {
    password = randomBytes(24).toString("base64url");
  } while (/^[0-9a-f]+$/.test(password));
  return password;
}
