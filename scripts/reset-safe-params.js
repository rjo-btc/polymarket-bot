#!/usr/bin/env node
/**
 * Reset autotuner parameters to safe, conservative values
 * Run this after the filter fix deployment to ensure all guards work
 */

const { kvSet } = require('../src/db');

const safeParams = {
  ema: {
    // Base filters - apply to all trades
    min_ema_dist_bps: 5.0,
    min_slope_abs: 2.0,
    max_entry_price: 0.45,  // Coinflip protection
    min_rr: 1.5,
    
    // Entry windows
    entry_window_min: 150,
    entry_window_max: 240,
    early_window_max: 270,
    
    // Direction-specific: LONGS need strong signals
    long_min_dist_bps: 8.0,
    long_min_slope: 6.0,
    
    // Direction-specific: SHORTS skip death zone
    short_dead_zone_lo: 5.0,
    short_dead_zone_hi: 8.0,
    short_dead_slope_lo: 3.0,
    short_dead_slope_hi: 6.0,
    
    // RSI confirmation
    rsi_long_min: 50,
    rsi_long_max: 75,
    rsi_short_max: 50,
    
    // Early signals
    early_signals_enabled: true,
    
    // Strategy enabled
    enabled: true,
  },
  
  session: {
    min_slope_abs: 2.0,
    max_entry_price: 0.45,
    min_rr: 1.5,
    entry_window_min: 150,
    entry_window_max: 240,
    enabled: true,
  },
};

try {
  kvSet.run({ 
    key: 'autotuner_params', 
    value: JSON.stringify(safeParams) 
  });
  
  console.log('✅ PARAMETERS RESET TO SAFE VALUES');
  console.log('📊 Key protections:');
  console.log('   • Max entry price: 0.45 (was allowing 0.65+ coinflips)');
  console.log('   • Min EMA distance: 5 bps (was allowing <5 noise)');
  console.log('   • Long requirements: 8+ bps, 6+ slope (was allowing weak 4-6 bps)');
  console.log('   • Short death zone: 5-8 bps blocked (was allowing trap range)');
  console.log('   • All trend guardrails active');
  console.log('');
  console.log('🛡️ Bot should now reject weak signals that caused recent losses');
  
} catch (error) {
  console.error('❌ Failed to reset parameters:', error.message);
  process.exit(1);
}