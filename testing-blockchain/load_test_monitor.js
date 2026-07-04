/**
 * load_test_monitor.js
 * ====================
 * Script Pendamping Load Testing dengan Apache JMeter
 * Tugas Akhir: Perbandingan Ethereum Testnet dan Hyperledger Fabric
 *
 * Cara pakai:
 *   node load_test_monitor.js --eth-10 hasil_eth_10.csv --fab-10 hasil_fab_10.csv [...]
 *
 * PETUNJUK SETUP JMETER: (sama seperti versi Python)
 *   - Download: https://jmeter.apache.org/download_jmeter.cgi
 *   - Jalankan 6 skenario: ETH 10/50/100 users, FAB 10/50/100 users
 *   - Simpan setiap hasil sebagai CSV
 *   - Jalankan script ini untuk parse + export ke Excel
 */

const fs      = require('fs')
const { parse } = require('csv-parse/sync')
const ExcelJS = require('exceljs')
const yargs   = require('yargs')
const { hideBin } = require('yargs/helpers')

// ─────────────────────────────────────────────
// PARSE CSV JMETER
// ─────────────────────────────────────────────
function parseJmeterCsv(filepath) {
  if (!filepath || !fs.existsSync(filepath)) {
    console.log(`  [!] File tidak ditemukan: ${filepath}`)
    return []
  }

  try {
    const content = fs.readFileSync(filepath, 'utf8')
    const rows    = parse(content, { columns: true, skip_empty_lines: true })
    return rows.map(row => ({
      elapsed: parseInt(row.elapsed || row.Latency || 0),
      success: (row.success || row.Success || '').toLowerCase() === 'true',
      code:    row.responseCode || row.ResponseCode || '',
      label:   row.label || row.Label || '',
    })).filter(r => !isNaN(r.elapsed))
  } catch (e) {
    console.log(`  [!] Gagal parse ${filepath}: ${e.message}`)
    return []
  }
}

function calcStats(data) {
  if (!data.length) return { total: 0, success: 0, fail: 0, errorRate: 0, avgLat: 0, minLat: 0, maxLat: 0, throughput: 0 }

  const elapsed  = data.map(d => d.elapsed)
  const success  = data.filter(d => d.success)
  const total    = data.length
  const maxElap  = Math.max(...elapsed)

  return {
    total,
    success:    success.length,
    fail:       total - success.length,
    errorRate:  total ? (total - success.length) / total * 100 : 0,
    avgLat:     elapsed.reduce((s, v) => s + v, 0) / total,
    minLat:     Math.min(...elapsed),
    maxLat:     maxElap,
    throughput: maxElap > 0 ? success.length / (maxElap / 1000) : 0,
  }
}

