-- CreateTable
CREATE TABLE "Strategy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "directionBias" TEXT,
    "preferredRegime" TEXT,
    "typicalTimeframe" TEXT,
    "description" TEXT,
    "entrySignalTags" TEXT,
    "typicalRrTarget" REAL,
    "checklist" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TradeGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "asset" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "thesis" TEXT,
    "strategyId" TEXT,
    "sourceTag" TEXT,
    "tradeType" TEXT,
    "aggregatePnl" REAL,
    "aggregateFees" REAL,
    "aggregateFunding" REAL,
    "averageEntryPrice" REAL,
    "averageExitPrice" REAL,
    "totalSize" REAL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TradeGroup_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "groupId" TEXT,
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
    CONSTRAINT "Trade_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TradeGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CustomStatDefinition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "options" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BoobaObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "observationText" TEXT NOT NULL,
    "confidence" TEXT,
    "sourceModule" TEXT,
    "relatedStrategyId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "compressedAt" DATETIME,
    CONSTRAINT "BoobaObservation_relatedStrategyId_fkey" FOREIGN KEY ("relatedStrategyId") REFERENCES "Strategy" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnalysisSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "periodType" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "totalTrades" INTEGER,
    "winRate" REAL,
    "expectancy" REAL,
    "profitFactor" REAL,
    "sharpeRatio" REAL,
    "regimeBreakdown" TEXT,
    "behavioralScores" TEXT,
    "summaryText" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FundingHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "asset" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "rate" REAL NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "tradeId" TEXT,
    "rawData" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FundingHistory_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RegimeSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "asset" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "timeframe" TEXT NOT NULL,
    "adxValue" REAL,
    "atrValue" REAL,
    "atrSmaValue" REAL,
    "regimeClassification" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "alertType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "relatedTradeId" TEXT,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Alert_relatedTradeId_fkey" FOREIGN KEY ("relatedTradeId") REFERENCES "Trade" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Strategy_name_key" ON "Strategy"("name");

-- CreateIndex
CREATE UNIQUE INDEX "CustomStatDefinition_name_key" ON "CustomStatDefinition"("name");

-- CreateIndex
CREATE INDEX "RegimeSnapshot_asset_timestamp_idx" ON "RegimeSnapshot"("asset", "timestamp");
