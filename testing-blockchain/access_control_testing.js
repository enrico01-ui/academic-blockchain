/**
 * access_control_testing.js  [v3 — Ethereum-safe]
 * =========================
 * Pengujian Kontrol Akses Sistem Manajemen Data Akademik
 * Tugas Akhir: Perbandingan Ethereum Testnet dan Hyperledger Fabric
 *
 * Kelompok 1–5 : Uji layer API/middleware
 * Kelompok 6   : Uji akses langsung ke Ethereum Smart Contract (bypass API)
 * Kelompok 7   : Uji akses langsung ke Hyperledger Fabric Chaincode (bypass API)
 *
 * SETUP SEBELUM JALANKAN:
 *   1. Copy file .env.example ke .env dan isi nilainya
 *   2. npm install ethers @hyperledger/fabric-gateway @grpc/grpc-js dotenv
 *   3. Pastikan ABI_PATH menunjuk ke file ABI kontrak yang sudah di-deploy
 *
 * Cara pakai:
 *   node access_control_testing.js
 */

const axios   = require('axios')
const ExcelJS = require('exceljs')
const fs      = require('fs')
const nodePath = require('path')
const crypto  = require('crypto')

// ── Load .env — private key TIDAK boleh hardcode di sini ──
try { require('dotenv').config() } catch { /* dotenv opsional */ }

// ── Dependensi blockchain layer ──
let ethers        = null
let fabricGateway = null
let grpc          = null
try { ({ ethers } = require('ethers'))                        } catch { /* dilewati */ }
try { fabricGateway = require('@hyperledger/fabric-gateway') } catch { /* dilewati */ }
try { grpc = require('@grpc/grpc-js')                        } catch { /* dilewati */ }

// ─────────────────────────────────────────────
// KONFIGURASI
// Private key dan key sensitif dibaca dari environment variable (.env)
// TIDAK ADA private key yang boleh ditulis langsung di sini
// ─────────────────────────────────────────────
const CONFIG = {
  apiUrl:        process.env.API_URL        || 'http://139.59.240.82:3000/api',
  adminUser:     process.env.ADMIN_USER     || 'admin',
  adminPass:     process.env.ADMIN_PASS     || 'admin123',
  dosenUser:     process.env.DOSEN_USER     || 'dosen1',
  dosenPass:     process.env.DOSEN_PASS     || 'dosen123',
  mahasiswaUser: process.env.MHS_USER       || 'mhs001',  // Fix Bug 4
  mahasiswaPass: process.env.MHS_PASS       || 'mhs123',

  eth: {
    rpcUrl:          process.env.ETH_RPC_URL       || '',
    contractAddress: process.env.ETH_CONTRACT_ADDR || '',
    abiPath:         process.env.ETH_ABI_PATH       || './artifacts/AcademicRecord.json',
    attackerKey:     process.env.ETH_ATTACKER_KEY   || '',
    ownerKey:        process.env.ETH_OWNER_KEY      || '',
  },

  fabric: {
    // Fix Bug 2: baca dari .env, bukan hardcode
    cryptoPath:        process.env.FABRIC_CRYPTO_PATH    || '/root/fabric-samples/test-network/organizations',
    channelName:       process.env.FABRIC_CHANNEL        || 'academicchannel',  // Fix Bug 5
    chaincodeName:     process.env.FABRIC_CHAINCODE      || 'academic',          // Fix Bug 5
    unauthorizedMspId: process.env.FABRIC_UNAUTH_MSP     || 'Org2MSP',
    peerEndpoint:      process.env.FABRIC_PEER_ENDPOINT  || '139.59.240.82:7051',
    peerHostAlias:     process.env.FABRIC_PEER_ALIAS     || 'peer0.org1.example.com',
  },
}

// ─────────────────────────────────────────────
// VALIDASI KONFIGURASI ETHEREUM
// Jalankan ini sebelum test dimulai — gagal cepat daripada error di tengah
// ─────────────────────────────────────────────
function validateEthConfig() {
  const issues = []

  if (!CONFIG.eth.rpcUrl)
    issues.push('ETH_RPC_URL kosong — isi di .env')

  if (!CONFIG.eth.contractAddress || CONFIG.eth.contractAddress === '0xYOUR_CONTRACT_ADDRESS')
    issues.push('ETH_CONTRACT_ADDR kosong atau masih placeholder')

  if (CONFIG.eth.contractAddress && !/^0x[0-9a-fA-F]{40}$/.test(CONFIG.eth.contractAddress))
    issues.push(`ETH_CONTRACT_ADDR tidak valid: ${CONFIG.eth.contractAddress}`)

  if (!CONFIG.eth.attackerKey)
    issues.push('ETH_ATTACKER_KEY kosong — isi private key wallet bukan-owner di .env')

  if (!CONFIG.eth.ownerKey)
    issues.push('ETH_OWNER_KEY kosong — isi private key owner di .env')

  if (CONFIG.eth.attackerKey && CONFIG.eth.ownerKey && CONFIG.eth.attackerKey === CONFIG.eth.ownerKey)
    issues.push('ETH_ATTACKER_KEY dan ETH_OWNER_KEY sama — attacker harus wallet yang berbeda dari owner')

  // Cek ABI file ada
  if (CONFIG.eth.abiPath && !fs.existsSync(CONFIG.eth.abiPath))
    issues.push(`ABI file tidak ditemukan: ${CONFIG.eth.abiPath} — pastikan sudah compile kontrak`)

  return issues
}

// ── Load ABI dari file JSON hasil compile ──
function loadAbi() {
  try {
    const raw = fs.readFileSync(CONFIG.eth.abiPath, 'utf8')
    const parsed = JSON.parse(raw)
    // Hardhat artifact: { abi: [...] }  |  raw ABI: langsung array
    return parsed.abi || parsed
  } catch (e) {
    return null
  }
}

