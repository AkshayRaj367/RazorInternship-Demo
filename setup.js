const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = __dirname;
const examplePath = path.join(root, '.env.example');
const envPath = path.join(root, '.env');

if (!fs.existsSync(envPath)) {
  let env = fs.readFileSync(examplePath, 'utf8');
  env = env.replace('replace-with-a-local-secret', crypto.randomBytes(24).toString('hex'));
  fs.writeFileSync(envPath, env);
  console.log('Created .env with a local MCP secret.');
} else {
  console.log('.env already exists; leaving it unchanged.');
}

const command = process.platform === 'win32' ? 'bun.exe' : 'bun';
const steps = [
  ['prisma', 'generate'],
  ['prisma', 'db', 'push'],
  ['prisma/seed.ts'],
];

for (const args of steps) {
  console.log(`Running: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(`Unable to run ${command}. Install Bun, then run this setup again.`);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (args[0] === 'prisma' && args[1] === 'generate') {
      console.warn('Prisma Client generation was skipped; stop any running app and run npm run db:generate later.');
      continue;
    }
    process.exit(result.status ?? 1);
  }
}

console.log('\nSetup complete. Start the app with: npm run dev');
