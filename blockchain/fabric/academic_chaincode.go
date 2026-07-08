// academic_chaincode.go [v3 — fix determinstic timestamp + access control MSP]
// Chaincode Hyperledger Fabric untuk sistem manajemen data akademik
// Platform: Hyperledger Fabric v2.5 | Bahasa: Go

package main

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// MSP yang diizinkan melakukan operasi write
// Sesuaikan dengan nama MSP di configtx.yaml jaringan Fabric kamu
var authorizedWriterMSPs = map[string]bool{
	"DosenMSP": true,
	"AdminMSP": true,
	"Org1MSP":  true, // MSP default Fabric test-network — sesuaikan jika perlu
}

// checkWritePermission memastikan pemanggil memiliki MSP yang berhak write.
// Mengembalikan error jika MSP tidak diizinkan.
func checkWritePermission(ctx contractapi.TransactionContextInterface) error {
	mspID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("gagal ambil MSP ID: %v", err)
	}

	if !authorizedWriterMSPs[mspID] {
		return fmt.Errorf(
			"akses ditolak: MSP '%s' tidak memiliki hak write. "+
				"Hanya %v yang diizinkan",
			mspID, getAuthorizedMSPs(),
		)
	}
	return nil
}

func getAuthorizedMSPs() []string {
	keys := make([]string, 0, len(authorizedWriterMSPs))
	for k := range authorizedWriterMSPs {
		keys = append(keys, k)
	}
	return keys
}

// getTxTimestampString mengambil timestamp transaksi dari header transaksi
// (bukan dari clock lokal peer), sehingga nilainya identik di seluruh peer
// endorser. Ini mencegah "ProposalResponsePayloads do not match" yang
// terjadi jika timestamp diambil dari time.Now() pada masing-masing peer.
func getTxTimestampString(ctx contractapi.TransactionContextInterface) (string, error) {
	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return "", fmt.Errorf("gagal ambil tx timestamp: %v", err)
	}
	return time.Unix(txTimestamp.Seconds, int64(txTimestamp.Nanos)).UTC().Format(time.RFC3339), nil
}

// ============================================================
// STRUCT: AcademicRecord
// ============================================================
type AcademicRecord struct {
	RecordID   string `json:"recordId"`
	StudentID  string `json:"studentId"`
	DataHash   string `json:"dataHash"`
	RecordedBy string `json:"recordedBy"`
	Timestamp  string `json:"timestamp"`
	IsActive   bool   `json:"isActive"`
	Version    int    `json:"version"`
}

type HistoryRecord struct {
	TxID      string          `json:"txId"`
	Timestamp string          `json:"timestamp"`
	IsDelete  bool            `json:"isDelete"`
	Record    *AcademicRecord `json:"record"`
}

type VerifyResult struct {
	RecordID     string `json:"recordId"`
	StudentID    string `json:"studentId"`
	IsValid      bool   `json:"isValid"`
	StoredHash   string `json:"storedHash"`
	ExpectedHash string `json:"expectedHash"`
	Message      string `json:"message"`
	Timestamp    string `json:"timestamp"`
}

// ============================================================
// SMART CONTRACT
// ============================================================
type AcademicContract struct {
	contractapi.Contract
}

// ============================================================
// InitLedger
// ============================================================
func (c *AcademicContract) InitLedger(ctx contractapi.TransactionContextInterface) error {
	fmt.Println("=== InitLedger: Academic Data Registry initialized ===")
	return nil
}

