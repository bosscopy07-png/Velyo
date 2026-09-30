-- Only needed if you do NOT use `prisma migrate dev` / `prisma db push`.
-- Run once against your Postgres database.
CREATE TYPE "BroadcastStatus" AS ENUM ('SENDING', 'COMPLETED', 'INTERRUPTED', 'RECALLED');

CREATE TABLE "broadcasts" (
  "id" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "entities" JSONB,
  "status" "BroadcastStatus" NOT NULL DEFAULT 'SENDING',
  "expireMinutes" INTEGER NOT NULL,
  "targetCount" INTEGER NOT NULL DEFAULT 0,
  "sentCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "broadcasts_createdAt_idx" ON "broadcasts"("createdAt");

CREATE TABLE "broadcast_deliveries" (
  "id" TEXT NOT NULL,
  "broadcastId" TEXT NOT NULL,
  "telegramId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "messageId" INTEGER NOT NULL,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "openedAt" TIMESTAMP(3),
  "deleteAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "broadcast_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "broadcast_deliveries_broadcastId_idx" ON "broadcast_deliveries"("broadcastId");
CREATE INDEX "broadcast_deliveries_telegramId_openedAt_deletedAt_idx" ON "broadcast_deliveries"("telegramId", "openedAt", "deletedAt");
CREATE INDEX "broadcast_deliveries_deletedAt_deleteAt_idx" ON "broadcast_deliveries"("deletedAt", "deleteAt");
ALTER TABLE "broadcast_deliveries" ADD CONSTRAINT "broadcast_deliveries_broadcastId_fkey"
  FOREIGN KEY ("broadcastId") REFERENCES "broadcasts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
