// database/seed.js
// Generate dummy data untuk testing
// Jalankan: node database/seed.js

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { faker } = require('@faker-js/faker/locale/id_ID'); // locale Indonesia
const crypto = require('crypto');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// ============================================================
// Helper: Generate hash SHA-256 dari data akademik
// Ini sama persis dengan fungsi yang dipakai di hashService.js
// ============================================================
function generateDataHash(data) {
  const dataString = `${data.student_id}|${data.course_code}|${data.grade}|${data.gpa_point}|${data.semester}|${data.academic_year}`;
  return crypto.createHash('sha256').update(dataString).digest('hex');
}

// ============================================================
// Data master: daftar mata kuliah informatika UAJY
// ============================================================
const mataKuliah = [
  { code: 'IF-1001', name: 'Dasar Pemrograman' },
  { code: 'IF-1002', name: 'Matematika Diskrit' },
  { code: 'IF-2001', name: 'Struktur Data' },
  { code: 'IF-2002', name: 'Basis Data' },
  { code: 'IF-2003', name: 'Pemrograman Berorientasi Objek' },
  { code: 'IF-3001', name: 'Pemrograman Web' },
  { code: 'IF-3002', name: 'Jaringan Komputer' },
  { code: 'IF-3003', name: 'Keamanan Informasi' },
  { code: 'IF-3004', name: 'Kecerdasan Buatan' },
  { code: 'IF-4001', name: 'Proyek Perangkat Lunak' },
];

// Konversi nilai huruf ke angka
const gradeMap = {
  'A': 4.00, 'A-': 3.70, 'B+': 3.30, 'B': 3.00,
  'B-': 2.70, 'C+': 2.30, 'C': 2.00, 'D': 1.00, 'E': 0.00
};
const grades = Object.keys(gradeMap);

async function seed() {
  const client = await pool.connect();
  try {
    console.log('🌱 Menjalankan seeder...\n');

    // ============================================================
    // 1. Buat user default (admin, dosen, mahasiswa)
    // ============================================================
    console.log('📝 Membuat user default...');
    const defaultUsers = [
      { username: 'admin', email: 'admin@uajy.ac.id', password: 'admin123', role: 'admin', full_name: 'Administrator Sistem' },
      { username: 'dosen1', email: 'dosen1@uajy.ac.id', password: 'dosen123', role: 'dosen', full_name: 'Dr. Budi Santoso, M.Kom' },
      { username: 'dosen2', email: 'dosen2@uajy.ac.id', password: 'dosen123', role: 'dosen', full_name: 'Prof. Andi Wahju R. Emanuel' },
      { username: 'mhs001', email: 'mhs001@student.uajy.ac.id', password: 'mhs123', role: 'mahasiswa', full_name: 'Emanuel Enrico Anindya Wibawa' },
    ];

    const userIds = {};
    for (const user of defaultUsers) {
      const passwordHash = await bcrypt.hash(user.password, 10);
      const result = await client.query(
        `INSERT INTO users (username, email, password_hash, role, full_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (username) DO UPDATE SET updated_at = NOW()
         RETURNING id`,
        [user.username, user.email, passwordHash, user.role, user.full_name]
      );
      userIds[user.username] = result.rows[0].id;
    }
    console.log(`  ✅ ${defaultUsers.length} user default dibuat`);

    // ============================================================
    // 2. Generate 50 data akademik dummy
    // ============================================================
    console.log('\n📊 Membuat 50 data akademik dummy...');
    let recordCount = 0;

    for (let i = 0; i < 50; i++) {
      // Generate NIM format UAJY: 22XXXXXYYY
      const nim = `22${faker.string.numeric(7)}`;
      const nama = faker.person.fullName();
      const mk = faker.helpers.arrayElement(mataKuliah);
      const grade = faker.helpers.arrayElement(grades);
      const semester = faker.number.int({ min: 1, max: 8 });
      const academicYear = '2024/2025';

      const recordData = {
        student_id: nim,
        course_code: mk.code,
        grade: grade,
        gpa_point: gradeMap[grade],
        semester: semester,
        academic_year: academicYear,
      };

      // Generate hash dari data — ini yang nanti akan dicatat di blockchain
      const dataHash = generateDataHash(recordData);

      // Simulasi tx_id (nanti diganti dengan tx_id asli dari blockchain)
      const fakeTxId = `0x${crypto.randomBytes(32).toString('hex')}`;

      await client.query(
        `INSERT INTO academic_records 
         (student_id, student_name, course_code, course_name, grade, gpa_point, 
          semester, academic_year, data_hash, tx_id, block_number, platform, status, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          nim, nama, mk.code, mk.name, grade, gradeMap[grade],
          semester, academicYear, dataHash, fakeTxId,
          faker.number.int({ min: 6000000, max: 6500000 }),
          'ethereum', 'confirmed',
          userIds['dosen1']
        ]
      );
      recordCount++;
    }
    console.log(`  ✅ ${recordCount} data akademik dummy dibuat`);

    // ============================================================
    // 3. Ringkasan
    // ============================================================
    console.log('\n🎉 Seeder selesai!');
    console.log('\nAkun default yang dibuat:');
    console.log('  Admin    → username: admin    | password: admin123');
    console.log('  Dosen 1  → username: dosen1   | password: dosen123');
    console.log('  Dosen 2  → username: dosen2   | password: dosen123');
    console.log('  Mahasiswa→ username: mhs001   | password: mhs123');
    console.log('\nData akademik: 50 record dummy siap untuk testing');

  } catch (err) {
    console.error('❌ Seeder gagal:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
