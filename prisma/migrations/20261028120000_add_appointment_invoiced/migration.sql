-- AlterTable: control de factura emitida por cita
ALTER TABLE `appointments`
  ADD COLUMN `invoiced` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `invoicedAt` DATETIME(3) NULL;
