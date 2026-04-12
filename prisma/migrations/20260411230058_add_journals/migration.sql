-- AlterTable
ALTER TABLE "BoobaObservation" ADD COLUMN "journalId" TEXT;

-- CreateTable
CREATE TABLE "Journal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletAddress" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "filters" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Position" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletAddress" TEXT,
    "asset" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "averageEntryPrice" REAL,
    "averageExitPrice" REAL,
    "totalSize" REAL,
    "aggregatePnl" REAL,
    "aggregateFees" REAL,
    "aggregateFunding" REAL,
    "holdTimeSeconds" INTEGER,
    "mfePrice" REAL,
    "mfePnl" REAL,
    "maePrice" REAL,
    "maePnl" REAL,
    "confidence" REAL,
    "tradeType" TEXT,
    "regimeAtEntry" TEXT,
    "sentimentAtEntry" TEXT,
    "sentimentScore" REAL,
    "firstEntryTime" DATETIME,
    "lastExitTime" DATETIME,
    "thesis" TEXT,
    "invalidationPrice" REAL,
    "targetPrice" TEXT,
    "stopType" TEXT,
    "conviction" INTEGER,
    "exitEfficiency" REAL,
    "moneyLeftOnTable" REAL,
    "maeRatio" REAL,
    "entryHour" INTEGER,
    "entryDayOfWeek" INTEGER,
    "entrySession" TEXT,
    "holdTimeCategory" TEXT,
    "tiltScore" REAL,
    "tiltEpisodeId" TEXT,
    "tiltFeatures" TEXT,
    "xpnl" REAL,
    "eloAtTrade" REAL,
    "strategyTag" TEXT,
    "sourceTag" TEXT,
    "customData" TEXT,
    "linkedStrategyId" TEXT,
    "strategyId" TEXT,
    "journalId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Position_linkedStrategyId_fkey" FOREIGN KEY ("linkedStrategyId") REFERENCES "LinkedStrategy" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Position_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Position_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "Journal" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Position" ("aggregateFees", "aggregateFunding", "aggregatePnl", "asset", "averageEntryPrice", "averageExitPrice", "confidence", "conviction", "createdAt", "customData", "direction", "eloAtTrade", "entryDayOfWeek", "entryHour", "entrySession", "exitEfficiency", "firstEntryTime", "holdTimeCategory", "holdTimeSeconds", "id", "invalidationPrice", "lastExitTime", "linkedStrategyId", "maePnl", "maePrice", "maeRatio", "mfePnl", "mfePrice", "moneyLeftOnTable", "regimeAtEntry", "sentimentAtEntry", "sentimentScore", "sourceTag", "status", "stopType", "strategyId", "strategyTag", "targetPrice", "thesis", "tiltEpisodeId", "tiltFeatures", "tiltScore", "totalSize", "tradeType", "updatedAt", "walletAddress", "xpnl") SELECT "aggregateFees", "aggregateFunding", "aggregatePnl", "asset", "averageEntryPrice", "averageExitPrice", "confidence", "conviction", "createdAt", "customData", "direction", "eloAtTrade", "entryDayOfWeek", "entryHour", "entrySession", "exitEfficiency", "firstEntryTime", "holdTimeCategory", "holdTimeSeconds", "id", "invalidationPrice", "lastExitTime", "linkedStrategyId", "maePnl", "maePrice", "maeRatio", "mfePnl", "mfePrice", "moneyLeftOnTable", "regimeAtEntry", "sentimentAtEntry", "sentimentScore", "sourceTag", "status", "stopType", "strategyId", "strategyTag", "targetPrice", "thesis", "tiltEpisodeId", "tiltFeatures", "tiltScore", "totalSize", "tradeType", "updatedAt", "walletAddress", "xpnl" FROM "Position";
DROP TABLE "Position";
ALTER TABLE "new_Position" RENAME TO "Position";
CREATE INDEX "Position_journalId_idx" ON "Position"("journalId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Journal_walletAddress_idx" ON "Journal"("walletAddress");

-- CreateIndex
CREATE INDEX "BoobaObservation_walletAddress_journalId_idx" ON "BoobaObservation"("walletAddress", "journalId");
