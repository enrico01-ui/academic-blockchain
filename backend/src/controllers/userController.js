// src/controllers/userController.js
// Manajemen user: GET semua user, POST buat user baru
// User baru akan di-hash dan hash-nya dicatat ke blockchain

const bcrypt = require('bcryptjs');
const { query } = require('../config/database');
const { generateUserHash } = require('../services/hashService');

/**
 * GET /api/users
 * Ambil semua user — admin only
 */
async function getAllUser(req, res) {
  try {
    const result = await query(
      `SELECT id, username, email, role, full_name, is_active,
              data_hash, tx_id, blockchain_status, created_at
       FROM users
       ORDER BY created_at DESC`
    );
    res.json({
      success: true,
      total: result.rows.length,
      users: result.rows,
    });
  } catch (err) {
    console.error('Error getAllUser:', err.message);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
}

/**
 * POST /api/users
 * Buat user baru + catat hash ke blockchain — admin only
 * Body: { username, email, password, role, full_name }
 */
async function storeUser(req, res) {
  const { username, email, password, role, full_name } = req.body;

  // ── 1. Validasi input ─────────────────────────────────────
  const required = { username, email, password, role, full_name };
  const missing  = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Field wajib kosong: ${missing.join(', ')}`,
    });
  }

  const validRoles = ['admin', 'dosen', 'mahasiswa'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({
      success: false,
      message: `Role tidak valid. Pilih: ${validRoles.join(', ')}`,
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      success: false,
      message: 'Password minimal 6 karakter.',
    });
  }

  try {
    // ── 2. Cek duplikat username / email ──────────────────────
    const existing = await query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Username atau email sudah digunakan.',
      });
    }

    // ── 3. Hash password dengan bcrypt ────────────────────────
    const passwordHash = await bcrypt.hash(password, 12);

    // ── 4. Simpan user ke PostgreSQL (status blockchain pending) ─
    const insertResult = await query(
      `INSERT INTO users
         (username, email, password_hash, role, full_name, blockchain_status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id, username, email, role, full_name, is_active, created_at`,
      [username, email, passwordHash, role, full_name]
    );
    const newUser = insertResult.rows[0];

    // ── 5. Generate hash dari data user ──────────────────────
    const dataHash = generateUserHash({
      id:        newUser.id,
      username:  newUser.username,
      email:     newUser.email,
      role:      newUser.role,
      full_name: newUser.full_name,
    });

    // Update kolom data_hash di DB
    await query(
      'UPDATE users SET data_hash = $1 WHERE id = $2',
      [dataHash, newUser.id]
    );

    // ── 6. Catat hash ke blockchain ──────────────────────────
    let txResult = { txId: null, blockNumber: null };
    const activeChain = process.env.ACTIVE_BLOCKCHAIN || 'ethereum';

    try {
      if (activeChain === 'ethereum') {
        const ethereumService = require('../services/ethereumService');
        // recordId pakai prefix "user-" agar tidak bentrok dengan academic record
        txResult = await ethereumService.recordHash(`user-${newUser.id}`, newUser.username, dataHash);
      } else if (activeChain === 'fabric') {
        const fabricService = require('../services/fabricService');
        txResult = await fabricService.recordHash(`user-${newUser.id}`, newUser.username, dataHash);
      }

      // Update tx_id dan status confirmed
      await query(
        `UPDATE users
         SET tx_id = $1, blockchain_status = 'confirmed', updated_at = NOW()
         WHERE id = $2`,
        [txResult.txId, newUser.id]
      );

      // Catat di blockchain_transactions untuk analisis performa
      await query(
        `INSERT INTO blockchain_transactions
           (tx_id, platform, operation, student_id, data_hash, status, block_number, latency_ms)
         VALUES ($1, $2, 'RECORD_USER', $3, $4, 'confirmed', $5, $6)`,
        [
          txResult.txId,
          activeChain,
          newUser.username,
          dataHash,
          txResult.blockNumber || null,
          txResult.latencyMs   || null,
        ]
      );

    } catch (blockchainErr) {
      // Blockchain gagal — user tetap tersimpan di DB, status failed
      console.warn('⚠️  Blockchain gagal saat storeUser:', blockchainErr.message);
      await query(
        `UPDATE users SET blockchain_status = 'failed', updated_at = NOW() WHERE id = $1`,
        [newUser.id]
      );
    }

    // ── 7. Audit log ─────────────────────────────────────────
    await query(
      `INSERT INTO audit_logs (user_id, action, target_id, ip_address, details)
       VALUES ($1, 'CREATE_USER', $2, $3, $4)`,
      [
        req.user.id,
        newUser.id,
        req.ip,
        JSON.stringify({ username, email, role }),
      ]
    );

    // ── 8. Response ───────────────────────────────────────────
    res.status(201).json({
      success: true,
      message: 'User berhasil dibuat dan hash dicatat ke blockchain.',
      data: {
        id:               newUser.id,
        username:         newUser.username,
        email:            newUser.email,
        role:             newUser.role,
        full_name:        newUser.full_name,
        data_hash:        dataHash,
        tx_id:            txResult.txId,
        blockchain_status: txResult.txId ? 'confirmed' : 'failed',
        platform:         activeChain,
      },
    });

  } catch (err) {
    console.error('Error storeUser:', err.message);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
}

/**
 * GET /api/users/:id
 * Detail satu user — admin only
 */
async function getUserById(req, res) {
  const { id } = req.params;
  try {
    const result = await query(
      `SELECT id, username, email, role, full_name, is_active,
              data_hash, tx_id, blockchain_status, created_at, updated_at
       FROM users WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
    }
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Error getUserById:', err.message);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
}

/**
 * PATCH /api/users/:id/status
 * Aktifkan / nonaktifkan user — admin only
 * Body: { is_active: true|false }
 */
async function toggleUserStatus(req, res) {
  const { id } = req.params;
  const { is_active } = req.body;

  if (typeof is_active !== 'boolean') {
    return res.status(400).json({ success: false, message: 'is_active harus boolean.' });
  }

  try {
    const result = await query(
      `UPDATE users SET is_active = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, username, role, is_active`,
      [is_active, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
    }

    await query(
      `INSERT INTO audit_logs (user_id, action, target_id, ip_address, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.id,
        is_active ? 'ACTIVATE_USER' : 'DEACTIVATE_USER',
        id,
        req.ip,
        JSON.stringify({ username: result.rows[0].username }),
      ]
    );

    res.json({
      success: true,
      message: `User berhasil di${is_active ? 'aktifkan' : 'nonaktifkan'}.`,
      user: result.rows[0],
    });
  } catch (err) {
    console.error('Error toggleUserStatus:', err.message);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
}
/**
 * GET /api/users/:id/verify
 * Verifikasi integritas data user — hash DB vs blockchain
 * Admin only
 */
async function verifyUser(req, res) {
  const { id } = req.params

  try {
    // 1. Ambil user dari DB
    const result = await query(
      `SELECT id, username, email, role, full_name, data_hash
       FROM users WHERE id = $1`,
      [id]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan.' })
    }

    const user = result.rows[0]

    // 2. Hitung ulang hash dari data user yang ada di DB sekarang
    const { generateUserHash, verifyHash } = require('../services/hashService')
    const recalculatedHash = generateUserHash({
      id:        user.id,
      username:  user.username,
      email:     user.email,
      role:      user.role,
      full_name: user.full_name,
    })

    // 3. Ambil hash dari blockchain
    let blockchainHash = null
    try {
      const activeChain = process.env.ACTIVE_BLOCKCHAIN || 'ethereum'
      if (activeChain === 'ethereum') {
        const eth = require('../services/ethereumService')
        blockchainHash = await eth.getHash(`user-${user.id}`)
      } else {
        const fab = require('../services/fabricService')
        blockchainHash = await fab.getHash(`user-${user.id}`)
      }
    } catch (e) {
      // Blockchain tidak bisa diakses — fallback ke hash di DB
      console.warn('Blockchain getHash gagal:', e.message)
      blockchainHash = user.data_hash
    }

    // 4. Bandingkan
    const verification = verifyHash(recalculatedHash, blockchainHash)

    // 5. Simpan ke integrity_checks
    await query(
      `INSERT INTO integrity_checks
         (academic_record_id, check_type, expected_hash, actual_hash, is_valid, checked_by)
       VALUES ($1, 'manual', $2, $3, $4, $5)`,
      [null, recalculatedHash, blockchainHash, verification.isValid, req.user.id]
    )

    res.json({
      success:    true,
      user_id:    user.id,
      username:   user.username,
      verification,
    })

  } catch (err) {
    console.error('Error verifyUser:', err.message)
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' })
  }
}

module.exports = { getAllUser, storeUser, getUserById, toggleUserStatus, verifyUser };