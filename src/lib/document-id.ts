import { z } from "zod";

export const DOCUMENT_TYPES = ["DPI", "CURP", "PASSPORT", "OTHER"] as const;
export type DocumentTypeValue = (typeof DOCUMENT_TYPES)[number];

/**
 * Normaliza el documento quitando espacios y guiones, pone mayúsculas para
 * tipos alfanuméricos (CURP, pasaporte) y deja solo dígitos en DPI.
 */
export function normalizeDocument(
  raw: string,
  type: DocumentTypeValue,
): string {
  const stripped = raw.replace(/[\s-]/g, "");
  if (type === "DPI") return stripped;
  return stripped.toUpperCase();
}

/** Valida un par (tipo, número) según el tipo. */
export function validateDocument(
  type: DocumentTypeValue,
  id: string,
): { ok: true } | { ok: false; message: string } {
  if (type === "DPI") {
    if (!/^\d{13}$/.test(id)) {
      return { ok: false, message: "El DPI debe tener 13 dígitos." };
    }
  } else if (type === "CURP") {
    if (!/^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/.test(id)) {
      return {
        ok: false,
        message: "CURP inválido (18 caracteres con formato mexicano).",
      };
    }
  } else if (type === "PASSPORT") {
    if (!/^[A-Z0-9]{5,15}$/.test(id)) {
      return {
        ok: false,
        message: "El pasaporte debe tener entre 5 y 15 caracteres alfanuméricos.",
      };
    }
  } else {
    // OTHER — solo verificamos longitud razonable
    if (id.length < 3 || id.length > 30) {
      return { ok: false, message: "El documento debe tener entre 3 y 30 caracteres." };
    }
  }
  return { ok: true };
}

/** Schema Zod reutilizable: acepta { documentType, documentId } y los normaliza. */
export const documentSchema = z
  .object({
    documentType: z.enum(DOCUMENT_TYPES).default("DPI"),
    documentId: z.string().trim().min(1, "Documento requerido"),
  })
  .transform((d) => ({
    documentType: d.documentType,
    documentId: normalizeDocument(d.documentId, d.documentType),
  }))
  .superRefine((d, ctx) => {
    const result = validateDocument(d.documentType, d.documentId);
    if (!result.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["documentId"],
        message: result.message,
      });
    }
  });
