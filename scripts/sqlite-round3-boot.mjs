import { spawn } from "child_process";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "xj-boot-"));
const dbFile = join(dir, "xuanji.db");
const uploadDir = join(dir, "uploads");
const backupDir = join(dir, "backups");
const jwtFile = join(dir, ".jwt-secret");
writeFileSync(jwtFile, "x".repeat(64), { mode: 0o600 });

const env = {
  ...process.env,
  SQLITE_PATH: dbFile,
  UPLOAD_DIR: uploadDir,
  BACKUP_TEMP_DIR: backupDir,
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "x".repeat(40),
  JWT_SECRET: "x".repeat(64),
  EGRESS_ALLOW_PRIVATE_NET: "true",
};

const child = spawn(process.execPath, ["--import", "tsx/esm", "api/boot.ts"], {
  env, cwd: process.cwd(), stdio: "pipe",
});

let stdout = "", stderr = "";
child.stdout.on("data", (d) => stdout += d);
child.stderr.on("data", (d) => stderr += d);
const timer = setTimeout(() => { child.kill("SIGTERM"); }, 5000);
child.on("exit", (code, sig) => {
  clearTimeout(timer);
  console.log("exit code:", code, "signal:", sig);
  console.log("STDOUT:", stdout.slice(0, 2000));
  console.log("STDERR:", stderr.slice(0, 3000));
  try { console.log("db file size:", readFileSync(dbFile).byteLength, "bytes"); } catch (e) { console.log("db err:", e?.message); }
  rmSync(dir, { recursive: true, force: true });
});
