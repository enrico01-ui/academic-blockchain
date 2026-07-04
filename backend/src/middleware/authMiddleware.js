// src/middleware/authMiddleware.js
// Memvalidasi JWT token pada setiap request ke endpoint yang dilindungi

const jwt = require('jsonwebtoken');

/**
 * Middleware: cek apakah request punya token JWT yang valid
 * Cara pakai: tambahkan 'authenticate' sebelum handler di route
 * Contoh: router.get('/data', authenticate, controller.getData)
 */
function authenticate(req, res, next) {
  // Token dikirim di header: Authorization: Bearer <token>
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Token tidak ditemukan. Silakan login terlebih dahulu.',
    });
  }
  const token = authHeader && authHeader.split(' ')[1]; // ambil bagian setelah "Bearer "

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Akses ditolak. Token tidak ditemukan.'
    });
  }

  try {
    // Verifikasi token dengan secret key dari .env
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Simpan data user ke req.user agar bisa diakses di controller
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Token tidak valid atau sudah kadaluarsa.'
    });
  }
}

/**
 * Middleware: batasi akses berdasarkan role
 * Cara pakai: authorize('admin') atau authorize('admin', 'dosen')
 * Contoh: router.post('/record', authenticate, authorize('admin','dosen'), controller.record)
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Belum terautentikasi.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Akses ditolak. Role '${req.user.role}' tidak diizinkan untuk operasi ini.`
      });
    }
    next();
  };
}

module.exports = { authenticate, authorize };
