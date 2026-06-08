-- AlterTable
ALTER TABLE `patients`
  ADD COLUMN `documentType` ENUM('DPI', 'CURP', 'PASSPORT', 'OTHER') NOT NULL DEFAULT 'DPI';
