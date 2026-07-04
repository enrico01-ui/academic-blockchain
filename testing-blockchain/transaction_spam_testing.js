/**
 * transaction_spam_testing.js
 * ============================
 * Pengujian Spam Transaksi Langsung ke Node Blockchain
 * Tugas Akhir: Perbandingan Ethereum Testnet (Sepolia) dan Hyperledger Fabric
 *
 * Cara pakai:
 *   node transaction_spam_testing.js --platform fabric --mode both
 *   node transaction_spam_testing.js --platform ethereum --mode both
 *   node transaction_spam_testing.js --platform ethereum --mode sequential --seq-count 50
 */

const axios   = require('axios')
const ExcelJS = require('exceljs')
const yargs   = require('yargs')
const { hideBin } = require('yargs/helpers')

// ─────────────────────────────────────────────
// KONFIGURASI
// ─────────────────────────────────────────────
const CONFIG = {
  apiUrl:      process.env.API_URL      || 'http://139.59.240.82:3000/api',
  apiUsername:  'admin',
  apiPassword:  'admin123',

  // ── Hyperledger Fabric ────────────────────
  // Tidak ada rate limit, block time <1 detik
  fabricSeqCount:  500,  // 500 tx sequential
  fabricConcCount: 100,  // 100 tx concurrent
  fabricWorkers:   10,   // 10 tx per batch concurrent
  fabricDelay:     0,    // ms antar tx (tidak perlu delay)
  fabricTimeout:   30000,

  // ── Ethereum Sepolia ──────────────────────
  // Dibatasi karena:
  //  - Infura/Alchemy free tier: ~100k req/hari, max 10 req/s
  //  - Block time ~12 detik per konfirmasi on-chain
  //  - Nonce conflict jika concurrent terlalu banyak dari 1 wallet
  //  - Faucet ETH testnet terbatas
  ethereumSeqCount:  50,    // cukup untuk data TA (~50 menit dengan delay)
  ethereumConcCount: 20,    // max 10 concurrent (1 batch kecil)
  ethereumWorkers:   5,     // max 5 tx per batch — hindari nonce conflict
  ethereumDelay:     500,  
  ethereumTimeout:   60000, // 60 detik — Sepolia bisa ~12 detik mining
}

// ─────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────
async function getToken() {
  try {
    const res = await axios.post(`${CONFIG.apiUrl}/auth/login`,
      { username: CONFIG.apiUsername, password: CONFIG.apiPassword },
      { timeout: 10000 })
    return res.data?.token || null
  } catch (e) {
    console.log(`  [!] Login gagal: ${e.message}`)
    return null
  }
}

