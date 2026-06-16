import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { env } from "../config/env.js";

// Asegura que el directorio existe
fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });

const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
]);

const receiptsDir = path.join(env.UPLOAD_DIR, "receipts");
fs.mkdirSync(receiptsDir, { recursive: true });

const receiptStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, receiptsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const id = crypto.randomBytes(10).toString("hex");
    cb(null, `${Date.now()}-${id}${ext}`);
  },
});

export const receiptUpload = multer({
  storage: receiptStorage,
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
    }
  },
});

// ── Imágenes de servicios (públicas) ───────────────────────────────
const IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const servicesImageDir = path.join(env.UPLOAD_DIR, "services");
fs.mkdirSync(servicesImageDir, { recursive: true });

const serviceImageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, servicesImageDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    const id = crypto.randomBytes(10).toString("hex");
    cb(null, `${Date.now()}-${id}${ext}`);
  },
});

export const serviceImageUpload = multer({
  storage: serviceImageStorage,
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Image type not allowed: ${file.mimetype}`));
    }
  },
});

/** Convierte una ruta absoluta del filesystem en URL relativa servida por Express */
export function toPublicUrl(filePath: string): string {
  const absUploadDir = path.resolve(env.UPLOAD_DIR);
  const relative = path.relative(absUploadDir, path.resolve(filePath));
  return `/uploads/${relative.split(path.sep).join("/")}`;
}
