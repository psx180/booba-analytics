import { PrismaClient } from '../../generated/prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import path from 'path';

const dbPath = process.env.DATABASE_URL 
  ? path.resolve(process.cwd(), process.env.DATABASE_URL.replace('file:./', ''))
  : path.resolve(process.cwd(), 'dev.db');
const adapter = new PrismaBetterSqlite3({ url: dbPath });

export const prisma = new PrismaClient({ adapter } as any);

// Enable SQLite WAL (Write-Ahead Logging) journal mode on process startup.
// In the default rollback-journal mode, any open write transaction blocks
// all readers until it commits — an import that writes hundreds of trades
// can stall unrelated API reads for seconds at a time. WAL mode lets
// readers continue against the last committed snapshot while a writer is
// in flight, dramatically reducing tail latency during long-running
// mutations. The pragma is persistent on the DB file, so setting it once
// is enough; the `.catch(() => {})` is a precaution in case the pragma
// fails on an already-WAL-enabled file or under a locked connection.
prisma.$executeRawUnsafe('PRAGMA journal_mode=WAL').catch(() => {});