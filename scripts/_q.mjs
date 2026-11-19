import "dotenv/config";
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const r = await pool.query(
    "SELECT role, is_active, COUNT(*)::int AS c FROM users GROUP BY role, is_active ORDER BY role, is_active",
  );
  console.log(r.rows);
  const a = await pool.query(
    "SELECT COUNT(*)::int AS c FROM users WHERE role = 'AGENT' AND is_active = TRUE",
  );
  console.log("active agents", a.rows);
} catch (e) {
  console.error(e.message);
} finally {
  await pool.end();
}
