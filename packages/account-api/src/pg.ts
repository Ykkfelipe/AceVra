import pg from "pg";
import type { SqlExecutor } from "./ports.js";

export function createPgExecutor(databaseUrl: string): SqlExecutor & { close(): Promise<void> } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  const wrap = (client: pg.Pool | pg.PoolClient): SqlExecutor => ({
    query: async (text, params) => ({ rows: (await client.query(text, params as never)).rows }),
    exec: async (script) => {
      await client.query(script);
    },
    transaction: async (fn) => {
      const conn = "release" in client ? client : await pool.connect();
      try {
        await conn.query("BEGIN");
        const value = await fn(wrap(conn));
        await conn.query("COMMIT");
        return value;
      } catch (error) {
        await conn.query("ROLLBACK");
        throw error;
      } finally {
        if (conn !== client) conn.release();
      }
    },
  });
  return { ...wrap(pool), close: () => pool.end() };
}
