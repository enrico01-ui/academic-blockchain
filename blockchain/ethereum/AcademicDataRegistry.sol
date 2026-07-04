// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * ============================================================
 * AcademicDataRegistry.sol
 * Smart Contract untuk sistem manajemen data akademik
 * Platform: Ethereum Testnet (Sepolia)
 * 
 * Fungsi utama:
 * 1. Mencatat hash data akademik ke blockchain (immutable)
 * 2. Verifikasi integritas data
 * 3. Audit trail riwayat perubahan
 * 4. Access control berbasis role
 * ============================================================
 */

contract AcademicDataRegistry {

    // ============================================================
    // TIPE DATA & STRUKTUR
    // ============================================================

    // Struct: menyimpan satu entri record akademik di blockchain
    struct AcademicRecord {
        string  recordId;       // ID unik dari PostgreSQL (UUID)
        string  studentId;      // NIM mahasiswa
        bytes32 dataHash;       // Hash SHA-256 data akademik (disimpan sebagai bytes32)
        address recordedBy;     // Ethereum address yang mencatat
        uint256 timestamp;      // Waktu pencatatan (Unix timestamp)
        bool    isActive;       // True = record aktif, False = sudah diupdate
    }

    // Enum: role pengguna dalam sistem
    enum Role { NONE, ADMIN, DOSEN, MAHASISWA }

    // ============================================================
    // STATE VARIABLES
    // ============================================================

    // Owner = address yang deploy contract (biasanya admin utama)
    address public owner;

    // Mapping: address => role (untuk access control)
    mapping(address => Role) public userRoles;

    // Mapping: recordId => AcademicRecord
    // recordId menggunakan UUID dari PostgreSQL agar sinkron
    mapping(string => AcademicRecord) public records;

    // Mapping: studentId => array of recordId
    // Digunakan untuk ambil semua record milik satu mahasiswa
    mapping(string => string[]) public studentRecords;

    // Mapping: recordId => array of AcademicRecord (riwayat versi)
    // Setiap update menambah entri baru, tidak menghapus yang lama
    mapping(string => AcademicRecord[]) public recordHistory;

    // Counter total record yang pernah dicatat
    uint256 public totalRecords;

    // ============================================================
    // EVENTS
    // ============================================================
    // Events digunakan untuk:
    // 1. Audit trail (bisa dibaca dari frontend / backend)
    // 2. Notifikasi ke aplikasi yang listen ke blockchain

    event RecordAdded(
        string  indexed recordId,
        string  indexed studentId,
        bytes32 dataHash,
        address recordedBy,
        uint256 timestamp
    );

    event RecordUpdated(
        string  indexed recordId,
        string  indexed studentId,
        bytes32 oldHash,
        bytes32 newHash,
        address updatedBy,
        uint256 timestamp
    );

    event IntegrityVerified(
        string  indexed recordId,
        string  indexed studentId,
        bytes32 expectedHash,
        bytes32 actualHash,
        bool    isValid,
        address verifiedBy,
        uint256 timestamp
    );

    event RoleAssigned(
        address indexed user,
        Role    role,
        address assignedBy,
        uint256 timestamp
    );

    event TamperingDetected(
        string  indexed recordId,
        string  indexed studentId,
        bytes32 expectedHash,
        bytes32 actualHash,
        address detectedBy,
        uint256 timestamp
    );

    // ============================================================
    // MODIFIERS
    // ============================================================

    // Hanya owner yang bisa jalankan fungsi ini
    modifier onlyOwner() {
        require(msg.sender == owner, "Akses ditolak: hanya owner");
        _;
    }

    // Hanya admin yang bisa jalankan fungsi ini
    modifier onlyAdmin() {
        require(
            userRoles[msg.sender] == Role.ADMIN || msg.sender == owner,
            "Akses ditolak: hanya admin"
        );
        _;
    }

    // Hanya admin atau dosen yang bisa write data
    modifier onlyAuthorizedWriter() {
        require(
            userRoles[msg.sender] == Role.ADMIN ||
            userRoles[msg.sender] == Role.DOSEN ||
            msg.sender == owner,
            "Akses ditolak: hanya admin atau dosen"
        );
        _;
    }

    // Pastikan record dengan recordId ini sudah ada
    modifier recordExists(string memory recordId) {
        require(
            bytes(records[recordId].recordId).length > 0,
            "Record tidak ditemukan"
        );
        _;
    }

    // ============================================================
    // CONSTRUCTOR
    // ============================================================

    constructor() {
        // Saat deploy, address yang deploy otomatis jadi owner dan admin
        owner = msg.sender;
        userRoles[msg.sender] = Role.ADMIN;

        emit RoleAssigned(msg.sender, Role.ADMIN, msg.sender, block.timestamp);
    }

    // ============================================================
    // FUNGSI: MANAJEMEN ROLE
    // ============================================================

    /**
     * Assign role ke address pengguna
     * Hanya bisa dipanggil oleh admin
     * 
     * @param user    - Ethereum address pengguna
     * @param role    - Role yang diberikan (1=ADMIN, 2=DOSEN, 3=MAHASISWA)
     */
    function assignRole(address user, Role role) external onlyAdmin {
        require(user != address(0), "Address tidak valid");
        userRoles[user] = role;
        emit RoleAssigned(user, role, msg.sender, block.timestamp);
    }

    /**
     * Cek role dari address tertentu
     * Fungsi read (tidak bayar gas)
     */
    function getRole(address user) external view returns (Role) {
        return userRoles[user];
    }

    // ============================================================
    // FUNGSI: PENCATATAN DATA AKADEMIK
    // ============================================================

    /**
     * Catat hash data akademik baru ke blockchain
     * Hanya bisa dipanggil oleh admin atau dosen
     *
     * @param recordId  - UUID dari PostgreSQL
     * @param studentId - NIM mahasiswa
     * @param dataHash  - Hash SHA-256 data akademik (bytes32)
     *
     * Cara konversi hash string ke bytes32 di backend (Ethers.js):
     * const hashBytes32 = ethers.hexlify(ethers.toUtf8Bytes(sha256Hash)).padEnd(66, '0')
     * atau lebih tepatnya:
     * const hashBytes32 = "0x" + sha256HashString (karena SHA-256 = 32 bytes = 64 hex chars = bytes32)
     */
    function recordAcademicData(
        string  memory recordId,
        string  memory studentId,
        bytes32        dataHash
    ) external onlyAuthorizedWriter {
        // Pastikan recordId belum pernah digunakan
        require(
            bytes(records[recordId].recordId).length == 0,
            "Record ID sudah ada, gunakan updateAcademicData untuk update"
        );
        require(bytes(recordId).length > 0,  "recordId tidak boleh kosong");
        require(bytes(studentId).length > 0, "studentId tidak boleh kosong");
        require(dataHash != bytes32(0),       "dataHash tidak boleh kosong");

        // Buat record baru
        AcademicRecord memory newRecord = AcademicRecord({
            recordId:   recordId,
            studentId:  studentId,
            dataHash:   dataHash,
            recordedBy: msg.sender,
            timestamp:  block.timestamp,
            isActive:   true
        });

        // Simpan ke mapping utama
        records[recordId] = newRecord;

        // Tambahkan recordId ke daftar record milik mahasiswa ini
        studentRecords[studentId].push(recordId);

        // Simpan ke history (versi pertama)
        recordHistory[recordId].push(newRecord);

        // Increment counter
        totalRecords++;

        // Emit event untuk audit trail
        emit RecordAdded(recordId, studentId, dataHash, msg.sender, block.timestamp);
    }

    // ============================================================
    // FUNGSI: UPDATE DATA AKADEMIK (APPEND-ONLY)
    // ============================================================

    /**
     * Update hash data akademik — mekanisme append-only
     * Data lama tidak dihapus, hanya ditandai isActive = false
     * Hash baru disimpan sebagai versi aktif terbaru
     *
     * @param recordId  - UUID record yang akan diupdate
     * @param newHash   - Hash SHA-256 baru setelah data diperbarui
     */
    function updateAcademicData(
        string  memory recordId,
        bytes32        newHash
    ) external onlyAuthorizedWriter recordExists(recordId) {
        require(newHash != bytes32(0), "newHash tidak boleh kosong");
        require(
            records[recordId].dataHash != newHash,
            "Hash baru sama dengan hash lama, tidak ada perubahan"
        );

        bytes32 oldHash = records[recordId].dataHash;
        string memory studentId = records[recordId].studentId;

        // Tandai record lama sebagai tidak aktif
        records[recordId].isActive = false;

        // Buat record baru dengan hash yang diperbarui
        AcademicRecord memory updatedRecord = AcademicRecord({
            recordId:   recordId,
            studentId:  studentId,
            dataHash:   newHash,
            recordedBy: msg.sender,
            timestamp:  block.timestamp,
            isActive:   true
        });

        // Update record aktif
        records[recordId] = updatedRecord;

        // Tambahkan ke history (append, tidak replace)
        recordHistory[recordId].push(updatedRecord);

        emit RecordUpdated(recordId, studentId, oldHash, newHash, msg.sender, block.timestamp);
    }

    // ============================================================
    // FUNGSI: VERIFIKASI INTEGRITAS
    // ============================================================

    /**
     * Verifikasi apakah hash yang diberikan cocok dengan yang tersimpan di blockchain
     * Fungsi ini bisa dipanggil siapa saja (tidak perlu role tertentu)
     *
     * @param recordId     - UUID record yang akan diverifikasi
     * @param expectedHash - Hash yang dihitung ulang dari data di PostgreSQL
     *
     * Return: (isValid, storedHash, timestamp)
     */
    function verifyIntegrity(
        string  memory recordId,
        bytes32        expectedHash
    ) external recordExists(recordId) returns (bool, bytes32, uint256) {
        bytes32 storedHash  = records[recordId].dataHash;
        bool    isValid     = (storedHash == expectedHash);
        string  memory sid  = records[recordId].studentId;

        if (isValid) {
            emit IntegrityVerified(
                recordId, sid, expectedHash, storedHash,
                true, msg.sender, block.timestamp
            );
        } else {
            // Emit event khusus tampering jika hash tidak cocok
            emit TamperingDetected(
                recordId, sid, expectedHash, storedHash,
                msg.sender, block.timestamp
            );
            emit IntegrityVerified(
                recordId, sid, expectedHash, storedHash,
                false, msg.sender, block.timestamp
            );
        }

        return (isValid, storedHash, records[recordId].timestamp);
    }

    // ============================================================
    // FUNGSI: READ / QUERY (tidak bayar gas)
    // ============================================================

    /**
     * Ambil data record berdasarkan recordId
     * Fungsi view = gratis, tidak menulis ke blockchain
     */
    function getRecord(string memory recordId)
        external
        view
        recordExists(recordId)
        returns (
            string  memory rid,
            string  memory studentId,
            bytes32        dataHash,
            address        recordedBy,
            uint256        timestamp,
            bool           isActive
        )
    {
        AcademicRecord memory r = records[recordId];
        return (r.recordId, r.studentId, r.dataHash, r.recordedBy, r.timestamp, r.isActive);
    }

    /**
     * Ambil hash terbaru (aktif) dari sebuah record
     * Digunakan oleh backend untuk verifikasi integritas
     */
    function getHash(string memory recordId)
        external
        view
        recordExists(recordId)
        returns (bytes32)
    {
        return records[recordId].dataHash;
    }

    /**
     * Ambil semua recordId milik satu mahasiswa
     * Digunakan untuk audit trail per mahasiswa
     */
    function getStudentRecordIds(string memory studentId)
        external
        view
        returns (string[] memory)
    {
        return studentRecords[studentId];
    }

    /**
     * Ambil jumlah versi / riwayat dari sebuah record
     * Digunakan untuk menampilkan berapa kali data pernah diupdate
     */
    function getHistoryCount(string memory recordId)
        external
        view
        recordExists(recordId)
        returns (uint256)
    {
        return recordHistory[recordId].length;
    }

    /**
     * Ambil riwayat record pada index tertentu
     * Index 0 = versi pertama, index terakhir = versi terbaru
     */
    function getHistoryAt(string memory recordId, uint256 index)
        external
        view
        recordExists(recordId)
        returns (
            bytes32 dataHash,
            address recordedBy,
            uint256 timestamp,
            bool    isActive
        )
    {
        require(index < recordHistory[recordId].length, "Index melebihi jumlah history");
        AcademicRecord memory h = recordHistory[recordId][index];
        return (h.dataHash, h.recordedBy, h.timestamp, h.isActive);
    }

    /**
     * Cek apakah sebuah recordId sudah terdaftar di blockchain
     */
    function recordExistsCheck(string memory recordId)
        external
        view
        returns (bool)
    {
        return bytes(records[recordId].recordId).length > 0;
    }
}
