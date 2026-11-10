import database from '../src/config/database.js';

async function main() {
  const usersRes = await database.query(
    "SELECT id, name, email, role FROM users WHERE email IN ('admin@example.com', 'agent@example.com', 'customer@example.com')"
  );
  console.log('Known test users:', usersRes.rows);

  const kbTables = await database.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND (table_name LIKE '%kb%' OR table_name LIKE '%article%')"
  );
  console.log('KB tables:', kbTables.rows);

  const authorsRes = await database.query(
    "SELECT id, name, email, role FROM users WHERE name ILIKE '%Maya%' OR name ILIKE '%Priya%' OR name ILIKE '%Liam%' OR name ILIKE '%Jonas%' OR role IN ('AGENT', 'ADMIN') LIMIT 15"
  );
  console.log('Authors found:', authorsRes.rows);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

