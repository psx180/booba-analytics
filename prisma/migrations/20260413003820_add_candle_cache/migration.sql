-- CreateTable
CREATE TABLE "CandleCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "asset" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "open" REAL NOT NULL,
    "high" REAL NOT NULL,
    "low" REAL NOT NULL,
    "close" REAL NOT NULL,
    "volume" REAL NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "CandleCache_asset_timeframe_timestamp_idx" ON "CandleCache"("asset", "timeframe", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "CandleCache_asset_timeframe_timestamp_key" ON "CandleCache"("asset", "timeframe", "timestamp");
