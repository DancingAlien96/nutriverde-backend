-- AlterTable: agregar SECRETARY al enum de roles del panel admin
ALTER TABLE `admin_users`
  MODIFY `role` ENUM('NUTRITIONIST', 'STAFF', 'SECRETARY') NOT NULL DEFAULT 'NUTRITIONIST';
