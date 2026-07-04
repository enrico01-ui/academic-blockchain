/**
 * integrity_testing.js
 * ====================
 * Pengujian Integritas Data Akademik
 * Tugas Akhir: Perbandingan Ethereum Testnet dan Hyperledger Fabric
 *
 * Cara pakai:
 *   node integrity_testing.js --platform ethereum
 *   node integrity_testing.js --platform fabric
 *   node integrity_testing.js --platform both
 *
 * Hasil disimpan ke: hasil_integrity_testing.xlsx
 */

const axios   = require('axios')
const ExcelJS = require('exceljs')
const crypto  = require('crypto')
const { Client } = require('pg')
const yargs   = require('yargs')
const { hideBin } = require('yargs/helpers')
const readline = require('readline')

// ─────────────────────────────────────────────
// KONFIGURASI
// ─────────────────────────────────────────────
// Ganti seluruh CONFIG dan fetchSampleRecords
const CONFIG = {
  // Pakai environment variable supaya fleksibel lokal/VPS
  dbHost:     process.env.DB_HOST     || '127.0.0.1',
  dbPort:     parseInt(process.env.DB_PORT || '5432'),
  dbName:     process.env.DB_NAME     || 'blockchain_academic',
  dbUser:     process.env.DB_USER     || 'postgres',
  dbPassword: process.env.DB_PASSWORD || 'blockchain123',

  apiUrl:      process.env.API_URL      || 'http://139.59.240.82:3000/api',
  apiUsername: process.env.ADMIN_USER   || 'admin',
  apiPassword: process.env.ADMIN_PASS   || 'admin123',

  sampleSize: 500,
}

// ─────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────
function calculateHash(record) {
  const gpa = parseFloat(record.gpa_point).toFixed(2)
  const raw  = `${record.student_id}|${record.course_code}|${record.grade}|${gpa}|${record.semester}|${record.academic_year}|${record.attendance}`
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex')
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans) }))
}

// ─────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────
async function countAvailableRecords(platform, token) {
  try {
    // platform 'both' tidak didukung API — query terpisah
    if (platform === 'both') {
      const eth = await countAvailableRecords('ethereum', token)
      const fab = await countAvailableRecords('fabric', token)
      return eth + fab
    }
    const res = await axios.get(
      `${CONFIG.apiUrl}/academic?platform=${platform}&status=confirmed&limit=1`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    )
    return parseInt(res.data?.total || 0)
  } catch (e) {
    console.log(`  [!] countAvailableRecords error: ${e.message}`)
    return 0
  }
}
// Fix Bug 2: tambah let
async function fetchSampleRecords(platform, limit = 500, token) {
  try {
    if (platform === 'both') {
      const half = Math.ceil(limit / 2)
      const eth  = await fetchSampleRecords('ethereum', half, token)
      const fab  = await fetchSampleRecords('fabric',   half, token)
      return [...eth, ...fab]
    }

    // Untuk ethereum, filter langsung di query DB via min_block
    const url = platform === 'ethereum'
      ? `${CONFIG.apiUrl}/academic?platform=ethereum&status=confirmed&limit=${limit}&min_block=7000000`
      : `${CONFIG.apiUrl}/academic?platform=fabric&status=confirmed&limit=${limit}`

    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000
    })

    return res.data?.records || []

  } catch (e) {
    console.log(`  [!] Gagal ambil records (${platform}): ${e.message}`)
    return []
  }
}


// Fix Bug 3: tamperRecord pakai config yang sama dengan DB yang dipakai API
// Karena DB ada di VPS, tamperRecord harus konek ke DB VPS
async function tamperRecord(id, grade, gpaPoint) {
  const client = new Client({
    host:     process.env.DB_HOST     || '139.59.240.82', // ← IP VPS bukan localhost
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME     || 'blockchain_academic',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || 'blockchain123',
  })
  try {
    await client.connect()
    await client.query(
      'UPDATE academic_records SET grade=$1, gpa_point=$2 WHERE id=$3',
      [grade, gpaPoint, id]
    )
  } finally {
    await client.end()
  }
}
// ─────────────────────────────────────────────
// API
// ─────────────────────────────────────────────
async function getToken() {
  try {
    const res = await axios.post(`${CONFIG.apiUrl}/auth/login`,
      { username: CONFIG.apiUsername, password: CONFIG.apiPassword }, { timeout: 10000 })
    return res.data?.token || null
  } catch (e) {
    console.log(`  [!] Gagal login: ${e.message}`)
    return null
  }
}

