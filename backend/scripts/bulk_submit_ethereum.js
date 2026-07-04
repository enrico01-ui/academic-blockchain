/**
 * bulk_submit_to_ethereum.js — FIXED VERSION
 */

const { ethers } = require('ethers')
const { Pool }   = require('pg')
const crypto     = require('crypto')
const ExcelJS    = require('exceljs')
const path       = require('path')
const yargs      = require('yargs')
const { hideBin }= require('yargs/helpers')
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const DB_CONFIG = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5433'),
  database: process.env.DB_NAME     || 'blockchain_academic',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'blockchain123',
  max: 10,
}

const ABI = [
  "function recordAcademicData(string recordId, string studentId, bytes32 dataHash) external",
  "function recordExistsCheck(string recordId) external view returns (bool)",
  "function totalRecords() external view returns (uint256)",
]

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

function hashToBytes32(hex) {
  const h = hex.startsWith('0x') ? hex : '0x' + hex
  if (h.length !== 66) throw new Error(`Hash tidak valid: ${h}`)
  return h
}

function setupEthereum() {
  const provider = new ethers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL)
  const wallet   = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider)
  const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, wallet)
  return { provider, wallet, contract }
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('size',    { type: 'number',  default: 5000,  description: 'Jumlah record' })
    .option('offset',  { type: 'number',  default: 0,     description: 'Skip N record pertama' })
    .option('batch',   { type: 'number',  default: 10,    description: 'Ukuran batch' })
    .option('dry-run', { type: 'boolean', default: false, description: 'Simulasi tanpa kirim tx' })
    .option('source',  { type: 'string',  default: 'all', description: 'Filter: all|DS1|DS2|DS3|DS4|SPAM' })
    .argv

  const dryRun    = argv['dry-run']
  const batchSize = argv.batch

  console.log(`\n${'='.repeat(62)}`)
  console.log('  BULK SUBMIT DATA AKADEMIK → ETHEREUM SEPOLIA')
  console.log(`  ${new Date().toLocaleString('id-ID')}`)
  console.log('='.repeat(62))
  if (dryRun) console.log('  ⚠  MODE DRY RUN')
  console.log(`  Target: ${argv.size.toLocaleString()} | Offset: ${argv.offset} | Batch: ${batchSize} | Sumber: ${argv.source}`)

  console.log('\n[1] Menghubungkan ke jaringan...')
  const pool = new Pool(DB_CONFIG)
  await pool.query('SELECT 1')
  console.log('  ✓ PostgreSQL terhubung')

  const { provider, wallet, contract } = setupEthereum()
  const network = await provider.getNetwork()
  console.log(`  ✓ Ethereum: ${network.name} (chainId: ${network.chainId})`)
  console.log(`  ✓ Wallet  : ${wallet.address}`)

  const balance = await provider.getBalance(wallet.address)
  const ethBal  = parseFloat(ethers.formatEther(balance))
  console.log(`  ✓ Saldo   : ${ethBal.toFixed(4)} ETH`)

  if (ethBal < 0.05 && !dryRun) {
    console.log('  ✗ Saldo terlalu rendah! Minimal 0.05 ETH.')
    process.exit(1)
  }

  // FIX Bug 2: Query SQL yang benar — hanya ambil yang belum pernah masuk blockchain
  console.log(`\n[2] Mengambil data dari database...`)
  let sourceFilter = ''
  if (argv.source !== 'all') {
    sourceFilter = `AND student_id LIKE '${argv.source}_%'`
  }

  // Ganti query di bagian [2] bulk_submit_to_ethereum.js
