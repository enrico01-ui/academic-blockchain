// src/services/ethereumService.js
// Integrasi backend Node.js dengan smart contract AcademicDataRegistry
// menggunakan library Ethers.js v6
//
// FIX v2:
//   - Hapus singleton contract — setiap tx buat signer baru untuk hindari nonce conflict
//   - Tambah nonce eksplisit dengan mutex lock agar concurrent request tidak bentrok
//   - Tambah retry logic untuk nonce error dan RPC timeout
//   - documentController: blockchain gagal → response 202 (bukan 201) + status 'pending_blockchain'

const { ethers } = require('ethers');
require('dotenv').config();

const ABI = [
  "function recordAcademicData(string recordId, string studentId, bytes32 dataHash) external",
  "function updateAcademicData(string recordId, bytes32 newHash) external",
  "function verifyIntegrity(string recordId, bytes32 expectedHash) external returns (bool, bytes32, uint256)",
  "function assignRole(address user, uint8 role) external",
  "function getRecord(string recordId) external view returns (string, string, bytes32, address, uint256, bool)",
  "function getHash(string recordId) external view returns (bytes32)",
  "function getStudentRecordIds(string studentId) external view returns (string[])",
  "function getHistoryCount(string recordId) external view returns (uint256)",
  "function getHistoryAt(string recordId, uint256 index) external view returns (bytes32, address, uint256, bool)",
  "function recordExistsCheck(string recordId) external view returns (bool)",
  "function getRole(address user) external view returns (uint8)",
  "function totalRecords() external view returns (uint256)",
  "event RecordAdded(string indexed recordId, string indexed studentId, bytes32 dataHash, address recordedBy, uint256 timestamp)",
  "event RecordUpdated(string indexed recordId, string indexed studentId, bytes32 oldHash, bytes32 newHash, address updatedBy, uint256 timestamp)",
  "event TamperingDetected(string indexed recordId, string indexed studentId, bytes32 expectedHash, bytes32 actualHash, address detectedBy, uint256 timestamp)",
];

// ─────────────────────────────────────────────
// NONCE MANAGER
// Masalah utama concurrent Ethereum: dua request paralel bisa dapat nonce yang sama
// dari wallet.getNonce() karena pending tx belum masuk ke mempool saat request kedua tiba.
//
// Solusinya: kelola nonce secara lokal dengan mutex — hanya satu request yang boleh
// ambil-dan-increment nonce dalam satu waktu.
// ─────────────────────────────────────────────
const nonceManager = {
  _nonce:  null,
  _lock:   Promise.resolve(),

  // Ambil nonce berikutnya — dijamin sequential, tidak ada race condition
  async acquire(provider, address) {
    const result = this._lock.then(async () => {
      if (this._nonce === null) {
        // Pakai 'pending' agar tx yang belum masuk block juga dihitung
        this._nonce = await provider.getTransactionCount(address, 'pending')
        console.log(`   [nonceManager] Nonce di-fetch dari jaringan: ${this._nonce}`)
      }
      const nonce = this._nonce
      this._nonce++
      return nonce
    })

    // FIX: _lock ikut error — kalau result reject, lock juga reject dulu
    // baru resolve, sehingga antrian berikutnya tahu ada masalah dan coba ulang
    this._lock = result.then(
      () => {},   // sukses → lock maju
      () => {}    // error → lock juga maju (agar antrian tidak freeze)
      // Bedanya dengan v2: error dari result TETAP propagate ke caller result
      // karena kita hanya chain _lock secara terpisah, bukan catch result itu sendiri
    )

    return result  // caller await ini → dapat nonce atau throw
  },

  // Kembalikan nonce yang gagal dipakai — taruh kembali ke counter
  // sehingga tidak ada gap di sequence
  reclaim(failedNonce) {
    if (this._nonce !== null && failedNonce < this._nonce) {
      this._nonce = failedNonce
      console.log(`   [nonceManager] Nonce ${failedNonce} di-reclaim (tx gagal)`)
    }
  },

  // Reset total — dipanggil hanya jika nonce sudah pasti tidak sinkron dengan jaringan
  // (misal: setelah error NONCE_TOO_LOW atau REPLACEMENT_UNDERPRICED)
  resetFromNetwork() {
    this._nonce = null
    // Tidak reset _lock — biarkan antrian yang ada tetap jalan
    console.log(`   [nonceManager] Nonce akan di-fetch ulang dari jaringan`)
  },
}


// ─────────────────────────────────────────────
// PROVIDER & SIGNER FACTORY
// Tidak pakai singleton contract — setiap tx buat signer fresh
// agar tidak ada shared state yang menyebabkan race condition
// ─────────────────────────────────────────────
function validateConfig() {
  if (!process.env.ETHEREUM_RPC_URL)   throw new Error('ETHEREUM_RPC_URL belum diisi di .env')
  if (!process.env.WALLET_PRIVATE_KEY) throw new Error('WALLET_PRIVATE_KEY belum diisi di .env')
  if (!process.env.CONTRACT_ADDRESS)   throw new Error('CONTRACT_ADDRESS belum diisi di .env')
}

