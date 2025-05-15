#!/usr/bin/env node

/**
 * Batch Update Stories Script
 * 
 * This script calls the /api/batch-update-stories endpoint repeatedly to process
 * all stories in the database that need AI summaries and/or images.
 * 
 * Usage:
 *   node scripts/batch-update-stories.js [batch_size]
 *   
 * Where:
 *   batch_size - Optional. Number of stories to process per batch (default: 5)
 */

const axios = require('axios');
require('dotenv').config();

// Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';
const BATCH_SIZE = parseInt(process.argv[2]) || 5; // Default batch size
const DELAY_BETWEEN_BATCHES_MS = 5000; // 5 seconds between batches

async function processBatch(continueToken = null) {
  try {
    console.log(`\n[${new Date().toISOString()}] Processing batch${continueToken ? ` (continuing from ID: ${continueToken})` : ''}...`);
    
    const response = await axios.post(`${API_BASE_URL}/api/batch-update-stories`, {
      batch_size: BATCH_SIZE,
      continue_token: continueToken
    });
    
    // Extract results
    const { message, results = [], continue_token, done } = response.data;
    
    console.log(`\n${message}`);
    console.log('----------------------------');
    
    // Log individual story results
    results.forEach(result => {
      if (result.success) {
        if (result.updates && result.updates.length > 0) {
          console.log(`✅ ID ${result.id}: Updated ${result.updates.join(', ')}`);
        } else {
          console.log(`ℹ️ ID ${result.id}: ${result.message}`);
        }
      } else {
        console.log(`❌ ID ${result.id}: ${result.message}`);
      }
    });
    
    if (done) {
      console.log('\n✨ All stories processed! No more stories need updating.');
      return true; // We're done
    } else {
      console.log(`\nContinuing with next batch after ID: ${continue_token}`);
      return continue_token; // Continue with next batch
    }
    
  } catch (error) {
    console.error('\n❌ Error processing batch:');
    if (error.response) {
      console.error(`  Status: ${error.response.status}`);
      console.error(`  Details: ${JSON.stringify(error.response.data)}`);
    } else {
      console.error(`  Message: ${error.message}`);
    }
    return false; // Error occurred
  }
}

async function main() {
  console.log('\n🔄 Starting batch update process');
  console.log(`📊 Batch size: ${BATCH_SIZE} stories per request`);
  console.log(`⏱️  Delay between batches: ${DELAY_BETWEEN_BATCHES_MS / 1000} seconds`);
  
  let continueToken = null;
  let isComplete = false;
  let batchNumber = 1;
  
  while (!isComplete) {
    console.log(`\n🔄 Processing batch #${batchNumber}...`);
    
    const result = await processBatch(continueToken);
    
    if (result === true) {
      // All done
      isComplete = true;
    } else if (result === false) {
      // Error occurred
      console.log('\n⚠️ Stopping due to error. You can resume later with the last continue token.');
      isComplete = true;
    } else {
      // Continue with next batch
      continueToken = result;
      batchNumber++;
      
      // Wait before next batch
      console.log(`\n⏳ Waiting ${DELAY_BETWEEN_BATCHES_MS / 1000} seconds before next batch...`);
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
    }
  }
  
  console.log('\n🎉 Batch update process complete!');
}

main().catch(err => {
  console.error('\n💥 Fatal error:', err);
  process.exit(1);
}); 