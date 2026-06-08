-- AlterTable
ALTER TABLE `patients` ADD COLUMN `documentId` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `patients_documentId_key` ON `patients`(`documentId`);