// ─────────────────────────────────────────────
// HELPER — Layer API (Kelompok 1–5)
// ─────────────────────────────────────────────
async function getToken(username, password) {
  try {
    const res = await axios.post(`${CONFIG.apiUrl}/auth/login`, { username, password }, { timeout: 10000 })
    return res.data?.token || null
  } catch (e) {
    console.log(`  [!] Login gagal (${username}): ${e.message}`)
    return null
  }
}

async function sendRequest(method, endpoint, token = null, body = null, expiredToken = false) {
  const url     = `${CONFIG.apiUrl}${endpoint}`
  const headers = { 'Content-Type': 'application/json' }

  if (expiredToken) {
    headers['Authorization'] = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjEiLCJyb2xlIjoiYWRtaW4iLCJpYXQiOjE2MDAwMDAwMDB9.INVALID_SIGNATURE'
  } else if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const t = Date.now()
  try {
    const res = await axios({ method, url, headers, data: body || {}, timeout: 10000 })
    return { statusCode: res.status, latencyMs: Date.now() - t, body: String(res.data).slice(0, 100) }
  } catch (e) {
    return { statusCode: e.response?.status || 0, latencyMs: Date.now() - t, body: String(e.message).slice(0, 100) }
  }
}

// ─────────────────────────────────────────────
// HELPER — Ethereum Smart Contract (Kelompok 6)
// ─────────────────────────────────────────────

/**
 * Klasifikasi error ethers ke hasil yang bermakna.
 * ethers v6 punya banyak kode error berbeda — semua yang terkait revert dianggap LULUS.
 */
function classifyEthError(e) {
  const msg  = (e.message || '').toLowerCase()
  const code = e.code || ''

  // Error yang artinya kontrak meng-revert transaksi → access control BEKERJA
  const isRevert =
    code === 'CALL_EXCEPTION'           ||  // ethers v6 standard revert
    code === 'UNPREDICTABLE_GAS_LIMIT'  ||  // ethers v5 revert saat estimateGas
    code === 'ACTION_REJECTED'          ||  // wallet menolak sebelum kirim
    msg.includes('execution reverted')  ||
    msg.includes('revert')              ||
    msg.includes('transaction reverted')||
    msg.includes('onlyowner')           ||  // beberapa kontrak include modifier name
    msg.includes('not authorized')      ||
    msg.includes('access denied')       ||
    // Error data — kontrak mengembalikan custom error (Solidity custom error)
    (code === 'CALL_EXCEPTION' && e.data !== '0x')

  // Error infrastruktur — bukan soal akses, tapi koneksi/konfigurasi
  const isInfra =
    msg.includes('could not detect network') ||
    msg.includes('network does not exist')   ||
    msg.includes('invalid api key')          ||
    msg.includes('invalid project id')       ||
    msg.includes('bad_data')                 ||  // ABI tidak cocok
    msg.includes('invalid argument')         ||
    code === 'INVALID_ARGUMENT'              ||
    code === 'BAD_DATA'                      ||
    code === 'NETWORK_ERROR'

  return { isRevert, isInfra }
}

/**
 * Coba panggil fungsi write dari wallet BUKAN owner.
 * Memakai staticCall() yang lebih reliable dari estimateGas() untuk mendeteksi revert.
 * staticCall() mensimulasikan eksekusi penuh tanpa mengirim transaksi — 0 gas terpakai.
 */
async function testEthUnauthorized(abi, funcName, args, desc) {
  const t = Date.now()

  if (!ethers) return skipResult('ethers tidak terinstall')

  // Validasi konfigurasi dulu
  const cfgIssues = validateEthConfig()
  if (cfgIssues.length > 0) return skipResult(cfgIssues[0])

  const abiLoaded = abi || loadAbi()
  if (!abiLoaded) return skipResult(`ABI tidak bisa dibaca dari ${CONFIG.eth.abiPath}`)

  // Pastikan fungsi ada di ABI sebelum memanggil
  const fnExists = abiLoaded.some(item =>
    (item.name === funcName || (typeof item === 'string' && item.includes(funcName))) &&
    (item.stateMutability !== 'view' && item.stateMutability !== 'pure')
  )
  if (!fnExists) return skipResult(`Fungsi '${funcName}' tidak ditemukan di ABI atau bukan fungsi write`)

  try {
    const provider  = new ethers.JsonRpcProvider(CONFIG.eth.rpcUrl)
    const attacker  = new ethers.Wallet(CONFIG.eth.attackerKey, provider)
    const contract  = new ethers.Contract(CONFIG.eth.contractAddress, abiLoaded, attacker)

    // Cek kontrak benar-benar ada di Sepolia
    const code = await provider.getCode(CONFIG.eth.contractAddress)
    if (code === '0x') {
      return skipResult(`Kontrak tidak ditemukan di ${CONFIG.eth.contractAddress} — belum di-deploy atau alamat salah`)
    }

    // staticCall: simulasikan eksekusi penuh, tidak kirim transaksi nyata
    await contract[funcName].staticCall(...args)

    // Jika sampai sini → kontrak TIDAK revert → celah keamanan
    return {
      statusCode: 200,
      latencyMs:  Date.now() - t,
      body:       `PERINGATAN: staticCall ${funcName} berhasil tanpa revert`,
      blockchainResult: `LOLOS — kontrak tidak memblokir wallet tidak sah (onlyOwner mungkin tidak ada)`,
      txHash: '—',
    }
  } catch (e) {
    const { isRevert, isInfra } = classifyEthError(e)
    const lat = Date.now() - t

    if (isInfra) return skipResult(`Konfigurasi/infrastruktur: ${e.message?.slice(0, 80)}`)

    return {
      statusCode:       isRevert ? 403 : 0,
      latencyMs:        lat,
      body:             e.message?.slice(0, 120) || 'error',
      blockchainResult: isRevert
        ? `DITOLAK — kontrak revert (access control bekerja) | kode: ${e.code || 'REVERT'}`
        : `ERROR tidak terduga (kode: ${e.code}) — periksa ABI dan nama fungsi`,
      txHash: '—',
    }
  }
}

