import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const sqlitePath = process.env.SQLITE_PATH ?? "/data/app/xuanji.db";
process.env.SQLITE_PATH = sqlitePath; // ensure child processes (push/migrate) see the same value

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: sqlitePath,
  },
});
