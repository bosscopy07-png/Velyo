-- Wallet address entered on the website before a claim code is issued.
-- Additive: two nullable columns + one index on the website reservations table.
ALTER TABLE "giveaway_reservations" ADD COLUMN "addressHash" TEXT;
ALTER TABLE "giveaway_reservations" ADD COLUMN "maskedAddress" TEXT;
CREATE INDEX "giveaway_reservations_giveawayId_addressHash_idx" ON "giveaway_reservations"("giveawayId", "addressHash");
