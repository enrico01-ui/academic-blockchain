// Jalankan SEKALI: node scripts/migrate_existing_users.js
const { query } = require('../src/config/database')
const { generateUserHash } = require('../src/services/hashService')
require('dotenv').config()

async function migrateUsers() {
  // Ambil semua user yang belum punya data_hash
  const result = await query(
    `SELECT id, username, email, role, full_name 
     FROM users WHERE data_hash IS NULL`
  )
  
  console.log(`Ditemukan ${result.rows.length} user belum di-hash`)

  for (const user of result.rows) {
    const dataHash = generateUserHash(user)
    
    // Update hash di DB dulu
    await query(
      'UPDATE users SET data_hash=$1, blockchain_status=$2 WHERE id=$3',
      [dataHash, 'pending', user.id]
    )

    // Kirim ke blockchain
    try {
      const activeChain = process.env.ACTIVE_BLOCKCHAIN || 'ethereum'
      let txResult
      if (activeChain === 'ethereum') {
        const eth = require('../src/services/ethereumService')
        txResult = await eth.recordHash(`user-${user.id}`, user.username, dataHash)
      } else {
        const fab = require('../src/services/fabricService')
        txResult = await fab.recordHash(`user-${user.id}`, user.username, dataHash)
      }
      
      await query(
        `UPDATE users SET tx_id=$1, blockchain_status='confirmed' WHERE id=$2`,
        [txResult.txId, user.id]
      )
      console.log(`✓ ${user.username} → ${txResult.txId}`)
    } catch (e) {
      await query(
        `UPDATE users SET blockchain_status='failed' WHERE id=$1`, [user.id]
      )
      console.log(`✗ ${user.username} → ${e.message}`)
    }
  }
  console.log('Selesai.')
  process.exit(0)
}

migrateUsers().catch(console.error)