#!/usr/bin/env node

// Simple syntax check for CI without database dependencies
console.log('🔍 Running syntax checks...');

const fs = require('fs');
const path = require('path');

const filesToCheck = [
  'src/index.js',
  'src/phenomena.js', 
  'src/trader.js',
  'src/market.js'
];

let allPassed = true;

for (const file of filesToCheck) {
  try {
    if (fs.existsSync(file)) {
      require('child_process').execSync(`node -c ${file}`, { stdio: 'pipe' });
      console.log(`✅ ${file} - syntax OK`);
    } else {
      console.log(`⚠️  ${file} - file not found, skipping`);
    }
  } catch (error) {
    console.log(`❌ ${file} - syntax error:`);
    console.log(error.stdout?.toString() || error.message);
    allPassed = false;
  }
}

// Test basic phenomena logic without database
try {
  console.log('🧪 Testing phenomena logic...');
  
  // Mock the database functions
  global.kvGet = { get: () => null };
  global.kvSet = { run: () => {} };
  global.getAllPositions = { all: () => [] };
  
  const phenomena = require('../src/phenomena.js');
  console.log('✅ Phenomena module loads successfully');
  
  // Test checkGuards function exists
  if (typeof phenomena.checkGuards === 'function') {
    console.log('✅ checkGuards function exists');
  } else {
    throw new Error('checkGuards function not found');
  }
  
} catch (error) {
  console.log('❌ Phenomena test failed:', error.message);
  allPassed = false;
}

if (allPassed) {
  console.log('\n🎉 All syntax checks passed!');
  process.exit(0);
} else {
  console.log('\n💥 Some checks failed');
  process.exit(1);
}