function randomChoice(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function nowStr() { return new Date().toLocaleTimeString('id-ID', { hour12: false }) }

// ─────────────────────────────────────────────
// KIRIM SATU TRANSAKSI
// ─────────────────────────────────────────────
async function sendTransaction(token, txNo, platform) {
  const GRADES  = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C']
  const GPA_MAP = { 'A':4.00,'A-':3.70,'B+':3.30,'B':3.00,'B-':2.70,'C+':2.30,'C':2.00 }
  const COURSES = ['Pemrograman Web','Basis Data','Jaringan Komputer','Kecerdasan Buatan','Keamanan Sistem']
  const CODES   = ['IF-301','IF-302','IF-303','IF-401','IF-402']
  const ATTEND  = ['always','sometimes','never']

  // Ethereum butuh timeout lebih panjang — menunggu block mining ~12 detik
  const timeout = platform === 'ethereum' ? CONFIG.ethereumTimeout : CONFIG.fabricTimeout

  const grade = randomChoice(GRADES)
  const payload = {
    student_id:    `SPAM_${platform === 'ethereum' ? 'ETH' : 'FAB'}_${String(txNo).padStart(4,'0')}`,
    student_name:  `Mahasiswa Spam ${txNo}`,
    course_code:   randomChoice(CODES),
    course_name:   randomChoice(COURSES),
    grade,
    gpa_point:     GPA_MAP[grade] || 3.00,
    semester:      randomInt(1, 8),
    academic_year: '2024/2025',
    attendance:    randomChoice(ATTEND),
  }

  const t = Date.now()
  try {
    const res = await axios.post(`${CONFIG.apiUrl}/academic/record`, payload, {
      headers: { Authorization: `Bearer ${token}` },
      timeout,
    })
    const latency = Date.now() - t
    const txId    = res.data?.data?.tx_id || ''
    return {
      txNo, studentId: payload.student_id,
      success: [200, 201].includes(res.status),
      statusCode: res.status,
      latencyMs: latency,
      txId: txId.length > 20 ? txId.slice(0, 20) + '...' : txId,
      timestamp: nowStr(), error: '',
    }
  } catch (e) {
    // Deteksi nonce conflict khusus Ethereum — dicatat sebagai temuan TA
    const msg = e.message || ''
    const isNonce = msg.toLowerCase().includes('nonce') ||
                    msg.toLowerCase().includes('replacement') ||
                    msg.toLowerCase().includes('already known')
    return {
      txNo, studentId: payload.student_id,
      success: false,
      statusCode: e.response?.status || 0,
      latencyMs: Date.now() - t,
      txId: '',
      timestamp: nowStr(),
      error: isNonce ? 'NONCE_CONFLICT (Ethereum limitation)' : msg.slice(0, 60),
    }
  }
}

// ─────────────────────────────────────────────
// SEQUENTIAL TEST
// ─────────────────────────────────────────────
async function runSequential(token, platform, count) {
  const delay   = platform === 'ethereum' ? CONFIG.ethereumDelay : CONFIG.fabricDelay
  const estTime = platform === 'ethereum'
    ? `~${Math.ceil(count * (delay + 3000) / 60000)} menit (termasuk konfirmasi block)`
    : `~${Math.ceil(count * 0.5 / 60)} menit`

  console.log(`\n${'='.repeat(60)}`)
  console.log(`  SEQUENTIAL TEST — ${platform.toUpperCase()}`)
  console.log(`  ${count} transaksi berurutan | delay: ${delay}ms/tx`)
  console.log(`  Estimasi durasi: ${estTime}`)
  console.log('='.repeat(60))

  const hasil = []
  let success = 0, fail = 0, nonceConflict = 0, totalLat = 0
  const tMulai = Date.now()

  for (let i = 1; i <= count; i++) {
    const result = await sendTransaction(token, i, platform)
    if (result.success) { success++ } else {
      fail++
      if (result.error.includes('NONCE_CONFLICT')) nonceConflict++
    }
    totalLat += result.latencyMs

    if (i % 10 === 0 || i <= 5 || i === count) {
      const elapsed = (Date.now() - tMulai) / 1000
      const tps     = i / elapsed
      console.log(`  [${String(i).padStart(3)}/${count}] ${result.success ? '✓' : '✗'} ${String(Math.round(result.latencyMs)).padStart(6)}ms | TPS: ${tps.toFixed(2)} | OK: ${success}/${i}`)
    }
    hasil.push(result)
    if (delay > 0) await sleep(delay)
  }

  const elapsed = (Date.now() - tMulai) / 1000
  const avgLat  = totalLat / count
  const tps     = success / elapsed

  console.log(`\n  ✓ Selesai: ${success}/${count} berhasil`)
  console.log(`  TPS: ${tps.toFixed(2)} | Latency avg: ${avgLat.toFixed(0)}ms | Durasi: ${elapsed.toFixed(1)}s`)
  if (nonceConflict > 0) console.log(`  ⚠ Nonce conflict: ${nonceConflict}x (dicatat sebagai limitasi Ethereum)`)

  return { hasil, success, fail, nonceConflict, avgLat, tps, elapsed }
}

// ─────────────────────────────────────────────
// CONCURRENT TEST
// ─────────────────────────────────────────────
async function runConcurrent(token, platform, count) {
  const workers  = platform === 'ethereum' ? CONFIG.ethereumWorkers : CONFIG.fabricWorkers
  const delay    = platform === 'ethereum' ? CONFIG.ethereumDelay   : CONFIG.fabricDelay

  console.log(`\n${'='.repeat(60)}`)
  console.log(`  CONCURRENT TEST — ${platform.toUpperCase()}`)
  console.log(`  ${count} transaksi | ${workers} tx/batch${platform === 'ethereum' ? ' (dibatasi — hindari nonce conflict)' : ''}`)
  console.log('='.repeat(60))

  if (platform === 'ethereum') {
    console.log('  ℹ Ethereum concurrent dibatasi 5 tx/batch untuk menghindari')
    console.log('    nonce conflict. Error NONCE_CONFLICT dicatat sebagai temuan TA.\n')
  }

  const hasil  = []
  let success  = 0, fail = 0, nonceConflict = 0
  const tMulai = Date.now()

  for (let i = 0; i < count; i += workers) {
    const batchEnd = Math.min(i + workers, count)
    const batch    = []
    for (let j = i + 1; j <= batchEnd; j++) {
      batch.push(sendTransaction(token, j, platform))
    }
    const results = await Promise.all(batch)
    for (const r of results) {
      if (r.success) { success++ } else {
        fail++
        if (r.error.includes('NONCE_CONFLICT')) nonceConflict++
      }
      hasil.push(r)
    }
    const elapsed = (Date.now() - tMulai) / 1000
    console.log(`  [${String(batchEnd).padStart(3)}/${count}] Batch selesai | TPS: ${(success/elapsed).toFixed(2)} | OK: ${success}/${hasil.length}`)
    // Jeda antar batch untuk Ethereum (hindari flood nonce)
    if (platform === 'ethereum' && i + workers < count) await sleep(delay)
  }

  hasil.sort((a, b) => a.txNo - b.txNo)
  const elapsed = (Date.now() - tMulai) / 1000
  const lats    = hasil.map(r => r.latencyMs)
  const avgLat  = lats.reduce((s, v) => s + v, 0) / lats.length
  const tps     = success / elapsed

  console.log(`\n  ✓ Selesai: ${success}/${count} berhasil`)
  console.log(`  TPS: ${tps.toFixed(2)} | Latency avg: ${avgLat.toFixed(0)}ms | Durasi: ${elapsed.toFixed(1)}s`)
  if (nonceConflict > 0) console.log(`  ⚠ Nonce conflict: ${nonceConflict}x`)

  return { hasil, success, fail, nonceConflict, avgLat, tps, elapsed }
}

// ─────────────────────────────────────────────
// EXPORT EXCEL
// ─────────────────────────────────────────────
async function exportExcel(platform, mode, hasil, success, fail, nonceConflict, avgLat, tps, elapsed, filename) {
  const wb    = new ExcelJS.Workbook()
  const NAVY  = { type:'pattern', pattern:'solid', fgColor:{argb:'FF1A2744'} }
  const GREEN = { type:'pattern', pattern:'solid', fgColor:{argb:'FFD4EDDA'} }
  const RED   = { type:'pattern', pattern:'solid', fgColor:{argb:'FFF8D7DA'} }
  const GREY  = { type:'pattern', pattern:'solid', fgColor:{argb:'FFF2F2F2'} }
  const YEL   = { type:'pattern', pattern:'solid', fgColor:{argb:'FFFFF3CD'} }

  const wFont  = { color:{argb:'FFFFFFFF'}, bold:true, name:'Times New Roman', size:11 }
  const nFont  = { name:'Times New Roman', size:11 }
  const center = { horizontal:'center', vertical:'middle', wrapText:true }
  const thin   = { style:'thin' }
  const brd    = { top:thin, bottom:thin, left:thin, right:thin }

  function styleHeader(row, n) {
    for (let c=1;c<=n;c++) { const cell=row.getCell(c); cell.fill=NAVY; cell.font=wFont; cell.alignment=center; cell.border=brd }
  }
  function styleRow(row, n, fill) {
    for (let c=1;c<=n;c++) { const cell=row.getCell(c); if(fill) cell.fill=fill; cell.font=nFont; cell.alignment=center; cell.border=brd }
  }

  // ── Sheet 1: Ringkasan ───────────────────
  const ws1 = wb.addWorksheet('Ringkasan')
  ws1.columns = [{ width:38 },{ width:28 }]

  const titleRow = ws1.addRow([`RINGKASAN SPAM TESTING — ${platform.toUpperCase()} (${mode.toUpperCase()})`])
  ws1.mergeCells('A1:B1')
  styleHeader(titleRow, 2)
  ws1.addRow([])
  styleHeader(ws1.addRow(['Parameter','Hasil']), 2)

  const lats = hasil.map(r => r.latencyMs)
  const rows = [
    ['Platform Blockchain',               platform === 'ethereum' ? 'Ethereum Sepolia (Testnet)' : 'Hyperledger Fabric'],
    ['Mode Pengujian',                    mode.toUpperCase()],
    ['Total Transaksi Dikirim',           hasil.length],
    ['Transaksi Berhasil',                success],
    ['Transaksi Gagal',                   fail],
    ['  └ Nonce Conflict (Ethereum)',      nonceConflict || '—'],
    ['Tingkat Keberhasilan (%)',           hasil.length ? `${(success/hasil.length*100).toFixed(1)}%` : '0%'],
    ['Throughput (TPS)',                   tps.toFixed(2)],
    ['Latency Rata-rata (ms)',             avgLat.toFixed(1)],
    ['Latency Minimum (ms)',              lats.length ? Math.min(...lats).toFixed(1) : '—'],
    ['Latency Maksimum (ms)',             lats.length ? Math.max(...lats).toFixed(1) : '—'],
    ['Durasi Total (detik)',              elapsed.toFixed(1)],
    ['Delay Antar Tx (ms)',               platform === 'ethereum' ? `${CONFIG.ethereumDelay}` : '0'],
    ['Timeout per Request (ms)',          platform === 'ethereum' ? `${CONFIG.ethereumTimeout}` : `${CONFIG.fabricTimeout}`],
    ['Tanggal Pengujian',                 new Date().toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'})],
  ]
  rows.forEach((p, i) => styleRow(ws1.addRow(p), 2, i%2===1 ? GREY : null))

  // Catatan khusus Ethereum
  if (platform === 'ethereum') {
    ws1.addRow([])
    const noteRow = ws1.addRow(['Catatan Ethereum Sepolia:',
      'Nonce conflict terjadi saat concurrent — limitasi arsitektur blockchain publik berbasis wallet tunggal. ' +
      'Timeout 60 detik mengakomodasi block time Sepolia ~12 detik.'])
    for (let c=1;c<=2;c++) { const cell=noteRow.getCell(c); cell.fill=YEL; cell.font={...nFont,italic:true}; cell.alignment={...center,wrapText:true}; cell.border=brd }
  }

  // ── Sheet 2: Detail Transaksi ────────────
  const ws2 = wb.addWorksheet('Detail Transaksi')
  ws2.columns = [{width:6},{width:24},{width:12},{width:12},{width:16},{width:24},{width:12},{width:35}]
  const t2t = ws2.addRow([`DETAIL — ${platform.toUpperCase()} ${mode.toUpperCase()}`])
  ws2.mergeCells('A1:H1'); styleHeader(t2t, 8)
  ws2.addRow([])
  styleHeader(ws2.addRow(['No','Student ID','Status','HTTP Code','Latency (ms)','Tx ID','Waktu','Keterangan']), 8)

  hasil.forEach(r => {
    const row = ws2.addRow([
      r.txNo, r.studentId,
      r.success ? 'Berhasil' : 'Gagal',
      r.statusCode, r.latencyMs.toFixed(1),
      r.txId || '—', r.timestamp, r.error || '',
    ])
    styleRow(row, 8, r.success ? GREEN : (r.error.includes('NONCE') ? YEL : RED))
  })

  await wb.xlsx.writeFile(filename)
  console.log(`\n  ✓ Hasil disimpan ke: ${filename}`)
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('platform',    { choices:['ethereum','fabric'], demandOption:true })
    .option('mode',        { choices:['sequential','concurrent','both'], default:'both' })
    .option('seq-count',   { type:'number', default: null, description:'Override jumlah tx sequential' })
    .option('conc-count',  { type:'number', default: null, description:'Override jumlah tx concurrent' })
    .argv

  // Gunakan default per-platform jika tidak di-override
  const seqCount  = argv['seq-count']  || (argv.platform === 'ethereum' ? CONFIG.ethereumSeqCount  : CONFIG.fabricSeqCount)
  const concCount = argv['conc-count'] || (argv.platform === 'ethereum' ? CONFIG.ethereumConcCount : CONFIG.fabricConcCount)

  console.log(`\n${'='.repeat(60)}`)
  console.log('  PENGUJIAN SPAM TRANSAKSI BLOCKCHAIN')
  console.log('  Tugas Akhir — Prodi Informatika UAJY')
  console.log(`  Platform: ${argv.platform.toUpperCase()} | Mode: ${argv.mode.toUpperCase()}`)
  console.log(`  ${new Date().toLocaleString('id-ID')}`)
  console.log('='.repeat(60))

  if (argv.platform === 'ethereum') {
    console.log('\n  ⚠ CATATAN ETHEREUM SEPOLIA:')
    console.log(`  - Sequential: ${seqCount} tx dengan delay ${CONFIG.ethereumDelay}ms/tx`)
    console.log(`  - Concurrent: ${concCount} tx, max ${CONFIG.ethereumWorkers} tx/batch`)
    console.log('  - Timeout: 60 detik/tx (menunggu block mining ~12 detik)')
    console.log('  - Pastikan saldo ETH Sepolia cukup di: https://sepoliafaucet.com')
  } else {
    console.log('\n  ℹ Fabric: tanpa delay, batch 10 tx concurrent')
    console.log(`  - Sequential: ${seqCount} tx | Concurrent: ${concCount} tx`)
  }

  console.log(`\n[1] Login ke backend API...`)
  console.log(`    Pastikan ACTIVE_BLOCKCHAIN=${argv.platform} di .env backend!`)
  const token = await getToken()
  if (!token) { console.log('  GAGAL. Pastikan backend berjalan di localhost:3000'); process.exit(1) }
  console.log('  ✓ Token diperoleh')

  const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)
  const allResults = []

  if (['sequential','both'].includes(argv.mode)) {
    console.log('\n[2a] Sequential Test...')
    const r = await runSequential(token, argv.platform, seqCount)
    allResults.push({ mode:'sequential', ...r })
    await exportExcel(argv.platform,'sequential',r.hasil,r.success,r.fail,r.nonceConflict,r.avgLat,r.tps,r.elapsed,
      `hasil_spam_${argv.platform}_sequential_${ts}.xlsx`)
  }

  if (['concurrent','both'].includes(argv.mode)) {
    console.log('\n[2b] Concurrent Test...')
    const r = await runConcurrent(token, argv.platform, concCount)
    allResults.push({ mode:'concurrent', ...r })
    await exportExcel(argv.platform,'concurrent',r.hasil,r.success,r.fail,r.nonceConflict,r.avgLat,r.tps,r.elapsed,
      `hasil_spam_${argv.platform}_concurrent_${ts}.xlsx`)
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log('  RINGKASAN AKHIR')
  console.log('='.repeat(60))
  for (const { mode, hasil, success, nonceConflict, avgLat, tps } of allResults) {
    const rate = hasil.length ? (success/hasil.length*100).toFixed(1) : 0
    console.log(`  ${mode.toUpperCase().padEnd(12)}: ${success}/${hasil.length} berhasil (${rate}%) | TPS: ${tps.toFixed(2)} | Latency: ${avgLat.toFixed(0)}ms${nonceConflict ? ` | Nonce: ${nonceConflict}x` : ''}`)
  }
  console.log('='.repeat(60))
  console.log('\n  Selesai!\n')
}

main().catch(e => { console.error(e); process.exit(1) })