-- VELYO Phase-2 upgrade: rewards, attribution, claim blocks/flags, deposit sessions.
-- ADDITIVE ONLY. No table is dropped, truncated, or altered destructively.

-- New enum types
CREATE TYPE "RewardType" AS ENUM ('GIVEAWAY_CASHBACK', 'REFERRAL_REWARD');
CREATE TYPE "RewardStatus" AS ENUM ('PENDING', 'CREDITED', 'APPLIED', 'FAILED');
CREATE TYPE "AttributionSource" AS ENUM ('GIVEAWAY_LINK', 'MANUAL_CODE');
CREATE TYPE "AttributionStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "FlagSeverity" AS ENUM ('POSSIBLE_DUPLICATE', 'CONFIRMED_ABUSE');
CREATE TYPE "FlagStatus" AS ENUM ('OPEN', 'DISMISSED', 'CONFIRMED');
CREATE TYPE "CompanyWalletStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "DepositSessionStatus" AS ENUM ('AWAITING', 'DETECTED', 'CREDITED', 'EXPIRED', 'FAILED');

-- Extend TransactionType (append-only, existing rows unaffected)
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'REWARD';

CREATE TABLE "rewards" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "RewardType" NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "status" "RewardStatus" NOT NULL DEFAULT 'CREDITED',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rewards_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "rewards_idempotencyKey_key" ON "rewards"("idempotencyKey");
CREATE INDEX "rewards_userId_idx" ON "rewards"("userId");
CREATE INDEX "rewards_sourceType_sourceId_idx" ON "rewards"("sourceType", "sourceId");
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "giveaway_attributions" (
    "id" TEXT NOT NULL,
    "giveawayId" TEXT NOT NULL,
    "claimantId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "claimId" TEXT,
    "source" "AttributionSource" NOT NULL,
    "status" "AttributionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "giveaway_attributions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "giveaway_attributions_giveawayId_claimantId_key" ON "giveaway_attributions"("giveawayId", "claimantId");
CREATE UNIQUE INDEX "giveaway_attributions_claimId_key" ON "giveaway_attributions"("claimId");
CREATE INDEX "giveaway_attributions_claimantId_idx" ON "giveaway_attributions"("claimantId");
CREATE INDEX "giveaway_attributions_creatorId_idx" ON "giveaway_attributions"("creatorId");
ALTER TABLE "giveaway_attributions" ADD CONSTRAINT "giveaway_attributions_giveawayId_fkey" FOREIGN KEY ("giveawayId") REFERENCES "giveaways"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "giveaway_attributions" ADD CONSTRAINT "giveaway_attributions_claimantId_fkey" FOREIGN KEY ("claimantId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "giveaway_attributions" ADD CONSTRAINT "giveaway_attributions_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "giveaway_attributions" ADD CONSTRAINT "giveaway_attributions_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "giveaway_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "claim_blocks" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "blockedUserId" TEXT NOT NULL,
    "giveawayId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_blocks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "claim_blocks_creatorId_blockedUserId_idx" ON "claim_blocks"("creatorId", "blockedUserId");
ALTER TABLE "claim_blocks" ADD CONSTRAINT "claim_blocks_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "claim_blocks" ADD CONSTRAINT "claim_blocks_blockedUserId_fkey" FOREIGN KEY ("blockedUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "claim_blocks" ADD CONSTRAINT "claim_blocks_giveawayId_fkey" FOREIGN KEY ("giveawayId") REFERENCES "giveaways"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "claim_flags" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "giveawayId" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "severity" "FlagSeverity" NOT NULL DEFAULT 'POSSIBLE_DUPLICATE',
    "detail" JSONB,
    "status" "FlagStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,

    CONSTRAINT "claim_flags_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "claim_flags_giveawayId_status_idx" ON "claim_flags"("giveawayId", "status");
CREATE INDEX "claim_flags_claimId_idx" ON "claim_flags"("claimId");
ALTER TABLE "claim_flags" ADD CONSTRAINT "claim_flags_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "giveaway_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "company_deposit_wallets" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "status" "CompanyWalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastAssignedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_deposit_wallets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "company_deposit_wallets_address_key" ON "company_deposit_wallets"("address");

CREATE TABLE "deposit_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "requestedAmount" DECIMAL(36,18) NOT NULL,
    "platformFee" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "expectedAmount" DECIMAL(36,18) NOT NULL,
    "uniqueSuffix" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "assignedWalletId" TEXT NOT NULL,
    "paymentRef" TEXT NOT NULL,
    "txHash" TEXT,
    "detectedTxHash" TEXT,
    "detectedAmount" DECIMAL(36,18),
    "status" "DepositSessionStatus" NOT NULL DEFAULT 'AWAITING',
    "creditedAmount" DECIMAL(36,18),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creditedAt" TIMESTAMP(3),
    "forwardedAt" TIMESTAMP(3),

    CONSTRAINT "deposit_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "deposit_sessions_paymentRef_key" ON "deposit_sessions"("paymentRef");
CREATE UNIQUE INDEX "deposit_sessions_txHash_key" ON "deposit_sessions"("txHash");
CREATE INDEX "deposit_sessions_userId_idx" ON "deposit_sessions"("userId");
CREATE INDEX "deposit_sessions_status_expiresAt_idx" ON "deposit_sessions"("status", "expiresAt");
ALTER TABLE "deposit_sessions" ADD CONSTRAINT "deposit_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deposit_sessions" ADD CONSTRAINT "deposit_sessions_assignedWalletId_fkey" FOREIGN KEY ("assignedWalletId") REFERENCES "company_deposit_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
