/**
 * ddos_monitor.js — v2
 * =====================
 * Monitor Ketersediaan + Integritas Data saat Simulasi Serangan DDoS
 * Tugas Akhir: Perbandingan Ethereum Testnet dan Hyperledger Fabric
 *
 * Cara pakai:
 *   node ddos_monitor.js --platform ethereum --duration 300
 *   node ddos_monitor.js --platform fabric   --duration 300
 *   node ddos_monitor.js --platform ethereum --duration 300 --flood-workers 50
 *
 * Serangan HTTP Flood dijalankan DARI SCRIPT INI (tidak perlu hping3).
 * Flood menyerang 5 endpoint berbeda secara paralel selama fase serangan.
 *
 * Endpoint yang di-flood:
 *   GET  /api/health                  ← endpoint publik, paling ringan
 *   GET  /api/academic?limit=50       ← query DB berat
 *   GET  /api/academic/:studentId     ← query per mahasiswa
 *   POST /api/auth/login              ← brute-force simulasi
 *   GET  /api/documents               ← query dokumen berat
 *
 * Monitor (di goroutine terpisah dari flood) tetap ukur:
 *   - Availability via GET /api/health
 *   - Store akademik via POST /api/academic/record
 *   - Store dokumen via POST /api/documents/generate
 *   - Read data via GET /api/academic
 *   - Verify hash via POST /api/verify/hash
 */

const axios   = require('axios')
const ExcelJS = require('exceljs')
const yargs   = require('yargs')
const { hideBin } = require('yargs/helpers')

// ─────────────────────────────────────────────
// KONFIGURASI
// ─────────────────────────────────────────────
const CONFIG = {
  apiUrl:        process.env.API_URL || 'http://139.59.240.82:3000/api',
  apiUsername:   'admin',
  apiPassword:   'admin123',
  testPrefix:    'DDOS_TEST_',

  // Interval monitor (ms)
  checkInterval: 5000,
  storeInterval: 20000,
  readInterval:  10000,
  verifyInterval:30000,

  // HTTP Flood
  floodWorkers:  50,     // jumlah concurrent request flood
  floodDelay:    0,      // ms antar request per worker (0 = flood penuh)
  floodTimeout:  3000,   // timeout per flood request (ms)
}

// Registry data test untuk cleanup
const registry = {
  academicIds: new Set(),
  documentIds: [],
  verifyIds:   [],
}

// State flood
let floodActive  = false
let floodStats   = { total:0, ok:0, fail:0, byEndpoint:{} }

// ─────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────
const sleep  = ms => new Promise(r => setTimeout(r, ms))
const now    = ()  => new Date().toLocaleTimeString('id-ID', { hour12:false })
const randInt= (a,b)=> Math.floor(Math.random()*(b-a+1))+a
const pick   = arr  => arr[Math.floor(Math.random()*arr.length)]

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────
async function getToken() {
  try {
    const res = await axios.post(`${CONFIG.apiUrl}/auth/login`,
      { username: CONFIG.apiUsername, password: CONFIG.apiPassword },
      { timeout: 10000 })
    return res.data?.token || null
  } catch { return null }
}

// ─────────────────────────────────────────────
// HTTP FLOOD ENGINE
// Jalankan request tanpa tunggu — fire & forget
// ─────────────────────────────────────────────
const FLOOD_ENDPOINTS = [
  // [method, path, body, needsAuth]
  ['GET',  '/health',             null,                               false],
  ['GET',  '/academic?limit=50',  null,                               true ],
  ['GET',  '/academic?limit=100', null,                               true ],
  ['GET',  '/documents?limit=50', null,                               true ],
  ['POST', '/auth/login',         { username:'x', password:'x' },    false],
]

async function floodWorker(token) {
  while (floodActive) {
    const [method, path, body, needsAuth] = pick(FLOOD_ENDPOINTS)
    const endpoint = path.split('?')[0]

    // Inject student_id acak untuk endpoint /academic/:id
    const actualPath = path === '/academic/:studentId'
      ? `/academic/DS${randInt(1,4)}_${randInt(10000,99999)}_Y${randInt(1,9)}`
      : path

    const headers = needsAuth ? { Authorization:`Bearer ${token}` } : {}

    try {
      if (method === 'GET') {
        await axios.get(`${CONFIG.apiUrl}${actualPath}`, { headers, timeout: CONFIG.floodTimeout })
      } else {
        await axios.post(`${CONFIG.apiUrl}${actualPath}`, body, { headers, timeout: CONFIG.floodTimeout })
      }
      floodStats.ok++
    } catch {
      floodStats.fail++
    }
    floodStats.total++
    floodStats.byEndpoint[endpoint] = (floodStats.byEndpoint[endpoint] || 0) + 1

    if (CONFIG.floodDelay > 0) await sleep(CONFIG.floodDelay)
  }
}

function startFlood(token, workers) {
  floodActive = true
  floodStats  = { total:0, ok:0, fail:0, byEndpoint:{} }
  for (let i = 0; i < workers; i++) {
    floodWorker(token) // fire & forget — tidak di-await
  }
  console.log(`  ✓ HTTP Flood dimulai: ${workers} workers menyerang 5 endpoint`)
}

function stopFlood() {
  floodActive = false
}

