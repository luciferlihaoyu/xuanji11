import mysql from 'mysql2/promise';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[MigrateBackupJobs] DATABASE_URL is not set');
  process.exit(1);
}

const columns = [
  { name: 'config', def: 'json DEFAULT NULL' },
  { name: 'cron', def: 'varchar(100) DEFAULT NULL' },
  { name: 'enabled', def: "enum('true','false') DEFAULT 'false' NOT NULL" },
  { name: 'nextRunAt', def: 'timestamp NULL DEFAULT NULL' },
  { name: 'keepLastN', def: 'int DEFAULT 7' },
  { name: 'maxRetries', def: 'int DEFAULT 3' },
  { name: 'retryCount', def: 'int DEFAULT 0' },
];

async function main() {
  const conn = await mysql.createConnection(url);
  try {
    for (const { name, def } of columns) {
      try {
        await conn.execute(`ALTER TABLE backup_jobs ADD COLUMN ${name} ${def}`);
        console.log(`[MigrateBackupJobs] Added column ${name}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('Duplicate column')) {
          console.log(`[MigrateBackupJobs] Column ${name} already exists`);
        } else {
          throw err;
        }
      }
    }
    console.log('[MigrateBackupJobs] Done');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('[MigrateBackupJobs] Failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