/**
 * Verifikasi owner sah bisa memanggil fungsi yang sama (kontrol negatif).
 * Juga pakai staticCall — tidak kirim transaksi nyata.
 */
async function testEthAuthorized(abi, funcName, args) {
  const t = Date.now()
  if (!ethers) return skipResult('ethers tidak terinstall')

  const cfgIssues = validateEthConfig()
  if (cfgIssues.length > 0) return skipResult(cfgIssues[0])

  const abiLoaded = abi || loadAbi()
  if (!abiLoaded) return skipResult(`ABI tidak bisa dibaca`)

  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.eth.rpcUrl)
    const owner    = new ethers.Wallet(CONFIG.eth.ownerKey, provider)
    const contract = new ethers.Contract(CONFIG.eth.contractAddress, abiLoaded, owner)

    const code = await provider.getCode(CONFIG.eth.contractAddress)
    if (code === '0x') return skipResult('Kontrak tidak ditemukan di alamat yang dikonfigurasi')

    await contract[funcName].staticCall(...args)

    return {
      statusCode: 200, latencyMs: Date.now() - t,
      body: `Owner dapat memanggil ${funcName}`,
      blockchainResult: 'DIIZINKAN — owner sah berhasil staticCall (kontrol negatif valid)',
      txHash: '—',
    }
  } catch (e) {
    const { isRevert, isInfra } = classifyEthError(e)
    if (isInfra) return skipResult(`Konfigurasi/infrastruktur: ${e.message?.slice(0, 80)}`)
    return {
      statusCode: 0, latencyMs: Date.now() - t,
      body: e.message?.slice(0, 120),
      // Kalau owner juga di-revert, kemungkinan ada masalah di state kontrak (data tidak ada)
      blockchainResult: isRevert
        ? `Kontrol negatif gagal — owner juga di-revert. Cek apakah data uji sudah ada di kontrak`
        : `ERROR tidak terduga: ${e.message?.slice(0, 60)}`,
      txHash: '—',
    }
  }
}


// Helper: buat bytes32 dummy untuk args test (32 bytes = 64 hex chars)
// Dipakai di skenario Kelompok 6 supaya args tipe-nya benar (bytes32 bukan plain string)
function hashToBytes32Fake(seed = 'access_control_test') {
  const crypto = require('crypto')
  return '0x' + crypto.createHash('sha256').update(seed).digest('hex')
}

function skipResult(reason) {
  return { statusCode: 0, latencyMs: 0, body: reason, blockchainResult: `SKIP — ${reason}`, txHash: '—' }
}

// ─────────────────────────────────────────────
// HELPER — Hyperledger Fabric Chaincode (Kelompok 7)
// ─────────────────────────────────────────────
function newGrpcConnection(tlsCertPath, peerEndpoint, peerHostAlias) {
  const tlsRootCert    = fs.readFileSync(tlsCertPath)
  const tlsCredentials = grpc.credentials.createSsl(tlsRootCert)
  return new grpc.Client(peerEndpoint, tlsCredentials, {
    'grpc.ssl_target_name_override': peerHostAlias,
  })
}

async function testFabricUnauthorized(funcName, args, mspId, certPath, keyPath) {
  const t = Date.now()
  if (!fabricGateway || !grpc) return skipResult('fabric-gateway/grpc tidak terinstall')

  const { connect, signers: { newPrivateKeySigner } } = fabricGateway

  const tlsCertPath = process.env.FABRIC_TLS_CERT.replace(/\\/g, '/') || nodePath.join(CONFIG.fabric.cryptoPath, 'peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt')
  if (!fs.existsSync(tlsCertPath))
    return skipResult(`TLS cert tidak ditemukan: ${tlsCertPath}. Sesuaikan CONFIG.fabric.cryptoPath`)
  if (!fs.existsSync(certPath))
    return skipResult(`Cert MSP tidak ditemukan: ${certPath}`)
  if (!fs.existsSync(keyPath))
    return skipResult(`Key MSP tidak ditemukan: ${keyPath}`)

  let client
  try {
    client = newGrpcConnection(tlsCertPath, CONFIG.fabric.peerEndpoint, CONFIG.fabric.peerHostAlias)

    const cert = fs.readFileSync(certPath)
    const keyPem = fs.readFileSync(keyPath, 'utf8')

    const identity = {
      mspId,
      credentials: cert
    }

    const privateKey = crypto.createPrivateKey(keyPem)
    const signer = newPrivateKeySigner(privateKey)

    const gateway = connect({ client, identity, signer })
    try {
      const network  = gateway.getNetwork(CONFIG.fabric.channelName)
      const contract = network.getContract(CONFIG.fabric.chaincodeName)
      await contract.submitTransaction(funcName, ...args)

      return { statusCode: 200, latencyMs: Date.now() - t, body: `PERINGATAN: ${funcName} tidak direject chaincode`, blockchainResult: 'LOLOS — chaincode tidak memblokir MSP tidak sah', txHash: '—' }
    } finally {
      gateway.close()
    }
  } catch (e) {
    const msg = (e.message || '').toLowerCase()
    const isRejected =
      msg.includes('permission') || msg.includes('unauthorized') ||
      msg.includes('not authorized') || msg.includes('access denied') ||
      msg.includes('failed to endorse') ||
      msg.includes('endorsement') || e.code === 12
    return {
      statusCode:       isRejected ? 403 : 0,
      latencyMs:        Date.now() - t,
      body:             e.message?.slice(0, 120) || 'error',
      blockchainResult: isRejected
        ? 'DITOLAK — chaincode/policy menolak MSP tidak sah'
        : `ERROR tidak terduga: ${e.message?.slice(0, 60)}`,
      txHash: '—',
    }
  } finally {
    client?.close()
  }
}

