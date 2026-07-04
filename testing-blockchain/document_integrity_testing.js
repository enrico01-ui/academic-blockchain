/**
 * document_integrity_testing.js
 * Pengujian Integritas Dokumen Akademik
 * Tugas Akhir — Prodi Informatika UAJY
 */

const axios   = require('axios')
const ExcelJS = require('exceljs')
const crypto  = require('crypto')
const yargs   = require('yargs')
const { hideBin } = require('yargs/helpers')

const CONFIG = {
  apiUrl:      process.env.API_URL    || 'http://139.59.240.82:3000/api',
  apiUsername: process.env.ADMIN_USER || 'admin',
  apiPassword: process.env.ADMIN_PASS || 'admin123',
}

async function getToken() {
  const res = await axios.post(`${CONFIG.apiUrl}/auth/login`,
    { username: CONFIG.apiUsername, password: CONFIG.apiPassword },
    { timeout: 10000 })
  return res.data?.token
}

async function fetchDocuments(platform, limit, token) {
  try {
    const res = await axios.get(
      `${CONFIG.apiUrl}/documents?platform=${platform}&status=confirmed&limit=${limit}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 }
    )
    // Filter exclude DDOS_TEST
    return (res.data?.documents || []).filter(d => 
      !d.student_id?.startsWith('DDOS_') && 
      !d.student_id?.startsWith('SPAM_')
    )
  } catch (e) {
    console.log(`  [!] Gagal fetch dokumen: ${e.message}`)
    return []
  }
}

// Verify dokumen via blockchain — cek hash dokumen di blockchain
async function verifyDocumentHash(doc, token) {
  const t = Date.now()
  try {
    const res = await axios.get(
      `${CONFIG.apiUrl}/documents/${doc.id}/verify`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    )
    const data    = res.data
    const latency = Date.now() - t
    return {
      isValid:     data?.verification?.isValid || false,
      fileHash:    data?.verification?.fileHashDb || doc.file_hash,
      storedHash:  data?.verification?.hashBlockchain || null,
      latencyMs:   latency,
      error:       data?.blockchain_error || null,
    }
  } catch (e) {
    return {
      isValid:    false,
      fileHash:   doc.file_hash,
      storedHash: null,
      latencyMs:  Date.now() - t,
      error:      e.message,
    }
  }
}

async function runTest(platform, docs, token) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  DOCUMENT INTEGRITY TEST — ${platform.toUpperCase()}`)
  console.log(`  Jumlah dokumen: ${docs.length}`)
  console.log('='.repeat(60))

  const hasil   = []
  let ok = 0, fail = 0, totalLat = 0

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]
    process.stdout.write(
      `  [${String(i+1).padStart(3)}/${docs.length}] ${doc.student_id.slice(0,15).padEnd(15)} ${doc.document_type.padEnd(12)} `
    )

    const v = await verifyDocumentHash(doc, token)
    totalLat += v.latencyMs

    if (v.isValid) {
      ok++
      console.log(`✓ VALID   (${Math.round(v.latencyMs)}ms)`)
    } else {
      fail++
      console.log(`✗ GAGAL   (${Math.round(v.latencyMs)}ms) ${v.error?.slice(0,40)||'hash mismatch'}`)
    }

    hasil.push({
      no:           i + 1,
      studentId:    doc.student_id,
      documentType: doc.document_type,
      fileName:     doc.file_name,
      fileHash:     doc.file_hash?.slice(0,16) + '...',
      storedHash:   v.storedHash?.slice(0,16) + '...' || '—',
      txId:         doc.tx_id?.slice(0,20) + '...',
      platform,
      latencyMs:    v.latencyMs.toFixed(1),
      status:       v.isValid ? 'VALID' : 'GAGAL',
      error:        v.error?.slice(0,60) || '',
    })

    await new Promise(r => setTimeout(r, platform === 'ethereum' ? 300 : 100))
  }

  const avgLat = docs.length ? totalLat / docs.length : 0
  console.log(`\n  ✓ ${ok} Valid | ✗ ${fail} Gagal | Avg: ${avgLat.toFixed(1)}ms | Rate: ${(ok/docs.length*100).toFixed(1)}%`)
  return { hasil, ok, fail, avgLat }
}

