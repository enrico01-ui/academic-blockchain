/**
 * duplicate_detection_testing.js
 * ================================
 * Uji apakah sistem mencegah duplikasi data akademik di blockchain
 * Tugas Akhir — Prodi Informatika UAJY
 */

const axios   = require('axios')
const ExcelJS = require('exceljs')
require('dotenv').config()

const CONFIG = {
  apiUrl:      process.env.API_URL     || 'http://139.59.240.82:3000/api',
  adminUser:   process.env.ADMIN_USER  || 'admin',
  adminPass:   process.env.ADMIN_PASS  || 'admin123',
}

async function getToken() {
  const res = await axios.post(`${CONFIG.apiUrl}/auth/login`,
    { username: CONFIG.adminUser, password: CONFIG.adminPass },
    { timeout: 10000 })
  return res.data?.token
}

async function sendRecord(token, payload) {
  const t = Date.now()
  try {
    const res = await axios.post(`${CONFIG.apiUrl}/academic/record`, payload, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 60000
    })
    return { success: true, status: res.status, latencyMs: Date.now() - t, data: res.data }
  } catch (e) {
    return { 
      success: false, 
      status: e.response?.status || 0, 
      latencyMs: Date.now() - t, 
      error: e.response?.data?.message || e.message 
    }
  }
}

