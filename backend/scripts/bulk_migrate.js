/**
 * bulk_migrate_to_fabric.js
 * ==========================
 * Migrasi MASSAL data Ethereum → Hyperledger Fabric
 * Langsung ke DB + Fabric SDK (bypass HTTP API) untuk kecepatan maksimal
 *
 * Cara pakai:
 *   node bulk_migrate_to_fabric.js               ← semua data Ethereum
 *   node bulk_migrate_to_fabric.js --size 5000   ← 5000 data
 *   node bulk_migrate_to_fabric.js --workers 20  ← 20 parallel workers
 *   node bulk_migrate_to_fabric.js --dry-run      ← simulasi tanpa submit ke Fabric
 *
 * Estimasi waktu:
 *   17.000 data × ~200ms/tx ÷ 20 workers ≈ ~170 detik (~3 menit)
 *
 * PENTING: Fabric network harus aktif di WSL2 sebelum menjalankan ini.
 *          Script ini TIDAK membutuhkan backend server berjalan.
 */

const { Client, Pool } = require('pg')
const { connect, hash, signers } = require('@hyperledger/fabric-gateway')
const grpc   = require('@grpc/grpc-js')
const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')
const ExcelJS= require('exceljs')
const yargs  = require('yargs')
const { hideBin } = require('yargs/helpers')
require('dotenv').config({ path: path.join(__dirname, '../backend/.env') })

// ─────────────────────────────────────────────
// KONFIGURASI — samakan dengan backend/.env
// ─────────────────────────────────────────────
const DB = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5433'),
  database: process.env.DB_NAME     || 'blockchain_academic',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'blockchain123',
  max: 20,  // connection pool size
}

const FABRIC = {
  wslUser:      process.env.WSL_USER             || 'involute',
  peerEndpoint: process.env.FABRIC_PEER_ENDPOINT || 'localhost:7051',
  peerAlias:    'peer0.org1.example.com',
  channel:      process.env.FABRIC_CHANNEL_NAME  || 'academicchannel',
  chaincode:    process.env.FABRIC_CHAINCODE_NAME|| 'academic',
  mspId:        process.env.FABRIC_MSP_ID        || 'Org1MSP',
}

// Path ke sertifikat Fabric (samakan dengan fabricService.js)
const FABRIC_BASE = 'C:\\Users\\Acer\\Downloads\\TugasAkhir\\fabric-certs\\organizations'
const CERT_PATH   = path.join(FABRIC_BASE, 'peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp')
const TLS_CERT    = path.join(FABRIC_BASE, 'peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt')

// ─────────────────────────────────────────────
// HASH — identik dengan hashService.js backend
// ─────────────────────────────────────────────
function generateAcademicHash(data) {
  const str = [
    String(data.student_id).trim(),
    String(data.course_code).trim(),
    String(data.grade).trim(),
    parseFloat(data.gpa_point).toFixed(2),
    String(data.semester).trim(),
    String(data.academic_year).trim(),
    String(data.attendance || 'always').trim(),
  ].join('|')
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex')
}

// ─────────────────────────────────────────────
// FABRIC SDK — singleton gateway
// ─────────────────────────────────────────────
let _gateway   = null
let _grpcClient= null
let _contract  = null

function getPrivateKey() {
  const ks    = path.join(CERT_PATH, 'keystore')
  const files = fs.readdirSync(ks)
  const kf    = files.find(f => f.endsWith('_sk'))
  if (!kf) throw new Error(`Private key tidak ditemukan di: ${ks}`)
  return fs.readFileSync(path.join(ks, kf))
}