// Provider di-cache (stateless — aman untuk di-share)
let _provider = null
function getProvider() {
  if (!_provider) {
    validateConfig()
    _provider = new ethers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL)
  }
  return _provider
}

// Signer dan contract selalu dibuat baru per transaksi — tidak di-cache
function newSigner() {
  return new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, getProvider())
}

function newContract(signer) {
  return new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, signer)
}

// ─────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────
function hashToBytes32(hashString) {
  const hex = hashString.startsWith('0x') ? hashString : '0x' + hashString
  if (hex.length !== 66) throw new Error(`Hash harus 64 hex chars, dapat: ${hex.length - 2}`)
  return hex
}

function bytes32ToHash(bytes32) {
  return bytes32.toLowerCase().replace('0x', '')
}

// Cek apakah error disebabkan oleh nonce conflict
function isNonceError(err) {
  const msg = (err.message || '').toLowerCase()
  return msg.includes('nonce') ||
         msg.includes('replacement transaction underpriced') ||
         msg.includes('already known') ||
         err.code === 'NONCE_EXPIRED' ||
         err.code === 'REPLACEMENT_UNDERPRICED'
}

// Cek apakah error disebabkan RPC timeout / jaringan
function isNetworkError(err) {
  const msg = (err.message || '').toLowerCase()
  return msg.includes('timeout') ||
         msg.includes('network') ||
         msg.includes('econnreset') ||
         msg.includes('enotfound') ||
         err.code === 'NETWORK_ERROR' ||
         err.code === 'SERVER_ERROR'
}

// ─────────────────────────────────────────────
// CORE: kirim transaksi dengan nonce management + retry
// ─────────────────────────────────────────────
const MAX_RETRY = 3

async function _sendOnce(buildTxFn, nonce) {
  const provider = getProvider()
  const signer   = newSigner()
  const contract = newContract(signer)
  const startTime = Date.now()

  const tx = await buildTxFn(contract, { nonce })
  console.log(`⟠ Tx dikirim: ${tx.hash} (nonce: ${nonce}) — menunggu konfirmasi...`)
  const receipt = await tx.wait(1)
  const latencyMs = Date.now() - startTime
  console.log(`✅ Confirmed! Block: ${receipt.blockNumber} | Gas: ${receipt.gasUsed} | ${latencyMs}ms`)

  return { txId: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: Number(receipt.gasUsed), latencyMs }
}

async function sendWithRetry(buildTxFn, retryCount = 0) {
  const provider = getProvider()
  const signer   = newSigner()

  // Ambil nonce dari manager — antri jika ada request lain yang sedang proses
  const nonce = await nonceManager.acquire(provider, signer.address)
  console.log(`   [sendWithRetry] Menggunakan nonce: ${nonce}`)

  return _sendWithNonce(buildTxFn, nonce, provider, signer, 0)
}
function isRateLimitError(err) {
  const msg = (err.message || '').toLowerCase()

  return (
    msg.includes('too many requests') ||
    msg.includes('rate limit') ||
    msg.includes('-32005')
  )
}
// Pisah fungsi agar nonce bisa di-pass tanpa acquire ulang saat retry
async function _sendWithNonce(buildTxFn, nonce, provider, signer, retryCount) {
  try {
    return await _sendOnce(buildTxFn, nonce)

  } catch (err) {
    console.error({
    message: err.message,
    shortMessage: err.shortMessage,
    code: err.code,
    reason: err.reason,
  })
    console.warn(`⚠️  Tx gagal (attempt ${retryCount + 1}/${MAX_RETRY}): ${err.message}`)

    if (isNonceError(err)) {
      // Nonce tidak sinkron — reset dari jaringan, lalu acquire nonce baru
      nonceManager.resetFromNetwork()

      if (retryCount < MAX_RETRY - 1) {
         const delay = 5000 * Math.pow(2, retryCount)
        console.log(`   [retry nonce] tunggu ${delay}ms`)
        await new Promise(r => setTimeout(r, delay))
        // Acquire nonce baru (fresh dari jaringan setelah reset)
        const newNonce = await nonceManager.acquire(provider, signer.address)
        console.log(`   [retry nonce error] Coba lagi dengan nonce baru: ${newNonce}`)
        return _sendWithNonce(buildTxFn, newNonce, provider, signer, retryCount + 1)
      }
    }

    if ((isNetworkError(err) || isRateLimitError(err)) && retryCount < MAX_RETRY - 1) {
      // Network error: nonce sudah di-reserve tapi tx belum sampai ke node
      // Reclaim nonce supaya tidak ada lubang, lalu retry dengan nonce SAMA
      nonceManager.reclaim(nonce)
      const delay = 5000 * Math.pow(2, retryCount)
      console.log(`   [retry network] tunggu ${delay}ms`)

      await new Promise(r => setTimeout(r, delay))
      // Re-acquire (akan dapat nonce yang sama karena sudah di-reclaim)
      const retryNonce = await nonceManager.acquire(provider, signer.address)
      console.log(`   [retry network] Coba lagi dengan nonce: ${retryNonce}`)
      return _sendWithNonce(buildTxFn, retryNonce, provider, signer, retryCount + 1)
    }

    throw err
  }
}

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────

