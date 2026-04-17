import { PrismaClient } from '../../generated/prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import path from 'path';

const dbPath = process.env.DATABASE_URL 
  ? path.resolve(process.cwd(), process.env.DATABASE_URL.replace('file:./', ''))
  : path.resolve(process.cwd(), 'dev.db');
const adapter = new PrismaBetterSqlite3({ url: dbPath });

export const prisma = new PrismaClient({ adapter } as any);