// ─────────────────────────────────────────────
// EXPORT EXCEL
// ─────────────────────────────────────────────
async function exportComparison(scenarios, filename) {
  const wb    = new ExcelJS.Workbook()
  const NAVY  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2744' } }
  const GREEN = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4EDDA' } }
  const RED   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8D7DA' } }
  const GREY  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }
  const YEL   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } }

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

  // Build stats map
  const statsMap = {}
  for (const sc of scenarios) {
    statsMap[`${sc.platform}_${sc.users}`] = calcStats(sc.data)
  }

  function sv(platform, users, key, fmt = '') {
    const s = statsMap[`${platform}_${users}`] || {}
    const v = s[key] || 0
    if (fmt === 'pct') return `${v.toFixed(1)}%`
    if (fmt === 'f1')  return `${v.toFixed(1)}`
    if (fmt === 'f2')  return `${v.toFixed(2)}`
    return String(v)
  }

  // ── Sheet Perbandingan ───────────────────
  const ws1 = wb.addWorksheet('Perbandingan')
  ws1.columns = [
    { width: 28 }, { width: 14 }, { width: 14 }, { width: 15 },
    { width: 14 }, { width: 14 }, { width: 15 }, { width: 14 },
  ]

  const titleRow = ws1.addRow(['PERBANDINGAN HASIL LOAD TESTING — ETH vs FABRIC'])
  ws1.mergeCells('A1:H1')
  styleHeader(titleRow, 8)
  ws1.addRow([])

  const hdrRow = ws1.addRow(['Metrik', 'ETH 10u', 'ETH 50u', 'ETH 100u', 'FAB 10u', 'FAB 50u', 'FAB 100u', 'Satuan'])
  styleHeader(hdrRow, 8)

  const metrics = [
    ['Total Request',         'total',     '',    'req'],
    ['Request Berhasil',      'success',   '',    'req'],
    ['Request Gagal',         'fail',      '',    'req'],
    ['Error Rate',            'errorRate', 'pct', '%'],
    ['Throughput (TPS)',      'throughput','f2',  'TPS'],
    ['Latency Rata-rata (ms)','avgLat',    'f1',  'ms'],
    ['Latency Minimum (ms)',  'minLat',    'f1',  'ms'],
    ['Latency Maksimum (ms)', 'maxLat',    'f1',  'ms'],
  ]

  metrics.forEach(([label, key, fmt, unit], i) => {
    const row = ws1.addRow([
      label,
      sv('ethereum', 10,  key, fmt),
      sv('ethereum', 50,  key, fmt),
      sv('ethereum', 100, key, fmt),
      sv('fabric',   10,  key, fmt),
      sv('fabric',   50,  key, fmt),
      sv('fabric',   100, key, fmt),
      unit,
    ])
    const fill = (label.includes('Throughput') || label.includes('Error')) ? YEL : (i % 2 === 1 ? GREY : null)
    styleRow(row, 8, fill)
  })

  // ── Sheet per skenario ───────────────────
  for (const sc of scenarios) {
    const title = `${sc.platform.toUpperCase()} ${sc.users}u`
    const ws    = wb.addWorksheet(title)
    ws.columns  = [{ width: 6 }, { width: 15 }, { width: 16 }, { width: 14 }]

    const sTitleRow = ws.addRow([`DETAIL — ${title}`])
    ws.mergeCells('A1:D1')
    styleHeader(sTitleRow, 4)
    ws.addRow([])

    const sHdrRow = ws.addRow(['No', 'Status', 'Elapsed (ms)', 'HTTP Code'])
    styleHeader(sHdrRow, 4)

    sc.data.slice(0, 500).forEach((d, i) => {
      const row = ws.addRow([i + 1, d.success ? 'Berhasil' : 'Gagal', d.elapsed, d.code])
      styleRow(row, 4, d.success ? GREEN : RED)
    })
  }

  await wb.xlsx.writeFile(filename)
  console.log(`\n  ✓ Hasil disimpan ke: ${filename}`)
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('eth-10',  { type: 'string', default: '', description: 'CSV JMeter Ethereum 10 users' })
    .option('eth-50',  { type: 'string', default: '', description: 'CSV JMeter Ethereum 50 users' })
    .option('eth-100', { type: 'string', default: '', description: 'CSV JMeter Ethereum 100 users' })
    .option('fab-10',  { type: 'string', default: '', description: 'CSV JMeter Fabric 10 users' })
    .option('fab-50',  { type: 'string', default: '', description: 'CSV JMeter Fabric 50 users' })
    .option('fab-100', { type: 'string', default: '', description: 'CSV JMeter Fabric 100 users' })
    .argv

  const ts = new Date()
  console.log(`\n${'='.repeat(60)}`)
  console.log('  LAPORAN LOAD TESTING — ETH vs FABRIC')
  console.log('  Tugas Akhir — Prodi Informatika UAJY')
  console.log(`  ${ts.toLocaleString('id-ID')}`)
  console.log('='.repeat(60))

  const scenarios = [
    { platform: 'ethereum', users: 10,  data: parseJmeterCsv(argv['eth-10'])  },
    { platform: 'ethereum', users: 50,  data: parseJmeterCsv(argv['eth-50'])  },
    { platform: 'ethereum', users: 100, data: parseJmeterCsv(argv['eth-100']) },
    { platform: 'fabric',   users: 10,  data: parseJmeterCsv(argv['fab-10'])  },
    { platform: 'fabric',   users: 50,  data: parseJmeterCsv(argv['fab-50'])  },
    { platform: 'fabric',   users: 100, data: parseJmeterCsv(argv['fab-100']) },
  ]

  const dateStr = ts.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const fname   = `hasil_load_testing_${dateStr}.xlsx`
  await exportComparison(scenarios, fname)

  console.log(`\n${'='.repeat(60)}`)
  console.log('  RINGKASAN PERBANDINGAN')
  console.log('='.repeat(60))
  for (const sc of scenarios) {
    if (sc.data.length) {
      const s = calcStats(sc.data)
      console.log(`  ${sc.platform.toUpperCase()} ${String(sc.users).padStart(3)}u: TPS=${s.throughput.toFixed(2)} | Lat=${s.avgLat.toFixed(1)}ms | Error=${s.errorRate.toFixed(1)}%`)
    }
  }
  console.log('='.repeat(60))
  console.log(`\n  Selesai. File: ${fname}\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
