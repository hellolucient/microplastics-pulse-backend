#!/usr/bin/env node

/**
 * Sync Files Script
 * 
 * This script helps maintain consistency between the two index.js files:
 * - api/index.js (used by Railway production)
 * - index.js (used by local development)
 * 
 * Usage:
 *   node sync-files.js api-to-root    # Copy api/index.js → index.js
 *   node sync-files.js root-to-api    # Copy index.js → api/index.js
 *   node sync-files.js check          # Check if files are in sync
 */

const fs = require('fs');
const path = require('path');

const API_FILE = path.join(__dirname, 'api', 'index.js');
const ROOT_FILE = path.join(__dirname, 'index.js');

function copyFile(source, destination) {
  try {
    const content = fs.readFileSync(source, 'utf8');
    fs.writeFileSync(destination, content);
    console.log(`✅ Copied ${path.basename(source)} → ${path.basename(destination)}`);
  } catch (error) {
    console.error(`❌ Error copying file: ${error.message}`);
    process.exit(1);
  }
}

function checkSync() {
  try {
    const apiContent = fs.readFileSync(API_FILE, 'utf8');
    const rootContent = fs.readFileSync(ROOT_FILE, 'utf8');
    
    if (apiContent === rootContent) {
      console.log('✅ Files are in sync');
    } else {
      console.log('⚠️  Files are NOT in sync');
      console.log('   Use: node sync-files.js api-to-root (to sync for local dev)');
      console.log('   Use: node sync-files.js root-to-api (to sync for production)');
    }
  } catch (error) {
    console.error(`❌ Error checking files: ${error.message}`);
    process.exit(1);
  }
}

const command = process.argv[2];

switch (command) {
  case 'api-to-root':
    copyFile(API_FILE, ROOT_FILE);
    break;
  case 'root-to-api':
    copyFile(ROOT_FILE, API_FILE);
    break;
  case 'check':
    checkSync();
    break;
  default:
    console.log(`
📁 MicroPlastics Pulse Backend - File Sync Utility

This script helps maintain consistency between the two index.js files:

Usage:
  node sync-files.js api-to-root    # Copy api/index.js → index.js (for local dev)
  node sync-files.js root-to-api    # Copy index.js → api/index.js (for production)
  node sync-files.js check          # Check if files are in sync

Remember:
  - Railway runs api/index.js (production)
  - Local dev runs index.js (development)
  - Always keep both files in sync!
    `);
    break;
}
