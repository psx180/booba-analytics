/*
  Warnings:

  - You are about to drop the `TradeGroup` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `groupId` on the `Trade` table. All the data in the column will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "TradeGroup";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "LinkedStrategy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletAddress" TEXT,
    "strategyType" TEXT NOT NULL,
    "combinedPnl" REAL,
    "combinedFees" REAL,
    "combinedFunding" REAL,
    "netDelta" REAL,
    "spreadPnl" REAL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "confidence" REAL,
    "tradeType" TEXT,
    "firstEntryTime" DATETIME,
    "lastExitTime" DATETIME,
    "thesis" TEXT,
    "customData" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Position" (
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
    "customData" TEXT,
    "linkedStrategyId" TEXT,
    "strategyId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Position_linkedStrategyId_fkey" FOREIGN KEY ("linkedStrategyId") REFERENCES "LinkedStrategy" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Position_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrderGroup" (
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
    "confidence" REAL,
    "ruleSource" TEXT,
    "tradeType" TEXT,
    "firstEntryTime" DATETIME,
    "lastExitTime" DATETIME,
    "rawMetadata" TEXT,
    "positionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OrderGroup_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Trade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletAddress" TEXT,
    "asset" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "size" REAL NOT NULL,
    "entryPrice" REAL NOT NULL,
    "exitPrice" REAL,
    "entryTime" DATETIME NOT NULL,
    "exitTime" DATETIME,
    "pnlRealized" REAL,
    "fees" REAL,
    "fundingEarned" REAL,
    "fundingPaid" REAL,
    "holdTimeSeconds" INTEGER,
    "mfePrice" REAL,
    "mfePnl" REAL,
    "maePrice" REAL,
    "maePnl" REAL,
    "regimeAtEntry" TEXT,
    "sentimentAtEntry" TEXT,
    "sentimentScore" REAL,
    "strategyId" TEXT,
    "orderGroupId" TEXT,
    "sourceTag" TEXT,
    "tradeType" TEXT,
    "subaccount" TEXT,
    "builderCode" TEXT,
    "captureMode" TEXT NOT NULL DEFAULT 'retroactive',
    "thesis" TEXT,
    "invalidationPrice" REAL,
    "targetPrice" TEXT,
    "stopType" TEXT,
    "conviction" INTEGER,
    "customData" TEXT,
    "rawData" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Trade_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Trade_orderGroupId_fkey" FOREIGN KEY ("orderGroupId") REFERENCES "OrderGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Trade" ("asset", "builderCode", "captureMode", "conviction", "createdAt", "customData", "direction", "entryPrice", "entryTime", "exitPrice", "exitTime", "fees", "fundingEarned", "fundingPaid", "holdTimeSeconds", "id", "invalidationPrice", "maePnl", "maePrice", "mfePnl", "mfePrice", "pnlRealized", "rawData", "regimeAtEntry", "sentimentAtEntry", "sentimentScore", "size", "sourceTag", "stopType", "strategyId", "subaccount", "targetPrice", "thesis", "tradeType", "updatedAt", "walletAddress") SELECT "asset", "builderCode", "captureMode", "conviction", "createdAt", "customData", "direction", "entryPrice", "entryTime", "exitPrice", "exitTime", "fees", "fundingEarned", "fundingPaid", "holdTimeSeconds", "id", "invalidationPrice", "maePnl", "maePrice", "mfePnl", "mfePrice", "pnlRealized", "rawData", "regimeAtEntry", "sentimentAtEntry", "sentimentScore", "size", "sourceTag", "stopType", "strategyId", "subaccount", "targetPrice", "thesis", "tradeType", "updatedAt", "walletAddress" FROM "Trade";
DROP TABLE "Trade";
ALTER TABLE "new_Trade" RENAME TO "Trade";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
