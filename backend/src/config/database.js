// src/config/database.js
// Konfigurasi koneksi ke PostgreSQL menggunakan library 'pg'

const { Pool } = require('pg');
require('dotenv').config();

// Pool = kumpulan koneksi yang dikelola otomatis (lebih efisien dari single connection)
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  // max: jumlah koneksi maksimum dalam pool
  max: 20,
  // idleTimeoutMillis: koneksi idle dihapus setelah 30 detik
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test koneksi saat pertama kali dijalankan
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Gagal konek ke PostgreSQL:', err.message);
  } else {
    console.log('✅ PostgreSQL terhubung');
    release(); // kembalikan koneksi ke pool
  }
});

// Helper function: jalankan query dengan otomatis handle koneksi
const query = (text, params) => pool.query(text, params);

module.exports = { pool, query };