const { rows: records } = await pool.query(`
  SELECT id, student_id, student_name, course_code, course_name,
         grade, gpa_point, semester, academic_year, attendance,
         data_hash, tx_id, block_number
  FROM academic_records
  WHERE platform = 'ethereum'
    AND (
      status = 'pending_blockchain'
      OR (
        status = 'confirmed'
        AND block_number < 7000000
      )
    )
    ${sourceFilter}
  ORDER BY id ASC
  LIMIT $1 OFFSET $2
`, [argv.size, argv.offset])

  if (!records.length) {
    console.log('  ✗ Tidak ada record ditemukan.')
    await pool.end(); process.exit(1)
  }
  console.log(`  ✓ ${records.length.toLocaleString()} record ditemukan`)

  let hashMismatch = 0
  const validRecords = records.filter(rec => {
    const recalc = generateAcademicHash(rec)
    if (recalc !== rec.data_hash) { hashMismatch++; return false }
    return true
  })
  if (hashMismatch > 0) console.log(`  ⚠  ${hashMismatch} record hash mismatch — di-skip`)
  console.log(`  ✓ ${validRecords.length.toLocaleString()} record valid`)

  console.log('\n[3] Mengambil nonce awal...')
  let currentNonce = await provider.getTransactionCount(wallet.address, 'pending')
  console.log(`  ✓ Nonce awal: ${currentNonce}`)

  // FIX Bug 3: estimasi gas sekali di awal
  let GAS_LIMIT = 200000n
  if (!dryRun) {
    try {
      const sample = validRecords[0]
      const est = await contract.recordAcademicData.estimateGas(
        String(sample.id), String(sample.student_id), hashToBytes32(sample.data_hash)
      )
      GAS_LIMIT = est * 130n / 100n // buffer 30%
      console.log(`  ✓ Gas limit: ${GAS_LIMIT} (estimasi: ${est})`)
    } catch {
      console.log(`  ⚠ Estimasi gas gagal, pakai default: ${GAS_LIMIT}`)
    }
  }

  console.log(`\n[4] Submit ${validRecords.length.toLocaleString()} tx ke Ethereum...\n`)
  console.log(`${'─'.repeat(62)}`)

  const results   = []
  let okCount     = 0
  let failCount   = 0
  let skipCount   = 0
  const startTime = Date.now()

  for (let bStart = 0; bStart < validRecords.length; bStart += batchSize) {
    const batch   = validRecords.slice(bStart, bStart + batchSize)
    const batchNo = Math.floor(bStart / batchSize) + 1
    const batchT  = Date.now()

    console.log(`\n  Batch ${batchNo} — ${batch.length} record (nonce awal: ${currentNonce})`)

    // FASE 1: kirim semua tx batch ke mempool
    const pendingTxs = []

    for (const rec of batch) {
      if (dryRun) {
        pendingTxs.push({ rec, tx: null, nonce: currentNonce++, t: Date.now() })
        continue
      }

      const nonce = currentNonce
      const t     = Date.now()

      try {
        // FIX Bug 4: hapus recordExistsCheck dari sini
        // DB query sudah filter yang belum ada — hemat 1 RPC call per record
        const bytes32Hash = hashToBytes32(rec.data_hash)

        const tx = await contract.recordAcademicData(
          String(rec.id),
          String(rec.student_id),
          bytes32Hash,
          { nonce, gasLimit: GAS_LIMIT }
        )

        currentNonce++ // FIX Bug 1: increment HANYA kalau tx berhasil masuk mempool
        process.stdout.write(`  → sent nonce ${nonce}: ${tx.hash.slice(0, 20)}...\n`)
        pendingTxs.push({ rec, tx, nonce, t })

      } catch (err) {
        // FIX Bug 1: JANGAN increment nonce kalau tx gagal masuk mempool
        const isNonceErr = err.message?.toLowerCase().includes('nonce') ||
                           err.message?.toLowerCase().includes('replacement')

        if (isNonceErr) {
          console.warn(`  ⚠ Nonce error! Sync ulang dari jaringan...`)
          currentNonce = await provider.getTransactionCount(wallet.address, 'pending')
          console.log(`  ✓ Nonce baru: ${currentNonce}`)
        }

        failCount++
        process.stdout.write(`  ✗ GAGAL_SEND nonce ${nonce}: ${err.message?.slice(0, 60)}\n`)
        results.push({
          no: bStart + pendingTxs.length + 1,
          studentId: rec.student_id, courseCode: rec.course_code,
          ethTxHash: '', blockNumber: '', latencyMs: Date.now() - t,
          status: 'GAGAL_SEND', error: err.message?.slice(0, 80)
        })
      }
    }

    // FASE 2: tunggu konfirmasi semua tx dalam batch
    await Promise.all(
      pendingTxs.map(async ({ rec, tx, nonce, t }, idx) => {
        const no = bStart + idx + 1

        if (dryRun) {
          await new Promise(r => setTimeout(r, 50))
          okCount++
          results.push({
            no, studentId: rec.student_id, courseCode: rec.course_code,
            ethTxHash: `dryrun_${rec.id}`, blockNumber: 'N/A',
            latencyMs: 50, status: 'DRY-RUN', error: ''
          })
          return
        }

        try {
          const receipt   = await tx.wait(1)
          const latencyMs = Date.now() - t
          okCount++

          await pool.query(`
            UPDATE academic_records
            SET tx_id=$1, block_number=$2, status='confirmed', updated_at=NOW()
            WHERE id=$3
          `, [receipt.hash, receipt.blockNumber, rec.id])

          process.stdout.write(
            `  ✓ [${String(no).padStart(5)}/${validRecords.length}] ${rec.student_id.slice(0,16).padEnd(16)} | block ${receipt.blockNumber} (${(latencyMs/1000).toFixed(1)}s)\n`
          )
          results.push({
            no, studentId: rec.student_id, courseCode: rec.course_code,
            ethTxHash: receipt.hash, blockNumber: receipt.blockNumber,
            latencyMs, status: 'BERHASIL', error: ''
          })

        } catch (waitErr) {
          const latencyMs = Date.now() - t
          failCount++

          await pool.query(`
            UPDATE academic_records
            SET tx_id=$1, status='pending_blockchain', updated_at=NOW()
            WHERE id=$2
          `, [tx.hash, rec.id])

          process.stdout.write(
            `  ✗ [${String(no).padStart(5)}/${validRecords.length}] ${rec.student_id.slice(0,16).padEnd(16)} | ${waitErr.message?.slice(0,40)}\n`
          )
          results.push({
            no, studentId: rec.student_id, courseCode: rec.course_code,
            ethTxHash: tx.hash, blockNumber: '',
            latencyMs, status: 'PENDING', error: waitErr.message?.slice(0, 80)
          })
        }
      })
    )

    // Progress
    const elapsed  = ((Date.now() - startTime) / 1000).toFixed(0)
    const batchSec = ((Date.now() - batchT) / 1000).toFixed(1)
    const done     = Math.min(bStart + batch.length, validRecords.length)
    const pct      = (done / validRecords.length * 100).toFixed(1)
    const etaMin   = done > 0
      ? Math.ceil((validRecords.length - done) * ((Date.now() - startTime) / done) / 1000 / 60)
      : 0

    console.log(`${'─'.repeat(62)}`)
    console.log(`  Batch ${batchNo} selesai ${batchSec}s | ${done}/${validRecords.length} (${pct}%) | ETA: ~${etaMin} menit`)
    console.log(`  ✓ ${okCount} berhasil | ✗ ${failCount} gagal | ⏭ ${skipCount} skip | Total: ${elapsed}s`)
    console.log(`${'─'.repeat(62)}`)

    // Jeda antar batch supaya node RPC tidak kewalahan
    if (bStart + batchSize < validRecords.length) {
      await new Promise(r => setTimeout(r, 2000))
    }
  }

  // Export Excel (sama seperti sebelumnya)
  console.log('\n[5] Menyimpan laporan Excel...')
  const wb   = new ExcelJS.Workbook()
  const ws   = wb.addWorksheet('Bulk Submit Ethereum')
  const NAVY = { type:'pattern', pattern:'solid', fgColor:{argb:'FF1A2744'} }
  const GREEN= { type:'pattern', pattern:'solid', fgColor:{argb:'FFD4EDDA'} }
  const RED  = { type:'pattern', pattern:'solid', fgColor:{argb:'FFF8D7DA'} }
  const YELL = { type:'pattern', pattern:'solid', fgColor:{argb:'FFFFF3CD'} }
  const wFont= { color:{argb:'FFFFFFFF'}, bold:true, name:'Times New Roman', size:11 }
  const nFont= { name:'Times New Roman', size:11 }
  const ctr  = { horizontal:'center', vertical:'middle', wrapText:true }
  const brd  = { top:{style:'thin'}, bottom:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'} }

  ws.columns = [{width:6},{width:22},{width:14},{width:12},{width:66},{width:14},{width:14},{width:12}]
  const applyH = (row, n) => { for(let c=1;c<=n;c++){const cell=row.getCell(c);cell.fill=NAVY;cell.font=wFont;cell.alignment=ctr;cell.border=brd} }
  const applyR = (row, n, fill) => { for(let c=1;c<=n;c++){const cell=row.getCell(c);if(fill)cell.fill=fill;cell.font=nFont;cell.alignment=ctr;cell.border=brd} }

  const title = ws.addRow(['LAPORAN BULK SUBMIT DATA AKADEMIK → ETHEREUM SEPOLIA'])
  ws.mergeCells('A1:H1'); applyH(title, 8)
  ws.addRow([])
  applyH(ws.addRow(['No','Student ID','Course Code','Block Number','Tx Hash','Latency (ms)','Durasi (s)','Status']), 8)

  results.forEach(r => {
    const fill = r.status === 'BERHASIL' ? GREEN : r.status === 'PENDING' ? YELL : RED
    const row  = ws.addRow([r.no, r.studentId, r.courseCode, r.blockNumber,
      r.ethTxHash, r.latencyMs, (r.latencyMs/1000).toFixed(1), r.status])
    applyR(row, 8, fill)
  })
  ws.addRow([])
  ws.addRow([`Total: ${results.length} | Berhasil: ${okCount} | Gagal: ${failCount} | Skip: ${skipCount}`])

  const ts    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const fname = `hasil_bulk_submit_ethereum_${ts}.xlsx`
  await wb.xlsx.writeFile(fname)
  console.log(`  ✓ Laporan: ${fname}`)

  // Ringkasan
  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1)
  const finalBal = dryRun ? ethBal : parseFloat(ethers.formatEther(await provider.getBalance(wallet.address)))

  console.log(`\n${'='.repeat(62)}`)
  console.log('  RINGKASAN AKHIR')
  console.log('='.repeat(62))
  console.log(`  Total    : ${validRecords.length.toLocaleString()}`)
  console.log(`  ✓ Berhasil: ${okCount} (${(okCount/validRecords.length*100).toFixed(1)}%)`)
  console.log(`  ✗ Gagal   : ${failCount}`)
  console.log(`  ⏳ Pending : ${results.filter(r=>r.status==='PENDING').length}`)
  console.log(`  Waktu     : ${totalSec}s (~${(totalSec/60).toFixed(1)} menit)`)
  if (!dryRun) console.log(`  Saldo akhir: ${finalBal.toFixed(4)} ETH`)
  console.log('='.repeat(62))

  if (okCount > 0) {
    console.log(`\n  Lanjut batch berikutnya:`)
    console.log(`    node bulk_submit_to_ethereum.js --size ${argv.size} --offset ${argv.offset + validRecords.length}`)
  }

  await pool.end()
}

main().catch(e => { console.error('\n✗ Fatal:', e.message); process.exit(1) })