async function verifyViaApi(studentId, token) {
  const t = Date.now()
  try {
    const res = await axios.post(`${CONFIG.apiUrl}/verify/hash`,
      { student_id: studentId },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 })
    const data = res.data
    return {
      isValid:       data?.verification?.isValid || false,
      expectedHash:  data?.verification?.expectedHash || '',
      actualHash:    data?.verification?.actualHash || '',
      latencyMs:     Date.now() - t,
    }
  } catch (e) {
    return { isValid: false, expectedHash: '', actualHash: '', latencyMs: Date.now() - t, error: e.message }
  }
}

// ─────────────────────────────────────────────
// INTEGRITY TEST
// ─────────────────────────────────────────────
async function runIntegrityTest(platform, records, token) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  INTEGRITY TESTING — Platform: ${platform.toUpperCase()}`)
  console.log(`  Jumlah record: ${records.length}`)
  console.log('='.repeat(60))

  const hasil       = []
  let passCount     = 0, failCount = 0, totalLatency = 0

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    process.stdout.write(`  [${String(i + 1).padStart(3, ' ')}/${records.length}] ${rec.student_id.slice(0, 15).padEnd(15)} `)

    const recalcHash  = calculateHash(rec)
    const hashMatchDb = recalcHash === rec.data_hash
    const verify      = await verifyViaApi(rec.student_id, token)
    const isValid     = verify.isValid
    const latencyMs   = verify.latencyMs

    const status = isValid && hashMatchDb ? 'LULUS' : 'GAGAL'
    if (isValid && hashMatchDb) {
      passCount++
      console.log(`✓ LULUS  (${Math.round(latencyMs)}ms)`)
    } else {
      failCount++
      console.log(`✗ GAGAL  hash_db:${hashMatchDb} | blockchain:${isValid}`)
    }

    totalLatency += latencyMs
    hasil.push({
      no:              i + 1,
      studentId:       rec.student_id,
      recordId:        String(rec.id),
      platform,
      hashDb:          rec.data_hash.slice(0, 16) + '...',
      hashRecalculated: recalcHash.slice(0, 16) + '...',
      hashBlockchain:  verify.actualHash ? verify.actualHash.slice(0, 16) + '...' : '—',
      hashMatchDb:     hashMatchDb ? 'Ya' : 'Tidak',
      blockchainValid: isValid ? 'Ya' : 'Tidak',
      latencyMs:       latencyMs.toFixed(1),
      status,
    })
    if ((i + 1) % 100 === 0) {
      console.log('  Cooling down 5 detik...')
      await sleep(5000)
    }
    await sleep(platform === 'ethereum' ? 300 : 200)
  }

  const avgLatency = records.length ? totalLatency / records.length : 0
  console.log(`\n  Hasil: ${passCount} Lulus, ${failCount} Gagal`)
  console.log(`  Rata-rata latency: ${avgLatency.toFixed(1)} ms`)
  console.log(`  Tingkat keberhasilan: ${(passCount / records.length * 100).toFixed(1)}%`)

  return { hasil, passCount, failCount, avgLatency }
}

// ─────────────────────────────────────────────
// TAMPERING TEST
// ─────────────────────────────────────────────
async function runTamperingTest(records, token) {
  console.log(`\n${'='.repeat(60)}`)
  console.log('  SIMULASI MANIPULASI DATA (Tampering Test)')
  console.log(`  Jumlah record: 30 sample`)
  console.log('='.repeat(60))

  const hasilTamper = []
  const sample      = records.slice(0, 30)

  for (let i = 0; i < sample.length; i++) {
    const rec = sample[i]
    process.stdout.write(`  [${String(i + 1).padStart(2, ' ')}/30] Memanipulasi ${rec.student_id.slice(0, 15).padEnd(15)} `)

    const originalGrade = rec.grade
    const originalGpa   = parseFloat(rec.gpa_point)
    const tamperedGrade = originalGrade !== 'A' ? 'A' : 'E'
    const tamperedGpa   = tamperedGrade === 'A' ? 4.00 : 0.00

    // Manipulasi DB sementara
    await tamperRecord(rec.id, tamperedGrade, tamperedGpa)

    // Verifikasi — seharusnya GAGAL
    const verify     = await verifyViaApi(rec.student_id, token)
    const isDetected = !verify.isValid

    // Kembalikan data asli
    await tamperRecord(rec.id, originalGrade, originalGpa)

    const status = isDetected ? 'TERDETEKSI ✓' : 'TIDAK TERDETEKSI ✗'
    console.log(`${status}  (${originalGrade}→${tamperedGrade})`)

    hasilTamper.push({
      no:          i + 1,
      studentId:   rec.student_id,
      nilaiAsli:   `${originalGrade} (${originalGpa})`,
      nilaiDiubah: `${tamperedGrade} (${tamperedGpa})`,
      terdeteksi:  isDetected ? 'Ya' : 'Tidak',
      status:      isDetected ? 'Lulus' : 'Gagal',
    })

    await sleep(500)
  }

  const detected = hasilTamper.filter(r => r.terdeteksi === 'Ya').length
  console.log(`\n  Deteksi berhasil: ${detected}/30`)
  return { hasilTamper, detected }
}

// ─────────────────────────────────────────────
// EXPORT EXCEL
// ─────────────────────────────────────────────
async function exportExcel(hasilEth, hasilFab, sumEth, sumFab, tamperHasil, filename) {
  const wb    = new ExcelJS.Workbook()
  const NAVY  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2744' } }
  const GREEN = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4EDDA' } }
  const RED   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8D7DA' } }
  const GREY  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }

  const wFont  = { color: { argb: 'FFFFFFFF' }, bold: true, name: 'Times New Roman', size: 11 }
  const nFont  = { name: 'Times New Roman', size: 11 }
  const center = { horizontal: 'center', vertical: 'middle', wrapText: true }
  const thin   = { style: 'thin' }
  const brd    = { top: thin, bottom: thin, left: thin, right: thin }

  function styleHeader(row, n) {
    for (let c = 1; c <= n; c++) {
      const cell = row.getCell(c); cell.fill = NAVY; cell.font = wFont; cell.alignment = center; cell.border = brd
    }
  }
  function styleRow(row, n, fill) {
    for (let c = 1; c <= n; c++) {
      const cell = row.getCell(c); if (fill) cell.fill = fill; cell.font = nFont; cell.alignment = center; cell.border = brd
    }
  }

  // ── Sheet 1: Ringkasan ───────────────────
  const ws1 = wb.addWorksheet('Ringkasan')
  ws1.columns = [{ width: 35 }, { width: 28 }, { width: 28 }]

  const titleRow = ws1.addRow(['RINGKASAN HASIL PENGUJIAN INTEGRITAS DATA'])
  ws1.mergeCells('A1:C1')
  styleHeader(titleRow, 3)
  ws1.addRow([])

  const hdrRow = ws1.addRow(['Parameter', 'Ethereum Testnet (Sepolia)', 'Hyperledger Fabric'])
  styleHeader(hdrRow, 3)

  const params = [
    ['Jumlah Data yang Diuji',         `${sumEth.total} record`,      `${sumFab.total} record`],
    ['Jumlah Lulus',                   String(sumEth.pass),           String(sumFab.pass)],
    ['Jumlah Gagal',                   String(sumEth.fail),           String(sumFab.fail)],
    ['Tingkat Keberhasilan (%)',        `${sumEth.rate.toFixed(1)}%`,  `${sumFab.rate.toFixed(1)}%`],
    ['Rata-rata Latency Verifikasi',   `${sumEth.avgLat.toFixed(1)} ms`, `${sumFab.avgLat.toFixed(1)} ms`],
    ['Deteksi Manipulasi (Tampering)', `${sumEth.tamper}/30`,          `${sumFab.tamper}/30`],
    ['Tanggal Pengujian',              new Date().toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' }), ''],
  ]
  params.forEach((p, i) => {
    const row = ws1.addRow(p); styleRow(row, 3, i % 2 === 1 ? GREY : null)
  })

  // ── Sheet per platform ───────────────────
  for (const [platform, hasil] of [['Ethereum', hasilEth], ['Fabric', hasilFab]]) {
    const ws = wb.addWorksheet(`Detail ${platform}`)
    ws.columns = [
      { width: 5 }, { width: 18 }, { width: 14 }, { width: 12 },
      { width: 20 }, { width: 20 }, { width: 22 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 12 },
    ]

    const tTitle = ws.addRow([`DETAIL PENGUJIAN INTEGRITAS — ${platform.toUpperCase()}`])
    ws.mergeCells(`A1:K1`)
    styleHeader(tTitle, 11)
    ws.addRow([])

    const tHdr = ws.addRow(['No', 'Student ID', 'Record ID', 'Platform', 'Hash DB', 'Hash Recalc.', 'Hash Blockchain', 'Cocok DB?', 'Valid BC?', 'Latency (ms)', 'Status'])
    styleHeader(tHdr, 11)

    hasil.forEach(r => {
      const row = ws.addRow([r.no, r.studentId, r.recordId, r.platform, r.hashDb, r.hashRecalculated, r.hashBlockchain, r.hashMatchDb, r.blockchainValid, r.latencyMs, r.status])
      styleRow(row, 11, r.status === 'LULUS' ? GREEN : RED)
    })
  }

  // ── Sheet Tampering ──────────────────────
  const ws3 = wb.addWorksheet('Simulasi Tampering')
  ws3.columns = [{ width: 5 }, { width: 20 }, { width: 20 }, { width: 22 }, { width: 16 }, { width: 16 }]

  const t3Title = ws3.addRow(['SIMULASI MANIPULASI DATA (TAMPERING TEST)'])
  ws3.mergeCells('A1:F1')
  styleHeader(t3Title, 6)
  ws3.addRow([])

  const t3Hdr = ws3.addRow(['No', 'Student ID', 'Nilai Asli', 'Nilai Dimanipulasi', 'Terdeteksi?', 'Status'])
  styleHeader(t3Hdr, 6)

  tamperHasil.forEach(r => {
    const row = ws3.addRow([r.no, r.studentId, r.nilaiAsli, r.nilaiDiubah, r.terdeteksi, r.status])
    styleRow(row, 6, r.status === 'Lulus' ? GREEN : RED)
  })

  await wb.xlsx.writeFile(filename)
  console.log(`\n  ✓ Hasil disimpan ke: ${filename}`)
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('platform', { choices: ['ethereum', 'fabric', 'both'], default: 'both' })
    .option('size', { type: 'number', default: CONFIG.sampleSize })
    .argv

  CONFIG.sampleSize = argv.size

  console.log(`\n${'='.repeat(60)}`)
  console.log('  PENGUJIAN INTEGRITAS DATA AKADEMIK')
  console.log('  Tugas Akhir — Prodi Informatika UAJY')
  console.log(`  ${new Date().toLocaleString('id-ID')}`)
  console.log('='.repeat(60))

  // 1. Login
  console.log('\n[1] Login ke backend API...')
  const token = await getToken()
  if (!token) { console.log('  GAGAL login.'); process.exit(1) }
  console.log('  ✓ Token diperoleh')

  console.log('\n[2] Mengecek ketersediaan data di database...')

const availEth = ['ethereum', 'both'].includes(argv.platform)
  ? await countAvailableRecords('ethereum', token)  // ← tambah token
  : 0
const availFab = ['fabric', 'both'].includes(argv.platform)
  ? await countAvailableRecords('fabric', token)    // ← tambah token
  : 0

if (['ethereum', 'both'].includes(argv.platform))
  console.log(`  Ethereum : ${availEth} record confirmed tersedia`)
if (['fabric', 'both'].includes(argv.platform))
  console.log(`  Fabric   : ${availFab} record confirmed tersedia`)

const sizeEth = Math.min(CONFIG.sampleSize, availEth)
const sizeFab = Math.min(CONFIG.sampleSize, availFab)

if (['ethereum', 'both'].includes(argv.platform) && sizeEth < CONFIG.sampleSize)
  console.log(`  ⚠  Ethereum: target ${CONFIG.sampleSize} tapi hanya ${sizeEth} tersedia.`)
if (['fabric', 'both'].includes(argv.platform) && sizeFab < CONFIG.sampleSize)
  console.log(`  ⚠  Fabric: target ${CONFIG.sampleSize} tapi hanya ${sizeFab} tersedia.`)

if (sizeEth === 0 && argv.platform === 'ethereum') {
  console.log('  ✗ Tidak ada data Ethereum.'); process.exit(1)
}
if (sizeFab === 0 && argv.platform === 'fabric') {
  console.log('  ✗ Tidak ada data Fabric.'); process.exit(1)
}
  // 2. Ambil data
  console.log(`\n[2] Mengambil ${CONFIG.sampleSize} record...`)
const records = await fetchSampleRecords(argv.platform, CONFIG.sampleSize, token) // ← tambah token
if (!records.length) { console.log('  GAGAL: tidak ada record.'); process.exit(1) }
console.log(`  ✓ ${records.length} record diperoleh`)

  // 3. Tampering test
  console.log('\n[3] Menjalankan simulasi manipulasi data...')
  const { hasilTamper, detected } = await runTamperingTest(records, token)

  let hasilEth = [], hasilFab = []
  let sumEth   = { total: 0, pass: 0, fail: 0, rate: 0, avgLat: 0, tamper: detected }
  let sumFab   = { total: 0, pass: 0, fail: 0, rate: 0, avgLat: 0, tamper: detected }

  // 4a. Ethereum
  if (['ethereum', 'both'].includes(argv.platform)) {
    console.log('\n[4a] Mengubah ACTIVE_BLOCKCHAIN ke ethereum...')
    console.log('     Pastikan .env sudah diset ACTIVE_BLOCKCHAIN=ethereum dan backend di-restart!')
    await prompt('     Tekan Enter jika sudah siap... ')
    const { hasil, passCount, failCount, avgLatency } = await runIntegrityTest('ethereum', records, token)
    hasilEth = hasil
    sumEth   = { total: records.length, pass: passCount, fail: failCount, rate: passCount / records.length * 100, avgLat: avgLatency, tamper: detected }
  }

  // 4b. Fabric
  if (['fabric', 'both'].includes(argv.platform)) {
    console.log('\n[4b] Mengubah ACTIVE_BLOCKCHAIN ke fabric...')
    console.log('     Pastikan .env sudah diset ACTIVE_BLOCKCHAIN=fabric dan backend di-restart!')
    await prompt('     Tekan Enter jika sudah siap... ')
    const { hasil, passCount, failCount, avgLatency } = await runIntegrityTest('fabric', records, token)
    hasilFab = hasil
    sumFab   = { total: records.length, pass: passCount, fail: failCount, rate: passCount / records.length * 100, avgLat: avgLatency, tamper: detected }
  }

  // Jika satu platform saja, duplikasi untuk sheet
  if (argv.platform === 'ethereum') { sumFab = { ...sumEth }; hasilFab = hasilEth }
  if (argv.platform === 'fabric')   { sumEth = { ...sumFab }; hasilEth = hasilFab }

  // 5. Export
  console.log('\n[5] Mengekspor hasil ke Excel...')
  const ts    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const fname = `hasil_integrity_testing_${ts}.xlsx`
  await exportExcel(hasilEth, hasilFab, sumEth, sumFab, hasilTamper, fname)

  // 6. Ringkasan
  console.log(`\n${'='.repeat(60)}`)
  console.log('  RINGKASAN AKHIR')
  console.log('='.repeat(60))
  if (sumEth.total > 0) console.log(`  Ethereum — Lulus: ${sumEth.pass}/${sumEth.total} (${sumEth.rate.toFixed(1)}%) | Latency: ${sumEth.avgLat.toFixed(1)}ms`)
  if (sumFab.total > 0) console.log(`  Fabric   — Lulus: ${sumFab.pass}/${sumFab.total} (${sumFab.rate.toFixed(1)}%) | Latency: ${sumFab.avgLat.toFixed(1)}ms`)
  console.log(`  Deteksi Tampering: ${detected}/30`)
  console.log('='.repeat(60))
  console.log(`\n  Selesai. File: ${fname}\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
