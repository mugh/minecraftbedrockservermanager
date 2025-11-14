#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

console.log('🚀 Setting up WebSocket support for Minecraft Server Manager...\n');

// Install socket.io server
console.log('📦 Installing socket.io server...');
try {
  execSync('npm install socket.io', { stdio: 'inherit' });
  console.log('✅ Socket.IO server installed successfully!\n');
} catch (error) {
  console.error('❌ Failed to install socket.io:', error.message);
  process.exit(1);
}

// Create public directory if it doesn't exist
if (!fs.existsSync('public')) {
  fs.mkdirSync('public');
  console.log('📁 Created public directory');
}

// Download socket.io client library
console.log('⬇️  Downloading Socket.IO client library...');
const clientUrl = 'https://cdn.socket.io/4.7.2/socket.io.min.js';
const clientPath = path.join('public', 'socket.io.js');

const file = fs.createWriteStream(clientPath);
const request = https.get(clientUrl, (response) => {
  if (response.statusCode !== 200) {
    console.error(`❌ Failed to download Socket.IO client: HTTP ${response.statusCode}`);
    process.exit(1);
  }

  response.pipe(file);

  file.on('finish', () => {
    file.close();
    console.log('✅ Socket.IO client downloaded successfully!\n');

    console.log('🎉 WebSocket setup complete!');
    console.log('');
    console.log('📋 Next steps:');
    console.log('1. Start the server: npm start');
    console.log('2. Or for development: npm run dev');
    console.log('');
    console.log('⚡ Real-time features now active:');
    console.log('• Server status updates (instant)');
    console.log('• Player join/leave notifications');
    console.log('• Live console logs');
    console.log('• Real-time configuration changes');
    console.log('• Addon enable/disable updates');
    console.log('• World switching notifications');
    console.log('');
    console.log('🔄 Fallback: Polling every 30 seconds if WebSocket fails');
  });
});

request.on('error', (error) => {
  console.error('❌ Failed to download Socket.IO client:', error.message);
  fs.unlink(clientPath, () => {}); // Delete partial file
  process.exit(1);
});

file.on('error', (error) => {
  console.error('❌ Failed to save Socket.IO client:', error.message);
  fs.unlink(clientPath, () => {}); // Delete partial file
  process.exit(1);
});