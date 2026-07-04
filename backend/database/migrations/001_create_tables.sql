CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'dosen', 'mahasiswa')),
    full_name VARCHAR(100) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS academic_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id VARCHAR(20) NOT NULL,
    student_name VARCHAR(100) NOT NULL,
    course_code VARCHAR(20) NOT NULL,
    course_name VARCHAR(100) NOT NULL,
    grade VARCHAR(5) NOT NULL,
    gpa_point DECIMAL(3,2) NOT NULL,
    semester INTEGER NOT NULL CHECK (semester BETWEEN 1 AND 14),
    academic_year VARCHAR(10) NOT NULL,
    data_hash TEXT NOT NULL,
    tx_id TEXT,
    block_number INTEGER,
    platform VARCHAR(20) DEFAULT 'ethereum' CHECK (platform IN ('ethereum', 'fabric')),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
    recorded_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS blockchain_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tx_id TEXT UNIQUE,
    platform VARCHAR(20) NOT NULL CHECK (platform IN ('ethereum', 'fabric')),
    operation VARCHAR(20) NOT NULL CHECK (operation IN ('RECORD', 'UPDATE', 'VERIFY')),
    student_id VARCHAR(20),
    data_hash TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
    block_number INTEGER,
    gas_used INTEGER,
    latency_ms INTEGER,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS integrity_checks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    academic_record_id UUID REFERENCES academic_records(id),
    check_type VARCHAR(20) DEFAULT 'manual' CHECK (check_type IN ('manual', 'auto', 'ddos_test')),
    expected_hash TEXT NOT NULL,
    actual_hash TEXT NOT NULL,
    is_valid BOOLEAN NOT NULL,
    mismatch_details JSONB,
    checked_by UUID REFERENCES users(id),
    checked_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    action VARCHAR(50) NOT NULL,
    target_id UUID,
    ip_address INET,
    details JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_academic_records_student_id ON academic_records(student_id);
CREATE INDEX IF NOT EXISTS idx_academic_records_platform ON academic_records(platform);
CREATE INDEX IF NOT EXISTS idx_academic_records_status ON academic_records(status);
CREATE INDEX IF NOT EXISTS idx_blockchain_transactions_tx_id ON blockchain_transactions(tx_id);
CREATE INDEX IF NOT EXISTS idx_blockchain_transactions_platform ON blockchain_transactions(platform);
CREATE INDEX IF NOT EXISTS idx_integrity_checks_record_id ON integrity_checks(academic_record_id);
CREATE INDEX IF NOT EXISTS idx_integrity_checks_is_valid ON integrity_checks(is_valid);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);