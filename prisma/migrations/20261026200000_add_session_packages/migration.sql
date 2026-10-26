-- Paquetes de sesiones: servicios con N consultas incluidas y control de uso

-- AlterTable: consultas incluidas por servicio (1 = cita suelta)
ALTER TABLE `services` ADD COLUMN `sessions` INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE `session_packages` (
    `id` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NOT NULL,
    `serviceId` VARCHAR(191) NOT NULL,
    `paymentId` VARCHAR(191) NULL,
    `totalSessions` INTEGER NOT NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `session_packages_paymentId_key`(`paymentId`),
    INDEX `session_packages_patientId_idx`(`patientId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable: cita ligada a un paquete
ALTER TABLE `appointments` ADD COLUMN `packageId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `appointments_packageId_idx` ON `appointments`(`packageId`);

-- AddForeignKey
ALTER TABLE `session_packages` ADD CONSTRAINT `session_packages_patientId_fkey` FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `session_packages` ADD CONSTRAINT `session_packages_serviceId_fkey` FOREIGN KEY (`serviceId`) REFERENCES `services`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `session_packages` ADD CONSTRAINT `session_packages_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `session_packages`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
