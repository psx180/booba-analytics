-- Add walletAddress to all user-specific tables
-- Using simple ALTER TABLE since these are nullable columns (SQLite supports this directly)

ALTER TABLE "Strategy" ADD COLUMN "walletAddress" TEXT;
ALTER TABLE "TradeGroup" ADD COLUMN "walletAddress" TEXT;
ALTER TABLE "Trade" ADD COLUMN "walletAddress" TEXT;
ALTER TABLE "FundingHistory" ADD COLUMN "walletAddress" TEXT;
ALTER TABLE "Alert" ADD COLUMN "walletAddress" TEXT;
ALTER TABLE "BoobaObservation" ADD COLUMN "walletAddress" TEXT;
ALTER TABLE "AnalysisSnapshot" ADD COLUMN "walletAddress" TEXT;

-- Indexes for efficient per-wallet queries
CREATE INDEX "Trade_walletAddress_idx" ON "Trade"("walletAddress");
CREATE INDEX "TradeGroup_walletAddress_idx" ON "TradeGroup"("walletAddress");
CREATE INDEX "FundingHistory_walletAddress_idx" ON "FundingHistory"("walletAddress");
CREATE INDEX "Alert_walletAddress_idx" ON "Alert"("walletAddress");
CREATE INDEX "Strategy_walletAddress_idx" ON "Strategy"("walletAddress");
CREATE INDEX "BoobaObservation_walletAddress_idx" ON "BoobaObservation"("walletAddress");
CREATE INDEX "AnalysisSnapshot_walletAddress_idx" ON "AnalysisSnapshot"("walletAddress");
