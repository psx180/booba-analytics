const { execSync } = require('child_process');

process.env.DATABASE_URL = 'file:./prisma/dev.db';

console.log('[start] Running prisma db push...');
try {
  execSync('npx prisma db push --skip-generate --accept-data-loss', { 
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: 'file:./prisma/dev.db' }
  });
  console.log('[start] Database ready');
} catch (e) {
  console.error('[start] prisma db push failed:', e.message);
}

console.log('[start] Starting Next.js...');
execSync('npx next start', { stdio: 'inherit', env: process.env });