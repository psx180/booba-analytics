-- AddColumn: Trade.orderId
ALTER TABLE "Trade" ADD COLUMN "orderId" BIGINT;

-- CreateIndex: speeds up Order ↔ Trade joins by Pacifica order_id.
CREATE INDEX "Trade_orderId_idx" ON "Trade"("orderId");

-- Backfill Trade.orderId from rawData JSON. The mapper has been storing
-- the entire fill payload in rawData since launch, and Pacifica's fill
-- payload includes order_id, so we can hydrate the column for every
-- existing row without a network call. Anything missing rawData or
-- order_id stays NULL — the grouping/enrichment paths handle nullable
-- orderId gracefully.
UPDATE "Trade"
SET "orderId" = CAST(json_extract("rawData", '$.order_id') AS INTEGER)
WHERE "rawData" IS NOT NULL
  AND json_extract("rawData", '$.order_id') IS NOT NULL;

-- AddColumn: Position enrichment fields populated from Order data after
-- grouping. Nullable (no data yet) until the enrichment runs.
ALTER TABLE "Position" ADD COLUMN "stopLossPrice" REAL;
ALTER TABLE "Position" ADD COLUMN "takeProfitPrice" REAL;
ALTER TABLE "Position" ADD COLUMN "entryOrderType" TEXT;
ALTER TABLE "Position" ADD COLUMN "hasPlannedStop" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Position" ADD COLUMN "hasPlannedTarget" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: Order — mirror of Pacifica /orders/history.
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletAddress" TEXT NOT NULL,
    "orderId" BIGINT NOT NULL,
    "clientOrderId" TEXT,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "orderType" TEXT NOT NULL,
    "orderStatus" TEXT NOT NULL,
    "initialPrice" REAL,
    "averageFilledPrice" REAL,
    "amount" REAL NOT NULL,
    "filledAmount" REAL,
    "stopPrice" REAL,
    "stopParentOrderId" BIGINT,
    "reduceOnly" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "triggerPriceType" TEXT,
    "instrumentType" TEXT,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME,
    "ingestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "Order_orderId_key" ON "Order"("orderId");
CREATE INDEX "Order_walletAddress_idx" ON "Order"("walletAddress");
CREATE INDEX "Order_symbol_idx" ON "Order"("symbol");
CREATE INDEX "Order_stopParentOrderId_idx" ON "Order"("stopParentOrderId");
CREATE INDEX "Order_walletAddress_symbol_createdAt_idx" ON "Order"("walletAddress", "symbol", "createdAt");