// ─────────────────────────────────────────────
// MONITOR FUNCTIONS
// ─────────────────────────────────────────────
async function checkHealth(token) {
  const t = Date.now()
  try {
    const res = await axios.get(`${CONFIG.apiUrl}/health`,
      { headers:{ Authorization:`Bearer ${token}` }, timeout:8000 })
    return { success: res.status===200, latencyMs: Date.now()-t, code: res.status, detail:'' }
  } catch(e) {
    return { success:false, latencyMs: Date.now()-t, code: e.response?.status||0, detail: e.code||'timeout' }
  }
}

async function storeAcademic(token, txNo) {
  const GRADES  = ['A','A-','B+','B','B-','C+','C']
  const GPA_MAP = { 'A':4.00,'A-':3.70,'B+':3.30,'B':3.00,'B-':2.70,'C+':2.30,'C':2.00 }
  const CODES   = ['IF-901','IF-902','IF-903','IF-904','IF-905']
  const NAMES   = ['Pemrograman Web','Basis Data','Jaringan Komputer','Kecerdasan Buatan','Keamanan Sistem']
  const grade   = pick(GRADES)
  const code    = pick(CODES)
  const studentId = `${CONFIG.testPrefix}${String(txNo).padStart(4,'0')}`

  const t = Date.now()
  try {
    const res = await axios.post(`${CONFIG.apiUrl}/academic/record`, {
      student_id:    studentId,
      student_name:  `DDoS Test ${txNo}`,
      course_code:   code,
      course_name:   NAMES[CODES.indexOf(code)],
      grade, gpa_point: GPA_MAP[grade],
      semester: randInt(1,8), academic_year:'2024/2025', attendance:'always',
    }, { headers:{ Authorization:`Bearer ${token}` }, timeout:60000 })

    const ok = [200,201].includes(res.status)
    if (ok) {
      registry.academicIds.add(studentId)
      if (res.data?.data?.id) registry.verifyIds.push({ id: res.data.data.id, studentId })
    }
    return { success:ok, latencyMs:Date.now()-t, code:res.status,
             studentId, txId:res.data?.data?.tx_id||'', detail:res.data?.data?.status||'' }
  } catch(e) {
    return { success:false, latencyMs:Date.now()-t, code:e.response?.status||0,
             studentId, txId:'', detail:String(e.message).slice(0,60) }
  }
}

async function storeDocument(token, studentId) {
  const dtype = pick(['transkrip','sertifikat'])
  const t = Date.now()
  try {
    const res = await axios.post(`${CONFIG.apiUrl}/documents/generate`,
      { student_id: studentId, document_type: dtype },
      { headers:{ Authorization:`Bearer ${token}` }, timeout:60000 })
    const ok = [200,201].includes(res.status)
    if (ok && res.data?.document?.id) registry.documentIds.push(res.data.document.id)
    return { success:ok, latencyMs:Date.now()-t, code:res.status,
             studentId, documentType:dtype, detail:res.data?.document?.tx_id||'' }
  } catch(e) {
    return { success:false, latencyMs:Date.now()-t, code:e.response?.status||0,
             studentId, documentType:dtype, detail:String(e.message).slice(0,60) }
  }
}

async function readAcademic(token) {
  const t = Date.now()
  try {
    const res = await axios.get(`${CONFIG.apiUrl}/academic?limit=10`,
      { headers:{ Authorization:`Bearer ${token}` }, timeout:8000 })
    return { success:res.status===200, latencyMs:Date.now()-t, code:res.status,
             recordCount:res.data?.total||0, detail:`${res.data?.records?.length||0} returned` }
  } catch(e) {
    return { success:false, latencyMs:Date.now()-t, code:e.response?.status||0,
             recordCount:0, detail:String(e.message).slice(0,60) }
  }
}

async function readStudent(token, studentId) {
  const t = Date.now()
  try {
    const res = await axios.get(`${CONFIG.apiUrl}/academic/${studentId}`,
      { headers:{ Authorization:`Bearer ${token}` }, timeout:8000 })
    return { success:res.status===200, latencyMs:Date.now()-t, code:res.status,
             recordCount:res.data?.total||0, detail:`student: ${studentId}` }
  } catch(e) {
    return { success:false, latencyMs:Date.now()-t, code:e.response?.status||0,
             recordCount:0, detail:String(e.message).slice(0,60) }
  }
}

async function verifyHash(token) {
  if (!registry.verifyIds.length) return null
  const target = pick(registry.verifyIds)
  const t = Date.now()
  try {
    const res = await axios.post(`${CONFIG.apiUrl}/verify/hash`,
      { student_id: target.studentId, record_id: target.id },
      { headers:{ Authorization:`Bearer ${token}` }, timeout:30000 })
    return { success:res.status===200, latencyMs:Date.now()-t, code:res.status,
             isValid:res.data?.verification?.isValid, studentId:target.studentId,
             detail:res.data?.verification?.message?.slice(0,60)||'' }
  } catch(e) {
    return { success:false, latencyMs:Date.now()-t, code:e.response?.status||0,
             isValid:false, studentId:target.studentId, detail:String(e.message).slice(0,60) }
  }
}

