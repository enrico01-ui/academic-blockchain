// src/services/documentService.js
// Service untuk generate PDF dokumen akademik dan hash-nya
// Menggunakan library PDFKit untuk generate PDF

const PDFDocument = require('pdfkit');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');

// Folder penyimpanan dokumen
const UPLOAD_DIR = path.join(__dirname, '../../uploads/documents');

// Pastikan folder upload ada
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ============================================================
// HELPER: Generate hash SHA-256 dari file PDF
// ============================================================
function generateFileHash(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

// ============================================================
// HELPER: Generate hash dari buffer (untuk verifikasi upload)
// ============================================================
function generateBufferHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ============================================================
// GENERATE: PDF Ijazah
// ============================================================
async function generateIjazah(studentData) {
  return new Promise((resolve, reject) => {
    const fileName  = `ijazah_${studentData.student_id}_${Date.now()}.pdf`;
    const filePath  = path.join(UPLOAD_DIR, fileName);
    const doc       = new PDFDocument({ size: 'A4', margin: 60 });
    const stream    = fs.createWriteStream(filePath);

    doc.pipe(stream);

    // Header
    doc.fontSize(24).font('Helvetica-Bold')
       .text('IJAZAH', { align: 'center' })
       .moveDown(0.5);

    doc.fontSize(16).font('Helvetica-Bold')
       .text('UNIVERSITAS ATMA JAYA YOGYAKARTA', { align: 'center' })
       .moveDown(0.3);

    doc.fontSize(12).font('Helvetica')
       .text('Fakultas Teknologi Industri | Program Studi Informatika', { align: 'center' })
       .moveDown(2);

    // Garis dekoratif
    doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke();
    doc.moveDown(1);

    // Konten
    doc.fontSize(12).font('Helvetica')
       .text('Yang bertanda tangan di bawah ini menyatakan bahwa:', { align: 'center' })
       .moveDown(1.5);

    const fields = [
      ['Nama Lengkap', studentData.student_name],
      ['NIM',          studentData.student_id],
      ['Program Studi','Informatika'],
      ['Fakultas',     'Teknologi Industri'],
      ['Tahun Lulus',  studentData.graduation_year || new Date().getFullYear()],
      ['IPK',          studentData.gpa || '3.50'],
    ];

    fields.forEach(([label, value]) => {
      doc.fontSize(12)
         .font('Helvetica-Bold').text(`${label}`, { continued: true, width: 200 })
         .font('Helvetica').text(` : ${value}`)
         .moveDown(0.5);
    });

    doc.moveDown(1);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke();
    doc.moveDown(1);

    doc.fontSize(12).font('Helvetica')
       .text('Telah dinyatakan LULUS dan berhak menyandang gelar:', { align: 'center' })
       .moveDown(0.5);

    doc.fontSize(18).font('Helvetica-Bold')
       .text('SARJANA KOMPUTER (S.Kom)', { align: 'center' })
       .moveDown(2);

    // Tanda tangan
    doc.fontSize(11).font('Helvetica')
       .text(`Yogyakarta, ${new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}`, { align: 'right' })
       .moveDown(3);

    doc.fontSize(11).font('Helvetica-Bold')
       .text('Rektor', { align: 'right' })
       .moveDown(0.3);

    doc.fontSize(11).font('Helvetica')
       .text('Prof. Dr. Ir. Yoyong Arfiadi, M.Eng.', { align: 'right' });

    // Hash dokumen sebagai watermark di footer
    doc.fontSize(8).font('Helvetica').fillColor('#999999')
       .text(`Document ID: ${studentData.student_id} | Generated: ${new Date().toISOString()}`, 60, 780, { align: 'center' });

    doc.end();

    stream.on('finish', () => {
      const fileHash = generateFileHash(filePath);
      const fileSize = fs.statSync(filePath).size;
      resolve({ fileName, filePath, fileHash, fileSize });
    });

    stream.on('error', reject);
  });
}

// ============================================================
// GENERATE: PDF Transkrip Nilai
// ============================================================
async function generateTranskrip(studentData, academicRecords) {
  return new Promise((resolve, reject) => {
    const fileName  = `transkrip_${studentData.student_id}_${Date.now()}.pdf`;
    const filePath  = path.join(UPLOAD_DIR, fileName);
    const doc       = new PDFDocument({ size: 'A4', margin: 60 });
    const stream    = fs.createWriteStream(filePath);

    doc.pipe(stream);

    // Header
    doc.fontSize(18).font('Helvetica-Bold')
       .text('TRANSKRIP NILAI AKADEMIK', { align: 'center' })
       .moveDown(0.3);

    doc.fontSize(14).font('Helvetica-Bold')
       .text('UNIVERSITAS ATMA JAYA YOGYAKARTA', { align: 'center' })
       .moveDown(0.3);

    doc.fontSize(10).font('Helvetica')
       .text('Jl. Babarsari No.44, Yogyakarta 55281', { align: 'center' })
       .moveDown(1.5);

    doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke();
    doc.moveDown(0.8);

    // Data mahasiswa
    const infoFields = [
      ['Nama',          studentData.student_name],
      ['NIM',           studentData.student_id],
      ['Program Studi', 'Informatika'],
      ['Fakultas',      'Teknologi Industri'],
    ];

    infoFields.forEach(([label, value]) => {
      doc.fontSize(10)
         .font('Helvetica-Bold').text(`${label}`, { continued: true, width: 150 })
         .font('Helvetica').text(` : ${value}`)
         .moveDown(0.3);
    });

    doc.moveDown(0.5);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke();
    doc.moveDown(0.8);

    // Header tabel nilai
    doc.fontSize(10).font('Helvetica-Bold');
    const tableTop = doc.y;
    doc.text('No',         60,  tableTop, { width: 30 });
    doc.text('Kode MK',    90,  tableTop, { width: 70 });
    doc.text('Nama Mata Kuliah', 160, tableTop, { width: 200 });
    doc.text('SKS',        360, tableTop, { width: 40 });
    doc.text('Nilai',      400, tableTop, { width: 40 });
    doc.text('Bobot',      440, tableTop, { width: 55 });
    doc.moveDown(0.3);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke();
    doc.moveDown(0.3);

    // Isi tabel nilai
    doc.fontSize(9).font('Helvetica');
    let totalSKS = 0;
    let totalBobot = 0;

    academicRecords.slice(0, 20).forEach((record, idx) => {
      const sks   = 3; // default 3 SKS
      const bobot = parseFloat(record.gpa_point) * sks;
      totalSKS   += sks;
      totalBobot += bobot;

      const y = doc.y;
      doc.text(String(idx + 1),           60,  y, { width: 30 });
      doc.text(record.course_code,        90,  y, { width: 70 });
      doc.text(record.course_name,        160, y, { width: 200 });
      doc.text(String(sks),               360, y, { width: 40 });
      doc.text(record.grade,              400, y, { width: 40 });
      doc.text(bobot.toFixed(2),          440, y, { width: 55 });
      doc.moveDown(0.4);
    });

    doc.moveDown(0.3);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke();
    doc.moveDown(0.5);

    // IPK
    const ipk = totalSKS > 0 ? (totalBobot / totalSKS).toFixed(2) : '0.00';
    doc.fontSize(11).font('Helvetica-Bold')
       .text(`Total SKS: ${totalSKS}    IPK: ${ipk}`, { align: 'right' })
       .moveDown(2);

    // Tanda tangan
    doc.fontSize(10).font('Helvetica')
       .text(`Yogyakarta, ${new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}`, { align: 'right' })
       .moveDown(3);

    doc.fontSize(10).font('Helvetica-Bold')
       .text('Wakil Rektor Bidang Akademik', { align: 'right' });

    // Footer hash
    doc.fontSize(7).font('Helvetica').fillColor('#999999')
       .text(`Document ID: ${studentData.student_id} | Generated: ${new Date().toISOString()}`, 60, 780, { align: 'center' });

    doc.end();

    stream.on('finish', () => {
      const fileHash = generateFileHash(filePath);
      const fileSize = fs.statSync(filePath).size;
      resolve({ fileName, filePath, fileHash, fileSize });
    });

    stream.on('error', reject);
  });
}

// ============================================================
// GENERATE: PDF Sertifikat
// ============================================================
async function generateSertifikat(studentData, certType = 'Kelulusan') {
  return new Promise((resolve, reject) => {
    const fileName  = `sertifikat_${studentData.student_id}_${Date.now()}.pdf`;
    const filePath  = path.join(UPLOAD_DIR, fileName);
    const doc       = new PDFDocument({ size: 'A4', margin: 60, layout: 'landscape' });
    const stream    = fs.createWriteStream(filePath);

    doc.pipe(stream);

    // Border dekoratif
    doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40).stroke();
    doc.rect(25, 25, doc.page.width - 50, doc.page.height - 50).stroke();

    // Header
    doc.fontSize(28).font('Helvetica-Bold')
       .text('SERTIFIKAT', { align: 'center' })
       .moveDown(0.3);

    doc.fontSize(16).font('Helvetica')
       .text(certType.toUpperCase(), { align: 'center' })
       .moveDown(1.5);

    doc.fontSize(12).font('Helvetica')
       .text('Diberikan kepada:', { align: 'center' })
       .moveDown(0.5);

    doc.fontSize(22).font('Helvetica-Bold')
       .text(studentData.student_name, { align: 'center' })
       .moveDown(0.3);

    doc.fontSize(12).font('Helvetica')
       .text(`NIM: ${studentData.student_id}`, { align: 'center' })
       .moveDown(0.5);

    doc.fontSize(12).font('Helvetica')
       .text('Program Studi Informatika, Fakultas Teknologi Industri', { align: 'center' })
       .moveDown(0.5);

    doc.fontSize(12).font('Helvetica')
       .text('Universitas Atma Jaya Yogyakarta', { align: 'center' })
       .moveDown(2);

    doc.fontSize(11).font('Helvetica')
       .text(`Yogyakarta, ${new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}`, { align: 'center' })
       .moveDown(3);

    doc.fontSize(11).font('Helvetica-Bold')
       .text('Dekan Fakultas Teknologi Industri', { align: 'center' });

    // Footer hash
    doc.fontSize(7).font('Helvetica').fillColor('#999999')
       .text(`Document ID: ${studentData.student_id} | Generated: ${new Date().toISOString()}`, 60, doc.page.height - 40, { align: 'center' });

    doc.end();

    stream.on('finish', () => {
      const fileHash = generateFileHash(filePath);
      const fileSize = fs.statSync(filePath).size;
      resolve({ fileName, filePath, fileHash, fileSize });
    });

    stream.on('error', reject);
  });
}

module.exports = {
  generateIjazah,
  generateTranskrip,
  generateSertifikat,
  generateFileHash,
  generateBufferHash,
  UPLOAD_DIR,
};