async function getFabricContract() {
  if (_contract) return _contract

  const tlsCert    = fs.readFileSync(TLS_CERT)
  const credentials= grpc.credentials.createSsl(tlsCert)
  _grpcClient      = new grpc.Client(FABRIC.peerEndpoint, credentials, {
    'grpc.ssl_target_name_override': FABRIC.peerAlias,
  })

  const certPem   = fs.readFileSync(path.join(CERT_PATH, 'signcerts', 'cert.pem'))
  const privateKey= crypto.createPrivateKey(getPrivateKey())
  const signer    = signers.newPrivateKeySigner(privateKey)

  _gateway  = connect({
    client  : _grpcClient,
    identity: { mspId: FABRIC.mspId, credentials: certPem },
    signer,
    hash    : hash.sha256,
    evaluateOptions    : () => ({ deadline: Date.now() + 5000 }),
    endorseOptions     : () => ({ deadline: Date.now() + 30000 }),
    submitOptions      : () => ({ deadline: Date.now() + 5000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
  })

  _contract = _gateway.getNetwork(FABRIC.channel).getContract(FABRIC.chaincode)
  console.log(`  ✓ Fabric terhubung: ${FABRIC.peerEndpoint} | ${FABRIC.channel} | ${FABRIC.chaincode}`)
  return _contract
}

function closeFabric() {
  if (_gateway)    { _gateway.close();    _gateway = null;    _contract = null }
  if (_grpcClient) { _grpcClient.close(); _grpcClient = null }
}

// ─────────────────────────────────────────────
// SUBMIT SATU RECORD KE FABRIC + INSERT DB
// ─────────────────────────────────────────────
async function processOne(rec, pool, contract, dryRun) {
  const t = Date.now()

  // Verifikasi hash — pastikan hash di DB masih valid
  const recalcHash = generateAcademicHash(rec)
  if (recalcHash !== rec.data_hash) {
    // Hash mismatch — skip tapi catat
    return { success: false, error: `hash_mismatch: db=${rec.data_hash.slice(0,8)} calc=${recalcHash.slice(0,8)}`, latencyMs: 0 }
  }

  // Cek apakah sudah ada di Fabric (hindari duplikat)
  const dupCheck = await pool.query(
    `SELECT id FROM academic_records
     WHERE student_id=$1 AND course_code=$2 AND semester=$3 AND academic_year=$4 AND platform='fabric'
     LIMIT 1`,
    [rec.student_id, rec.course_code, rec.semester, rec.academic_year]
  )
  if (dupCheck.rows.length > 0) {
    return { success: false, error: 'sudah_ada_di_fabric', latencyMs: 0, skipped: true }
  }

  if (dryRun) {
    // Dry run — tidak submit ke blockchain, hanya simulasi
    await new Promise(r => setTimeout(r, 10))
    return { success: true, txId: `dryrun_${rec.id}`, latencyMs: Date.now() - t }
  }

  try {
    const fabricRecordId = String(rec.id)

    // submitTransaction return Uint8Array (response dari chaincode)
    // tx_id tidak bisa diambil langsung dari sini di fabric-gateway v1
    // Solusi: pakai kombinasi timestamp + record id sebagai identifier
    await contract.submitTransaction(
      'RecordAcademicData',
      fabricRecordId,
      String(rec.student_id),
      String(rec.data_hash)
    )

    const latencyMs  = Date.now() - t
    // tx_id Fabric = format yang bisa diidentifikasi tapi bukan hash asli
    const fabricTxId = `fabric_${rec.id}`

    await pool.query(`
      INSERT INTO academic_records
        (student_id, student_name, course_code, course_name, grade, gpa_point,
        semester, academic_year, attendance, data_hash, tx_id, platform, status, recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'fabric','confirmed',$12)
      ON CONFLICT DO NOTHING
    `, [
      rec.student_id, rec.student_name,
      rec.course_code, rec.course_name || rec.course_code,
      rec.grade, rec.gpa_point,
      rec.semester, rec.academic_year,
      rec.attendance || 'always',
      rec.data_hash, fabricTxId,
      rec.recorded_by || 1,
    ])

    return { success: true, txId: fabricTxId, latencyMs }

  } catch (err) {
    
    if (err.message?.includes('sudah ada') || err.message?.includes('already')) {
      return { success: false, error: err.message.slice(0,80), latencyMs: Date.now() - t, skipped: true }
    }
    return { success: false, error: err.message?.slice(0, 120), latencyMs: Date.now() - t }
  }
}

// ─────────────────────────────────────────────
// WORKER POOL — proses N record secara paralel
// ─────────────────────────────────────────────
async function runWithWorkers(records, pool, contract, workers, dryRun, onProgress) {
  const results  = new Array(records.length)
  const queue    = records.map((r, i) => ({ rec: r, idx: i }))
  let   ptr      = 0

  async function worker() {
    while (ptr < queue.length) {
      const { rec, idx } = queue[ptr++]
      results[idx] = await processOne(rec, pool, contract, dryRun)
      onProgress(idx + 1, results[idx])
    }
  }

  // Jalankan N worker sekaligus
  await Promise.all(Array.from({ length: workers }, worker))
  return results
}

// ─────────────────────────────────────────────
// EXPORT EXCEL
// ─────────────────────────────────────────────
async function exportExcel(records, results, filename) {
  const wb   = new ExcelJS.Workbook()
  const ws   = wb.addWorksheet('Migrasi Bulk ke Fabric')
  const NAVY = { type:'pattern', pattern:'solid', fgColor:{argb:'FF1A2744'} }
  const GREEN= { type:'pattern', pattern:'solid', fgColor:{argb:'FFD4EDDA'} }
  const RED  = { type:'pattern', pattern:'solid', fgColor:{argb:'FFF8D7DA'} }
  const SKIP = { type:'pattern', pattern:'solid', fgColor:{argb:'FFFFF3CD'} }
  const wFont= { color:{argb:'FFFFFFFF'}, bold:true, name:'Times New Roman', size:11 }
  const nFont= { name:'Times New Roman', size:11 }
  const ctr  = { horizontal:'center', vertical:'middle', wrapText:true }
  const brd  = { top:{style:'thin'}, bottom:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'} }

  ws.columns = [
    {width:5},{width:22},{width:14},{width:10},{width:8},
    {width:8},{width:14},{width:16},{width:12},{width:12},
  ]

  const applyHeader = (row, n) => {
    for (let c=1;c<=n;c++) { const cell=row.getCell(c); cell.fill=NAVY; cell.font=wFont; cell.alignment=ctr; cell.border=brd }
  }
  const applyRow = (row, n, fill) => {
    for (let c=1;c<=n;c++) { const cell=row.getCell(c); if(fill)cell.fill=fill; cell.font=nFont; cell.alignment=ctr; cell.border=brd }
  }

  const title = ws.addRow(['LAPORAN MIGRASI BULK ETHEREUM → HYPERLEDGER FABRIC'])
  ws.mergeCells('A1:J1'); applyHeader(title, 10)
  ws.addRow([])
  applyHeader(ws.addRow(['No','Student ID','Course Code','Semester','Grade','GPA','Academic Year','Fabric Tx ID','Latency (ms)','Status']), 10)

  let ok=0, fail=0, skip=0
  records.forEach((rec, i) => {
    const r   = results[i]
    const fill= r?.skipped ? SKIP : r?.success ? GREEN : RED
    const status = r?.skipped ? 'SKIP' : r?.success ? 'BERHASIL' : 'GAGAL'
    if (r?.skipped) skip++
    else if (r?.success) ok++
    else fail++

    const row = ws.addRow([
      i+1, rec.student_id, rec.course_code, rec.semester,
      rec.grade, parseFloat(rec.gpa_point).toFixed(2), rec.academic_year,
      r?.txId ? r.txId.slice(0,30)+'...' : (r?.error||'—'),
      r?.latencyMs || 0, status,
    ])
    applyRow(row, 10, fill)
  })

  ws.addRow([])
  ws.addRow([`Total: ${records.length} | Berhasil: ${ok} | Skip (duplikat): ${skip} | Gagal: ${fail}`])

  await wb.xlsx.writeFile(filename)
  return { ok, fail, skip }
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('size',    { type:'number',  default: 999999, description: 'Jumlah record (default: semua)' })
    .option('workers', { type:'number', default: 5, description: 'Parallel workers' })
    .option('offset',  { type:'number',  default: 0,      description: 'Mulai dari record ke-N' })
    .option('dry-run', { type:'boolean', default: false,  description: 'Simulasi tanpa submit ke Fabric' })
    .argv

  const dryRun = argv['dry-run']

  console.log(`\n${'='.repeat(60)}`)
  console.log('  BULK MIGRATE ETHEREUM → HYPERLEDGER FABRIC')
  console.log('  Tugas Akhir — Prodi Informatika UAJY')
  console.log(`  ${new Date().toLocaleString('id-ID')}`)
  console.log('='.repeat(60))
  if (dryRun) console.log('  ⚠  MODE DRY RUN — tidak ada data yang ditulis ke blockchain/DB')
  console.log(`  Workers : ${argv.workers}`)
  console.log(`  Max size: ${argv.size === 999999 ? 'semua' : argv.size}`)
  console.log(`  Offset  : ${argv.offset}`)

  // 1. Koneksi DB pool
  console.log('\n[1] Menghubungkan ke PostgreSQL...')
  const pool = new Pool(DB)
  await pool.query('SELECT 1')
  console.log('  ✓ PostgreSQL terhubung')

  // 2. Koneksi Fabric
  console.log('\n[2] Menghubungkan ke Fabric...')
  let contract
  try {
    contract = await getFabricContract()
  } catch (e) {
    console.log(`  ✗ Gagal konek ke Fabric: ${e.message}`)
    console.log('    Pastikan Fabric network aktif di WSL2')
    await pool.end()
    process.exit(1)
  }

  // 3. Ambil semua record Ethereum
  console.log('\n[3] Mengambil record Ethereum dari database...')
  const { rows: records } = await pool.query(`
  SELECT id, student_id, student_name, course_code, course_name,
         grade, gpa_point, semester, academic_year, attendance,
         data_hash, tx_id, recorded_by
  FROM academic_records
  WHERE status = 'confirmed'
    AND tx_id IS NOT NULL
    AND platform = 'ethereum'
    AND block_number >= 7000000  -- hanya yang sudah asli Sepolia
  ORDER BY id ASC
  LIMIT $1 OFFSET $2
`, [argv.size, argv.offset])

  if (!records.length) {
    console.log('  ✗ Tidak ada record Ethereum ditemukan.')
    await pool.end(); closeFabric(); process.exit(1)
  }
  console.log(`  ✓ ${records.length.toLocaleString()} record ditemukan`)

  // Estimasi waktu
  const estSec = Math.ceil(records.length * 0.25 / argv.workers)
  console.log(`  ⏱  Estimasi waktu: ~${estSec} detik (~${Math.ceil(estSec/60)} menit) dengan ${argv.workers} workers`)

  // 4. Proses dengan progress bar
  console.log(`\n[4] Memproses ${records.length.toLocaleString()} record...\n`)

  let okCount   = 0
  let failCount = 0
  let skipCount = 0
  const startTime = Date.now()

  // Progress callback
  function onProgress(done, result) {
    if (result?.skipped)    skipCount++
    else if (result?.success) okCount++
    else                     failCount++

    // Tampilkan progress setiap 100 record atau saat selesai
    if (done % 100 === 0 || done === records.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const pct     = (done / records.length * 100).toFixed(1)
      const tps     = (okCount / ((Date.now() - startTime) / 1000)).toFixed(1)
      process.stdout.write(
        `\r  [${String(done).padStart(6)}/${records.length}] ${pct.padStart(5)}% | ✓${okCount} ✗${failCount} ⊘${skipCount} | ${elapsed}s | ${tps} tx/s    `
      )
    }
  }

  const results = await runWithWorkers(records, pool, contract, argv.workers, dryRun, onProgress)
  console.log('\n')

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  // 5. Export Excel
  console.log('[5] Menyimpan laporan Excel...')
  const ts    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const fname = `hasil_bulk_migrate_fabric_${ts}.xlsx`
  const { ok, fail, skip } = await exportExcel(records, results, fname)

  // 6. Ringkasan
  console.log(`\n${'='.repeat(60)}`)
  console.log('  RINGKASAN MIGRASI')
  console.log('='.repeat(60))
  console.log(`  Total diproses   : ${records.length.toLocaleString()}`)
  console.log(`  ✓ Berhasil       : ${ok.toLocaleString()} (${(ok/records.length*100).toFixed(1)}%)`)
  console.log(`  ⊘ Skip (duplikat): ${skip.toLocaleString()}`)
  console.log(`  ✗ Gagal          : ${fail.toLocaleString()}`)
  console.log(`  Waktu total      : ${elapsed} detik`)
  console.log(`  Throughput       : ${(ok / parseFloat(elapsed)).toFixed(1)} tx/s`)
  console.log(`  Laporan          : ${fname}`)
  console.log('='.repeat(60))

  if (ok > 0) {
    console.log(`\n  Sekarang jalankan:`)
    console.log(`    node integrity_testing.js --platform fabric --size ${ok}`)
  }
  if (fail > 0) {
    console.log(`\n  Ada ${fail} yang gagal. Coba jalankan ulang dengan --offset untuk skip yang sudah berhasil,`)
    console.log(`  atau cek laporan Excel untuk detail error.`)
  }
  console.log()

  // Cleanup
  await pool.end()
  closeFabric()
}

main().catch(async e => {
  console.error('\n✗ Fatal error:', e.message)
  closeFabric()
  process.exit(1)
})
