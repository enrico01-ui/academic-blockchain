// src/services/fabricService.js
// Integrasi backend Node.js dengan Hyperledger Fabric
// menggunakan @hyperledger/fabric-gateway SDK

const { connect, hash, signers } = require('@hyperledger/fabric-gateway');
const grpc   = require('@grpc/grpc-js');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
require('dotenv').config();

// ============================================================
// KONFIGURASI — sesuaikan dengan username WSL2 kamu
// ============================================================
const WSL_USER       = process.env.WSL_USER            || 'involute';
const PEER_ENDPOINT  = process.env.FABRIC_PEER_ENDPOINT || 'localhost:7051';
const PEER_HOST_ALIAS= 'peer0.org1.example.com';
const CHANNEL_NAME   = process.env.FABRIC_CHANNEL_NAME  || 'academicchannel';
const CHAINCODE_NAME = process.env.FABRIC_CHAINCODE_NAME|| 'academic';
const MSP_ID         = process.env.FABRIC_MSP_ID        || 'Org1MSP';

// Base path ke test-network di WSL2
// Dari Windows: akses via \\wsl$\Ubuntu-22.04\...
// Dari WSL2 langsung: /home/involute/...
const isWindows  = process.platform === 'win32';
const FABRIC_BASE = isWindows
  ? 'C:\\Users\\Acer\\Downloads\\TugasAkhir\\fabric-certs\\organizations'
  : `/root/fabric-samples/test-network/organizations`;

const CERT_PATH = path.join(
  FABRIC_BASE,
  'peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp'
);

const TLS_CERT = path.join(
  FABRIC_BASE,
  'peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt'
);

// Singleton
let gateway = null;
let grpcClient = null;
let contract = null;

// ============================================================
// HELPER: Ambil private key dari keystore
// ============================================================
function getPrivateKey() {
  const keystorePath = path.join(CERT_PATH, 'keystore');
  const files  = fs.readdirSync(keystorePath);
  const keyFile= files.find(f => f.endsWith('_sk'));
  if (!keyFile) throw new Error(`Private key tidak ditemukan di: ${keystorePath}`);
  return fs.readFileSync(path.join(keystorePath, keyFile));
}

