#!/usr/bin/env tsx
/**
 * promote.ts — Backend-only role promotion CLI (ADR-019)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Promotes a user to a specified role by direct DB update.
 * This is the ONLY way to create the first Admiral.
 *
 * Usage:
 *   npx tsx scripts/promote.ts --email you@email.com --role admiral
 *   npm run promote -- --email you@email.com --role admiral
 *
 * Requires DATABASE_URL environment variable (or .env file).
 */

import "dotenv/config";
import pg from "pg";

const VALID_ROLES = ["ensign", "lieutenant", "captain", "admiral"] as const;
type Role = (typeof VALID_ROLES)[number];

function usage(): never {
  console.error(`
Usage: npx tsx scripts/promote.ts --email <email> --role <role>

Options:
  --email <email>   User email address (case-insensitive)
  --role <role>     Target role: ${VALID_ROLES.join(", ")}
  --list            List all users and their current roles
  --help            Show this help message

Examples:
  npx tsx scripts/promote.ts --email admin@example.com --role admiral
  npx tsx scripts/promote.ts --list
`);
  process.exit(1);
}

function parseArgs(args: string[]): { email?: string; role?: Role; list?: boolean } {
  const result: { email?: string; role?: string; list?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--email" && args[i + 1]) {
      result.email = args[++i];
    } else if (arg === "--role" && args[i + 1]) {
      result.role = args[++i];
    } else if (arg === "--list") {
      result.list = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    }
  }

  if (result.role && !VALID_ROLES.includes(result.role as Role)) {
    console.error(`❌ Invalid role: "${result.role}". Valid roles: ${VALID_ROLES.join(", ")}`);
    process.exit(1);
  }

  return result as { email?: string; role?: Role; list?: boolean };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("❌ DATABASE_URL not set. Use a .env file or set it in the environment.");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    // Test connection
    await pool.query("SELECT 1");

    if (args.list) {
      const res = await pool.query(
        `SELECT id, email, display_name, role, email_verified, locked_at, created_at
         FROM users ORDER BY created_at ASC`,
      );
      if (res.rows.length === 0) {
        console.log("📭 No users found.");
        return;
      }

      console.log(`\n👥 ${res.rows.length} user(s):\n`);
      console.log("%-36s  %-30s  %-12s  %-10s  %-8s", "ID", "Email", "Role", "Verified", "Locked");
      console.log("-".repeat(100));
      for (const row of res.rows) {
        console.log(
          "%-36s  %-30s  %-12s  %-10s  %-8s",
          row.id,
          row.email,
          `★ ${row.role.toUpperCase()}`,
          row.email_verified ? "✓" : "✗",
          row.locked_at ? "🔒" : "—",
        );
      }
      console.log();
      return;
    }

    if (!args.email || !args.role) {
      usage();
    }

    const email = args.email.trim().toLowerCase();
    const role = args.role;

    // Look up user
    const res = await pool.query("SELECT id, email, display_name, role FROM users WHERE LOWER(email) = $1", [email]);
    if (res.rows.length === 0) {
      console.error(`❌ No user found with email: ${email}`);
      console.error("   Sign up first, then run this script.");
      process.exit(1);
    }

    const user = res.rows[0] as { id: string; email: string; display_name: string; role: string };

    if (user.role === role) {
      console.log(`ℹ️  ${user.display_name} (${user.email}) is already ${role.toUpperCase()}.`);
      return;
    }

    const previousRole = user.role;

    // Promote
    await pool.query("UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2", [role, user.id]);

    console.log(`\n✅ Role updated!`);
    console.log(`   User:     ${user.display_name} (${user.email})`);
    console.log(`   Previous: ★ ${previousRole.toUpperCase()}`);
    console.log(`   Current:  ★ ${role.toUpperCase()}`);
    console.log();
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Fatal error:", err.message || err);
  process.exit(1);
});
