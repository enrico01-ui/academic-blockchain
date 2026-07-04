const { ethers } = require('ethers')
require('dotenv').config({ path: '../.env' })

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL)
  const wallet   = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider)
  
  const confirmed = await provider.getTransactionCount(wallet.address, 'latest')
  const pending   = await provider.getTransactionCount(wallet.address, 'pending')
  
  console.log(`Address         : ${wallet.address}`)
  console.log(`Nonce confirmed : ${confirmed}`)
  console.log(`Nonce pending   : ${pending}`)
  
  if (pending > confirmed) {
    console.log(`⚠  Ada ${pending - confirmed} tx masih pending di mempool!`)
    console.log('   Tunggu dulu sampai clear sebelum jalankan bulk submit.')
  } else {
    console.log('✓ Tidak ada tx pending, aman untuk mulai.')
  }
}