// ============================================================
// RecordAcademicData — WRITE (DosenMSP / AdminMSP only)
// ============================================================
func (c *AcademicContract) RecordAcademicData(
	ctx contractapi.TransactionContextInterface,
	recordId string,
	studentId string,
	dataHash string,
) error {
	// ── Access control berbasis MSP ──────────────────────────
	if err := checkWritePermission(ctx); err != nil {
		return err // "akses ditolak: MSP 'StudentMSP' tidak memiliki hak write"
	}

	if recordId == "" || studentId == "" || dataHash == "" {
		return fmt.Errorf("recordId, studentId, dan dataHash tidak boleh kosong")
	}

	existing, err := ctx.GetStub().GetState(recordId)
	if err != nil {
		return fmt.Errorf("gagal cek state: %v", err)
	}
	if existing != nil {
		return fmt.Errorf("record %s sudah ada, gunakan UpdateAcademicData untuk update", recordId)
	}

	mspID, _ := ctx.GetClientIdentity().GetMSPID()

	// ── Timestamp deterministik dari header transaksi ────────
	timestampStr, err := getTxTimestampString(ctx)
	if err != nil {
		return err
	}

	record := AcademicRecord{
		RecordID:   recordId,
		StudentID:  studentId,
		DataHash:   dataHash,
		RecordedBy: mspID,
		Timestamp:  timestampStr,
		IsActive:   true,
		Version:    1,
	}

	recordJSON, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("gagal serialize record: %v", err)
	}

	if err = ctx.GetStub().PutState(recordId, recordJSON); err != nil {
		return fmt.Errorf("gagal simpan record: %v", err)
	}

	studentKey := fmt.Sprintf("student_%s_%s", studentId, recordId)
	if err = ctx.GetStub().PutState(studentKey, []byte(recordId)); err != nil {
		return fmt.Errorf("gagal simpan student mapping: %v", err)
	}

	fmt.Printf("✅ RecordAcademicData: %s | student: %s | by: %s\n", recordId, studentId, mspID)
	return nil
}

// ============================================================
// UpdateAcademicData — WRITE (DosenMSP / AdminMSP only)
// ============================================================
func (c *AcademicContract) UpdateAcademicData(
	ctx contractapi.TransactionContextInterface,
	recordId string,
	newHash string,
) error {
	// ── Access control berbasis MSP ──────────────────────────
	if err := checkWritePermission(ctx); err != nil {
		return err
	}

	if recordId == "" || newHash == "" {
		return fmt.Errorf("recordId dan newHash tidak boleh kosong")
	}

	recordJSON, err := ctx.GetStub().GetState(recordId)
	if err != nil || recordJSON == nil {
		return fmt.Errorf("record %s tidak ditemukan", recordId)
	}

	var record AcademicRecord
	if err := json.Unmarshal(recordJSON, &record); err != nil {
		return fmt.Errorf("gagal parse record: %v", err)
	}

	if record.DataHash == newHash {
		return fmt.Errorf("hash baru sama dengan hash lama, tidak ada perubahan")
	}

	mspID, _ := ctx.GetClientIdentity().GetMSPID()

	// ── Timestamp deterministik dari header transaksi ────────
	timestampStr, err := getTxTimestampString(ctx)
	if err != nil {
		return err
	}

	record.DataHash = newHash
	record.RecordedBy = mspID
	record.Timestamp = timestampStr
	record.Version = record.Version + 1
	record.IsActive = true

	updatedJSON, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("gagal serialize record: %v", err)
	}

	if err = ctx.GetStub().PutState(recordId, updatedJSON); err != nil {
		return fmt.Errorf("gagal update record: %v", err)
	}

	fmt.Printf("✅ UpdateAcademicData: %s | newHash: %.10s... | version: %d | by: %s\n",
		recordId, newHash, record.Version, mspID)
	return nil
}

// ============================================================
// VerifyIntegrity — READ (semua MSP boleh, evaluateTransaction)
// ============================================================
func (c *AcademicContract) VerifyIntegrity(
	ctx contractapi.TransactionContextInterface,
	recordId string,
	expectedHash string,
) (*VerifyResult, error) {
	if recordId == "" || expectedHash == "" {
		return nil, fmt.Errorf("recordId dan expectedHash tidak boleh kosong")
	}

	recordJSON, err := ctx.GetStub().GetState(recordId)
	if err != nil || recordJSON == nil {
		return nil, fmt.Errorf("record %s tidak ditemukan", recordId)
	}

	var record AcademicRecord
	if err := json.Unmarshal(recordJSON, &record); err != nil {
		return nil, fmt.Errorf("gagal parse record: %v", err)
	}

	isValid := record.DataHash == expectedHash
	message := "Data valid — hash cocok, tidak ada tampering terdeteksi"
	if !isValid {
		message = "PERINGATAN: Hash tidak cocok! Data kemungkinan telah dimodifikasi"
	}

	// Fungsi ini dipanggil lewat evaluateTransaction (read-only, tidak
	// di-endorse lintas peer dan tidak masuk ledger), sehingga secara
	// teknis time.Now() di sini aman. Tapi tetap dipakai GetTxTimestamp()
	// agar konsisten dan tidak membingungkan pembaca kode di masa depan.
	timestampStr, err := getTxTimestampString(ctx)
	if err != nil {
		return nil, err
	}

	fmt.Printf("🔍 VerifyIntegrity: %s | valid: %v\n", recordId, isValid)
	return &VerifyResult{
		RecordID:     recordId,
		StudentID:    record.StudentID,
		IsValid:      isValid,
		StoredHash:   record.DataHash,
		ExpectedHash: expectedHash,
		Message:      message,
		Timestamp:    timestampStr,
	}, nil
}

