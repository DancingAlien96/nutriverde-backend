-- AlterTable: idioma del panel por usuario admin
ALTER TABLE `admin_users`
  ADD COLUMN `locale` ENUM('EN', 'ES') NOT NULL DEFAULT 'EN';
