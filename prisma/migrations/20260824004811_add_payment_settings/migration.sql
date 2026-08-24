-- CreateTable
CREATE TABLE `payment_settings` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'default',
    `bankName` VARCHAR(191) NOT NULL DEFAULT '',
    `accountType` VARCHAR(191) NOT NULL DEFAULT '',
    `accountNumber` VARCHAR(191) NOT NULL DEFAULT '',
    `accountHolder` VARCHAR(191) NOT NULL DEFAULT '',
    `instructions` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