// ============================================================
// GetRecord — READ (semua MSP boleh)
// ============================================================
func (c *AcademicContract) GetRecord(
	ctx contractapi.TransactionContextInterface,
	recordId string,
) (*AcademicRecord, error) {
	recordJSON, err := ctx.GetStub().GetState(recordId)
	if err != nil {
		return nil, fmt.Errorf("gagal ambil record: %v", err)
	}
	if recordJSON == nil {
		return nil, fmt.Errorf("record %s tidak ditemukan", recordId)
	}
	var record AcademicRecord
	if err := json.Unmarshal(recordJSON, &record); err != nil {
		return nil, fmt.Errorf("gagal parse record: %v", err)
	}
	return &record, nil
}

// ============================================================
// GetHash — READ (semua MSP boleh)
// ============================================================
func (c *AcademicContract) GetHash(
	ctx contractapi.TransactionContextInterface,
	recordId string,
) (string, error) {
	record, err := c.GetRecord(ctx, recordId)
	if err != nil {
		return "", err
	}
	return record.DataHash, nil
}

// ============================================================
// GetRecordHistory — READ (semua MSP boleh)
// ============================================================
func (c *AcademicContract) GetRecordHistory(
	ctx contractapi.TransactionContextInterface,
	recordId string,
) ([]*HistoryRecord, error) {
	historyIterator, err := ctx.GetStub().GetHistoryForKey(recordId)
	if err != nil {
		return nil, fmt.Errorf("gagal ambil history: %v", err)
	}
	defer historyIterator.Close()

	var history []*HistoryRecord
	for historyIterator.HasNext() {
		modification, err := historyIterator.Next()
		if err != nil {
			return nil, fmt.Errorf("error iterasi history: %v", err)
		}
		hr := &HistoryRecord{
			TxID:      modification.TxId,
			Timestamp: time.Unix(modification.Timestamp.Seconds, 0).UTC().Format(time.RFC3339),
			IsDelete:  modification.IsDelete,
		}
		if !modification.IsDelete {
			var r AcademicRecord
			if err := json.Unmarshal(modification.Value, &r); err == nil {
				hr.Record = &r
			}
		}
		history = append(history, hr)
	}
	return history, nil
}

// ============================================================
// RecordExists — READ (semua MSP boleh)
// ============================================================
func (c *AcademicContract) RecordExists(
	ctx contractapi.TransactionContextInterface,
	recordId string,
) (bool, error) {
	recordJSON, err := ctx.GetStub().GetState(recordId)
	if err != nil {
		return false, fmt.Errorf("gagal cek state: %v", err)
	}
	return recordJSON != nil, nil
}

// ============================================================
// GetStudentRecords — READ (semua MSP boleh)
// ============================================================
func (c *AcademicContract) GetStudentRecords(
	ctx contractapi.TransactionContextInterface,
	studentId string,
) ([]*AcademicRecord, error) {
	prefix := fmt.Sprintf("student_%s_", studentId)
	iterator, err := ctx.GetStub().GetStateByRange(prefix, prefix+"~")
	if err != nil {
		return nil, fmt.Errorf("gagal query student records: %v", err)
	}
	defer iterator.Close()

	var records []*AcademicRecord
	for iterator.HasNext() {
		item, err := iterator.Next()
		if err != nil {
			continue
		}
		record, err := c.GetRecord(ctx, string(item.Value))
		if err == nil {
			records = append(records, record)
		}
	}
	return records, nil
}

// ============================================================
// MAIN
// ============================================================
func main() {
	chaincode, err := contractapi.NewChaincode(&AcademicContract{})
	if err != nil {
		fmt.Printf("Error membuat chaincode: %v\n", err)
		return
	}
	if err := chaincode.Start(); err != nil {
		fmt.Printf("Error menjalankan chaincode: %v\n", err)
	}
}
