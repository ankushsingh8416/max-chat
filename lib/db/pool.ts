import { Pool } from "pg";

let pool: Pool | null = null;

/**
 * Singleton Postgres connection pool. Works against any standard Postgres
 * instance — AWS RDS, Supabase's own direct connection string, a self-hosted
 * box, etc. — since the app only relies on the vanilla `pgvector` extension
 * (see sql/schema.sql), nothing provider-specific.
 */
export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  // Most managed Postgres (AWS RDS, Supabase, etc.) requires TLS but presents
  // a cert not in Node's default trust store; disabling strict verification
  // avoids having to bundle every provider's CA bundle. Set DATABASE_SSL=disable
  // for a local/unencrypted Postgres instance.
  const sslDisabled = process.env.DATABASE_SSL === "disable";
  pool = new Pool({
    connectionString,
    ssl: sslDisabled ? false : { rejectUnauthorized: false },
  });
  return pool;
}