// ─────────────────────────────────────────────
// CLEANUP
// ─────────────────────────────────────────────
async function cleanupTestData(token) {
  console.log('\n[CLEANUP] Menghapus data test DDoS...')
  console.log(`  Student IDs: ${registry.academicIds.size} | Dokumen: ${registry.documentIds.length}`)

  let deletedAcademic = 0
  const sqlCleanup = `
    DELETE FROM integrity_checks
    WHERE academic_record_id IN (
      SELECT id
      FROM academic_records
      WHERE student_id LIKE '${CONFIG.testPrefix}%'
    );

    DELETE FROM documents
    WHERE student_id LIKE '${CONFIG.testPrefix}%';

    DELETE FROM academic_records
    WHERE student_id LIKE '${CONFIG.testPrefix}%';
    `

  try {
    const res = await axios.delete(`${CONFIG.apiUrl}/academic/cleanup-test`,
      { headers:{ Authorization:`Bearer ${token}` }, data:{ prefix: CONFIG.testPrefix }, timeout:15000 })
    deletedAcademic = res.data?.deleted || 0
    
  } catch {
    console.log(`  ✓ Cleanup otomatis: ${deletedAcademic} academic records dihapus`)
    console.log(`\n  SQL:\n  ${sqlCleanup.split('\n').join('\n  ')}`)
  }

  return { deletedAcademic, manualSql: deletedAcademic > 0 ? '' : sqlCleanup }
}

// ─────────────────────────────────────────────
// STATISTIK
// ─────────────────────────────────────────────
function calcStats(data) {
  if (!data?.length) return { total:0,success:0,fail:0,availability:0,avgLatency:0,maxLatency:0,minLatency:0,p95:0 }
  const ok  = data.filter(d => d.success)
  const lat = data.map(d => d.latencyMs).sort((a,b)=>a-b)
  const p95 = lat[Math.floor(lat.length*0.95)] || lat[lat.length-1]
  return {
    total:        data.length,
    success:      ok.length,
    fail:         data.length - ok.length,
    availability: ok.length / data.length * 100,
    avgLatency:   lat.reduce((s,v)=>s+v,0)/lat.length,
    maxLatency:   lat[lat.length-1],
    minLatency:   lat[0],
    p95,
  }
}

// ─────────────────────────────────────────────
// FASE 1: BASELINE
// ─────────────────────────────────────────────
async function runBaseline(token, duration) {
  console.log(`\n${'─'.repeat(62)}`)
  console.log(`[FASE 1] BASELINE — ${duration} detik tanpa serangan`)
  console.log(`${'─'.repeat(62)}`)

  const hasil = { health:[], store:[], read:[], verify:[] }
  const endAt = Date.now() + duration*1000
  let i=0, storeNo=0, nextStore=Date.now(), nextRead=Date.now(), nextVerify=Date.now()+10000

  while (Date.now() < endAt) {
    i++
    const now_ = Date.now()
    const health = await checkHealth(token)
    hasil.health.push({ fase:'Baseline', no:i, ts:now(), ...health })

    if (now_ >= nextStore) {
      storeNo++
      const store = await storeAcademic(token, storeNo)
      hasil.store.push({ fase:'Baseline', no:storeNo, ts:now(), jenis:'Akademik', ...store })
      if (store.success) {
        const doc = await storeDocument(token, store.studentId)
        hasil.store.push({ fase:'Baseline', no:storeNo, ts:now(), jenis:'Dokumen', ...doc })
      }
      nextStore = now_ + CONFIG.storeInterval
      console.log(`  [BL-${String(i).padStart(2)}] Health:${health.success?'OK':'FAIL'}(${Math.round(health.latencyMs)}ms) | Store:${store.success?'OK':'FAIL'}(${Math.round(store.latencyMs)}ms)`)
    } else {
      console.log(`  [BL-${String(i).padStart(2)}] Health:${health.success?'OK':'FAIL'}(${Math.round(health.latencyMs)}ms)`)
    }

    if (now_ >= nextRead) {
      const r = await readAcademic(token)
      hasil.read.push({ fase:'Baseline', no:i, ts:now(), jenis:'Read All', ...r })
      nextRead = now_ + CONFIG.readInterval
    }

    if (now_ >= nextVerify) {
      const v = await verifyHash(token)
      if (v) hasil.verify.push({ fase:'Baseline', no:i, ts:now(), ...v })
      nextVerify = now_ + CONFIG.verifyInterval
    }

    await sleep(CONFIG.checkInterval)
  }
  return hasil
}

