#!/usr/bin/env node
// Test if database.js exports are correct
const db = require('./services/database');

console.log('Testing database.js exports:');
console.log('  getDevice:', typeof db.getDevice);
console.log('  getDeviceById:', typeof db.getDeviceById);
console.log('  getPeerSysinfo:', typeof db.getPeerSysinfo);
console.log('  upsertPeerSysinfo:', typeof db.upsertPeerSysinfo);

if (typeof db.getDevice === 'function') {
    console.log('\n✓ getDevice is properly exported');
} else {
    console.log('\n✗ getDevice is NOT exported!');
    console.log('  Available exports:', Object.keys(db).filter(k => k.includes('Device') || k.includes('get')).join(', '));
}
