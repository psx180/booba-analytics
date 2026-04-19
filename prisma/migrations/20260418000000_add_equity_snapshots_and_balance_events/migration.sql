-- CreateTable
CREATE TABLE "EquitySnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletAddress" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "accountEquity" REAL NOT NULL,
    "pnl" REAL,
    "source" TEXT NOT NULL DEFAULT 'pacifica',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "EquitySnapshot_walletAddress_timestamp_idx" ON "EquitySnapshot"("walletAddress", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "EquitySnapshot_walletAddress_timestamp_key" ON "EquitySnapshot"("walletAddress", "timestamp");

-- CreateTable
CREATE TABLE "BalanceEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletAddress" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "eventType" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "balance" REAL,
    "source" TEXT NOT NULL DEFAULT 'pacifica',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "BalanceEvent_walletAddress_timestamp_idx" ON "BalanceEvent"("walletAddress", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "BalanceEvent_walletAddress_timestamp_eventType_amount_key" ON "BalanceEvent"("walletAddress", "timestamp", "eventType", "amount");
