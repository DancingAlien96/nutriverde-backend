-- Factura: de booleano a tres estados (pendiente / emitida / no solicitada).
-- Conserva lo ya marcado: invoiced = true pasa a ISSUED.
ALTER TABLE `appointments`
  ADD COLUMN `invoiceStatus` ENUM('PENDING', 'ISSUED', 'NOT_REQUESTED') NOT NULL DEFAULT 'PENDING';

UPDATE `appointments` SET `invoiceStatus` = 'ISSUED' WHERE `invoiced` = true;

ALTER TABLE `appointments` DROP COLUMN `invoiced`;
