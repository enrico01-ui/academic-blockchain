// src/routes/index.js
const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/authMiddleware');
const authController = require('../controllers/authController');
const academicController = require('../controllers/academicController');
const documentController = require('../controllers/documentController');
const userController = require('../controllers/userController');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

// ── Auth ──────────────────────────────────────────────
router.post('/auth/login', authController.login);
router.get('/auth/me', authenticate, authController.getMe);

// ── Academic Records ──────────────────────────────────
// Catat data baru (admin & dosen saja)
router.post('/academic/record', authenticate, authorize('admin', 'dosen'), academicController.recordData);
// Ambil semua data (admin saja)
router.get('/academic', authenticate, authorize('admin'), academicController.getAllRecords);
// Ambil data per mahasiswa (semua role)
router.delete('/academic/cleanup-test',
  authenticate,
  authorize('admin'),
  async (req, res) => {
    const { prefix } = req.body
 
    // Validasi: prefix wajib ada dan harus mengandung "TEST" atau "DDOS"
    // agar tidak bisa dipakai untuk hapus data asli
    if (!prefix || (!prefix.includes('TEST') && !prefix.includes('DDOS'))) {
      return res.status(400).json({
        success: false,
        message: 'Prefix tidak valid. Hanya data dengan prefix TEST/DDOS yang bisa dihapus.',
      })
    }
 
    try {
      const { query } = require('../config/database')
      // Cari ID academic_records yang mau dihapus
      const academicRows = await query(
        `SELECT id FROM academic_records WHERE student_id LIKE $1`,
        [`${prefix}%`]
      )

      const academicIds = academicRows.rows.map(r => r.id)

      // Hapus integrity_checks dulu
      if (academicIds.length > 0) {
        await query(
          `DELETE FROM integrity_checks
          WHERE academic_record_id = ANY($1::uuid[])`,
          [academicIds]
        )
      }
      // Hapus dokumen dulu (foreign key ke academic_records)
      const delDocs = await query(
        `DELETE FROM documents WHERE student_id LIKE $1 RETURNING id`,
        [`${prefix}%`]
      )
 
      // Hapus data akademik
      const delAcademic = await query(
        `DELETE FROM academic_records WHERE student_id LIKE $1 RETURNING id`,
        [`${prefix}%`]
      )
 
      // Hapus audit log terkait (opsional)
      await query(
        `DELETE FROM audit_logs WHERE details::text LIKE $1`,
        [`%${prefix}%`]
      )
      const delUsers = await query(
        `DELETE FROM users
         WHERE username LIKE 'func_test_%'`
      );
      // Catat cleanup ini ke audit log
      await query(
        `INSERT INTO audit_logs (user_id, action, ip_address, details)
         VALUES ($1, 'CLEANUP_TEST_DATA', $2, $3)`,
        [
          req.user.id,
          req.ip,
          JSON.stringify({
            prefix,
            deletedAcademic: delAcademic.rowCount,
            deletedDocuments: delDocs.rowCount,
            deletedUsers: delUsers.rowCount
          }),
        ]
      )
 
      res.json({
        success:          true,
        message:          `Data test berhasil dihapus`,
        deleted:          delAcademic.rowCount,
        deletedDocuments: delDocs.rowCount,
        prefix,
      })
 
    } catch (err) {
      console.error('Error cleanup-test:', err.message)
      res.status(500).json({ success: false, message: 'Gagal menghapus data test.' })
    }
  }
) 

router.get('/academic/:studentId', authenticate, academicController.getStudentRecords);
// Ambil data semua user
router.get('/users', authenticate, authorize('admin'), userController.getAllUser);
// Tambah user baru (admin saja)
router.post('/users', authenticate, authorize('admin'), userController.storeUser);
router.get('/users/:id/verify',
  authenticate,
  authorize('admin'),
  userController.verifyUser
)
router.get  ('/users/:id', authenticate, authorize('admin'), userController.getUserById);
router.patch('/users/:id/status', authenticate, authorize('admin'), userController.toggleUserStatus);
// ── Verifikasi ────────────────────────────────────────
router.post('/verify/hash', authenticate, academicController.verifyIntegrity);

