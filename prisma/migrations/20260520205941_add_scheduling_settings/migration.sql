-- CreateTable
CREATE TABLE `scheduling_settings` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'default',
    `allowSameDayBooking` BOOLEAN NOT NULL DEFAULT true,
    `minLeadMinutes` INTEGER NOT NULL DEFAULT 60,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Insertar fila por defecto
INSERT INTO `scheduling_settings` (`id`, `allowSameDayBooking`, `minLeadMinutes`, `updatedAt`)
VALUES ('default', true, 60, CURRENT_TIMESTAMP(3));