// ─────────────────────────────────────────────
// FASE 2: SERANGAN HTTP FLOOD
// ─────────────────────────────────────────────
async function runAttackPhase(token, duration, floodWorkers) {
  console.log(`\n${'─'.repeat(62)}`)
  console.log(`[FASE 2] SERANGAN HTTP FLOOD — ${duration} detik`)
  console.log(`${'─'.repeat(62)}`)
  console.log(`  Endpoint target flood:`)
  console.log(`    GET  /api/health`)
  console.log(`    GET  /api/academic?limit=50  &  ?limit=100`)
  console.log(`    GET  /api/documents?limit=50`)
  console.log(`    POST /api/auth/login  (simulasi brute-force)`)
  console.log(`  Workers: ${floodWorkers} concurrent requests`)
  console.log()

  // Mulai flood
  startFlood(token, floodWorkers)
  await sleep(1000) // beri waktu flood warm-up
  
  const hasil = { health:[], store:[], read:[], verify:[] }
  const endAt = Date.now() + duration*1000
  let i=0, storeNo=500, nextStore=Date.now()+5000, nextRead=Date.now()+3000
  let nextVerify=Date.now()+15000, nextFloodReport=Date.now()+10000

  while (Date.now() < endAt) {
    i++
    const now_  = Date.now()
    const sisa  = Math.max(0, Math.round((endAt-now_)/1000))

    const health = await checkHealth(token)
    hasil.health.push({ fase:'Serangan DDoS', no:i, ts:now(), ...health })

    // Laporan flood setiap 10 detik
    if (now_ >= nextFloodReport) {
      const rps = floodStats.total / (duration - sisa) || 0
      console.log(`  [FLOOD] total:${floodStats.total} | ok:${floodStats.ok} | fail:${floodStats.fail} | ~${rps.toFixed(0)} req/s`)
      nextFloodReport = now_ + 10000
    }

    if (now_ >= nextStore) {
      storeNo++
      const store = await storeAcademic(token, storeNo)
      hasil.store.push({ fase:'Serangan DDoS', no:storeNo, ts:now(), jenis:'Akademik', ...store })
      if (store.success) {
        const doc = await storeDocument(token, store.studentId)
        hasil.store.push({ fase:'Serangan DDoS', no:storeNo, ts:now(), jenis:'Dokumen', ...doc })
        console.log(`  [AT-${String(i).padStart(2)}] sisa:${sisa}s | H:${health.success?'OK':'FAIL'}(${Math.round(health.latencyMs)}ms) | Store:OK(${Math.round(store.latencyMs)}ms) | Doc:${doc.success?'OK':'FAIL'}`)
      } else {
        console.log(`  [AT-${String(i).padStart(2)}] sisa:${sisa}s | H:${health.success?'OK':'FAIL'}(${Math.round(health.latencyMs)}ms) | Store:FAIL(${Math.round(store.latencyMs)}ms) err:${store.detail}`)
      }
      nextStore = now_ + CONFIG.storeInterval
    } else {
      console.log(`  [AT-${String(i).padStart(2)}] sisa:${sisa}s | H:${health.success?'OK':'FAIL'}(${Math.round(health.latencyMs)}ms) | flood:${floodStats.total}req`)
    }

    if (now_ >= nextRead) {
      const r = await readAcademic(token)
      hasil.read.push({ fase:'Serangan DDoS', no:i, ts:now(), jenis:'Read All', ...r })
      if (registry.academicIds.size > 0) {
        const sid = [...registry.academicIds][0]
        const rs  = await readStudent(token, sid)
        hasil.read.push({ fase:'Serangan DDoS', no:i, ts:now(), jenis:'Read Student', ...rs })
      }
      nextRead = now_ + CONFIG.readInterval
    }

    if (now_ >= nextVerify) {
      const v = await verifyHash(token)
      if (v) hasil.verify.push({ fase:'Serangan DDoS', no:i, ts:now(), ...v })
      nextVerify = now_ + CONFIG.verifyInterval
    }

    await sleep(CONFIG.checkInterval)
  }

  stopFlood()
  await sleep(500)
  console.log(`\n  ✓ HTTP Flood dihentikan`)
  console.log(`  Total request flood: ${floodStats.total} | OK: ${floodStats.ok} | Fail: ${floodStats.fail}`)
  console.log(`  Distribusi per endpoint:`)
  Object.entries(floodStats.byEndpoint).forEach(([ep, cnt]) => {
    console.log(`    ${ep.padEnd(30)} ${cnt} req`)
  })

  return { hasil, floodStats: { ...floodStats } }
}

// ─────────────────────────────────────────────
// FASE 3: RECOVERY
// ─────────────────────────────────────────────
async function runRecovery(token, duration) {
  console.log(`\n${'─'.repeat(62)}`)
  console.log(`[FASE 3] RECOVERY — ${duration} detik setelah serangan`)
  console.log(`${'─'.repeat(62)}`)

  const hasil = { health:[], store:[], read:[], verify:[] }
  const endAt = Date.now() + duration*1000
  let i=0, storeNo=1000, nextStore=Date.now()+15000, nextRead=Date.now()
  let nextVerify=Date.now()+10000

  while (Date.now() < endAt) {
    i++
    const now_ = Date.now()
    const health = await checkHealth(token)
    hasil.health.push({ fase:'Recovery', no:i, ts:now(), ...health })

    if (now_ >= nextStore) {
      storeNo++
      const store = await storeAcademic(token, storeNo)
      hasil.store.push({ fase:'Recovery', no:storeNo, ts:now(), jenis:'Akademik', ...store })
      if (store.success) {
        const doc = await storeDocument(token, store.studentId)
        hasil.store.push({ fase:'Recovery', no:storeNo, ts:now(), jenis:'Dokumen', ...doc })
        console.log(`  [RC-${String(i).padStart(2)}] H:${health.success?'PULIH':'BELUM'}(${Math.round(health.latencyMs)}ms) | Store:OK(${Math.round(store.latencyMs)}ms) | Doc:${doc.success?'OK':'FAIL'}`)
      } else {
        console.log(`  [RC-${String(i).padStart(2)}] H:${health.success?'PULIH':'BELUM'}(${Math.round(health.latencyMs)}ms) | Store:FAIL(${Math.round(store.latencyMs)}ms) err:${store.detail}`)
      }
      nextStore = now_ + CONFIG.storeInterval
    } else {
      console.log(`  [RC-${String(i).padStart(2)}] H:${health.success?'PULIH':'BELUM'}(${Math.round(health.latencyMs)}ms)`)
    }

    if (now_ >= nextRead) {
      const r = await readAcademic(token)
      hasil.read.push({ fase:'Recovery', no:i, ts:now(), jenis:'Read All', ...r })
      nextRead = now_ + CONFIG.readInterval
    }

    if (now_ >= nextVerify) {
      const v = await verifyHash(token)
      if (v) hasil.verify.push({ fase:'Recovery', no:i, ts:now(), ...v })
      nextVerify = now_ + CONFIG.verifyInterval
    }

    await sleep(CONFIG.checkInterval)
  }
  return hasil
}

