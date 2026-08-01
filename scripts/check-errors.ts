import Database from "better-sqlite3";
import { join } from "node:path";

const dataDir = join(import.meta.dirname ?? ".", "..", "data");

// Check aiworker.db for sessions and messages
try {
  const sessionDb = new Database(join(dataDir, "aiworker.db"), { readonly: true });
  const tables = sessionDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  console.log("=== aiworker.db tables ===");
  console.log(tables.map((t) => t.name).join(", "));

  // Check sessions table
  const sessions = sessionDb.prepare("SELECT * FROM sqlite_master WHERE type='table' AND name LIKE '%session%'").all();
  if (sessions.length > 0) {
    const rows = sessionDb.prepare("SELECT id, created_at, updated_at, title FROM sessions ORDER BY updated_at DESC LIMIT 10").all() as any[];
    console.log("\n=== Recent sessions ===");
    rows.forEach((r: any) => console.log(JSON.stringify(r, null, 2)));
  }

  // Check messages
  const msgs = sessionDb.prepare("SELECT * FROM sqlite_master WHERE type='table' AND name LIKE '%message%'").all();
  if (msgs.length > 0) {
    const rows = sessionDb.prepare("SELECT role, substr(content,1,200) as preview, created_at FROM messages ORDER BY created_at DESC LIMIT 20").all() as any[];
    console.log("\n=== Recent messages ===");
    rows.forEach((r: any) => console.log(JSON.stringify(r, null, 2)));
  }

  // Check for any errors in session data
  const allTables = tables.map((t) => t.name);
  for (const t of allTables) {
    try {
      const cols = sessionDb.prepare(`PRAGMA table_info(${t})`).all() as any[];
      const colNames = cols.map((c: any) => c.name);
      if (colNames.includes("error") || colNames.includes("status") || t.includes("error")) {
        console.log(`\n=== Table: ${t} (error/status related) ===`);
        const rows = sessionDb.prepare(`SELECT * FROM ${t} LIMIT 20`).all();
        rows.forEach((r: any) => console.log(JSON.stringify(r, null, 2)));
      }
    } catch { /* skip */ }
  }
  sessionDb.close();
} catch (err) {
  console.log("aiworker.db error:", (err as Error).message);
}

// Check audit.db
try {
  const auditDb = new Database(join(dataDir, "audit.db"), { readonly: true });
  const tables = auditDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  console.log("\n=== audit.db tables ===");
  console.log(tables.map((t) => t.name).join(", "));

  for (const t of tables) {
    try {
      const rows = auditDb.prepare(`SELECT * FROM ${t.name} ORDER BY rowid DESC LIMIT 30`).all();
      if (rows.length > 0) {
        console.log(`\n=== audit.${t.name} (last ${rows.length}) ===`);
        rows.forEach((r: any) => console.log(JSON.stringify(r, null, 2)));
      }
    } catch { /* skip */ }
  }
  auditDb.close();
} catch (err) {
  console.log("audit.db error:", (err as Error).message);
}
