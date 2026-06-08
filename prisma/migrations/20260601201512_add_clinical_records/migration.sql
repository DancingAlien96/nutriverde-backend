-- AlterTable: nuevos datos clínicos en Patient
ALTER TABLE `patients`
  ADD COLUMN `birthDate` DATETIME(3) NULL,
  ADD COLUMN `heightCm` INTEGER NULL,
  ADD COLUMN `allergies` TEXT NULL,
  ADD COLUMN `medicalConditions` TEXT NULL,
  ADD COLUMN `medications` TEXT NULL,
  ADD COLUMN `alcoholNotes` VARCHAR(191) NULL,
  ADD COLUMN `cravingsNotes` VARCHAR(191) NULL,
  ADD COLUMN `waterCoffeeNotes` VARCHAR(191) NULL,
  ADD COLUMN `dislikedFoods` TEXT NULL,
  ADD COLUMN `weekendSpots` TEXT NULL;

-- CreateTable: PatientDiagnosis
CREATE TABLE `patient_diagnoses` (
    `id` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NOT NULL,
    `objective` TEXT NULL,
    `goalFatPercent` DOUBLE NULL,
    `goalFatLossLbs` DOUBLE NULL,
    `goalLeanMassKg` DOUBLE NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `patient_diagnoses_patientId_idx`(`patientId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: PatientTraining
CREATE TABLE `patient_trainings` (
    `id` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NOT NULL,
    `duration` VARCHAR(191) NULL,
    `frequency` VARCHAR(191) NULL,
    `schedule` TEXT NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `patient_trainings_patientId_idx`(`patientId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: AnthropometricMeasurement
CREATE TABLE `anthropometric_measurements` (
    `id` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NULL,
    `measuredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `visitNumber` INTEGER NULL,
    `weightKg` DOUBLE NULL,
    `fatPercent` DOUBLE NULL,
    `waterPercent` DOUBLE NULL,
    `leanMassKg` DOUBLE NULL,
    `metabolicAge` INTEGER NULL,
    `visceralFat` INTEGER NULL,
    `caliperFatPercent` DOUBLE NULL,
    `chestCm` DOUBLE NULL,
    `waistCm` DOUBLE NULL,
    `abdomenCm` DOUBLE NULL,
    `hipCm` DOUBLE NULL,
    `armCm` DOUBLE NULL,
    `thighCm` DOUBLE NULL,
    `calfCm` DOUBLE NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `anthropometric_measurements_patientId_idx`(`patientId`),
    INDEX `anthropometric_measurements_measuredAt_idx`(`measuredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: MealPlan
CREATE TABLE `meal_plans` (
    `id` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NULL,
    `breakfast` TEXT NULL,
    `morningSnack` TEXT NULL,
    `lunch` TEXT NULL,
    `afternoonSnack` TEXT NULL,
    `dinner` TEXT NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `meal_plans_patientId_idx`(`patientId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `patient_diagnoses` ADD CONSTRAINT `patient_diagnoses_patientId_fkey`
  FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `patient_trainings` ADD CONSTRAINT `patient_trainings_patientId_fkey`
  FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `anthropometric_measurements` ADD CONSTRAINT `anthropometric_measurements_patientId_fkey`
  FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `meal_plans` ADD CONSTRAINT `meal_plans_patientId_fkey`
  FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