// ── Documents ─────────────────────────────────────────────────
router.post('/documents/generate',          authenticate, authorize('admin','dosen'), documentController.generateDocument);
router.post('/documents/verify',            authenticate, upload.single('document'),  documentController.verifyDocument);
router.get ('/documents/download/:id',      authenticate,                             documentController.downloadDocument);
router.get ('/documents/student/:studentId',authenticate,                             documentController.getStudentDocuments);
router.get('/documents/:id/verify', authenticate, documentController.verifyDocumentById);
router.get ('/documents',                   authenticate, authorize('admin'),         documentController.getAllDocuments);
// ── Health Check ──────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ success: true, status: 'OK', timestamp: new Date().toISOString(), blockchain: process.env.ACTIVE_BLOCKCHAIN });
});

router.get('/activity', authenticate, authorize('admin', 'dosen'), async (req, res) => {
  const { limit = 10 } = req.query
  const { query } = require('../config/database')
 
  try {
    // Gabungkan audit_logs dengan info user yang melakukan aksi
    const result = await query(`
      SELECT
        al.id,
        al.action,
        al.details,
        al.created_at,
        u.username,
        u.full_name,
        u.role
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE al.action NOT IN ('LOGIN', 'CLEANUP_TEST_DATA')
      ORDER BY al.created_at DESC
      LIMIT $1
    `, [limit])
 
    // Format setiap aktivitas jadi kalimat yang mudah dibaca
    const activities = result.rows.map(row => {
      const details = typeof row.details === 'string'
        ? JSON.parse(row.details)
        : (row.details || {})
 
      // Label aksi yang ramah pengguna
      const ACTION_LABEL = {
        RECORD_DATA:      'Input data akademik',
        VERIFY_FAILED:    'Verifikasi gagal',
        CREATE_USER:      'Buat akun pengguna',
        ACTIVATE_USER:    'Aktifkan akun',
        DEACTIVATE_USER:  'Nonaktifkan akun',
        VERIFY_USER:      'Verifikasi akun pengguna',
      }
 
      // Konteks tambahan dari details
      let context = ''
      if (details.student_id)  context = details.student_id
      if (details.course_code) context += ` · ${details.course_code}`
      if (details.username)    context = details.username
      if (details.email)       context = details.email
 
      // Status blockchain dari details
      const blockchainOk = details.blockchain_ok !== false
 
      return {
        id:           row.id,
        action:       row.action,
        label:        ACTION_LABEL[row.action] || row.action,
        actor:        row.username || 'sistem',
        actorRole:    row.role || '',
        context,
        blockchainOk,
        timestamp:    row.created_at,
      }
    })
 
    res.json({ success: true, total: activities.length, activities })
 
  } catch (err) {
    console.error('Error /activity:', err.message)
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' })
  }
})
 
/**
 * GET /api/stats
 * Statistik ringkasan untuk Dashboard
 * Role: admin, dosen
 */
router.get('/stats', authenticate, authorize('admin', 'dosen'), async (req, res) => {
  const { query } = require('../config/database')
 
  try {
    const [acadTotal, acadConfirmed, acadPending, docTotal, docConfirmed, userTotal] =
      await Promise.all([
        query('SELECT COUNT(*) FROM academic_records'),
        query("SELECT COUNT(*) FROM academic_records WHERE status = 'confirmed'"),
        query("SELECT COUNT(*) FROM academic_records WHERE status IN ('pending', 'pending_blockchain')"),
        query('SELECT COUNT(*) FROM documents'),
        query("SELECT COUNT(*) FROM documents WHERE status = 'confirmed'"),
        query('SELECT COUNT(*) FROM users WHERE is_active = true'),
      ])
 
    res.json({
      success: true,
      academic: {
        total:     parseInt(acadTotal.rows[0].count),
        confirmed: parseInt(acadConfirmed.rows[0].count),
        pending:   parseInt(acadPending.rows[0].count),
      },
      documents: {
        total:     parseInt(docTotal.rows[0].count),
        confirmed: parseInt(docConfirmed.rows[0].count),
      },
      users: {
        activeTotal: parseInt(userTotal.rows[0].count),
      },
    })
 
  } catch (err) {
    console.error('Error /stats:', err.message)
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' })
  }
})

module.exports = router;
