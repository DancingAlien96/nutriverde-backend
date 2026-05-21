-- AlterTable
ALTER TABLE `appointments` ADD COLUMN `scheduleToken` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `appointments_scheduleToken_key` ON `appointments`(`scheduleToken`);
