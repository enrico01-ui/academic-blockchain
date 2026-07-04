
/**
 * bulk_create_users.js
 * Buat akun mahasiswa berdasarkan student_id yang sudah confirmed di Sepolia
 * Tugas Akhir — Prodi Informatika UAJY
 * 
 * Cara pakai:
 *   node bulk_create_users.js           ← dry run (tidak insert)
 *   node bulk_create_users.js --execute ← insert ke DB
 */

const { Pool }  = require('pg')
const crypto    = require('crypto')
const yargs     = require('yargs')
const { hideBin } = require('yargs/helpers')
require('dotenv').config({ path: '/root/backend/.env' })

const pool = new Pool({
  host:     process.env.DB_HOST     || '127.0.0.1',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'blockchain_academic',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'blockchain123',
})

// Hash password pakai bcrypt-like (pakai crypto sha256 dulu cek backend pakai apa)
function hashPassword(plain) {
  // Cek dulu apakah backend pakai bcrypt atau sha256
  // Default: bcrypt via require('bcrypt')
  return crypto.createHash('sha256').update(plain).digest('hex')
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('execute', { type: 'boolean', default: false, description: 'Jalankan insert ke DB' })
    .option('password', { type: 'string', default: 'mahasiswa123', description: 'Default password' })
    .argv

  console.log('\n' + '='.repeat(60))
  console.log('  BULK CREATE USER MAHASISWA')
  console.log('  Sumber: academic_records (ethereum, confirmed, Sepolia)')
  console.log('='.repeat(60))

  if (!argv.execute) {
    console.log('\n  ⚠  DRY RUN — tambahkan --execute untuk insert ke DB\n')
  }

  // Ambil student_id unik dari Sepolia
  const { rows: students } = await pool.query(`
    SELECT DISTINCT 
      ar.student_id,
      MAX(ar.student_name) as student_name
    FROM academic_records ar
    WHERE ar.platform = 'ethereum'
      AND ar.block_number >= 7000000
      AND ar.status = 'confirmed'
      AND ar.student_id NOT LIKE 'LOAD_%'
      AND ar.student_id NOT LIKE 'SPAM_%'
      AND ar.student_id NOT LIKE 'DDOS_%'
      AND ar.student_id NOT LIKE 'FUNC_%'
    GROUP BY ar.student_id
    ORDER BY ar.student_id
  `)

  console.log(`\n  ${students.length} student_id unik ditemukan di Sepolia`)

  // Cek user yang sudah ada
  const { rows: existing } = await pool.query(`
    SELECT username FROM users WHERE role = 'mahasiswa'
  `)
  const existingSet = new Set(existing.map(u => u.username))
  console.log(`  ${existingSet.size} user mahasiswa sudah ada di DB`)

  // Filter yang belum ada
  const toCreate = students.filter(s => !existingSet.has(s.student_id.toLowerCase()))
  const skipped  = students.length - toCreate.length

  console.log(`  ${toCreate.length} akan dibuat baru | ${skipped} skip (sudah ada)\n`)

  if (toCreate.length === 0) {
    console.log('  Semua user sudah ada. Selesai.')
    await pool.end()
    return
  }

  // Preview 5 pertama
  console.log('  Preview 5 user pertama:')
  toCreate.slice(0, 5).forEach(s => {
    const username = s.student_id.toLowerCase()
    const email    = `${username}@student.uajy.ac.id`
    console.log(`    username: ${username} | email: ${email}`)
  })
  console.log('  ...')

  if (!argv.execute) {
    console.log('\n  Jalankan dengan --execute untuk insert ke DB')
    await pool.end()
    return
  }

  // Cek apakah backend pakai bcrypt
  let bcrypt
  try {
    bcrypt = require('bcrypt')
    console.log('\n  ✓ bcrypt tersedia')
  } catch {
    console.log('\n  ⚠ bcrypt tidak tersedia, pakai SHA-256')
  }

  // Insert user ke DB
  console.log('\n  Membuat user...')
  let created = 0, failed = 0

  for (const s of toCreate) {
    try {
      const username  = s.student_id.toLowerCase()
      const email     = `${username}@student.uajy.ac.id`
      const fullName  = s.student_name || `Mahasiswa ${s.student_id}`
      const password  = argv.password

      // Hash password
      const hashedPw = bcrypt
        ? await bcrypt.hash(password, 10)
        : hashPassword(password)

      await pool.query(`
        INSERT INTO users (username, email, password, role, full_name, is_active)
        VALUES ($1, $2, $3, 'mahasiswa', $4, true)
        ON CONFLICT (username) DO NOTHING
      `, [username, email, hashedPw, fullName])

      created++
      if (created % 100 === 0) {
        process.stdout.write(`\r  Progress: ${created}/${toCreate.length}`)
      }
    } catch (err) {
      failed++
      if (failed <= 5) console.log(`\n  Error ${s.student_id}: ${err.message?.slice(0,60)}`)
    }
  }

  console.log(`\n\n  Selesai!`)
  console.log(`  ✓ Berhasil : ${created}`)
  console.log(`  ✗ Gagal    : ${failed}`)
  console.log(`  ⊘ Skip     : ${skipped}`)
  console.log(`\n  Password default: ${argv.password}`)
  console.log(`  Format username : student_id.toLowerCase()`)
  console.log(`  Format email    : username@student.uajy.ac.id`)

  await pool.end()
}

main().catch(async e => {
  console.error('\n✗ Fatal:', e.message)
  await pool.end()
  process.exit(1)
})
