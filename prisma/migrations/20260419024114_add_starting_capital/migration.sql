-- AlterTable
ALTER TABLE "Journal" ADD COLUMN "startingCapital" REAL;
ALTER TABLE "Journal" ADD COLUMN "startingCapitalSource" TEXT;

-- AlterTable
ALTER TABLE "Trade" ADD COLUMN "cause" TEXT;

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletAddress" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "channelName" TEXT,
    "callerName" TEXT NOT NULL,
    "rawMessage" TEXT,
    "asset" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "entryPrice" REAL NOT NULL,
    "targetPrice" REAL,
    "targetPrices" TEXT,
    "stopPrice" REAL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcomePrice" REAL,
    "outcomePnlPct" REAL,
    "outcomeRMultiple" REAL,
    "targetPricesHit" TEXT,
    "resolvedAt" DATETIME,
    "positionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Playbook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletAddress" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rules" TEXT NOT NULL,
    "totalChecks" INTEGER NOT NULL DEFAULT 0,
    "avgAdherence" REAL,
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
    "groupingConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "tradeType" TEXT,
    "manualTradeType" TEXT,
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
    "emotion" TEXT,
    "mistakes" TEXT,
    "confirmation" TEXT,
    "playbookId" TEXT,
    "adherenceScore" REAL,
    "adherenceDetail" TEXT,
    "socialSentiment" REAL,
    "socialMentions" INTEGER,
    "socialMindshare" REAL,
    "screenshot" TEXT,
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
INSERT INTO "new_Position" ("aggregateFees", "aggregateFunding", "aggregatePnl", "asset", "averageEntryPrice", "averageExitPrice", "confidence", "conviction", "createdAt", "customData", "direction", "eloAtTrade", "emotion", "entryDayOfWeek", "entryHour", "entrySession", "exitEfficiency", "firstEntryTime", "holdTimeCategory", "holdTimeSeconds", "id", "invalidationPrice", "journalId", "lastExitTime", "linkedStrategyId", "maePnl", "maePrice", "maeRatio", "mfePnl", "mfePrice", "mistakes", "moneyLeftOnTable", "regimeAtEntry", "sentimentAtEntry", "sentimentScore", "sourceTag", "status", "stopType", "strategyId", "strategyTag", "targetPrice", "thesis", "tiltEpisodeId", "tiltFeatures", "tiltScore", "totalSize", "tradeType", "updatedAt", "walletAddress", "xpnl") SELECT "aggregateFees", "aggregateFunding", "aggregatePnl", "asset", "averageEntryPrice", "averageExitPrice", "confidence", "conviction", "createdAt", "customData", "direction", "eloAtTrade", "emotion", "entryDayOfWeek", "entryHour", "entrySession", "exitEfficiency", "firstEntryTime", "holdTimeCategory", "holdTimeSeconds", "id", "invalidationPrice", "journalId", "lastExitTime", "linkedStrategyId", "maePnl", "maePrice", "maeRatio", "mfePnl", "mfePrice", "mistakes", "moneyLeftOnTable", "regimeAtEntry", "sentimentAtEntry", "sentimentScore", "sourceTag", "status", "stopType", "strategyId", "strategyTag", "targetPrice", "thesis", "tiltEpisodeId", "tiltFeatures", "tiltScore", "totalSize", "tradeType", "updatedAt", "walletAddress", "xpnl" FROM "Position";
DROP TABLE "Position";
ALTER TABLE "new_Position" RENAME TO "Position";
CREATE INDEX "Position_journalId_idx" ON "Position"("journalId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Signal_walletAddress_callerName_idx" ON "Signal"("walletAddress", "callerName");

-- CreateIndex
CREATE INDEX "Signal_walletAddress_status_idx" ON "Signal"("walletAddress", "status");

-- CreateIndex
CREATE INDEX "Playbook_walletAddress_idx" ON "Playbook"("walletAddress");
