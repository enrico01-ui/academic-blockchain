// database/migrate.js
// Jalankan: node database/migrate.js

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🚀 Menjalankan migration...\n');

    const sqlFile = path.join(__dirname, 'migrations', '001_create_tables.sql');
    const sql = fs.readFileSync(sqlFile, 'utf8');

    await client.query(sql);
    console.log('✅ Migration berhasil! Semua tabel dibuat.\n');
    console.log('Tabel yang dibuat:');
    console.log('  - users');
    console.log('  - academic_records');
    console.log('  - blockchain_transactions');
    console.log('  - integrity_checks');
    console.log('  - audit_logs');

  } catch (err) {
    console.error('❌ Migration gagal:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
