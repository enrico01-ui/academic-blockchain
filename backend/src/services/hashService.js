// src/services/hashService.js
// Bertanggung jawab untuk generate dan verifikasi hash SHA-256
// Hash ini yang akan dicatat di blockchain sebagai bukti integritas

const crypto = require('crypto');

/**
 * Generate hash SHA-256 dari data akademik
 * Format: student_id|course_code|grade|gpa_point|semester|academic_year
 *
 * PENTING: urutan field harus SELALU sama agar hash konsisten.
 * Jika urutan berubah, hash akan berbeda meskipun datanya sama.
 */
function generateAcademicHash(data) {
  const dataString = [
    String(data.student_id).trim(),
    String(data.course_code).trim(),
    String(data.grade).trim(),
    parseFloat(data.gpa_point).toFixed(2),  // ← selalu "4.00" bukan 4
    String(data.semester).trim(),            // ← selalu string
    String(data.academic_year).trim(),
    String(data.attendance || 'always').trim()
  ].join('|');

  return crypto.createHash('sha256').update(dataString, 'utf8').digest('hex');
}

function generateUserHash(user) {
  const dataString = [
    String(user.id).trim(),
    String(user.username).trim(),
    String(user.email).trim(),
    String(user.role).trim(),
    String(user.full_name).trim()
  ].join('|');

  return crypto.createHash('sha256').update(dataString, 'utf8').digest('hex');
}

/**
 * Verifikasi apakah hash dari database cocok dengan hash dari blockchain
 * Return: { isValid: boolean, expectedHash, actualHash, message }
 */
function verifyHash(expectedHash, actualHash) {
  const isValid = expectedHash === actualHash;
  return {
    isValid,
    expectedHash,
    actualHash,
    message: isValid
      ? 'Data valid — hash cocok, tidak ada tampering terdeteksi'
      : 'PERINGATAN: Hash tidak cocok! Data kemungkinan telah dimodifikasi',
  };
}

/**
 * Generate hash generik dari sembarang string
 * Digunakan untuk keperluan testing dan utilitas lain
 */
function hashString(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

module.exports = { generateAcademicHash, verifyHash, hashString, generateUserHash };
