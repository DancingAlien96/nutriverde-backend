-- AlterTable: servicios internos (no públicos), p. ej. paquetes para empresas
ALTER TABLE `services` ADD COLUMN `internal` BOOLEAN NOT NULL DEFAULT false;