// 1. Catat hash baru ke blockchain
async function recordHash(recordId, studentId, dataHash) {
  try {
    return await sendWithRetry((contract, opts) =>
      contract.recordAcademicData(recordId, studentId, hashToBytes32(dataHash), opts)
    )
  } catch (err) {
    throw new Error(`recordHash error: ${err.message}`)
  }
}

// 2. Update hash (append-only)
async function updateHash(recordId, newDataHash) {
  try {
    return await sendWithRetry((contract, opts) =>
      contract.updateAcademicData(recordId, hashToBytes32(newDataHash), opts)
    )
  } catch (err) {
    throw new Error(`updateHash error: ${err.message}`)
  }
}

// 3. Ambil hash dari blockchain (view function — gratis, tidak perlu nonce)
async function getHash(recordId) {
  try {
    // View function pakai contract read-only — tidak butuh signer
    const provider    = getProvider()
    const contractRO  = new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, provider)
    const result      = await contractRO.getHash(recordId)
    return bytes32ToHash(result)
  } catch (err) {
    throw new Error(`getHash error: ${err.message}`)
  }
}

// 4. Verifikasi integritas on-chain
// FIX: verifyIntegrity di kontrak adalah fungsi NON-VIEW (write tx karena emit event).
// Ini berarti perlu tx, tapi kita bisa pakai staticCall dulu untuk baca hasilnya
// lalu kirim tx untuk catat event. Nonce manager handle ini.
async function verifyOnChain(recordId, expectedHash) {
  try {
    const provider   = getProvider()
    const contractRO = new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, provider)
    const expectedBytes = hashToBytes32(expectedHash)

    // Baca hasil dulu gratis via staticCall
    const result = await contractRO.verifyIntegrity.staticCall(recordId, expectedBytes)

    // Kirim tx untuk catat event (opsional — bisa dihapus kalau tidak perlu audit trail on-chain)
    const txResult = await sendWithRetry((contract, opts) =>
      contract.verifyIntegrity(recordId, expectedBytes, opts)
    )

    return {
      isValid    : result[0],
      storedHash : bytes32ToHash(result[1]),
      timestamp  : Number(result[2]),
      txId       : txResult.txId,
      latencyMs  : txResult.latencyMs,
    }
  } catch (err) {
    throw new Error(`verifyOnChain error: ${err.message}`)
  }
}

// 5. Cek apakah record sudah ada (view — gratis)
async function recordExists(recordId) {
  try {
    const provider   = getProvider()
    const contractRO = new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, provider)
    return await contractRO.recordExistsCheck(recordId)
  } catch { return false }
}

// 6. Ambil semua recordId milik satu mahasiswa (view — gratis)
async function getStudentRecordIds(studentId) {
  try {
    const provider   = getProvider()
    const contractRO = new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, provider)
    return await contractRO.getStudentRecordIds(studentId)
  } catch (err) {
    throw new Error(`getStudentRecordIds error: ${err.message}`)
  }
}

// 7. Ambil riwayat history sebuah record (view — gratis)
async function getRecordHistory(recordId) {
  try {
    const provider   = getProvider()
    const contractRO = new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, provider)
    const count      = Number(await contractRO.getHistoryCount(recordId))
    const history    = []
    for (let i = 0; i < count; i++) {
      const h = await contractRO.getHistoryAt(recordId, i)
      history.push({ dataHash: bytes32ToHash(h[0]), recordedBy: h[1], timestamp: Number(h[2]), isActive: h[3], version: i + 1 })
    }
    return history
  } catch (err) {
    throw new Error(`getRecordHistory error: ${err.message}`)
  }
}

// 8. Assign role ke address
async function assignRole(userAddress, role) {
  try {
    const result = await sendWithRetry((contract, opts) =>
      contract.assignRole(userAddress, role, opts)
    )
    return { txId: result.txId, blockNumber: result.blockNumber }
  } catch (err) {
    throw new Error(`assignRole error: ${err.message}`)
  }
}

// 9. Cek koneksi saat server start
async function checkConnection() {
  try {
    validateConfig()
    const provider   = getProvider()
    const network    = await provider.getNetwork()
    const contractRO = new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, provider)
    const total      = await contractRO.totalRecords()
    console.log(`✅ Ethereum: ${network.name} (chainId: ${network.chainId}) | Records: ${total}`)
    return true
  } catch (err) {
    console.warn(`⚠️  Ethereum tidak terhubung: ${err.message}`)
    return false
  }
}

module.exports = { recordHash, updateHash, getHash, verifyOnChain, recordExists, getStudentRecordIds, getRecordHistory, assignRole, checkConnection }