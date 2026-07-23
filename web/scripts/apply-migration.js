// Supabase Management APIでweb/supabase/migrations/配下のSQLファイルを直接実行する。
// supabase CLIが未インストールの開発環境向けの代替手段。
// 使い方: node scripts/apply-migration.js <ファイル名>  (web/ディレクトリから実行)
const fs = require("fs");
const path = require("path");
const https = require("https");

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/apply-migration.js <migration filename>");
  process.exit(1);
}

const envPath = path.join(__dirname, "..", "..", ".env");
const env = fs.readFileSync(envPath, "utf8");
const token = env.match(/SUPABASE_ACCESS_TOKEN=(.*)/)?.[1]?.trim();
const supaUrl = env.match(/SUPABASE_URL=(.*)/)?.[1]?.trim();
if (!token) throw new Error("SUPABASE_ACCESS_TOKEN not found (repo-root .env, not web/.env)");
if (!supaUrl) throw new Error("SUPABASE_URL not found");
const ref = new URL(supaUrl).hostname.split(".")[0];

const sqlPath = path.join(__dirname, "..", "supabase", "migrations", file);
const sql = fs.readFileSync(sqlPath, "utf8");

function req(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL("https://api.supabase.com" + apiPath);
    const data = JSON.stringify(body);
    const r = https.request(
      u,
      { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    r.on("error", reject);
    r.write(data);
    r.end();
  });
}

req("POST", `/v1/projects/${ref}/database/query`, { query: sql }).then((res) => {
  console.log(`[${file}] status:`, res.status);
  console.log(res.body);
  if (res.status >= 300) process.exit(1);
});