// ─────────────────────────────────────────────
// SKENARIO PENGUJIAN
// ─────────────────────────────────────────────
function buildScenarios(tokenAdmin, tokenDosen, tokenMhs) {
  const scenarios = []

  const academicBody = {
    student_id: 'X', course_code: 'Y', grade: 'A', gpa_point: 4,
    semester: 1, academic_year: '2024/2025', attendance: 'always',
    student_name: 'X', course_name: 'Y'
  }

  // ── Kelompok 1: Tanpa Token (9 skenario) ──
  const noTokenCases = [
    ['GET',  '/academic',                   null, null,         'Ambil semua record tanpa token'],
    ['POST', '/academic/record',            null, academicBody, 'Input data tanpa token'],
    ['POST', '/verify/hash',                null, { student_id: 'X' }, 'Verifikasi tanpa token'],
    ['GET',  '/users',                      null, null,         'Ambil daftar user tanpa token'],
    ['POST', '/users',                      null, { username: 'x', password: 'x', role: 'admin', email: 'x@x.com', full_name: 'X' }, 'Buat user tanpa token'],
    ['GET',  '/documents',                  null, null,         'Ambil daftar dokumen tanpa token'],
    ['POST', '/documents/generate',         null, { student_id: 'X', document_type: 'ijazah' }, 'Generate dokumen tanpa token'],
    ['GET',  '/academic/STUD_001',          null, null,         'Ambil record mahasiswa tanpa token'],
    ['GET',  '/documents/student/STUD_001', null, null,         'Ambil dokumen mahasiswa tanpa token'],
  ]
  for (const [m, ep, tok, body, desc] of noTokenCases)
    scenarios.push({ kelompok: '1 — Tanpa Token', method: m, endpoint: ep, token: tok, body, expired: false, deskripsi: desc, expected: 'HTTP 401', expectedCodes: [401], layer: 'API' })

  // ── Kelompok 2: Token Expired/Palsu (10 skenario) ──
  const expiredCases = [
    ['GET',  '/academic',                   'Ambil semua record dengan token palsu'],
    ['POST', '/academic/record',            'Input data dengan token expired'],
    ['GET',  '/users',                      'Ambil user dengan token palsu'],
    ['POST', '/documents/generate',         'Generate dokumen token expired'],
    ['POST', '/verify/hash',                'Verifikasi dengan token palsu'],
    ['GET',  '/documents',                  'Daftar dokumen token expired'],
    ['GET',  '/academic/STUD_001',          'Ambil record dengan token palsu'],
    ['POST', '/users',                      'Buat user token expired'],
    ['GET',  '/documents/student/STUD_001', 'Dokumen mahasiswa token palsu'],
    ['GET',  '/auth/me',                    'Profil dengan token palsu'],
  ]
  for (const [m, ep, desc] of expiredCases)
    scenarios.push({ kelompok: '2 — Token Palsu/Expired', method: m, endpoint: ep, token: null, body: null, expired: true, deskripsi: desc, expected: 'HTTP 401', expectedCodes: [401], layer: 'API' })

  // ── Kelompok 3: Mahasiswa Akses Endpoint Admin/Dosen (15 skenario) ──
  const mhsCases = [
    ['POST', '/academic/record',    { ...academicBody },                                              'Mahasiswa input data akademik'],
    ['GET',  '/users',              null,                                                              'Mahasiswa ambil daftar user'],
    ['POST', '/users',              { username: 'hack', password: 'hack', role: 'admin', email: 'h@h.com', full_name: 'H' }, 'Mahasiswa buat akun admin'],
    ['POST', '/documents/generate', { student_id: 'X', document_type: 'ijazah' },                    'Mahasiswa generate ijazah'],
    ['GET',  '/documents',          null,                                                              'Mahasiswa ambil semua dokumen'],
    ['GET',  '/academic',           null,                                                              'Mahasiswa ambil semua record'],
    ['POST', '/academic/record',    { ...academicBody, semester: 2 },                                 'Mahasiswa input record semester 2'],
    ['POST', '/documents/generate', { student_id: 'STUD_001', document_type: 'transkrip' },          'Mahasiswa generate transkrip mahasiswa lain'],
    ['POST', '/documents/generate', { student_id: 'STUD_002', document_type: 'sertifikat' },         'Mahasiswa generate sertifikat mahasiswa lain'],
    ['GET',  '/users',              null,                                                              'Mahasiswa lihat daftar pengguna (ulang)'],
    ['POST', '/users',              { username: 'test2', password: 'test2', role: 'dosen', email: 't@t.com', full_name: 'T' }, 'Mahasiswa buat akun dosen'],
    ['POST', '/academic/record',    { ...academicBody, semester: 3, course_code: 'Z', course_name: 'Z' }, 'Mahasiswa input record semester 3'],
    ['GET',  '/documents',          null,                                                              'Mahasiswa akses semua dokumen (ulang)'],
    ['POST', '/documents/generate', { student_id: 'STUD_003', document_type: 'ijazah' },             'Mahasiswa generate ijazah mahasiswa lain'],
    ['GET',  '/academic',           null,                                                              'Mahasiswa ambil semua record (ulang)'],
  ]
  for (const [m, ep, body, desc] of mhsCases)
    scenarios.push({ kelompok: '3 — Mahasiswa Akses Endpoint Admin/Dosen', method: m, endpoint: ep, token: tokenMhs, body, expired: false, deskripsi: desc, expected: 'HTTP 403', expectedCodes: [403, 401], layer: 'API' })

  // ── Kelompok 4: Dosen Akses Endpoint Admin (10 skenario) ──
  const dosenCases = [
    ['GET',  '/users', null, 'Dosen ambil daftar user'],
    ['POST', '/users', { username: 'newuser',  password: 'pass123', role: 'admin',     email: 'n@n.com',  full_name: 'New' },    'Dosen buat akun baru'],
    ['POST', '/users', { username: 'newdosen', password: 'pass123', role: 'dosen',     email: 'nd@n.com', full_name: 'Osen' },   'Dosen buat akun dosen'],
    ['POST', '/users', { username: 'newadmin', password: 'pass123', role: 'admin',     email: 'na@n.com', full_name: 'Admin' },  'Dosen buat akun admin'],
    ['GET',  '/users', null, 'Dosen lihat semua pengguna (ulang)'],
    ['POST', '/users', { username: 'hack',     password: 'hack',    role: 'admin',     email: 'hk@h.com', full_name: 'Hacker' }, 'Dosen eskalasi ke admin'],
    ['GET',  '/users', null, 'Dosen akses manajemen user (ulang)'],
    ['POST', '/users', { username: 'user5',    password: 'pass',    role: 'mahasiswa', email: 'u5@u.com', full_name: 'U5' },     'Dosen buat akun mahasiswa'],
    ['POST', '/users', { username: 'user6',    password: 'pass',    role: 'dosen',     email: 'u6@u.com', full_name: 'U6' },     'Dosen buat akun dosen lagi'],
    ['GET',  '/users', null, 'Dosen cek daftar user (ulang)'],
  ]
  for (const [m, ep, body, desc] of dosenCases)
    scenarios.push({ kelompok: '4 — Dosen Akses Endpoint Admin', method: m, endpoint: ep, token: tokenDosen, body, expired: false, deskripsi: desc, expected: 'HTTP 403', expectedCodes: [403, 401], layer: 'API' })

  // ── Kelompok 5: Brute Force / Eskalasi Privilege (5 skenario) ──
  const bruteCases = [
    ['POST', '/academic/record', { ...academicBody, student_id: 'HACK' },  'Brute force input data (1)'],
    ['POST', '/academic/record', { ...academicBody, student_id: 'HACK2' }, 'Brute force input data (2)'],
    ['GET',  '/users',           null,                                       'Brute force akses user (1)'],
    ['GET',  '/users',           null,                                       'Brute force akses user (2)'],
    ['POST', '/users',           { username: 'brute', password: 'brute', role: 'admin', email: 'b@b.com', full_name: 'Brute' }, 'Brute force buat admin'],
  ]
  for (const [m, ep, body, desc] of bruteCases)
    scenarios.push({ kelompok: '5 — Brute Force / Eskalasi Privilege', method: m, endpoint: ep, token: tokenMhs, body, expired: false, deskripsi: desc, expected: 'HTTP 403', expectedCodes: [403, 401], layer: 'API' })

  // ── Kelompok 6: Akses Langsung Ethereum Smart Contract (bypass API) ──
  // ABI dibaca sekali dari file untuk semua skenario kelompok ini
  const abi = loadAbi()

  // Nama fungsi sesuaikan dengan yang ada di kontrak Solidity kamu
  // Script akan otomatis skip jika fungsi tidak ditemukan di ABI
  // Nama fungsi HARUS sama persis dengan yang ada di AcademicDataRegistry.sol
  const ethUnauthorizedCases = [
    {
      fn:   'recordAcademicData',   // ← nama di .sol (bukan storeAcademicRecord)
      args: ['HACK_TEST_001', 'CS999', hashToBytes32Fake()],
      desc: 'Wallet bukan-owner coba recordAcademicData langsung ke kontrak Sepolia',
    },
    {
      fn:   'updateAcademicData',   // ← nama di .sol (bukan updateAcademicRecord)
      args: ['STUD_001', hashToBytes32Fake()],
      desc: 'Wallet bukan-owner coba updateAcademicData langsung ke kontrak Sepolia',
    },
    {
      fn:   'assignRole',           // ← onlyAdmin modifier — cocok untuk uji access control
      // args: [address, role] — pakai address dummy dan role DOSEN (2)
      args: ['0x000000000000000000000000000000000000dEaD', 2],
      desc: 'Wallet bukan-owner (bukan admin) coba assignRole langsung ke kontrak Sepolia',
    },
  ]

  for (const { fn, args, desc } of ethUnauthorizedCases) {
    scenarios.push({
      kelompok: '6 — Akses Langsung Smart Contract Ethereum',
      method: 'ETH_STATIC', endpoint: `${fn}()`,
      token: null, body: null, expired: false, layer: 'Smart Contract',
      deskripsi: desc,
      expected: 'staticCall revert (onlyOwner)',
      expectedCodes: [403],
      blockchainFn: () => testEthUnauthorized(abi, fn, args, desc),
    })
  }

  // Kontrol negatif: pastikan owner sah bisa akses
  scenarios.push({
    kelompok: '6 — Akses Langsung Smart Contract Ethereum',
    method: 'ETH_STATIC', endpoint: 'recordAcademicData() [owner — kontrol negatif]',
    token: null, body: null, expired: false, layer: 'Smart Contract',
    deskripsi: 'Verifikasi: owner sah dapat memanggil recordAcademicData (modifier tidak false positive)',
    expected: 'staticCall OK (akses sah)',
    expectedCodes: [200],
    blockchainFn: () => testEthAuthorized(
      abi,
      'recordAcademicData',
      ['VERIFY_NEG_001', 'CS999', hashToBytes32Fake()]
    ),
  })

  // ── Kelompok 7: Akses Langsung Fabric Chaincode (bypass API) ──
  // Ganti ini
  // Ganti bagian studentCertPath dan studentKeyPath di buildScenarios:
  const studentCertPath = (process.env.FABRIC_UNAUTH_CERT || nodePath.join(
    CONFIG.fabric.cryptoPath,
    'peerOrganizations/org2.example.com/users/User1@org2.example.com/msp/signcerts/cert.pem'
  )).replace(/\\/g, '/')  // ← tambah replace

  const studentKeyPath = (process.env.FABRIC_UNAUTH_KEY || nodePath.join(
    CONFIG.fabric.cryptoPath,
    'peerOrganizations/org2.example.com/users/User1@org2.example.com/msp/keystore/priv_sk'
  )).replace(/\\/g, '/')  // ← tambah replace

  // Nama fungsi HARUS sama persis dengan yang ada di academic_chaincode.go
  // Fabric chaincode menggunakan PascalCase sesuai konvensi Go
  const fabricCases = [
    {
      fn:   'RecordAcademicData',                                        // ← nama di .go
      args: ['HACK_FAB_001', 'MHS_ATTACKER', 'fakehash_fab_1'],
      desc: 'StudentMSP invoke RecordAcademicData di chaincode (coba write tanpa hak)',
    },
    {
      fn:   'RecordAcademicData',                                        // skenario ke-2
      args: ['HACK_FAB_002', 'MHS_ATTACKER', 'fakehash_fab_2'],
      desc: 'StudentMSP invoke RecordAcademicData kedua kali (verifikasi konsistensi penolakan)',
    },
    {
      fn:   'UpdateAcademicData',                                        // ← nama di .go
      args: ['STUD_001', 'fakehash_fab_update'],
      desc: 'StudentMSP invoke UpdateAcademicData di chaincode (coba update record existing)',
    },
    {
      fn:   'UpdateAcademicData',                                        // skenario ke-2
      args: ['STUD_002', 'fakehash_fab_update2'],
      desc: 'StudentMSP invoke UpdateAcademicData record lain (verifikasi konsistensi penolakan)',
    },
  ]
  for (const { fn, args, desc } of fabricCases) {
    scenarios.push({
      kelompok: '7 — Akses Langsung Chaincode Fabric (bypass API)',
      method: 'FAB_INVOKE', endpoint: `${fn}()`,
      token: null, body: null, expired: false, layer: 'Chaincode',
      deskripsi: desc,
      expected: 'Chaincode reject (policy/MSP)',
      expectedCodes: [403],
      blockchainFn: () => testFabricUnauthorized(fn, args, CONFIG.fabric.unauthorizedMspId, studentCertPath, studentKeyPath),
    })
  }

  return scenarios
}