async function runDuplicateTest(token, platform) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  DUPLICATE DETECTION TEST — ${platform.toUpperCase()}`)
  console.log('='.repeat(60))

  const hasil = []

  const testCases = [
    {
      desc: 'Submit data baru (pertama kali)',
      payload: {
        student_id:    `DUP_TEST_${platform.toUpperCase()}_001`,
        student_name:  'Mahasiswa Duplikat Test',
        course_code:   'IF-DUP-01',
        course_name:   'Mata Kuliah Duplikat',
        grade:         'A',
        gpa_point:     4.00,
        semester:      1,
        academic_year: '2024/2025',
        attendance:    'always',
      },
      expectedStatus: [201, 202],
      expectedResult: 'DITERIMA',
    },
    {
      desc: 'Submit data IDENTIK kedua kali (duplikat penuh)',
      payload: {
        student_id:    `DUP_TEST_${platform.toUpperCase()}_001`,
        student_name:  'Mahasiswa Duplikat Test',
        course_code:   'IF-DUP-01',
        course_name:   'Mata Kuliah Duplikat',
        grade:         'A',
        gpa_point:     4.00,
        semester:      1,
        academic_year: '2024/2025',
        attendance:    'always',
      },
      expectedStatus: [409, 400, 500],
      expectedResult: 'DITOLAK',
    },
    {
      desc: 'Submit data sama tapi grade berbeda (bukan duplikat)',
      payload: {
        student_id:    `DUP_TEST_${platform.toUpperCase()}_001`,
        student_name:  'Mahasiswa Duplikat Test',
        course_code:   'IF-DUP-01',
        course_name:   'Mata Kuliah Duplikat',
        grade:         'B',     // ← beda
        gpa_point:     3.00,   // ← beda
        semester:      1,
        academic_year: '2024/2025',
        attendance:    'always',
      },
      expectedStatus: [201, 202, 400],
      expectedResult: 'TERGANTUNG IMPLEMENTASI',
    },
    {
      desc: 'Submit data student sama, course berbeda (bukan duplikat)',
      payload: {
        student_id:    `DUP_TEST_${platform.toUpperCase()}_001`,
        student_name:  'Mahasiswa Duplikat Test',
        course_code:   'IF-DUP-02',  // ← course berbeda
        course_name:   'Mata Kuliah Lain',
        grade:         'A',
        gpa_point:     4.00,
        semester:      2,
        academic_year: '2024/2025',
        attendance:    'always',
      },
      expectedStatus: [201, 202],
      expectedResult: 'DITERIMA',
    },
    {
      desc: 'Submit 3x berturut-turut data identik (stress duplikat)',
      payload: {
        student_id:    `DUP_TEST_${platform.toUpperCase()}_002`,
        student_name:  'Mahasiswa Stress Duplikat',
        course_code:   'IF-DUP-03',
        course_name:   'Mata Kuliah Stress',
        grade:         'B+',
        gpa_point:     3.30,
        semester:      3,
        academic_year: '2024/2025',
        attendance:    'sometimes',
      },
      expectedStatus: [201, 202],
      expectedResult: 'HANYA PERTAMA DITERIMA',
      repeat: 3,
    },
  ]

  for (const tc of testCases) {
    const repeatCount = tc.repeat || 1

    if (repeatCount > 1) {
      console.log(`\n  Skenario: ${tc.desc}`)
      const repeatResults = []
      for (let i = 1; i <= repeatCount; i++) {
        const res = await sendRecord(token, tc.payload)
        const isExpected = tc.expectedStatus.includes(res.status)
        console.log(`    [${i}/${repeatCount}] Status: ${res.status} | ${res.success ? '✓ Diterima' : '✗ Ditolak'} (${res.latencyMs}ms)`)
        repeatResults.push(res)
      }
      const firstOk  = repeatResults[0].success
      const dupsRejected = repeatResults.slice(1).every(r => !r.success)
      const status = firstOk && dupsRejected ? 'LULUS' : 'GAGAL'
      console.log(`    → ${status}: Pertama ${firstOk ? 'diterima' : 'ditolak'}, duplikat ${dupsRejected ? 'semua ditolak' : 'ada yang lolos'}`)
      hasil.push({
        desc: tc.desc,
        expectedResult: tc.expectedResult,
        actualStatus: repeatResults.map(r => r.status).join(', '),
        actualResult: `${firstOk ? 'Pertama OK' : 'Pertama GAGAL'} | Duplikat: ${dupsRejected ? 'ditolak' : 'lolos'}`,
        latencyMs: repeatResults.map(r => r.latencyMs).join(', '),
        status,
      })
    } else {
      const res = await sendRecord(token, tc.payload)
      const isExpected = tc.expectedStatus.includes(res.status)
      const status = isExpected ? 'LULUS' : 'PERLU REVIEW'
      console.log(`\n  Skenario: ${tc.desc}`)
      console.log(`    Status  : ${res.status} | ${res.success ? '✓ Diterima' : '✗ Ditolak'} (${res.latencyMs}ms)`)
      console.log(`    Expected: ${tc.expectedResult} | Actual: ${isExpected ? '✓ Sesuai' : '⚠ Tidak sesuai'}`)
      if (res.error) console.log(`    Error   : ${res.error}`)
      hasil.push({
        desc: tc.desc,
        expectedResult: tc.expectedResult,
        actualStatus: res.status,
        actualResult: res.success ? 'Diterima' : `Ditolak: ${res.error || ''}`,
        latencyMs: res.latencyMs,
        status,
      })
    }

    await new Promise(r => setTimeout(r, 1000))
  }

  return hasil
}

async function exportExcel(hasilEth, hasilFab, filename) {
  const wb    = new ExcelJS.Workbook()
  const NAVY  = { type:'pattern', pattern:'solid', fgColor:{argb:'FF1A2744'} }
  const GREEN = { type:'pattern', pattern:'solid', fgColor:{argb:'FFD4EDDA'} }
  const RED   = { type:'pattern', pattern:'solid', fgColor:{argb:'FFF8D7DA'} }
  const YELL  = { type:'pattern', pattern:'solid', fgColor:{argb:'FFFFF3CD'} }
  const GREY  = { type:'pattern', pattern:'solid', fgColor:{argb:'FFF2F2F2'} }

  const wFont  = { color:{argb:'FFFFFFFF'}, bold:true, name:'Times New Roman', size:11 }
  const nFont  = { name:'Times New Roman', size:11 }
  const center = { horizontal:'center', vertical:'middle', wrapText:true }
  const brd    = { top:{style:'thin'}, bottom:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'} }

  function styleHeader(row, n) {
    for (let c=1;c<=n;c++) { const cell=row.getCell(c); cell.fill=NAVY; cell.font=wFont; cell.alignment=center; cell.border=brd }
  }
  function styleRow(row, n, fill) {
    for (let c=1;c<=n;c++) { const cell=row.getCell(c); if(fill)cell.fill=fill; cell.font=nFont; cell.alignment=center; cell.border=brd }
  }

  for (const [platform, hasil] of [['Ethereum', hasilEth], ['Fabric', hasilFab]]) {
    const ws = wb.addWorksheet(`Duplikat ${platform}`)
    ws.columns = [{width:5},{width:45},{width:20},{width:16},{width:30},{width:16},{width:12}]

    const title = ws.addRow([`DUPLICATE DETECTION TEST — ${platform.toUpperCase()}`])
    ws.mergeCells(`A1:G1`); styleHeader(title, 7)
    ws.addRow([])
    styleHeader(ws.addRow(['No','Skenario','Expected','HTTP Status','Actual Result','Latency (ms)','Status']), 7)

    hasil.forEach((r, i) => {
      const fill = r.status === 'LULUS' ? GREEN : r.status === 'PERLU REVIEW' ? YELL : RED
      const row  = ws.addRow([i+1, r.desc, r.expectedResult, r.actualStatus, r.actualResult, r.latencyMs, r.status])
      styleRow(row, 7, fill)
    })
  }

  await wb.xlsx.writeFile(filename)
  console.log(`\n  ✓ Hasil disimpan ke: ${filename}`)
}

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log('  DUPLICATE DETECTION TESTING')
  console.log('  Tugas Akhir — Prodi Informatika UAJY')
  console.log(`  ${new Date().toLocaleString('id-ID')}`)
  console.log('='.repeat(60))

  const token = await getToken()
  if (!token) { console.log('GAGAL login'); process.exit(1) }
  console.log('  ✓ Token diperoleh')

  // Test Ethereum
  console.log('\n  Pastikan ACTIVE_BLOCKCHAIN=ethereum di backend!')
  console.log('  Tekan Enter setelah restart backend...')
  await new Promise(r => process.stdin.once('data', r))

  const hasilEth = await runDuplicateTest(token, 'ethereum')

  // Test Fabric
  console.log('\n  Ganti ACTIVE_BLOCKCHAIN=fabric di backend dan restart!')
  console.log('  Tekan Enter setelah restart backend...')
  await new Promise(r => process.stdin.once('data', r))

  const hasilFab = await runDuplicateTest(token, 'fabric')

  const ts    = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)
  const fname = `hasil_duplicate_detection_${ts}.xlsx`
  await exportExcel(hasilEth, hasilFab, fname)

  console.log(`\n${'='.repeat(60)}`)
  console.log('  RINGKASAN')
  console.log('='.repeat(60))
  const ethLulus = hasilEth.filter(r => r.status === 'LULUS').length
  const fabLulus = hasilFab.filter(r => r.status === 'LULUS').length
  console.log(`  Ethereum: ${ethLulus}/${hasilEth.length} skenario lulus`)
  console.log(`  Fabric  : ${fabLulus}/${hasilFab.length} skenario lulus`)
  console.log('='.repeat(60))
}

main().catch(console.error)