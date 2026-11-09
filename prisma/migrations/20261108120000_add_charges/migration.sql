-- Cobros del panel: precio acordado por cita suelta o paquete, y sus abonos

-- CreateTable
CREATE TABLE `charges` (
    `id` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NOT NULL,
    `serviceId` VARCHAR(191) NOT NULL,
    `packageId` VARCHAR(191) NULL,
    `appointmentId` VARCHAR(191) NULL,
    `priceCents` INTEGER NOT NULL,
    `listPriceCents` INTEGER NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'GTQ',
    `plan` ENUM('FULL', 'INSTALLMENTS') NOT NULL DEFAULT 'FULL',
    `notes` TEXT NULL,
    `createdByEmail` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `charges_packageId_key`(`packageId`),
    UNIQUE INDEX `charges_appointmentId_key`(`appointmentId`),
    INDEX `charges_patientId_idx`(`patientId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `charge_payments` (
    `id` VARCHAR(191) NOT NULL,
    `chargeId` VARCHAR(191) NOT NULL,
    `amountCents` INTEGER NOT NULL,
    `method` ENUM('CASH', 'TRANSFER', 'CARD', 'OTHER') NOT NULL DEFAULT 'CASH',
    `paidAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `note` VARCHAR(300) NULL,
    `recordedByEmail` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `charge_payments_chargeId_idx`(`chargeId`),
    INDEX `charge_payments_paidAt_idx`(`paidAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `charges` ADD CONSTRAINT `charges_patientId_fkey` FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `charges` ADD CONSTRAINT `charges_serviceId_fkey` FOREIGN KEY (`serviceId`) REFERENCES `services`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `charges` ADD CONSTRAINT `charges_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `session_packages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `charges` ADD CONSTRAINT `charges_appointmentId_fkey` FOREIGN KEY (`appointmentId`) REFERENCES `appointments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `charge_payments` ADD CONSTRAINT `charge_payments_chargeId_fkey` FOREIGN KEY (`chargeId`) REFERENCES `charges`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
