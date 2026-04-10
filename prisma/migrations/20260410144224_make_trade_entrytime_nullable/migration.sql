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
    "entryTime" DATETIME,
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
INSERT INTO "new_Trade" ("asset", "builderCode", "captureMode", "conviction", "createdAt", "customData", "direction", "entryPrice", "entryTime", "exitPrice", "exitTime", "fees", "fundingEarned", "fundingPaid", "holdTimeSeconds", "id", "invalidationPrice", "maePnl", "maePrice", "mfePnl", "mfePrice", "orderGroupId", "pnlRealized", "rawData", "regimeAtEntry", "sentimentAtEntry", "sentimentScore", "size", "sourceTag", "stopType", "strategyId", "subaccount", "targetPrice", "thesis", "tradeType", "updatedAt", "walletAddress") SELECT "asset", "builderCode", "captureMode", "conviction", "createdAt", "customData", "direction", "entryPrice", "entryTime", "exitPrice", "exitTime", "fees", "fundingEarned", "fundingPaid", "holdTimeSeconds", "id", "invalidationPrice", "maePnl", "maePrice", "mfePnl", "mfePrice", "orderGroupId", "pnlRealized", "rawData", "regimeAtEntry", "sentimentAtEntry", "sentimentScore", "size", "sourceTag", "stopType", "strategyId", "subaccount", "targetPrice", "thesis", "tradeType", "updatedAt", "walletAddress" FROM "Trade";
DROP TABLE "Trade";
ALTER TABLE "new_Trade" RENAME TO "Trade";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
