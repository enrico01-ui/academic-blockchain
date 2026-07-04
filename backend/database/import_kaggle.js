// database/import_all_datasets.js
// Import gabungan 4 dataset ke PostgreSQL
//
// Dataset:
// DS1: student_academic_performance.csv  (199 rows)
// DS2: Student_data.csv                  (5000 rows)
// DS3: Academic_student_retention_2021   (500 rows)
// DS4: academic_performance_dataset_V2   (3046 rows)
//
// Total estimasi: ~8.745 record
//
// Cara pakai:
// 1. Copy semua CSV ke folder backend/data/
// 2. npm install csv-parse (kalau belum)
// 3. node database/import_all_datasets.js

const { Pool } = require('pg');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const { parse }= require('csv-parse/sync');
const bcrypt   = require('bcryptjs');
require('dotenv').config();

const pool = new Pool({
  host    : process.env.DB_HOST,
  port    : process.env.DB_PORT,
  database: process.env.DB_NAME,
  user    : process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// ============================================================
// HELPER: Generate hash SHA-256
// HARUS SAMA PERSIS dengan hashService.js di backend
// ============================================================
function generateDataHash(data) {
  const str = [
    String(data.student_id).trim(),
    String(data.course_code).trim(),
    String(data.grade).trim(),
    parseFloat(data.gpa_point).toFixed(2),
    String(data.semester).trim(),
    String(data.academic_year).trim(),
    String(data.attendance || 'always').trim(),
  ].join('|');
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// ============================================================
// HELPER: Konversi CGPA berbagai skala ke grade + gpa skala 4
// ============================================================
function convertCGPA(value, scale = 4) {
  const raw        = parseFloat(value) || 0;
  const normalized = scale === 4 ? raw : (raw / scale) * 4.0;
  const n          = Math.min(Math.max(normalized, 0), 4);

  if (n >= 3.85) return { grade: 'A',  gpa: 4.00 };
  if (n >= 3.50) return { grade: 'A-', gpa: 3.70 };
  if (n >= 3.15) return { grade: 'B+', gpa: 3.30 };
  if (n >= 2.85) return { grade: 'B',  gpa: 3.00 };
  if (n >= 2.50) return { grade: 'B-', gpa: 2.70 };
  if (n >= 2.15) return { grade: 'C+', gpa: 2.30 };
  if (n >= 1.50) return { grade: 'C',  gpa: 2.00 };
  if (n >= 0.50) return { grade: 'D',  gpa: 1.00 };
  return { grade: 'E', gpa: 0.00 };
}

// ============================================================
// HELPER: Konversi grade string ke GPA angka
// ============================================================
function gradeToGpa(g) {
  const map = {
    'A+':4.00,'A':4.00,'A-':3.70,
    'B+':3.30,'B':3.00,'B-':2.70,
    'C+':2.30,'C':2.00,'C-':1.70,
    'D':1.00,'E':0.00,'F':0.00,
  };
  return map[String(g).trim().toUpperCase()] ?? 2.00;
}

// ============================================================
// HELPER: Konversi attendance % ke kategori
// ============================================================
function pctToAttendance(pct) {
  const p = parseFloat(pct) || 0;
  if (p >= 80) return 'always';
  if (p >= 50) return 'sometimes';
  return 'never';
}

// ============================================================
// HELPER: Konversi approved/enrolled units ke attendance
// ============================================================
function unitsToAttendance(approved, enrolled) {
  const e = parseInt(enrolled) || 1;
  const a = parseInt(approved) || 0;
  return pctToAttendance((a / e) * 100);
}

// ============================================================
// HELPER: Mapping nama jurusan/program ke kode mata kuliah
// ============================================================
const COURSE_MAP = {
  // DS1
  'CSE':{ code:'CSE-301', name:'Computer Science Engineering' },
  'IT' :{ code:'IT-301',  name:'Information Technology' },
  'ECE':{ code:'ECE-301', name:'Electronics & Communication Eng' },
  'ME' :{ code:'ME-301',  name:'Mechanical Engineering' },
  'CE' :{ code:'CE-301',  name:'Civil Engineering' },
  // DS2
  'Engineering'     :{ code:'ENG-301', name:'Engineering' },
  'Business'        :{ code:'BUS-201', name:'Business' },
  'Computer Science':{ code:'CS-301',  name:'Computer Science' },
  'Mathematics'     :{ code:'MAT-201', name:'Mathematics' },
  'Economics'       :{ code:'ECO-201', name:'Economics' },
  'Psychology'      :{ code:'PSY-201', name:'Psychology' },
  // DS3
  'Management'    :{ code:'MGT-301', name:'Management' },
  'Journalism'    :{ code:'JRN-201', name:'Journalism' },
  'Agronomy'      :{ code:'AGR-101', name:'Agronomy' },
  'Design'        :{ code:'DSN-201', name:'Design' },
  'Education'     :{ code:'EDU-101', name:'Education' },
  'Nursing'       :{ code:'NRS-301', name:'Nursing' },
  'Social Service':{ code:'SOC-201', name:'Social Service' },
  'Technologies'  :{ code:'TEC-301', name:'Technologies' },
  // DS4
  'BCH' :{ code:'BCH-301', name:'Biochemistry' },
  'BLD' :{ code:'BLD-301', name:'Building Technology' },
  'CEN' :{ code:'CEN-301', name:'Computer Engineering' },
  'CHE' :{ code:'CHE-301', name:'Chemical Engineering' },
  'CHM' :{ code:'CHM-301', name:'Industrial Chemistry' },
  'CIS' :{ code:'CIS-301', name:'Computer Science' },
  'CVE' :{ code:'CVE-301', name:'Civil Engineering' },
  'EEE' :{ code:'EEE-301', name:'Electrical & Electronics Eng' },
  'ICE' :{ code:'ICE-301', name:'Information & Communication Eng' },
  'MAT' :{ code:'MAT-301', name:'Mathematics' },
  'MCB' :{ code:'MCB-301', name:'Microbiology' },
  'MCE' :{ code:'MCE-301', name:'Mechanical Engineering' },
  'MIS' :{ code:'MIS-301', name:'Management & Information System' },
  'PET' :{ code:'PET-301', name:'Petroleum Engineering' },
  'PHYE':{ code:'PHYE-301',name:'Industrial Physics-Electronics' },
  'PHYG':{ code:'PHYG-301',name:'Industrial Physics-Geophysics' },
  'PHYR':{ code:'PHYR-301',name:'Industrial Physics-Renewable' },
};

function getCourse(key) {
  return COURSE_MAP[key?.trim()] || { code:'GEN-101', name: key?.trim() || 'General' };
}

// ============================================================
// HELPER: Baca CSV dari folder data/
// ============================================================
function readCSV(filename) {
  const filePath = path.join(__dirname, '..', 'data', filename);
  if (!fs.existsSync(filePath)) {
    console.log(`  ⚠️  File tidak ditemukan: data/${filename} — skip`);
    return null;
  }
  return parse(fs.readFileSync(filePath, 'utf8'), {
    columns: true, skip_empty_lines: true, trim: true, bom: true,
  });
}

// ============================================================
// HELPER: Insert satu record ke database
// ============================================================
async function insertRecord(client, data, adminId) {
  const dataHash = generateDataHash(data);
  const fakeTxId = `0x${crypto.randomBytes(32).toString('hex')}`;

  await client.query(
    `INSERT INTO academic_records
     (student_id, student_name, course_code, course_name,
      grade, gpa_point, semester, academic_year,
      attendance, gender, data_hash, tx_id, block_number,
      platform, status, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'ethereum','confirmed',$14)
     ON CONFLICT DO NOTHING`,
    [
      String(data.student_id).trim(),
      data.student_name || `Student ${data.student_id}`,
      data.course_code,
      data.course_name,
      data.grade,
      parseFloat(data.gpa_point).toFixed(2),
      parseInt(data.semester) || 1,
      data.academic_year || '2023/2024',
      data.attendance || 'always',
      data.gender || null,
      dataHash,
      fakeTxId,
      Math.floor(Math.random() * 500000) + 6000000,
      adminId,
    ]
  );
}

// ============================================================
// DS1: student_academic_performance.csv
// Kolom dipakai   : student_id, gender, department, semester, cgpa, grade
// Kolom tidak dipakai: internal_marks, external_marks, total_marks, percentage, result
// Skala CGPA      : 0-10
// ============================================================
async function importDS1(client, adminId) {
  console.log('\n📂 DS1: student_academic_performance.csv');
  const rows = readCSV('student_academic_performance.csv');
  if (!rows) return 0;

  let count = 0;
  for (const row of rows) {
    if (!row.student_id || !row.cgpa) continue;
    const course   = getCourse(row.department);
    const grade    = String(row.grade || 'C').trim().toUpperCase();
    const gpa      = gradeToGpa(grade);
    const semester = Math.min(parseInt(row.semester) || 1, 8);

    await insertRecord(client, {
      student_id   : `DS1_${row.student_id}`,
      student_name : `Student DS1-${row.student_id}`,
      course_code  : course.code,
      course_name  : course.name,
      grade,
      gpa_point    : gpa,
      semester     : semester > 0 ? semester : Math.ceil(Math.random() * 8),
      academic_year: '2023/2024',
      attendance   : 'always',
      gender       : row.gender || null,
    }, adminId);
    count++;
  }
  console.log(`  ✅ ${count} record`);
  return count;
}

// ============================================================
// DS2: Student_data.csv
// Kolom dipakai   : Student_ID, Gender, Major, Attendance_Pct, Final_CGPA
// Kolom tidak dipakai: Age, Study_Hours_Per_Day, Previous_GPA, Sleep_Hours, Social_Hours_Week
// Skala CGPA      : 0-4 (sudah standar)
// ============================================================
async function importDS2(client, adminId) {
  console.log('\n📂 DS2: Student_data.csv');
  const rows = readCSV('Student_data.csv');
  if (!rows) return 0;

  let count = 0;
  for (const row of rows) {
    if (!row.Student_ID || !row.Final_CGPA) continue;
    const course         = getCourse(row.Major);
    const { grade, gpa } = convertCGPA(row.Final_CGPA, 4);

    await insertRecord(client, {
      student_id   : `DS2_${row.Student_ID}`,
      student_name : `Student DS2-${row.Student_ID}`,
      course_code  : course.code,
      course_name  : course.name,
      grade,
      gpa_point    : gpa,
      semester     : Math.ceil(Math.random() * 8),
      academic_year: '2023/2024',
      attendance   : pctToAttendance(row.Attendance_Pct),
      gender       : row.Gender || null,
    }, adminId);
    count++;
    if (count % 1000 === 0) console.log(`  📊 ${count} record...`);
  }
  console.log(`  ✅ ${count} record`);
  return count;
}

// ============================================================
// DS3: Academic_student_retention_dataset_2021.csv
// Kolom dipakai   : Student_ID, Gender, Course_Chosen,
//                   Semester_Average_Grade, Semester_Enrolled_Units,
//                   Semester_Approved_Units, Year
// Kolom tidak dipakai: Age, Marital_Status, Application_Mode,
//                      Residence_Location, Parental_Education,
//                      Parental_Income_Level, Employment_Status,
//                      Retention, Unemployment_Rate, Inflation_Rate, Regional_GDP
// Skala CGPA      : 0-6
// ============================================================
async function importDS3(client, adminId) {
  console.log('\n📂 DS3: Academic_student_retention_dataset_2021.csv');
  const rows = readCSV('Academic_student_retention_dataset_2021.csv');
  if (!rows) return 0;

  let count = 0;
  for (const row of rows) {
    if (!row.Student_ID || !row.Semester_Average_Grade) continue;
    const course         = getCourse(row.Course_Chosen);
    const { grade, gpa } = convertCGPA(row.Semester_Average_Grade, 6);
    const academicYear   = `${row.Year}/${parseInt(row.Year) + 1}`;

    await insertRecord(client, {
      student_id   : `DS3_${row.Student_ID}`,
      student_name : `Student DS3-${row.Student_ID}`,
      course_code  : course.code,
      course_name  : course.name,
      grade,
      gpa_point    : gpa,
      semester     : Math.ceil(Math.random() * 8),
      academic_year: academicYear,
      attendance   : unitsToAttendance(row.Semester_Approved_Units, row.Semester_Enrolled_Units),
      gender       : row.Gender || null,
    }, adminId);
    count++;
  }
  console.log(`  ✅ ${count} record`);
  return count;
}

// ============================================================
// DS4: academic_performance_dataset_V2.csv
// Kolom dipakai   : ID No, Prog Code, Gender, YoG,
//                   CGPA100, CGPA200, CGPA300, CGPA400
// Setiap mahasiswa menghasilkan 4 record (per tahun akademik)
// Skala CGPA      : 0-5
// ============================================================
async function importDS4(client, adminId) {
  console.log('\n📂 DS4: academic_performance_dataset_V2.csv');
  const rows = readCSV('academic_performance_dataset_V2.csv');
  if (!rows) return 0;

  let count = 0;
  for (const row of rows) {
    if (!row['ID No'] || !row.CGPA) continue;
    const course = getCourse(row['Prog Code']);
    const yog    = parseInt(row.YoG) || 2020;

    // Buat record per tahun akademik
    const yearData = [
      { cgpa: row.CGPA100, year: yog - 3, sem: 1 },
      { cgpa: row.CGPA200, year: yog - 2, sem: 3 },
      { cgpa: row.CGPA300, year: yog - 1, sem: 5 },
      { cgpa: row.CGPA400, year: yog,     sem: 7 },
    ];

    for (const yd of yearData) {
      if (!yd.cgpa || parseFloat(yd.cgpa) === 0) continue;
      const { grade, gpa } = convertCGPA(yd.cgpa, 5);

      await insertRecord(client, {
        student_id   : `DS4_${row['ID No']}_Y${yd.sem}`,
        student_name : `Student DS4-${row['ID No']}`,
        course_code  : course.code,
        course_name  : course.name,
        grade,
        gpa_point    : gpa,
        semester     : yd.sem,
        academic_year: `${yd.year}/${yd.year + 1}`,
        attendance   : 'always',
        gender       : row.Gender || null,
      }, adminId);
      count++;
    }
    if (count % 1000 === 0) console.log(`  📊 ${count} record...`);
  }
  console.log(`  ✅ ${count} record`);
  return count;
}

// ============================================================
// MAIN
// ============================================================
async function importAll() {
  const client = await pool.connect();
  try {
    console.log('🚀 Import gabungan 4 dataset dimulai...');
    console.log('   Pastikan semua CSV ada di folder backend/data/\n');

    // Pastikan admin ada
    let adminId;
    const existing = await client.query("SELECT id FROM users WHERE username='admin'");
    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash('admin123', 10);
      const res  = await client.query(
        `INSERT INTO users (username,email,password_hash,role,full_name)
         VALUES ('admin','admin@university.ac.id',$1,'admin','Administrator') RETURNING id`, [hash]
      );
      adminId = res.rows[0].id;
    } else {
      adminId = existing.rows[0].id;
    }

    const before = await client.query('SELECT COUNT(*) FROM academic_records');
    console.log(`📋 Record sebelum import: ${before.rows[0].count}`);

    const d1 = await importDS1(client, adminId);
    const d2 = await importDS2(client, adminId);
    const d3 = await importDS3(client, adminId);
    const d4 = await importDS4(client, adminId);

    const after = await client.query('SELECT COUNT(*) FROM academic_records');

    console.log('\n' + '='.repeat(55));
    console.log('🎉 IMPORT SELESAI!');
    console.log('='.repeat(55));
    console.log(`  DS1 student_academic_performance : ${String(d1).padStart(5)} record`);
    console.log(`  DS2 Student_data                 : ${String(d2).padStart(5)} record`);
    console.log(`  DS3 Academic_student_retention   : ${String(d3).padStart(5)} record`);
    console.log(`  DS4 academic_performance_V2      : ${String(d4).padStart(5)} record`);
    console.log(`  ${'─'.repeat(43)}`);
    console.log(`  Total ditambahkan                : ${String(d1+d2+d3+d4).padStart(5)} record`);
    console.log(`  Total di database sekarang       : ${String(after.rows[0].count).padStart(5)} record`);
    console.log('='.repeat(55));

    const breakdown = await client.query(`
      SELECT
        CASE
          WHEN student_id LIKE 'DS1_%' THEN 'DS1 - Academic Performance'
          WHEN student_id LIKE 'DS2_%' THEN 'DS2 - Student Data'
          WHEN student_id LIKE 'DS3_%' THEN 'DS3 - Kaggle Retention'
          WHEN student_id LIKE 'DS4_%' THEN 'DS4 - Performance V2'
          ELSE 'Lainnya (manual input)'
        END AS sumber,
        COUNT(*) AS jumlah
      FROM academic_records
      GROUP BY sumber
      ORDER BY jumlah DESC
    `);

    console.log('\n📊 Breakdown per sumber:');
    breakdown.rows.forEach(r => {
      console.log(`  ${r.sumber.padEnd(30)}: ${r.jumlah} record`);
    });

  } catch (err) {
    console.error('\n❌ Import gagal:', err.message);
    if (err.message.includes('csv-parse')) {
      console.error('   Jalankan: npm install csv-parse');
    }
    if (err.message.includes('column "gender"')) {
      console.error('   Kolom gender belum ada! Jalankan di pgAdmin:');
      console.error('   ALTER TABLE academic_records ADD COLUMN IF NOT EXISTS gender VARCHAR(10);');
    }
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

importAll();