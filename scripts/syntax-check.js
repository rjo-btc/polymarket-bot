#!/usr/bin/env node

// Ultra-simple CI test - just verify core JS files exist and basic structure
console.log('🔍 Running minimal CI checks...');

const fs = require('fs');

const requiredFiles = [
  'src/index.js',
  'src/phenomena.js',
  'src/trader.js', 
  'src/market.js',
  'package.json'
];

let allPassed = true;

for (const file of requiredFiles) {
  if (fs.existsSync(file)) {
    console.log(`✅ ${file} exists`);
  } else {
    console.log(`❌ ${file} missing`);
    allPassed = false;
  }
}

// Check package.json has required fields
try {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  if (pkg.name && pkg.dependencies) {
    console.log('✅ package.json structure OK');
  } else {
    console.log('❌ package.json missing required fields');
    allPassed = false;
  }
} catch (error) {
  console.log('❌ package.json parse error:', error.message);
  allPassed = false;
}

if (allPassed) {
  console.log('\n🎉 All CI checks passed!');
  process.exit(0);
} else {
  console.log('\n💥 Some checks failed');  
  process.exit(1);
}