// ─────────────────────────────────────────────
// EXPORT EXCEL
// ─────────────────────────────────────────────
async function exportExcel(hasil, filename) {
  const wb    = new ExcelJS.Workbook()
  const NAVY  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2744' } }
  const GREEN = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4EDDA' } }
  const RED   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8D7DA' } }
  const GREY  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }
  const BLUE  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F1FB' } }
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

  const total   = hasil.length
  const passed  = hasil.filter(r => r.status === 'LULUS').length
  const skipped = hasil.filter(r => r.status === 'SKIP').length
  const failed  = hasil.filter(r => r.status === 'GAGAL').length
  const apiOnly = hasil.filter(r => r.layer === 'API')
  const avgLat  = apiOnly.length ? apiOnly.reduce((s, r) => s + (r.latencyMs || 0), 0) / apiOnly.length : 0

  const kelompokStats = {}
  for (const r of hasil) {
    if (!kelompokStats[r.kelompok]) kelompokStats[r.kelompok] = { total: 0, pass: 0, skip: 0 }
    kelompokStats[r.kelompok].total++
    if (r.status === 'LULUS') kelompokStats[r.kelompok].pass++
    if (r.status === 'SKIP')  kelompokStats[r.kelompok].skip++
  }

  // Sheet 1: Ringkasan
  const ws1 = wb.addWorksheet('Ringkasan')
  ws1.columns = [{ width: 42 }, { width: 24 }]
  const t1 = ws1.addRow(['RINGKASAN PENGUJIAN KONTROL AKSES — API & BLOCKCHAIN LAYER'])
  ws1.mergeCells('A1:B1'); styleHeader(t1, 2)
  ws1.addRow([])
  styleHeader(ws1.addRow(['Parameter', 'Hasil']), 2)
  const nonSkip = total - skipped
  const pctStr  = nonSkip > 0 ? `${((passed / nonSkip) * 100).toFixed(1)}%` : '—'
  const params = [
    ['Total Skenario Diuji',                  String(total)],
    ['  — Layer API (Kelompok 1–5)',           String(hasil.filter(r => r.layer === 'API').length)],
    ['  — Layer Smart Contract (Kelompok 6)',  String(hasil.filter(r => r.layer === 'Smart Contract').length)],
    ['  — Layer Chaincode (Kelompok 7)',       String(hasil.filter(r => r.layer === 'Chaincode').length)],
    ['Skenario Lulus',                         String(passed)],
    ['Skenario SKIP (dependensi/konfigurasi)', String(skipped)],
    ['Skenario Gagal (akses lolos)',           String(failed)],
    ['Tingkat Keberhasilan (diluar SKIP)',      pctStr],
    ['Rata-rata Latency API (ms)',              `${avgLat.toFixed(1)} ms`],
    ['Tanggal Pengujian',                      new Date().toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' })],
  ]
  params.forEach((p, i) => {
    const row = ws1.addRow(p); styleRow(row, 2, i % 2 === 1 ? GREY : null)
  })
  ws1.addRow([])
  styleHeader(ws1.addRow(['Per Kelompok', 'Lulus / Total (Skip)']), 2)
  for (const [k, s] of Object.entries(kelompokStats)) {
    const skipNote = s.skip > 0 ? ` (${s.skip} SKIP)` : ''
    const fill = k.startsWith('6') ? BLUE : k.startsWith('7') ? YEL : null
    styleRow(ws1.addRow([k, `${s.pass}/${s.total}${skipNote}`]), 2, fill)
  }

  // Sheet 2: Detail
  const ws2 = wb.addWorksheet('Detail Pengujian')
  ws2.columns = [
    { width: 5 }, { width: 32 }, { width: 14 }, { width: 40 },
    { width: 35 }, { width: 24 }, { width: 40 }, { width: 12 }, { width: 10 },
  ]
  const t2 = ws2.addRow([`DETAIL PENGUJIAN KONTROL AKSES — ${total} SKENARIO`])
  ws2.mergeCells('A1:I1'); styleHeader(t2, 9)
  ws2.addRow([])
  styleHeader(ws2.addRow(['No', 'Kelompok', 'Layer', 'Deskripsi Skenario', 'Endpoint / Fungsi', 'Expected', 'Actual / Hasil Blockchain', 'Latency (ms)', 'Status']), 9)

  hasil.forEach(r => {
    const fill = r.status === 'LULUS' ? GREEN : r.status === 'SKIP' ? GREY : RED
    styleRow(ws2.addRow([
      r.no, r.kelompok, r.layer, r.deskripsi, r.endpoint,
      r.expected, r.actualResult || `HTTP ${r.actualCode}`,
      r.latencyMs != null ? r.latencyMs.toFixed(1) : '—',
      r.status,
    ]), 9, fill)
  })

  // Sheet 3: Panduan Setup
  const ws3 = wb.addWorksheet('Setup & Metodologi')
  ws3.columns = [{ width: 28 }, { width: 72 }]
  styleHeader(ws3.addRow(['PANDUAN SETUP & METODOLOGI PENGUJIAN BLOCKCHAIN LAYER']), 2)
  ws3.mergeCells('A1:B1')
  ws3.addRow([])

  const docs = [
    ['FILE .env YANG DIPERLUKAN', null],
    ['ETH_RPC_URL',           'https://sepolia.infura.io/v3/YOUR_KEY'],
    ['ETH_CONTRACT_ADDR',     '0x... (alamat kontrak yang sudah di-deploy di Sepolia)'],
    ['ETH_ABI_PATH',          './artifacts/AcademicRecord.json  ← file JSON hasil compile Hardhat'],
    ['ETH_ATTACKER_KEY',      '0x... (private key wallet Sepolia BUKAN owner — hanya untuk test)'],
    ['ETH_OWNER_KEY',         '0x... (private key owner kontrak — untuk kontrol negatif)'],
    ['FABRIC_CRYPTO_PATH',    '/path/ke/crypto-config (sesuaikan dengan environment Fabric kamu)'],
    ['', null],
    ['METODOLOGI KELOMPOK 6 — Ethereum', null],
    ['Metode',      'staticCall() via ethers.js — simulasi eksekusi penuh tanpa mengirim transaksi nyata. 0 ETH/gas terpakai.'],
    ['Skenario uji','3 fungsi write dipanggil dari wallet bukan-owner → harapan: kontrak revert (onlyOwner bekerja)'],
    ['Kontrol (-)', 'Owner sah memanggil fungsi yang sama → harapan: berhasil (modifier tidak false positive)'],
    ['Validasi',    'Script cek kontrak benar-benar ada di alamat tersebut (getCode) sebelum memanggil fungsi'],
    ['', null],
    ['METODOLOGI KELOMPOK 7 — Fabric Chaincode', null],
    ['Metode',      'submitTransaction() via @hyperledger/fabric-gateway dengan identitas StudentMSP'],
    ['Skenario uji','4 fungsi write dipanggil dengan MSP tidak berhak → harapan: chaincode/policy reject'],
    ['Catatan',     'Pastikan chaincode punya pengecekan ctx.clientIdentity.getMSPID() untuk access control internal'],
  ]

  for (const [k, v] of docs) {
    if (v === null) {
      const r = ws3.addRow([k, ''])
      ws3.mergeCells(`A${r.number}:B${r.number}`)
      r.getCell(1).fill = BLUE; r.getCell(1).font = { ...nFont, bold: true }; r.getCell(1).border = brd
    } else {
      const r = ws3.addRow([k, v])
      r.getCell(1).font = { ...nFont, bold: true, color: { argb: 'FF1A2744' } }
      r.getCell(2).font = nFont; r.getCell(2).alignment = { wrapText: true, vertical: 'top' }
      for (let c = 1; c <= 2; c++) r.getCell(c).border = brd
    }
  }

  await wb.xlsx.writeFile(filename)
  console.log(`\n  ✓ Hasil disimpan ke: ${filename}`)
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  console.log(`\n${'='.repeat(65)}`)
  console.log('  PENGUJIAN KONTROL AKSES — API + BLOCKCHAIN LAYER [v3]')
  console.log('  Tugas Akhir — Prodi Informatika UAJY')
  console.log(`  ${new Date().toLocaleString('id-ID')}`)
  console.log('='.repeat(65))

  // Tampilkan status konfigurasi sebelum jalan
  console.log('\n[0] Cek konfigurasi...')
  const ethIssues = validateEthConfig()
  if (ethIssues.length > 0) {
    console.log('  ⚠ Ethereum (Kelompok 6) — ada yang perlu diisi di .env:')
    ethIssues.forEach(i => console.log(`    - ${i}`))
  } else {
    console.log('  ✓ Konfigurasi Ethereum OK')
  }
  if (!fabricGateway || !grpc) console.log('  ⚠ Fabric (Kelompok 7) — npm install @hyperledger/fabric-gateway @grpc/grpc-js')

  console.log('\n[1] Login ke semua role...')
  const tokenAdmin = await getToken(CONFIG.adminUser,     CONFIG.adminPass)
  const tokenDosen = await getToken(CONFIG.dosenUser,     CONFIG.dosenPass)
  const tokenMhs   = await getToken(CONFIG.mahasiswaUser, CONFIG.mahasiswaPass)

  if (!tokenAdmin) { console.log('  GAGAL login admin.'); process.exit(1) }
  console.log(`  ✓ Admin | ${tokenDosen ? '✓' : '⚠'} Dosen | ${tokenMhs ? '✓' : '⚠'} Mahasiswa | ${ethers ? '✓' : '⚠'} ethers | ${fabricGateway ? '✓' : '⚠'} fabric-gateway`)

  const scenarios = buildScenarios(tokenAdmin, tokenDosen, tokenMhs)
  const total     = scenarios.length
  console.log(`\n[2] ${total} skenario siap`)
  console.log(`\n[3] Menjalankan ${total} skenario...\n`)

  const hasil   = []
  let passCount = 0, failCount = 0, skipCount = 0

  for (let i = 0; i < total; i++) {
    const sc = scenarios[i]
    let actualCode, latencyMs, actualResult

    if (sc.blockchainFn) {
      process.stdout.write(`  [${String(i + 1).padStart(2)}/${total}] ${sc.method.padEnd(12)} ${sc.endpoint.slice(0, 40).padEnd(40)} `)
      const res    = await sc.blockchainFn()
      actualCode   = res.statusCode
      latencyMs    = res.latencyMs
      actualResult = res.blockchainResult || res.body

      const isSkip = actualResult?.toUpperCase().startsWith('SKIP')
      const isPass = !isSkip && sc.expectedCodes.includes(actualCode)
      const status = isSkip ? 'SKIP' : isPass ? 'LULUS' : 'GAGAL'
      if (isSkip) skipCount++; else if (isPass) passCount++; else failCount++
      console.log(`${isSkip ? '—' : isPass ? '✓' : '✗'} ${actualResult?.slice(0, 55)} [${status}]`)
      hasil.push({ no: i + 1, kelompok: sc.kelompok, layer: sc.layer, method: sc.method, deskripsi: sc.deskripsi, endpoint: sc.endpoint, expected: sc.expected, actualCode, actualResult, latencyMs, status })
    } else {
      const resp   = await sendRequest(sc.method, sc.endpoint, sc.token, sc.body, sc.expired)
      actualCode   = resp.statusCode
      latencyMs    = resp.latencyMs
      actualResult = `HTTP ${actualCode}`
      const isPass = sc.expectedCodes.includes(actualCode)
      const status = isPass ? 'LULUS' : 'GAGAL'
      if (isPass) passCount++; else failCount++
      console.log(`  [${String(i + 1).padStart(2)}/${total}] ${isPass ? '✓' : '✗'} ${sc.method.padEnd(7)} ${sc.endpoint.slice(0, 38).padEnd(38)} → HTTP ${actualCode} [${status}]`)
      hasil.push({ no: i + 1, kelompok: sc.kelompok, layer: 'API', method: sc.method, deskripsi: sc.deskripsi, endpoint: sc.endpoint, expected: sc.expected, actualCode, actualResult, latencyMs, status })
    }

    await new Promise(r => setTimeout(r, 200))
  }

  console.log('\n[4] Mengekspor hasil ke Excel...')
  const ts    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const fname = `hasil_access_control_${ts}.xlsx`
  await exportExcel(hasil, fname)

  const nonSkip = total - skipCount
  console.log(`\n${'='.repeat(65)}`)
  console.log('  RINGKASAN HASIL')
  console.log('='.repeat(65))
  console.log(`  Total    : ${total} | Lulus: ${passCount} | Skip: ${skipCount} | Gagal: ${failCount}`)
  console.log(`  Tingkat  : ${nonSkip > 0 ? ((passCount / nonSkip) * 100).toFixed(1) : 0}% (diluar Skip)`)

  if (failCount > 0) {
    console.log('\n  ⚠ Skenario GAGAL:')
    hasil.filter(r => r.status === 'GAGAL').forEach(r =>
      console.log(`    - [${String(r.no).padStart(2)}] ${r.deskripsi} → ${r.actualResult}`)
    )
  }

  if (skipCount > 0) {
    console.log('\n  ℹ Untuk aktifkan Kelompok 6:')
    console.log('    npm install ethers dotenv')
    console.log('    Buat file .env dengan ETH_RPC_URL, ETH_CONTRACT_ADDR, ETH_ABI_PATH, ETH_ATTACKER_KEY, ETH_OWNER_KEY')
  }
  console.log('='.repeat(65))
  console.log(`\n  Selesai. File: ${fname}\n`)
}

main().catch(e => { console.error(e); process.exit(1) })