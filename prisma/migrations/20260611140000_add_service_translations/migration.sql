-- AlterTable: traducciones auto-generadas de servicios (overlay EN/ES)
ALTER TABLE `services`
  ADD COLUMN `nameEn` VARCHAR(191) NULL,
  ADD COLUMN `nameEs` VARCHAR(191) NULL,
  ADD COLUMN `descriptionEn` TEXT NULL,
  ADD COLUMN `descriptionEs` TEXT NULL;
