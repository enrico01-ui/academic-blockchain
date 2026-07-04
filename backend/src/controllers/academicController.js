// src/controllers/academicController.js
// Handle semua operasi data akademik: create, read, update, verify
//
// FIX v2:
//   - Response 201 hanya dikirim SETELAH blockchain confirmed (bukan sebelum)
//   - Blockchain gagal → response 202 + status 'pending_blockchain' (bukan 201)
//   - Ini menjamin tidak ada window di mana data ada di DB tapi belum di blockchain
//     tanpa client tahu

const { query } = require('../config/database');
const { generateAcademicHash, verifyHash } = require('../services/hashService');

const activeChain = process.env.ACTIVE_BLOCKCHAIN || 'ethereum'

function getBlockchainService() {
  if (activeChain === 'ethereum') return require('../services/ethereumService')
  if (activeChain === 'fabric')   return require('../services/fabricService')
  throw new Error(`ACTIVE_BLOCKCHAIN tidak dikenal: ${activeChain}`)
}

/**
 * POST /api/academic/record
 * Catat data akademik baru ke database + blockchain
 * Role: admin, dosen
 *
 * Response codes:
 *   201 — data tersimpan DAN blockchain confirmed (tx_id ada)
 *   202 — data tersimpan tapi blockchain belum dikonfirmasi (tx_id null, status pending_blockchain)
 *   400 — validasi gagal
 *   500 — server error
 */
async function recordData(req, res) {
  const { student_id, student_name, course_code, course_name, grade, gpa_point, semester, academic_year } = req.body;

  // Validasi input
  const required = { student_id, student_name, course_code, course_name, grade, gpa_point, semester, academic_year };
  const missing  = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    return res.status(400).json({ success: false, message: `Field wajib kosong: ${missing.join(', ')}` });
  }

  try {
    // 1. Generate hash
    const dataHash = generateAcademicHash({ student_id, course_code, grade, gpa_point, semester, academic_year });

    // 2. Simpan ke PostgreSQL dengan status 'pending'
    const result = await query(
      `INSERT INTO academic_records
       (student_id, student_name, course_code, course_name, grade, gpa_point,
        semester, academic_year, data_hash, platform, status, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)
       RETURNING *`,
      [student_id, student_name, course_code, course_name, grade, gpa_point,
       semester, academic_year, dataHash, activeChain, req.user.id]
    );

    const record = result.rows[0];

    // 3. Kirim ke blockchain — WAJIB await, response tidak boleh dikirim sebelum ini selesai
    let txResult     = null
    let blockchainOk = false

    try {
      const svc = getBlockchainService()
      txResult  = await svc.recordHash(record.id, student_id, dataHash)

      // 4. Update status ke 'confirmed' setelah blockchain selesai
      await query(
        `UPDATE academic_records
         SET tx_id=$1, block_number=$2, status='confirmed', updated_at=NOW()
         WHERE id=$3`,
        [txResult.txId, txResult.blockNumber, record.id]
      );

      // 5. Catat di blockchain_transactions
      await query(
        `INSERT INTO blockchain_transactions
         (tx_id, platform, operation, student_id, data_hash, status, block_number, latency_ms)
         VALUES ($1,$2,'RECORD',$3,$4,'confirmed',$5,$6)`,
        [txResult.txId, activeChain, student_id, dataHash, txResult.blockNumber, txResult.latencyMs]
      );

      blockchainOk = true

    } catch (blockchainErr) {
      // Blockchain gagal — tandai di DB dan BERI TAHU client via 202
      console.warn('⚠️  Blockchain error:', blockchainErr.message)
      await query(
        `UPDATE academic_records SET status='pending_blockchain', updated_at=NOW() WHERE id=$1`,
        [record.id]
      );
    }

    // 6. Audit log
    await query(
      `INSERT INTO audit_logs (user_id, action, target_id, ip_address, details)
       VALUES ($1,'RECORD_DATA',$2,$3,$4)`,
      [req.user.id, record.id, req.ip, JSON.stringify({ student_id, course_code, blockchain_ok: blockchainOk })]
    );

    // 7. Response:
    //    201 → blockchain confirmed, tx_id ada → integritas terjamin
    //    202 → blockchain belum confirmed, client harus retry atau cek status nanti
    const statusCode  = blockchainOk ? 201 : 202
    const statusMsg   = blockchainOk
      ? 'Data akademik berhasil dicatat dan dikonfirmasi blockchain'
      : 'Data tersimpan di database, menunggu konfirmasi blockchain (cek status dengan GET /api/academic/:id/status)'

    return res.status(statusCode).json({
      success : blockchainOk,
      message : statusMsg,
      data    : {
        id          : record.id,
        student_id,
        course_code,
        grade,
        data_hash   : dataHash,
        tx_id       : txResult?.txId   || null,
        block_number: txResult?.blockNumber || null,
        latency_ms  : txResult?.latencyMs   || null,
        status      : blockchainOk ? 'confirmed' : 'pending_blockchain',
        platform    : activeChain,
      }
    });

  } catch (err) {
    console.error('Error recordData:', err.message)
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
}

