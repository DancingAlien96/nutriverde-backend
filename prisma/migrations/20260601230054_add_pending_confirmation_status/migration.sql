-- AlterTable: agregar PENDING_CONFIRMATION al enum de estados de cita
ALTER TABLE `appointments`
  MODIFY `status` ENUM(
    'AWAITING_PAYMENT',
    'PAYMENT_APPROVED',
    'PENDING_CONFIRMATION',
    'SCHEDULED',
    'COMPLETED',
    'CANCELED',
    'NO_SHOW'
  ) NOT NULL DEFAULT 'AWAITING_PAYMENT';
