#!/bin/bash
export DATABASE_URL="file:./prisma/dev.db"
npx prisma db push --skip-generate --accept-data-loss
exec npx next start