// ============================================================
// HELPER: Inisialisasi koneksi ke Fabric
// ============================================================
async function getContract() {
  if (contract) return contract;

  const tlsCert      = fs.readFileSync(TLS_CERT);
  const credentials  = grpc.credentials.createSsl(tlsCert);

  grpcClient = new grpc.Client(PEER_ENDPOINT, credentials, {
    'grpc.ssl_target_name_override': PEER_HOST_ALIAS,
  });

  const certPem   = fs.readFileSync(path.join(CERT_PATH, 'signcerts', 'cert.pem'));
  const privateKey= crypto.createPrivateKey(getPrivateKey());
  const signer    = signers.newPrivateKeySigner(privateKey);

  gateway = connect({
    client  : grpcClient,
    identity: { mspId: MSP_ID, credentials: certPem },
    signer,
    hash    : hash.sha256,
    evaluateOptions    : () => ({ deadline: Date.now() + 5000 }),
    endorseOptions     : () => ({ deadline: Date.now() + 15000 }),
    submitOptions      : () => ({ deadline: Date.now() + 5000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
  });

  contract = gateway.getNetwork(CHANNEL_NAME).getContract(CHAINCODE_NAME);
  console.log(`✅ Fabric: ${PEER_ENDPOINT} | ${CHANNEL_NAME} | ${CHAINCODE_NAME}`);
  return contract;
}

// ============================================================
// FUNGSI 1: Catat hash baru ke blockchain
// ============================================================
async function recordHash(recordId, studentId, dataHash) {
  const startTime = Date.now();
  try {
    const ct = await getContract();
    console.log(`⬡ Fabric submit: RecordAcademicData | ${recordId}`);
    await ct.submitTransaction(
      'RecordAcademicData',
      String(recordId),
      String(studentId),
      String(dataHash)
    );
    const latencyMs = Date.now() - startTime;
    console.log(`✅ Fabric confirmed! | ${latencyMs}ms`);
    return {
      txId      : `fabric_${recordId}_${Date.now()}`,
      blockNumber: null,
      latencyMs,
    };
  } catch (err) {
    throw new Error(`Fabric recordHash error: ${err.message}`);
  }
}

// ============================================================
// FUNGSI 2: Update hash (append-only)
// ============================================================
async function updateHash(recordId, newDataHash) {
  const startTime = Date.now();
  try {
    const ct = await getContract();
    await ct.submitTransaction('UpdateAcademicData', String(recordId), String(newDataHash));
    return { txId: `fabric_update_${recordId}_${Date.now()}`, latencyMs: Date.now() - startTime };
  } catch (err) {
    throw new Error(`Fabric updateHash error: ${err.message}`);
  }
}

// ============================================================
// FUNGSI 3: Ambil hash dari blockchain (gratis)
// ============================================================
async function getHash(recordId) {
  try {
    const ct     = await getContract();
    const result = await ct.evaluateTransaction('GetHash', String(recordId));
    // result bisa berupa Buffer atau Uint8Array
    const hashStr = Buffer.from(result).toString('utf8').trim();
    console.log(`⬡ Fabric getHash result: "${hashStr}"`);
    return hashStr;
  } catch (err) {
    throw new Error(`Fabric getHash error: ${err.message}`);
  }
}

// ============================================================
// FUNGSI 4: Verifikasi integritas
// ============================================================
async function verifyOnChain(recordId, expectedHash) {
  const startTime = Date.now();
  try {
    const ct     = await getContract();
    const result = await ct.evaluateTransaction('VerifyIntegrity', String(recordId), String(expectedHash));
    const data   = JSON.parse(Buffer.from(result).toString('utf8'));
    return { ...data, latencyMs: Date.now() - startTime };
  } catch (err) {
    throw new Error(`Fabric verifyOnChain error: ${err.message}`);
  }
}

// ============================================================
// FUNGSI 5: Cek apakah record sudah ada
// ============================================================
async function recordExists(recordId) {
  try {
    const ct     = await getContract();
    const result = await ct.evaluateTransaction('RecordExists', String(recordId));
    return Buffer.from(result).toString('utf8') === 'true';
  } catch { return false; }
}

// ============================================================
// FUNGSI 6: Ambil semua record milik satu mahasiswa
// ============================================================
async function getStudentRecords(studentId) {
  try {
    const ct     = await getContract();
    const result = await ct.evaluateTransaction('GetStudentRecords', String(studentId));
    return JSON.parse(Buffer.from(result).toString('utf8'));
  } catch (err) {
    throw new Error(`Fabric getStudentRecords error: ${err.message}`);
  }
}

// ============================================================
// FUNGSI 7: Ambil riwayat history sebuah record
// ============================================================
async function getRecordHistory(recordId) {
  try {
    const ct     = await getContract();
    const result = await ct.evaluateTransaction('GetRecordHistory', String(recordId));
    return JSON.parse(Buffer.from(result).toString('utf8'));
  } catch (err) {
    throw new Error(`Fabric getRecordHistory error: ${err.message}`);
  }
}

// ============================================================
// FUNGSI 8: Cek koneksi saat server start
// ============================================================
async function checkConnection() {
  try {
    await getContract();
    return true;
  } catch (err) {
    console.warn(`⚠️  Fabric tidak terhubung: ${err.message}`);
    return false;
  }
}

// ============================================================
// FUNGSI 9: Tutup koneksi saat server shutdown
// ============================================================
function closeConnection() {
  if (gateway)   { gateway.close();   gateway = null;   contract = null; }
  if (grpcClient){ grpcClient.close(); grpcClient = null; }
}

module.exports = {
  recordHash, updateHash, getHash, verifyOnChain,
  recordExists, getStudentRecords, getRecordHistory,
  checkConnection, closeConnection,
};