// ─────────────────────────────────────────────
// EXPORT EXCEL
// ─────────────────────────────────────────────
async function exportExcel(platform, baseline, attack, recovery, finalFloodStats, cleanup, filename) {
  const wb   = new ExcelJS.Workbook()
  const NAVY = { type:'pattern', pattern:'solid', fgColor:{argb:'FF1A2744'} }
  const GREEN= { type:'pattern', pattern:'solid', fgColor:{argb:'FFD4EDDA'} }
  const RED  = { type:'pattern', pattern:'solid', fgColor:{argb:'FFF8D7DA'} }
  const GREY = { type:'pattern', pattern:'solid', fgColor:{argb:'FFF2F2F2'} }
  const YEL  = { type:'pattern', pattern:'solid', fgColor:{argb:'FFFFF3CD'} }
  const BLUE = { type:'pattern', pattern:'solid', fgColor:{argb:'FFE6F1FB'} }
  const ORNG = { type:'pattern', pattern:'solid', fgColor:{argb:'FFFDE8D8'} }

  const wFont = { color:{argb:'FFFFFFFF'}, bold:true, name:'Times New Roman', size:11 }
  const nFont = { name:'Times New Roman', size:11 }
  const ctr   = { horizontal:'center', vertical:'middle', wrapText:true }
  const brd   = { top:{style:'thin'}, bottom:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'} }

  const H = (row, n) => { for(let c=1;c<=n;c++){const cell=row.getCell(c);cell.fill=NAVY;cell.font=wFont;cell.alignment=ctr;cell.border=brd} }
  const R = (row, n, fill) => { for(let c=1;c<=n;c++){const cell=row.getCell(c);if(fill)cell.fill=fill;cell.font=nFont;cell.alignment=ctr;cell.border=brd} }

  // Hitung stats
  const bH = calcStats(baseline.health)
  const aH = calcStats(attack.health)
  const rH = calcStats(recovery.health)
  const bS = calcStats(baseline.store.filter(d=>d.jenis==='Akademik'))
  const aS = calcStats(attack.store.filter(d=>d.jenis==='Akademik'))
  const rS = calcStats(recovery.store.filter(d=>d.jenis==='Akademik'))
  const bD = calcStats(baseline.store.filter(d=>d.jenis==='Dokumen'))
  const aD = calcStats(attack.store.filter(d=>d.jenis==='Dokumen'))
  const rD = calcStats(recovery.store.filter(d=>d.jenis==='Dokumen'))
  const bR = calcStats(baseline.read)
  const aR = calcStats(attack.read)
  const rR = calcStats(recovery.read)
  const bV = calcStats(baseline.verify)
  const aV = calcStats(attack.verify)
  const rV = calcStats(recovery.verify)

  // ── Sheet 1: Ringkasan ───────────────────────────────────────────
  const ws1 = wb.addWorksheet('Ringkasan')
  ws1.columns = [{width:34},{width:20},{width:20},{width:20},{width:28}]
  const t1 = ws1.addRow([`HASIL SIMULASI DDOS HTTP FLOOD — ${platform.toUpperCase()}`])
  ws1.mergeCells('A1:E1'); H(t1,5)
  ws1.addRow([])
  H(ws1.addRow(['Metrik','Baseline (Normal)','Saat HTTP Flood','Recovery','Keterangan']),5)

  const sections = [
    { label: '── AVAILABILITY — Health Check ──' },
    { v:['Total Request',            bH.total,                       aH.total,                       rH.total,                       'GET /api/health'] },
    { v:['Berhasil',                 bH.success,                     aH.success,                     rH.success,                     ''] },
    { v:['Availability (%)',         `${bH.availability.toFixed(1)}%`,`${aH.availability.toFixed(1)}%`,`${rH.availability.toFixed(1)}%`,'Target ≥ 90%'], y:true },
    { v:['Latency Avg (ms)',         bH.avgLatency.toFixed(1),       aH.avgLatency.toFixed(1),       rH.avgLatency.toFixed(1),       ''] },
    { v:['Latency P95 (ms)',         bH.p95.toFixed(1),              aH.p95.toFixed(1),              rH.p95.toFixed(1),              'Persentil ke-95'] },
    { v:['Latency Maks (ms)',        bH.maxLatency.toFixed(1),       aH.maxLatency.toFixed(1),       rH.maxLatency.toFixed(1),       ''] },

    { label: '── STORE DATA AKADEMIK ──' },
    { v:['Total Percobaan',          bS.total,                       aS.total,                       rS.total,                       'POST /api/academic/record'] },
    { v:['Berhasil',                 bS.success,                     aS.success,                     rS.success,                     ''] },
    { v:['Gagal',                    bS.fail,                        aS.fail,                        rS.fail,                        ''] },
    { v:['Success Rate (%)',         `${bS.availability.toFixed(1)}%`,`${aS.availability.toFixed(1)}%`,`${rS.availability.toFixed(1)}%`,'Integritas data'], y:true },
    { v:['Latency Avg (ms)',         bS.avgLatency.toFixed(1),       aS.avgLatency.toFixed(1),       rS.avgLatency.toFixed(1),       ''] },
    { v:['Latency P95 (ms)',         bS.p95.toFixed(1),              aS.p95.toFixed(1),              rS.p95.toFixed(1),              ''] },

    { label: '── STORE DOKUMEN (PDF) ──' },
    { v:['Total Percobaan',          bD.total,                       aD.total,                       rD.total,                       'POST /api/documents/generate'] },
    { v:['Berhasil',                 bD.success,                     aD.success,                     rD.success,                     ''] },
    { v:['Success Rate (%)',         `${bD.availability.toFixed(1)}%`,`${aD.availability.toFixed(1)}%`,`${rD.availability.toFixed(1)}%`,''], y:true },
    { v:['Latency Avg (ms)',         bD.avgLatency.toFixed(1),       aD.avgLatency.toFixed(1),       rD.avgLatency.toFixed(1),       ''] },

    { label: '── READ DATA ──' },
    { v:['Total Percobaan',          bR.total,                       aR.total,                       rR.total,                       'GET /api/academic'] },
    { v:['Berhasil',                 bR.success,                     aR.success,                     rR.success,                     ''] },
    { v:['Success Rate (%)',         `${bR.availability.toFixed(1)}%`,`${aR.availability.toFixed(1)}%`,`${rR.availability.toFixed(1)}%`,''], y:true },
    { v:['Latency Avg (ms)',         bR.avgLatency.toFixed(1),       aR.avgLatency.toFixed(1),       rR.avgLatency.toFixed(1),       ''] },

    { label: '── VERIFIKASI HASH (INTEGRITAS) ──' },
    { v:['Total Percobaan',          bV.total,                       aV.total,                       rV.total,                       'POST /api/verify/hash'] },
    { v:['Berhasil',                 bV.success,                     aV.success,                     rV.success,                     ''] },
    { v:['Success Rate (%)',         `${bV.availability.toFixed(1)}%`,`${aV.availability.toFixed(1)}%`,`${rV.availability.toFixed(1)}%`,'Hash valid = data tidak tamper'], y:true },

    { label: '── STATISTIK HTTP FLOOD ──' },
    { v:['Total Request Flood',      '—', finalFloodStats.total,     '—',                            'Dari flood workers'] },
    { v:['Flood Berhasil (ok)',       '—', finalFloodStats.ok,        '—',                            ''] },
    { v:['Flood Gagal (error)',       '—', finalFloodStats.fail,      '—',                            'Server menolak / timeout'] },
    { v:['Flood Error Rate (%)',      '—', `${(finalFloodStats.fail/Math.max(finalFloodStats.total,1)*100).toFixed(1)}%`,'—','Tinggi = server terkena dampak'] },

    { label: '── INFO ──' },
    { v:['Platform',                 platform,                       platform,                       platform,                       ''] },
    { v:['Tanggal',                  new Date().toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'}),'','',''] },
    { v:['Data Test Dibersihkan',    '—','—', cleanup.deletedAcademic>0?`${cleanup.deletedAcademic} records`:'Via SQL manual','Prefix: DDOS_TEST_'] },
  ]

  let idx=0
  for (const s of sections) {
    if (s.label) {
      const row = ws1.addRow([s.label,'','','',''])
      ws1.mergeCells(`A${ws1.rowCount}:E${ws1.rowCount}`)
      for(let c=1;c<=5;c++){const cell=row.getCell(c);cell.fill=BLUE;cell.font={...nFont,bold:true,color:{argb:'FF185FA5'}};cell.alignment=ctr;cell.border=brd}
    } else {
      const row = ws1.addRow(s.v)
      R(row, 5, s.y ? YEL : (idx%2===0?null:GREY))
      idx++
    }
  }

  // ── Sheet 2: Statistik Flood ─────────────────────────────────────
  const ws2 = wb.addWorksheet('Statistik HTTP Flood')
  ws2.columns = [{width:36},{width:20},{width:20}]
  const t2 = ws2.addRow(['STATISTIK HTTP FLOOD — DISTRIBUSI ENDPOINT'])
  ws2.mergeCells('A1:C1'); H(t2,3)
  ws2.addRow([])
  H(ws2.addRow(['Endpoint','Jumlah Request','Persentase']),3)
  const totalFlood = finalFloodStats.total || 1
  Object.entries(finalFloodStats.byEndpoint||{}).sort((a,b)=>b[1]-a[1]).forEach(([ ep, cnt ], i) => {
    const row = ws2.addRow([ep, cnt, `${(cnt/totalFlood*100).toFixed(1)}%`])
    R(row, 3, i%2===0?null:GREY)
  })
  ws2.addRow([])
  const rFlood = ws2.addRow(['TOTAL', finalFloodStats.total, '100%'])
  R(rFlood, 3, YEL)

  // ── Sheet 3: Log Health ──────────────────────────────────────────
  const ws3 = wb.addWorksheet('Log Health')
  ws3.columns = [{width:5},{width:16},{width:10},{width:12},{width:16},{width:10}]
  H(ws3.addRow(['LOG HEALTH CHECK — AVAILABILITY']).getCell(1).row&&ws3.lastRow,6)
  ws3.addRow([]); H(ws3.addRow(['No','Fase','Timestamp','Status','Latency (ms)','HTTP']),6)
  ;[...baseline.health,...attack.health,...recovery.health].forEach((d,i)=>{
    R(ws3.addRow([i+1,d.fase,d.ts,d.success?'Berhasil':'Gagal',d.latencyMs.toFixed(1),d.code]),6,d.success?GREEN:RED)
  })

  // ── Sheet 4: Log Store Akademik ──────────────────────────────────
  const ws4 = wb.addWorksheet('Log Store Akademik')
  ws4.columns = [{width:5},{width:16},{width:10},{width:20},{width:12},{width:16},{width:24},{width:20}]
  ws4.addRow(['LOG STORE DATA AKADEMIK SAAT HTTP FLOOD'])
  ws4.mergeCells(`A1:H1`); H(ws4.getRow(1),8)
  ws4.addRow([]); H(ws4.addRow(['No','Fase','Timestamp','Student ID','Status','Latency (ms)','Tx ID','Keterangan']),8)
  ;[...baseline.store,...attack.store,...recovery.store].filter(d=>d.jenis==='Akademik').forEach((d,i)=>{
    R(ws4.addRow([i+1,d.fase,d.ts,d.studentId,d.success?'Berhasil':'Gagal',d.latencyMs.toFixed(1),d.txId||'—',d.detail||'']),8,d.success?GREEN:RED)
  })

  // ── Sheet 5: Log Store Dokumen ───────────────────────────────────
  const ws5 = wb.addWorksheet('Log Store Dokumen')
  ws5.columns = [{width:5},{width:16},{width:10},{width:20},{width:14},{width:12},{width:16},{width:20}]
  ws5.addRow(['LOG GENERATE DOKUMEN SAAT HTTP FLOOD'])
  ws5.mergeCells('A1:H1'); H(ws5.getRow(1),8)
  ws5.addRow([]); H(ws5.addRow(['No','Fase','Timestamp','Student ID','Tipe Dokumen','Status','Latency (ms)','Keterangan']),8)
  ;[...baseline.store,...attack.store,...recovery.store].filter(d=>d.jenis==='Dokumen').forEach((d,i)=>{
    R(ws5.addRow([i+1,d.fase,d.ts,d.studentId,d.documentType,d.success?'Berhasil':'Gagal',d.latencyMs.toFixed(1),d.detail||'']),8,d.success?GREEN:RED)
  })

  // ── Sheet 6: Log Read ────────────────────────────────────────────
  const ws6 = wb.addWorksheet('Log Read Data')
  ws6.columns = [{width:5},{width:16},{width:10},{width:16},{width:12},{width:16},{width:18},{width:20}]
  ws6.addRow(['LOG READ DATA SAAT HTTP FLOOD'])
  ws6.mergeCells('A1:H1'); H(ws6.getRow(1),8)
  ws6.addRow([]); H(ws6.addRow(['No','Fase','Timestamp','Jenis','Status','Latency (ms)','Records','Keterangan']),8)
  ;[...baseline.read,...attack.read,...recovery.read].forEach((d,i)=>{
    R(ws6.addRow([i+1,d.fase,d.ts,d.jenis,d.success?'Berhasil':'Gagal',d.latencyMs.toFixed(1),d.recordCount||0,d.detail||'']),8,d.success?GREEN:RED)
  })

  // ── Sheet 7: Log Verify Hash ─────────────────────────────────────
  const ws7 = wb.addWorksheet('Log Verify Hash')
  ws7.columns = [{width:5},{width:16},{width:10},{width:20},{width:12},{width:12},{width:16},{width:30}]
  ws7.addRow(['LOG VERIFIKASI HASH INTEGRITAS SAAT HTTP FLOOD'])
  ws7.mergeCells('A1:H1'); H(ws7.getRow(1),8)
  ws7.addRow([]); H(ws7.addRow(['No','Fase','Timestamp','Student ID','Status','Hash Valid?','Latency (ms)','Keterangan']),8)
  ;[...baseline.verify,...attack.verify,...recovery.verify].forEach((d,i)=>{
    const fill = !d.success ? RED : d.isValid ? GREEN : ORNG
    R(ws7.addRow([i+1,d.fase,d.ts,d.studentId,d.success?'Berhasil':'Gagal',d.isValid?'VALID':'TIDAK VALID',d.latencyMs.toFixed(1),d.detail||'']),8,fill)
  })

  // ── Sheet 8: Cleanup ─────────────────────────────────────────────
  const ws8 = wb.addWorksheet('Cleanup Info')
  ws8.columns = [{width:30},{width:50}]
  H(ws8.addRow(['INFORMASI DATA TEST & CLEANUP']),2)
  ws8.mergeCells('A1:B1')
  ws8.addRow([]); H(ws8.addRow(['Informasi','Detail']),2)
  ;[
    ['Prefix Data Test',   CONFIG.testPrefix],
    ['Jumlah Student IDs', registry.academicIds.size],
    ['Jumlah Dokumen',     registry.documentIds.length],
    ['Status Cleanup',     cleanup.deletedAcademic>0?'Otomatis':'Manual — lihat SQL di bawah'],
    ['SQL Cleanup',        cleanup.manualSql||'Tidak diperlukan'],
  ].forEach((p,i) => { R(ws8.addRow(p),2,i%2===1?GREY:null) })

  await wb.xlsx.writeFile(filename)
  console.log(`  ✓ Laporan disimpan ke: ${filename}`)
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('platform',      { type:'string',  default:'ethereum', description:'ethereum atau fabric' })
    .option('duration',      { type:'number',  default:300,        description:'Durasi serangan (detik)' })
    .option('baseline',      { type:'number',  default:60,         description:'Durasi baseline (detik)' })
    .option('recovery',      { type:'number',  default:60,         description:'Durasi recovery (detik)' })
    .option('flood-workers', { type:'number',  default:50,         description:'Jumlah concurrent HTTP flood workers' })
    .argv

  const floodWorkers = argv['flood-workers']

  console.log(`\n${'='.repeat(62)}`)
  console.log('  SIMULASI DDoS HTTP FLOOD — AVAILABILITY & INTEGRITAS')
  console.log('  Tugas Akhir — Prodi Informatika UAJY')
  console.log(`  Platform    : ${argv.platform.toUpperCase()}`)
  console.log(`  API URL     : ${CONFIG.apiUrl}`)
  console.log(`  Durasi      : baseline=${argv.baseline}s | serangan=${argv.duration}s | recovery=${argv.recovery}s`)
  console.log(`  Flood       : ${floodWorkers} workers → 5 endpoint`)
  console.log(`  ${new Date().toLocaleString('id-ID')}`)
  console.log('='.repeat(62))

  // Login
  console.log('\n[0] Login...')
  const token = await getToken()
  if (!token) {
    console.log('  ✗ Login gagal. Pastikan backend aktif di ' + CONFIG.apiUrl)
    process.exit(1)
  }
  console.log('  ✓ Token diperoleh')

  // Jalankan 3 fase
  const baseline             = await runBaseline(token, argv.baseline)
  const { hasil: attack,
          floodStats: fs }   = await runAttackPhase(token, argv.duration, floodWorkers)
  const recovery             = await runRecovery(token, argv.recovery)
  const cleanup              = await cleanupTestData(token)

  // Export Excel
  console.log('\n[4] Mengekspor laporan Excel...')
  const ts    = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)
  const fname = `hasil_ddos_${argv.platform}_${ts}.xlsx`
  await exportExcel(argv.platform, baseline, attack, recovery, fs, cleanup, fname)

  // Ringkasan terminal
  const bH = calcStats(baseline.health), aH = calcStats(attack.health), rH = calcStats(recovery.health)
  const aS = calcStats(attack.store.filter(d=>d.jenis==='Akademik'))
  const aD = calcStats(attack.store.filter(d=>d.jenis==='Dokumen'))
  const rS = calcStats(recovery.store.filter(d=>d.jenis==='Akademik'))
  const rD = calcStats(recovery.store.filter(d=>d.jenis==='Dokumen'))
  const aR = calcStats(attack.read)
  const aV = calcStats(attack.verify)

  console.log(`\n${'='.repeat(62)}`)
  console.log('  RINGKASAN AKHIR')
  console.log('='.repeat(62))
  console.log(`  Availability  : BL ${bH.availability.toFixed(1)}% → AT ${aH.availability.toFixed(1)}% → RC ${rH.availability.toFixed(1)}%`)
  console.log(`  Latency Avg   : BL ${bH.avgLatency.toFixed(0)}ms → AT ${aH.avgLatency.toFixed(0)}ms → RC ${rH.avgLatency.toFixed(0)}ms`)
  console.log(`  Store Akademik: AT ${aS.success}/${aS.total} (${aS.availability.toFixed(1)}%) | RC ${rS.success}/${rS.total} (${rS.availability.toFixed(1)}%)`)
  console.log(`  Store Dokumen : AT ${aD.success}/${aD.total} (${aD.availability.toFixed(1)}%) | RC ${rD.success}/${rD.total} (${rD.availability.toFixed(1)}%)`)
  console.log(`  Read Data     : ${aR.success}/${aR.total} berhasil (${aR.availability.toFixed(1)}%)`)
  console.log(`  Verify Hash   : ${aV.success}/${aV.total} berhasil (${aV.availability.toFixed(1)}%)`)
  console.log(`  HTTP Flood    : ${fs.total} req dikirim | ${fs.fail} ditolak server`)
  console.log(`\n  Target availability ≥90%: ${aH.availability>=90?'✓ TERCAPAI':'✗ TIDAK TERCAPAI'}`)
  console.log(`  Laporan       : ${fname}`)
  if (cleanup.manualSql) {
    console.log(`\n  ⚠ SQL Cleanup:\n  ${cleanup.manualSql.split('\n').join('\n  ')}`)
  }
  console.log('='.repeat(62)+'\n')
}

main().catch(e => { stopFlood(); console.error('Fatal:', e.message); process.exit(1) })