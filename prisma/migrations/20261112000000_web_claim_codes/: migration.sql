-- VEYLO website claim codes + giveaway-scoped duplicate evidence.
-- Additive: creates new enums/tables only. Existing tables are untouched.

CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CONVERTED', 'EXPIRED', 'RELEASED');
CREATE TYPE "WebCodeStatus" AS ENUM ('ACTIVE', 'REDEEMED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "DuplicateLevel" AS ENUM ('CONFIRMED_DUPLICATE', 'STRONG_SUSPICIOUS', 'WEAK_SIGNAL');
CREATE TYPE "DuplicateReview" AS ENUM ('NOT_REQUIRED', 'OPEN', 'DISMISSED', 'CONFIRMED');

CREATE TABLE "giveaway_public_links" (
  "id" TEXT NOT NULL,
  "giveawayId" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "giveaway_public_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "giveaway_public_links_giveawayId_key" ON "giveaway_public_links"("giveawayId");
CREATE UNIQUE INDEX "giveaway_public_links_slug_key" ON "giveaway_public_links"("slug");

CREATE TABLE "giveaway_reservations" (
  "id" TEXT NOT NULL,
  "giveawayId" TEXT NOT NULL,
  "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "ipHash" TEXT,
  "deviceHash" TEXT,
  "uaHash" TEXT,
  "claimId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "convertedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  CONSTRAINT "giveaway_reservations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "giveaway_reservations_giveawayId_status_expiresAt_idx" ON "giveaway_reservations"("giveawayId", "status", "expiresAt");
CREATE INDEX "giveaway_reservations_giveawayId_ipHash_idx" ON "giveaway_reservations"("giveawayId", "ipHash");
CREATE INDEX "giveaway_reservations_giveawayId_deviceHash_idx" ON "giveaway_reservations"("giveawayId", "deviceHash");
CREATE INDEX "giveaway_reservations_status_expiresAt_idx" ON "giveaway_reservations"("status", "expiresAt");

CREATE TABLE "giveaway_web_codes" (
  "id" TEXT NOT NULL,
  "giveawayId" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "codeCipher" TEXT,
  "status" "WebCodeStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "redeemedAt" TIMESTAMP(3),
  "telegramUserId" TEXT,
  "claimId" TEXT,
  "audit" JSONB,
  CONSTRAINT "giveaway_web_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "giveaway_web_codes_reservationId_key" ON "giveaway_web_codes"("reservationId");
CREATE UNIQUE INDEX "giveaway_web_codes_codeHash_key" ON "giveaway_web_codes"("codeHash");
CREATE INDEX "giveaway_web_codes_giveawayId_status_idx" ON "giveaway_web_codes"("giveawayId", "status");
CREATE INDEX "giveaway_web_codes_status_expiresAt_idx" ON "giveaway_web_codes"("status", "expiresAt");
ALTER TABLE "giveaway_web_codes" ADD CONSTRAINT "giveaway_web_codes_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "giveaway_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "giveaway_wallet_uses" (
  "id" TEXT NOT NULL,
  "giveawayId" TEXT NOT NULL,
  "addressHash" TEXT NOT NULL,
  "maskedAddress" TEXT NOT NULL,
  "claimId" TEXT NOT NULL,
  "telegramId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "giveaway_wallet_uses_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "giveaway_wallet_uses_claimId_key" ON "giveaway_wallet_uses"("claimId");
CREATE UNIQUE INDEX "giveaway_wallet_uses_giveawayId_addressHash_key" ON "giveaway_wallet_uses"("giveawayId", "addressHash");
CREATE INDEX "giveaway_wallet_uses_addressHash_idx" ON "giveaway_wallet_uses"("addressHash");

CREATE TABLE "duplicate_evidence" (
  "id" TEXT NOT NULL,
  "giveawayId" TEXT NOT NULL,
  "level" "DuplicateLevel" NOT NULL,
  "signals" JSONB NOT NULL,
  "currentClaimId" TEXT,
  "currentReservationId" TEXT,
  "previousClaimId" TEXT,
  "previousClaimAt" TIMESTAMP(3),
  "walletHash" TEXT,
  "maskedWallet" TEXT,
  "relatedTelegramIds" JSONB,
  "signalRefs" JSONB,
  "decision" TEXT NOT NULL,
  "reviewStatus" "DuplicateReview" NOT NULL DEFAULT 'NOT_REQUIRED',
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "duplicate_evidence_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "duplicate_evidence_giveawayId_level_idx" ON "duplicate_evidence"("giveawayId", "level");
CREATE INDEX "duplicate_evidence_reviewStatus_createdAt_idx" ON "duplicate_evidence"("reviewStatus", "createdAt");
CREATE INDEX "duplicate_evidence_currentClaimId_idx" ON "duplicate_evidence"("currentClaimId");
