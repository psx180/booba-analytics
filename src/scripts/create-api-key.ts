/**
 * create-api-key.ts
 *
 * One-time script to generate a Pacifica API config key.
 * The key is printed to stdout — save it as PF_API_KEY in your environment.
 *
 * Usage:
 *   PACIFICA_PRIVATE_KEY=<your_base58_private_key> npx tsx src/scripts/create-api-key.ts
 *
 * The private key is only used to sign the creation request and is never stored.
 * You can use a hardware wallet or Phantom export for this.
 *
 * After running, add to your shell profile or .env:
 *   PF_API_KEY=<printed_key>
 */

import { PacificaClient } from '../services/pacifica';

async function main() {
  const privateKey = process.env.PACIFICA_PRIVATE_KEY;
  if (!privateKey) {
    console.error('Set PACIFICA_PRIVATE_KEY env var first.');
    process.exit(1);
  }

  const client = new PacificaClient({ privateKey });
  console.log(`Wallet: ${client.publicKey}`);
  console.log('Creating API config key...');

  const key = await client.apiKeys.create();
  console.log(`\nAPI config key created:\n\n  PF_API_KEY=${key}\n`);
  console.log('Add this to your environment to use it with the import script.');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
