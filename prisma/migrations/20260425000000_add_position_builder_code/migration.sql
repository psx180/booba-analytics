-- AddColumn
ALTER TABLE "Position" ADD COLUMN "builderCode" TEXT;

-- CreateIndex
CREATE INDEX "Position_walletAddress_builderCode_idx" ON "Position"("walletAddress", "builderCode");

-- Backfill: copy builderCode from each Position's earliest fill (Trade) via OrderGroup.
-- Manual trades (no builder code on any fill) remain NULL, which is the "Manual only" sentinel.
UPDATE "Position"
SET "builderCode" = (
  SELECT t."builderCode"
  FROM "Trade" t
  INNER JOIN "OrderGroup" og ON og."id" = t."orderGroupId"
  WHERE og."positionId" = "Position"."id"
    AND t."builderCode" IS NOT NULL
  ORDER BY t."entryTime" ASC, t."id" ASC
  LIMIT 1
);
