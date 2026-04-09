/*
  Warnings:

  - Added the required column `method` to the `RegimeSnapshot` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RegimeSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "asset" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "timeframe" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "regimeClassification" TEXT,
    "confidence" REAL,
    "adxValue" REAL,
    "atrValue" REAL,
    "atrSmaValue" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_RegimeSnapshot" ("adxValue", "asset", "atrSmaValue", "atrValue", "createdAt", "id", "regimeClassification", "timeframe", "timestamp") SELECT "adxValue", "asset", "atrSmaValue", "atrValue", "createdAt", "id", "regimeClassification", "timeframe", "timestamp" FROM "RegimeSnapshot";
DROP TABLE "RegimeSnapshot";
ALTER TABLE "new_RegimeSnapshot" RENAME TO "RegimeSnapshot";
CREATE INDEX "RegimeSnapshot_asset_timestamp_idx" ON "RegimeSnapshot"("asset", "timestamp");
CREATE UNIQUE INDEX "RegimeSnapshot_asset_timestamp_timeframe_method_key" ON "RegimeSnapshot"("asset", "timestamp", "timeframe", "method");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
