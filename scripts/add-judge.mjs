#!/usr/bin/env node
import {
  ACCOUNTS_ENV,
  USERNAME_RE,
  appendCredentials,
  generatePassword,
  hashPassword,
  loadJudgesFile,
  saveJudge,
} from "../lib/accounts.mjs";

// node scripts/add-judge.mjs <username>   add a judge (password goes to judges-credentials.txt, never printed)
// node scripts/add-judge.mjs --env        print the JUDGE_ACCOUNTS value (hashes only) for Vercel
const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--env") {
  const all = loadJudgesFile();
  if (!Object.keys(all).length) {
    console.error("No judges in judges.json. Add one first: node scripts/add-judge.mjs <username>");
    process.exit(1);
  }
  console.error(`Paste this as the ${ACCOUNTS_ENV} env var (scrypt hashes only, no passwords):`);
  console.log(JSON.stringify({ ...all }));
  process.exit(0);
}

const username = args[0];
if (args.length !== 1 || !USERNAME_RE.test(username || "")) {
  console.error("Usage: node scripts/add-judge.mjs <username>");
  console.error("       node scripts/add-judge.mjs --env");
  console.error("Username: 1-32 characters, letters, digits, dot, underscore or hyphen.");
  process.exit(1);
}

try {
  const password = generatePassword();
  const { salt, hash } = hashPassword(password);
  saveJudge(username, salt, hash);
  appendCredentials(username, password);
} catch {
  console.error("Could not add the judge.");
  process.exit(1);
}

console.log(`Added ${username}. Wrote credentials to judges-credentials.txt.`);
console.log(`For Vercel, run: node scripts/add-judge.mjs --env  and update ${ACCOUNTS_ENV}.`);