async function exportExcel(hasilEth, hasilFab, sumEth, sumFab, filename) {
  const wb    = new ExcelJS.Workbook()
  const NAVY  = { type:'pattern', pattern:'solid', fgColor:{argb:'FF1A2744'} }
  const GREEN = { type:'pattern', pattern:'solid', fgColor:{argb:'FFD4EDDA'} }
  const RED   = { type:'pattern', pattern:'solid', fgColor:{argb:'FFF8D7DA'} }
  const GREY  = { type:'pattern', pattern:'solid', fgColor:{argb:'FFF2F2F2'} }
  const wFont = { color:{argb:'FFFFFFFF'}, bold:true, name:'Times New Roman', size:11 }
  const nFont = { name:'Times New Roman', size:11 }
  const ctr   = { horizontal:'center', vertical:'middle', wrapText:true }
  const brd   = { top:{style:'thin'}, bottom:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'} }

  const sH = (row, n) => { for(let c=1;c<=n;c++){const cl=row.getCell(c);cl.fill=NAVY;cl.font=wFont;cl.alignment=ctr;cl.border=brd} }
  const sR = (row, n, fill) => { for(let c=1;c<=n;c++){const cl=row.getCell(c);if(fill)cl.fill=fill;cl.font=nFont;cl.alignment=ctr;cl.border=brd} }

  // Sheet Ringkasan
  const ws1 = wb.addWorksheet('Ringkasan Dokumen')
  ws1.columns = [{width:38},{width:28},{width:28}]
  const t1 = ws1.addRow(['RINGKASAN PENGUJIAN INTEGRITAS DOKUMEN AKADEMIK'])
  ws1.mergeCells('A1:C1'); sH(t1, 3)
  ws1.addRow([])
  sH(ws1.addRow(['Parameter','Ethereum Sepolia','Hyperledger Fabric']), 3)
  const rows = [
    ['Jumlah Dokumen Diuji',      `${sumEth.total}`,             `${sumFab.total}`],
    ['Dokumen Valid',              `${sumEth.ok}`,                `${sumFab.ok}`],
    ['Dokumen Gagal',              `${sumEth.fail}`,              `${sumFab.fail}`],
    ['Tingkat Keberhasilan (%)',   `${sumEth.rate.toFixed(1)}%`,  `${sumFab.rate.toFixed(1)}%`],
    ['Rata-rata Latency (ms)',     `${sumEth.avgLat.toFixed(1)}`, `${sumFab.avgLat.toFixed(1)}`],
    ['Tanggal Pengujian',         new Date().toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'}), ''],
  ]
  rows.forEach((p,i) => sR(ws1.addRow(p), 3, i%2===1 ? GREY : null))

  // Sheet Detail
  for (const [label, hasil] of [['Ethereum', hasilEth], ['Fabric', hasilFab]]) {
    const ws = wb.addWorksheet(`Detail ${label}`)
    ws.columns = [{width:5},{width:18},{width:14},{width:22},{width:20},{width:20},{width:22},{width:14},{width:10},{width:35}]
    const tit = ws.addRow([`DETAIL INTEGRITAS DOKUMEN — ${label.toUpperCase()}`])
    ws.mergeCells(`A1:J1`); sH(tit, 10)
    ws.addRow([])
    sH(ws.addRow(['No','Student ID','Doc Type','File Name','File Hash (DB)','Hash Blockchain','Tx ID','Latency (ms)','Status','Keterangan']), 10)
    hasil.forEach(r => {
      const row = ws.addRow([r.no, r.studentId, r.documentType, r.fileName, r.fileHash, r.storedHash, r.txId, r.latencyMs, r.status, r.error])
      sR(row, 10, r.status === 'VALID' ? GREEN : RED)
    })
  }

  await wb.xlsx.writeFile(filename)
  console.log(`\n  ✓ Laporan: ${filename}`)
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('platform', { choices:['ethereum','fabric','both'], default:'both' })
    .option('size',     { type:'number', default: 50 })
    .argv

  console.log(`\n${'='.repeat(60)}`)
  console.log('  PENGUJIAN INTEGRITAS DOKUMEN AKADEMIK')
  console.log('  Tugas Akhir — Prodi Informatika UAJY')
  console.log(`  ${new Date().toLocaleString('id-ID')}`)
  console.log('='.repeat(60))

  const token = await getToken()
  if (!token) { console.log('GAGAL login'); process.exit(1) }
  console.log('  ✓ Token diperoleh')

  let hasilEth = [], hasilFab = []
  let sumEth = { total:0, ok:0, fail:0, rate:0, avgLat:0 }
  let sumFab = { total:0, ok:0, fail:0, rate:0, avgLat:0 }

  if (['ethereum','both'].includes(argv.platform)) {
    console.log('\n  Pastikan ACTIVE_BLOCKCHAIN=ethereum di backend!')
    console.log('  Tekan Enter jika sudah siap...')
    await new Promise(r => process.stdin.once('data', r))

    const docs = await fetchDocuments('ethereum', argv.size, token)
    console.log(`  ✓ ${docs.length} dokumen ethereum`)
    if (docs.length) {
      const res = await runTest('ethereum', docs, token)
      hasilEth = res.hasil
      sumEth   = { total: docs.length, ok: res.ok, fail: res.fail, rate: res.ok/docs.length*100, avgLat: res.avgLat }
    }
  }

  if (['fabric','both'].includes(argv.platform)) {
    console.log('\n  Pastikan ACTIVE_BLOCKCHAIN=fabric di backend!')
    console.log('  Tekan Enter jika sudah siap...')
    await new Promise(r => process.stdin.once('data', r))

    const docs = await fetchDocuments('fabric', argv.size, token)
    console.log(`  ✓ ${docs.length} dokumen fabric`)
    if (docs.length) {
      const res = await runTest('fabric', docs, token)
      hasilFab = res.hasil
      sumFab   = { total: docs.length, ok: res.ok, fail: res.fail, rate: res.ok/docs.length*100, avgLat: res.avgLat }
    }
  }

  if (argv.platform === 'ethereum') { sumFab = {...sumEth}; hasilFab = hasilEth }
  if (argv.platform === 'fabric')   { sumEth = {...sumFab}; hasilEth = hasilFab }

  const ts    = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)
  const fname = `hasil_document_integrity_${ts}.xlsx`
  await exportExcel(hasilEth, hasilFab, sumEth, sumFab, fname)

  console.log(`\n${'='.repeat(60)}`)
  console.log('  RINGKASAN')
  console.log('='.repeat(60))
  if (sumEth.total > 0) console.log(`  Ethereum: ${sumEth.ok}/${sumEth.total} valid (${sumEth.rate.toFixed(1)}%) | ${sumEth.avgLat.toFixed(1)}ms`)
  if (sumFab.total > 0) console.log(`  Fabric  : ${sumFab.ok}/${sumFab.total} valid (${sumFab.rate.toFixed(1)}%) | ${sumFab.avgLat.toFixed(1)}ms`)
  console.log('='.repeat(60))
 console.log(`\n  Selesai. File: ${fname}\n`)
}

main().catch(e => { console.error(e); process.exit(1) })