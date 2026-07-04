// src/controllers/documentController.js
// Handle semua operasi dokumen akademik

const { query }          = require('../config/database');
const documentService    = require('../services/documentService');
const { generateAcademicHash } = require('../services/hashService');
const path               = require('path');
const fs                 = require('fs');

// ============================================================
// POST /api/documents/generate
// Generate PDF dokumen (ijazah/transkrip/sertifikat) untuk mahasiswa
// ============================================================
async function generateDocument(req, res) {
  const { student_id, document_type, cert_type } = req.body;

  if (!student_id || !document_type) {
    return res.status(400).json({ success: false, message: 'student_id dan document_type wajib diisi' });
  }

  const validTypes = ['ijazah', 'transkrip', 'sertifikat'];
  if (!validTypes.includes(document_type)) {
    return res.status(400).json({ success: false, message: 'document_type harus: ijazah, transkrip, atau sertifikat' });
  }

  try {
    // Ambil data mahasiswa dari DB
    const studentResult = await query(
      `SELECT DISTINCT student_id, student_name FROM academic_records WHERE student_id = $1 LIMIT 1`,
      [student_id]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: `Mahasiswa ${student_id} tidak ditemukan` });
    }

    const studentData = studentResult.rows[0];

    // Ambil semua nilai akademik mahasiswa
    const recordsResult = await query(
      `SELECT * FROM academic_records WHERE student_id = $1 AND status = 'confirmed' ORDER BY semester`,
      [student_id]
    );

    // Hitung IPK rata-rata
    const records = recordsResult.rows;
    const avgGPA  = records.length > 0
      ? (records.reduce((sum, r) => sum + parseFloat(r.gpa_point), 0) / records.length).toFixed(2)
      : '0.00';

    const graduationYear = new Date().getFullYear();
    const fullStudentData = { ...studentData, gpa: avgGPA, graduation_year: graduationYear };

    // Generate PDF sesuai tipe
    let pdfResult;
    if (document_type === 'ijazah') {
      pdfResult = await documentService.generateIjazah(fullStudentData);
    } else if (document_type === 'transkrip') {
      pdfResult = await documentService.generateTranskrip(fullStudentData, records);
    } else {
      pdfResult = await documentService.generateSertifikat(fullStudentData, cert_type || 'Kelulusan');
    }

    // Simpan metadata ke database
    const docResult = await query(
      `INSERT INTO documents
       (student_id, student_name, document_type, file_name, file_path, file_size, file_hash, platform, status, metadata, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)
       RETURNING *`,
      [
        student_id,
        studentData.student_name,
        document_type,
        pdfResult.fileName,
        pdfResult.filePath,
        pdfResult.fileSize,
        pdfResult.fileHash,
        process.env.ACTIVE_BLOCKCHAIN || 'ethereum',
        JSON.stringify({ graduation_year: graduationYear, gpa: avgGPA, cert_type: cert_type || null }),
        req.user.id,
      ]
    );

    const doc = docResult.rows[0];

    // Catat hash ke blockchain
    let txResult = { txId: null };
    try {
      const activeChain = process.env.ACTIVE_BLOCKCHAIN || 'ethereum';
      if (activeChain === 'ethereum') {
        const ethereumService = require('../services/ethereumService');
        txResult = await ethereumService.recordHash(doc.id, student_id, pdfResult.fileHash);
      } else {
        const fabricService = require('../services/fabricService');
        txResult = await fabricService.recordHash(doc.id, student_id, pdfResult.fileHash);
      }

      await query(
        `UPDATE documents SET tx_id=$1, status='confirmed', updated_at=NOW() WHERE id=$2`,
        [txResult.txId, doc.id]
      );
    } catch (blockchainErr) {
      console.warn('⚠️  Blockchain belum terhubung:', blockchainErr.message);
    }

    res.status(201).json({
      success  : true,
      message  : `${document_type} berhasil digenerate`,
      document : {
        id           : doc.id,
        student_id,
        document_type,
        file_name    : pdfResult.fileName,
        file_hash    : pdfResult.fileHash,
        tx_id        : txResult.txId,
        download_url : `/api/documents/download/${doc.id}`,
      }
    });

  } catch (err) {
    console.error('generateDocument error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// ============================================================
// GET /api/documents/student/:studentId
// Ambil semua dokumen milik satu mahasiswa
// ============================================================
async function getStudentDocuments(req, res) {
  const { studentId } = req.params;
  try {
    const result = await query(
      `SELECT id, student_id, student_name, document_type, file_name, file_hash, tx_id, status, metadata, created_at
       FROM documents WHERE student_id = $1 ORDER BY created_at DESC`,
      [studentId]
    );
    res.json({ success: true, student_id: studentId, total: result.rows.length, documents: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ============================================================
// GET /api/documents/download/:id
// Download file PDF
// ============================================================
async function downloadDocument(req, res) {
  const { id } = req.params;
  try {
    const result = await query('SELECT * FROM documents WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Dokumen tidak ditemukan' });
    }
    const doc = result.rows[0];
    if (!fs.existsSync(doc.file_path)) {
      return res.status(404).json({ success: false, message: 'File tidak ditemukan di server' });
    }
    res.download(doc.file_path, doc.file_name);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ============================================================
// POST /api/documents/verify
// Verifikasi keaslian dokumen dengan upload PDF
// Body: multipart/form-data dengan field 'document'
// ============================================================
async function verifyDocument(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'File PDF wajib diupload' });
    }

    // Generate hash dari file yang diupload
    const fileBuffer = fs.readFileSync(req.file.path); 
const uploadedHash = documentService.generateBufferHash(fileBuffer);

    // Cari di database berdasarkan hash
    const dbResult = await query(
      'SELECT * FROM documents WHERE file_hash = $1',
      [uploadedHash]
    );

    if (dbResult.rows.length === 0) {
      return res.json({
        success     : true,
        isValid     : false,
        uploadedHash,
        message     : 'Dokumen TIDAK VALID — hash tidak ditemukan di database. Dokumen mungkin dipalsukan atau tidak terdaftar.',
      });
    }

    const doc = dbResult.rows[0];

    // Verifikasi hash dari blockchain
    let blockchainHash = null;
    let blockchainVerified = false;
    try {
      const activeChain = process.env.ACTIVE_BLOCKCHAIN || 'ethereum';
      if (activeChain === 'ethereum') {
        const ethereumService = require('../services/ethereumService');
        blockchainHash = await ethereumService.getHash(doc.id);
      } else {
        const fabricService = require('../services/fabricService');
        blockchainHash = await fabricService.getHash(doc.id);
      }
      blockchainVerified = (blockchainHash === uploadedHash);
    } catch {
      blockchainHash = doc.file_hash;
      blockchainVerified = (blockchainHash === uploadedHash);
    }

    res.json({
      success            : true,
      isValid            : blockchainVerified,
      uploadedHash,
      storedHash         : blockchainHash,
      document           : {
        id            : doc.id,
        student_id    : doc.student_id,
        student_name  : doc.student_name,
        document_type : doc.document_type,
        tx_id         : doc.tx_id,
        status        : doc.status,
        created_at    : doc.created_at,
      },
      message: blockchainVerified
        ? '✅ Dokumen VALID — hash cocok dengan yang tersimpan di blockchain'
        : '⚠️ Dokumen TIDAK VALID — hash tidak cocok, kemungkinan telah dimodifikasi',
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ============================================================
// GET /api/documents
// Ambil semua dokumen (admin only)
// ============================================================
async function getAllDocuments(req, res) {
  const { document_type, status, limit = 50, offset = 0, platform } = req.query;
  try {
    let sql    = 'SELECT * FROM documents WHERE 1=1';
    const params = [];
    if (document_type) { params.push(document_type); sql += ` AND document_type=$${params.length}`; }
    if (status)        { params.push(status);         sql += ` AND status=$${params.length}`; }
    if (platform)      { params.push(platform);       sql += ` AND platform=$${params.length}`; }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(limit, offset);

    const result      = await query(sql, params);
    const countResult = await query('SELECT COUNT(*) FROM documents');
    res.json({ success: true, total: parseInt(countResult.rows[0].count), documents: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

async function verifyDocumentById(req, res) {
  const { id } = req.params
  try {
    const result = await query('SELECT * FROM documents WHERE id = $1', [id])
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Dokumen tidak ditemukan' })
    }

    const doc = result.rows[0]

    // Ambil hash dari blockchain
    let blockchainHash = null
    let blockchainError = null
    try {
      const activeChain = process.env.ACTIVE_BLOCKCHAIN || 'ethereum'
      if (activeChain === 'ethereum') {
        const ethereumService = require('../services/ethereumService')
        blockchainHash = await ethereumService.getHash(doc.id)
      } else {
        const fabricService = require('../services/fabricService')
        // Untuk fabric, extract ethereum UUID dari tx_id
        let recordId = doc.id
        if (doc.tx_id) {
          const match = doc.tx_id.match(/^fabric_([a-f0-9-]{36})/)
          if (match) recordId = match[1]
        }
        blockchainHash = await fabricService.getHash(recordId)
      }
    } catch (err) {
      blockchainError = err.message
    }

    const isValid = blockchainHash && (blockchainHash === doc.file_hash)

    res.json({
      success          : true,
      document_id      : doc.id,
      student_id       : doc.student_id,
      document_type    : doc.document_type,
      platform         : doc.platform,
      verification     : {
        isValid,
        fileHashDb       : doc.file_hash,
        hashBlockchain   : blockchainHash,
        message          : isValid
          ? 'Dokumen VALID — hash cocok dengan blockchain'
          : 'Dokumen TIDAK VALID — hash tidak cocok atau tidak ditemukan di blockchain',
      },
      blockchain_error : blockchainError,
    })

  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

module.exports = { generateDocument, getStudentDocuments, downloadDocument, verifyDocument, getAllDocuments, verifyDocumentById };