/**
 * GET /api/academic/:studentId
 * Ambil semua data akademik satu mahasiswa
 */
async function getStudentRecords(req, res) {
  const { studentId } = req.params;
  try {
    const result = await query(
      `SELECT ar.*, u.full_name as recorded_by_name
       FROM academic_records ar
       LEFT JOIN users u ON ar.recorded_by = u.id
       WHERE ar.student_id = $1
       ORDER BY ar.created_at DESC`,
      [studentId]
    );
    res.json({ success: true, student_id: studentId, total: result.rows.length, records: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
}

/**
 * GET /api/academic
 * Ambil semua data akademik (admin only)
 */
async function getAllRecords(req, res) {
  try {
    let {
      platform,
      status,
      limit = 50,
      page = 1,
      min_block,
      search = ''
    } = req.query;

    limit = parseInt(limit);
    page = parseInt(page);

    const offset = (page - 1) * limit;

    let sql = `
      SELECT
        ar.*,
        u.full_name as recorded_by_name
      FROM academic_records ar
      LEFT JOIN users u ON ar.recorded_by = u.id
      WHERE 1=1
    `;

    let countSql = `
      SELECT COUNT(*) as total
      FROM academic_records ar
      WHERE 1=1
    `;

    const params = [];
    const countParams = [];

    // PLATFORM
    if (platform) {
      params.push(platform);
      countParams.push(platform);

      sql += ` AND ar.platform = $${params.length}`;
      countSql += ` AND ar.platform = $${countParams.length}`;
    }

    // STATUS
    if (status) {
      params.push(status);
      countParams.push(status);

      sql += ` AND ar.status = $${params.length}`;
      countSql += ` AND ar.status = $${countParams.length}`;
    }

    // MIN BLOCK
    if (min_block) {
      params.push(min_block);
      countParams.push(min_block);

      sql += ` AND ar.block_number >= $${params.length}`;
      countSql += ` AND ar.block_number >= $${countParams.length}`;
    }

    // SEARCH
    if (search.trim()) {
      const searchValue = `%${search}%`;

      params.push(searchValue);
      countParams.push(searchValue);

      sql += `
        AND (
          ar.student_id ILIKE $${params.length}
          OR ar.course_name ILIKE $${params.length}
          OR ar.tx_id ILIKE $${params.length}
        )
      `;

      countSql += `
        AND (
          ar.student_id ILIKE $${countParams.length}
          OR ar.course_name ILIKE $${countParams.length}
          OR ar.tx_id ILIKE $${countParams.length}
        )
      `;
    }

    // PAGINATION
    sql += `
      ORDER BY ar.created_at DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    params.push(limit, offset);

    const result = await query(sql, params);
    const countResult = await query(countSql, countParams);

    res.json({
      success: true,
      total: parseInt(countResult.rows[0].total),
      page,
      limit,
      totalPages: Math.ceil(countResult.rows[0].total / limit),
      records: result.rows
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan server.'
    });
  }
}
async function getAllRecords(req, res) {
  try {
    let {
      platform,
      status,
      limit = 50,
      page = 1,
      min_block,
      search = ''
    } = req.query

    limit = parseInt(limit)
    page = parseInt(page)

    const offset = (page - 1) * limit

    let sql = `
      SELECT ar.*, u.full_name as recorded_by_name
      FROM academic_records ar
      LEFT JOIN users u ON ar.recorded_by = u.id
      WHERE 1=1
    `

    let countSql = `
      SELECT COUNT(*) as total
      FROM academic_records ar
      WHERE 1=1
    `

    const params = []

    if (platform) {
      params.push(platform)
      sql += ` AND ar.platform = $${params.length}`
      countSql += ` AND ar.platform = $${params.length}`
    }

    if (status) {
      params.push(status)
      sql += ` AND ar.status = $${params.length}`
      countSql += ` AND ar.status = $${params.length}`
    }

    if (min_block) {
      params.push(min_block)
      sql += ` AND ar.block_number >= $${params.length}`
      countSql += ` AND ar.block_number >= $${params.length}`
    }

    if (search) {
      params.push(`%${search}%`)

      sql += `
        AND (
          ar.student_id ILIKE $${params.length}
          OR ar.course_name ILIKE $${params.length}
          OR ar.tx_id ILIKE $${params.length}
        )
      `

      countSql += `
        AND (
          ar.student_id ILIKE $${params.length}
          OR ar.course_name ILIKE $${params.length}
          OR ar.tx_id ILIKE $${params.length}
        )
      `
    }

    sql += `
      ORDER BY ar.created_at DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `

    const dataParams = [...params, limit, offset]

    const result = await query(sql, dataParams)
    const countResult = await query(countSql, params)

    const total = parseInt(countResult.rows[0].total)
    const totalPages = Math.ceil(total / limit)

    res.json({
      success: true,
      records: result.rows,
      total,
      totalPages,
      currentPage: page
    })

  } catch (err) {
    console.error(err)

    res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan server.'
    })
  }
}
/**
 * POST /api/verify/hash
 * Verifikasi integritas data dengan membandingkan hash DB vs blockchain
 */
async function verifyIntegrity(req, res) {
  const { student_id, record_id } = req.body;

  try {
    let sql, params

    if (activeChain === 'ethereum') {
    sql = `
    	SELECT * FROM academic_records 
    	WHERE student_id = $1 
      	AND platform = 'ethereum'
      	AND status = 'confirmed'
      	AND block_number >= 7000000
  	`
    params = [student_id]
    if (record_id) { sql += ' AND id = $2'; params.push(record_id) }
    sql += ' ORDER BY block_number DESC LIMIT 1'
   } else {
   // Fabric: block_number NULL, filter pakai tx_id
  	sql = `
        SELECT * FROM academic_records 
    	WHERE student_id = $1 
      	AND platform = 'fabric'
      	AND status = 'confirmed'
      	AND tx_id IS NOT NULL
      	AND tx_id LIKE 'fabric_%'
  	`
      	params = [student_id]
      	if (record_id) { sql += ' AND id = $2'; params.push(record_id) }
  	sql += ' ORDER BY created_at DESC LIMIT 1'
    }

    const result = await query(sql, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data tidak ditemukan.' });
    }

    const record = result.rows[0];

    // Hitung ulang hash dari data di DB
    const recalculatedHash = generateAcademicHash({
      student_id   : record.student_id,
      course_code  : record.course_code,
      grade        : record.grade,
      gpa_point    : record.gpa_point,
      semester     : record.semester,
      academic_year: record.academic_year,
      attendance   : record.attendance,
    });

    // Ambil hash dari blockchain
    let blockchainHash   = null;
    let blockchainSource = 'blockchain';
    let blockchainError  = null;

    try {
      const svc      = getBlockchainService();
      let blockchainRecordId = record.id
      if (record.platform === 'fabric' && record.tx_id) {
        const match = record.tx_id.match(/^fabric_([a-f0-9-]{36})_/)
        if (match) blockchainRecordId = match[1]
      }
      blockchainHash = await svc.getHash(blockchainRecordId);
    } catch (err) {
      console.warn('getHash blockchain gagal:', err.message);
      blockchainSource = 'blockchain_unavailable';
      blockchainError  = err.message;
    }

    // Susun hasil verifikasi
    let verification;
    if (!blockchainHash) {
      verification = {
        isValid        : false,
        expectedHash   : recalculatedHash,
        actualHash     : null,
        message        : `Verifikasi blockchain gagal: ${blockchainError || 'hash tidak ditemukan di blockchain'}`,
        blockchainNote : record.tx_id
          ? `Record ini (id: ${record.id}) tidak ditemukan di smart contract. Kemungkinan data seed/dummy atau kontrak sudah diganti.`
          : 'Record belum pernah dikirim ke blockchain (tx_id kosong).',
      };
    } else {
      verification = verifyHash(recalculatedHash, blockchainHash);
    }

    // FIX: Hanya insert ke integrity_checks jika blockchainHash tersedia (tidak null)
    // Karena kolom actual_hash NOT NULL — insert dengan null akan crash
    if (blockchainHash !== null) {
      await query(
        `INSERT INTO integrity_checks
         (academic_record_id, check_type, expected_hash, actual_hash, is_valid, checked_by)
         VALUES ($1,'manual',$2,$3,$4,$5)`,
        [record.id, recalculatedHash, blockchainHash, verification.isValid, req.user.id]
      );
    } else {
      // Catat kegagalan verifikasi di audit_logs saja (tidak butuh actual_hash)
      await query(
        `INSERT INTO audit_logs (user_id, action, target_id, ip_address, details)
         VALUES ($1,'VERIFY_FAILED',$2,$3,$4)`,
        [req.user.id, record.id, req.ip,
         JSON.stringify({ student_id, blockchain_error: blockchainError, reason: 'blockchain_unavailable' })]
      ).catch(() => {}) // jangan crash kalau audit_logs juga error
    }

    return res.json({
      success          : true,
      record_id        : record.id,
      student_id       : record.student_id,
      platform         : record.platform,
      blockchain_source: blockchainSource,
      blockchain_error : blockchainError,
      verification,
    });

  } catch (err) {
    console.error('Error verifyIntegrity:', err.message);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
  }
}

module.exports = { recordData, getStudentRecords, getAllRecords, verifyIntegrity };
