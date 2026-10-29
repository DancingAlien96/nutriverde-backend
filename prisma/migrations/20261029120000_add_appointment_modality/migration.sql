-- AlterTable: modalidad de la cita (virtual con enlace / presencial)
ALTER TABLE `appointments`
  ADD COLUMN `modality` ENUM('VIRTUAL', 'IN_PERSON') NOT NULL DEFAULT 'VIRTUAL';
