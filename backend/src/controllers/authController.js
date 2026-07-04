// src/controllers/authController.js
// Handle login dan generate JWT token

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

/**
 * POST /api/auth/login
 * Body: { username, password }
 * Response: { success, token, user: { id, username, role, full_name } }
 */
async function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: 'Username dan password wajib diisi.'
    });
  }

  try {
    // Cari user di database
    const result = await query(
      'SELECT id, username, email, password_hash, role, full_name, is_active FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Username atau password salah.' });
    }

    const user = result.rows[0];

    // Cek apakah akun aktif
    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'Akun tidak aktif.' });
    }

    // Bandingkan password dengan hash yang tersimpan
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: 'Username atau password salah.' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    // Catat aktivitas login di audit_logs
    await query(
      `INSERT INTO audit_logs (user_id, action, ip_address, details)
       VALUES ($1, 'LOGIN', $2, $3)`,
      [user.id, req.ip, JSON.stringify({ username: user.username })]
    );

    res.json({
      success: true,
      message: 'Login berhasil',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        full_name: user.full_name
      }
    });

  } catch (err) {
    console.error('Error login:', err.message);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
}

/**
 * GET /api/auth/me
 * Ambil data user yang sedang login (butuh token)
 */
async function getMe(req, res) {
  try {
    const result = await query(
      'SELECT id, username, email, role, full_name, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
}

module.exports = { login, getMe };
