import PDFDocument from "pdfkit";
import type { Writable } from "node:stream";
import type {
  Patient,
  PatientDiagnosis,
  PatientTraining,
  AnthropometricMeasurement,
  MealPlan,
} from "@prisma/client";

export interface ExpedientePdfData {
  patient: Patient;
  diagnoses: PatientDiagnosis[];
  trainings: PatientTraining[];
  measurements: AnthropometricMeasurement[];
  mealPlans: MealPlan[];
}

const BRAND = "#95593a"; // brand-600 terracota
const INK = "#1d1812";   // ink-900
const MUTED = "#6b6052"; // ink-500
const CREAM = "#f5efe4"; // cream-100

/**
 * Genera el PDF del expediente y lo escribe en el stream destino.
 * El layout reproduce la hoja de consulta inicial: datos del paciente,
 * diagnóstico, entrenamiento, tabla de mediciones por visita y plan
 * alimentario.
 */
export function buildExpedientePdf(data: ExpedientePdfData, dest: Writable): void {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    info: {
      Title: `Expediente — ${data.patient.fullName}`,
      Author: "Plenha Nutrition",
    },
  });

  doc.pipe(dest);

  drawHeader(doc, data.patient);
  drawClinicalInfo(doc, data.patient);
  drawDiagnosis(doc, data.diagnoses[0]);
  drawTraining(doc, data.trainings[0]);
  drawMeasurementsTable(doc, data.measurements);
  drawMealPlan(doc, data.mealPlans[0]);

  doc.end();
}

// ============================================================
// Secciones
// ============================================================

function drawHeader(doc: PDFKit.PDFDocument, p: Patient): void {
  doc
    .fillColor(BRAND)
    .fontSize(10)
    .font("Helvetica-Bold")
    .text("PLENHA NUTRITION", { continued: true })
    .fillColor(MUTED)
    .font("Helvetica")
    .text("  ·  Expediente nutricional");

  doc.moveDown(0.5);

  doc
    .fillColor(INK)
    .fontSize(20)
    .font("Helvetica-Bold")
    .text(p.fullName);

  doc.moveDown(0.5);

  const lines: [string, string][] = [
    [documentTypeLabel(p.documentType), p.documentId ?? "—"],
    ["Correo", p.email],
    ["Teléfono", p.phone ?? "—"],
    ["Fecha nac.", fmtDate(p.birthDate)],
    ["Edad", ageFrom(p.birthDate)],
    [
      "Estatura",
      p.heightCm != null ? `${(p.heightCm / 100).toFixed(2)} m` : "—",
    ],
  ];

  doc.fontSize(9).font("Helvetica");
  twoColumnList(doc, lines);

  doc.moveDown(1);
  hr(doc);
}

function drawClinicalInfo(doc: PDFKit.PDFDocument, p: Patient): void {
  sectionTitle(doc, "Datos clínicos");

  const items: [string, string | null][] = [
    ["Alergias", p.allergies],
    ["Enfermedades", p.medicalConditions],
    ["Medicamentos / suplementos", p.medications],
    ["Alcohol", p.alcoholNotes],
    ["Antojos cosas dulces", p.cravingsNotes],
    ["Agua pura / café", p.waterCoffeeNotes],
    ["Alimentos que no le gustan", p.dislikedFoods],
    ["Lugares que frecuenta fin de semana", p.weekendSpots],
  ];

  doc.fontSize(9);
  for (const [label, value] of items) {
    if (!value) continue;
    doc
      .fillColor(MUTED)
      .font("Helvetica-Bold")
      .text(`${label}: `, { continued: true })
      .fillColor(INK)
      .font("Helvetica")
      .text(value);
  }
  doc.moveDown(0.5);
  hr(doc);
}

function drawDiagnosis(
  doc: PDFKit.PDFDocument,
  d: PatientDiagnosis | undefined,
): void {
  sectionTitle(doc, "Diagnóstico y metas");
  if (!d) {
    doc.fontSize(9).fillColor(MUTED).font("Helvetica-Oblique").text("Sin registro.");
    doc.moveDown(0.5);
    hr(doc);
    return;
  }

  if (d.objective) {
    doc
      .fontSize(9)
      .fillColor(MUTED)
      .font("Helvetica-Bold")
      .text("Objetivo: ", { continued: true })
      .fillColor(INK)
      .font("Helvetica")
      .text(d.objective);
    doc.moveDown(0.3);
  }

  const goals: [string, string][] = [];
  if (d.goalFatPercent != null) goals.push(["Meta % grasa", `${d.goalFatPercent}%`]);
  if (d.goalFatLossLbs != null) goals.push(["Meta lbs grasa", `${d.goalFatLossLbs} lb`]);
  if (d.goalLeanMassKg != null) goals.push(["Meta masa magra", `${d.goalLeanMassKg} kg`]);
  if (goals.length) twoColumnList(doc, goals);

  if (d.notes) {
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor(MUTED).text(d.notes);
  }

  doc.moveDown(0.5);
  hr(doc);
}

function drawTraining(
  doc: PDFKit.PDFDocument,
  t: PatientTraining | undefined,
): void {
  sectionTitle(doc, "Entrenamiento");
  if (!t) {
    doc.fontSize(9).fillColor(MUTED).font("Helvetica-Oblique").text("Sin registro.");
    doc.moveDown(0.5);
    hr(doc);
    return;
  }

  const items: [string, string | null][] = [
    ["Duración", t.duration],
    ["Frecuencia", t.frequency],
    ["Horario", t.schedule],
    ["Notas", t.notes],
  ];

  doc.fontSize(9);
  for (const [label, value] of items) {
    if (!value) continue;
    doc
      .fillColor(MUTED)
      .font("Helvetica-Bold")
      .text(`${label}: `, { continued: true })
      .fillColor(INK)
      .font("Helvetica")
      .text(value);
  }
  doc.moveDown(0.5);
  hr(doc);
}

function drawMeasurementsTable(
  doc: PDFKit.PDFDocument,
  measurements: AnthropometricMeasurement[],
): void {
  sectionTitle(doc, "Mediciones por visita");
  if (measurements.length === 0) {
    doc.fontSize(9).fillColor(MUTED).font("Helvetica-Oblique").text("Sin mediciones.");
    doc.moveDown(0.5);
    hr(doc);
    return;
  }

  // Ordenamos por fecha ascendente para que las visitas crezcan a la derecha
  const sorted = [...measurements].sort(
    (a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime(),
  );

  // Limitamos a 8 columnas por página para que quepan
  const visitChunks: AnthropometricMeasurement[][] = [];
  for (let i = 0; i < sorted.length; i += 8) {
    visitChunks.push(sorted.slice(i, i + 8));
  }

  const rows: { key: keyof AnthropometricMeasurement; label: string }[] = [
    { key: "weightKg", label: "Peso (kg)" },
    { key: "fatPercent", label: "% grasa" },
    { key: "waterPercent", label: "% agua" },
    { key: "leanMassKg", label: "Masa magra (kg)" },
    { key: "metabolicAge", label: "Edad metabólica" },
    { key: "visceralFat", label: "Grasa visceral" },
    { key: "caliperFatPercent", label: "% grasa cáliper" },
    { key: "chestCm", label: "Pecho (cm)" },
    { key: "waistCm", label: "Cintura (cm)" },
    { key: "abdomenCm", label: "Abdomen (cm)" },
    { key: "hipCm", label: "Cadera (cm)" },
    { key: "armCm", label: "Brazo (cm)" },
    { key: "thighCm", label: "Muslo (cm)" },
    { key: "calfCm", label: "Pantorrilla (cm)" },
  ];

  for (let i = 0; i < visitChunks.length; i++) {
    if (i > 0) {
      doc.addPage();
      sectionTitle(doc, `Mediciones (continuación)`);
    }
    drawMeasurementChunk(doc, rows, visitChunks[i]);
  }

  doc.moveDown(0.5);
  hr(doc);
}

function drawMeasurementChunk(
  doc: PDFKit.PDFDocument,
  rows: { key: keyof AnthropometricMeasurement; label: string }[],
  visits: AnthropometricMeasurement[],
): void {
  const startX = 50;
  const tableWidth = 512;
  const labelColWidth = 110;
  const valueColWidth = (tableWidth - labelColWidth) / visits.length;
  let y = doc.y;

  // Asegurar espacio. Si no, salto de página.
  const rowHeight = 16;
  const needed = (rows.length + 2) * rowHeight;
  if (y + needed > 720) {
    doc.addPage();
    y = doc.y;
  }

  // Header
  doc.fillColor(CREAM).rect(startX, y, tableWidth, rowHeight).fill();
  doc.fillColor(MUTED).fontSize(8).font("Helvetica-Bold");
  doc.text("Medida", startX + 4, y + 4, { width: labelColWidth - 8 });

  visits.forEach((v, i) => {
    const x = startX + labelColWidth + i * valueColWidth;
    const visitLabel = v.visitNumber ? `#${v.visitNumber}` : `V${i + 1}`;
    const dateLabel = new Date(v.measuredAt).toLocaleDateString("es-GT", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
    });
    doc.text(visitLabel, x, y + 2, { width: valueColWidth, align: "center" });
    doc.font("Helvetica");
    doc.fontSize(7).text(dateLabel, x, y + 9, {
      width: valueColWidth,
      align: "center",
    });
    doc.fontSize(8).font("Helvetica-Bold");
  });

  y += rowHeight;

  // Filas
  doc.font("Helvetica").fontSize(8);
  rows.forEach((row, ri) => {
    if (ri % 2 === 1) {
      doc.fillColor(CREAM).rect(startX, y, tableWidth, rowHeight).fill();
    }
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
    doc.text(row.label, startX + 4, y + 4, { width: labelColWidth - 8 });
    doc.fillColor(INK).font("Helvetica");
    visits.forEach((v, vi) => {
      const x = startX + labelColWidth + vi * valueColWidth;
      const value = v[row.key];
      const display = value == null || value === "" ? "—" : String(value);
      doc.text(display, x, y + 4, {
        width: valueColWidth,
        align: "center",
      });
    });
    y += rowHeight;
  });

  doc.y = y + 6;
}

function drawMealPlan(
  doc: PDFKit.PDFDocument,
  mp: MealPlan | undefined,
): void {
  // Salto de página si queda muy poco espacio
  if (doc.y > 600) doc.addPage();

  sectionTitle(doc, "Plan alimentario");
  if (!mp) {
    doc.fontSize(9).fillColor(MUTED).font("Helvetica-Oblique").text("Sin registro.");
    return;
  }

  if (mp.title) {
    doc
      .fontSize(10)
      .fillColor(INK)
      .font("Helvetica-Bold")
      .text(mp.title);
    doc.moveDown(0.3);
  }

  const meals: [string, string | null][] = [
    ["Desayuno", mp.breakfast],
    ["Refacción matutina", mp.morningSnack],
    ["Almuerzo", mp.lunch],
    ["Refacción vespertina", mp.afternoonSnack],
    ["Cena", mp.dinner],
  ];

  doc.fontSize(9);
  for (const [name, content] of meals) {
    if (!content) continue;
    if (doc.y > 720) doc.addPage();
    doc
      .fillColor(BRAND)
      .font("Helvetica-Bold")
      .text(name.toUpperCase());
    doc
      .fillColor(INK)
      .font("Helvetica")
      .text(content);
    doc.moveDown(0.5);
  }

  if (mp.notes) {
    doc.moveDown(0.3);
    doc
      .fillColor(MUTED)
      .font("Helvetica-Oblique")
      .fontSize(8)
      .text(mp.notes);
  }
}

// ============================================================
// Helpers visuales
// ============================================================

function sectionTitle(doc: PDFKit.PDFDocument, label: string): void {
  if (doc.y > 730) doc.addPage();
  doc
    .fillColor(BRAND)
    .fontSize(11)
    .font("Helvetica-Bold")
    .text(label.toUpperCase());
  doc.moveDown(0.3);
}

function hr(doc: PDFKit.PDFDocument): void {
  const y = doc.y;
  doc
    .strokeColor(CREAM)
    .lineWidth(0.5)
    .moveTo(50, y)
    .lineTo(562, y)
    .stroke();
  doc.moveDown(0.5);
}

function twoColumnList(
  doc: PDFKit.PDFDocument,
  pairs: [string, string][],
): void {
  const colWidth = 256;
  const startY = doc.y;
  let leftY = startY;
  let rightY = startY;

  pairs.forEach((pair, i) => {
    const isLeft = i % 2 === 0;
    const x = isLeft ? 50 : 306;
    const y = isLeft ? leftY : rightY;
    doc
      .fontSize(8)
      .fillColor(MUTED)
      .font("Helvetica-Bold")
      .text(pair[0], x, y, { continued: true, width: colWidth })
      .fillColor(INK)
      .font("Helvetica")
      .text(`  ${pair[1]}`);
    if (isLeft) leftY = doc.y;
    else rightY = doc.y;
  });

  doc.y = Math.max(leftY, rightY);
  doc.moveDown(0.3);
}

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("es-GT", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function documentTypeLabel(type: string): string {
  switch (type) {
    case "DPI":
      return "DPI";
    case "CURP":
      return "CURP";
    case "PASSPORT":
      return "Pasaporte";
    case "OTHER":
      return "Documento";
    default:
      return "Documento";
  }
}

function ageFrom(birthDate: Date | null): string {
  if (!birthDate) return "—";
  const b = new Date(birthDate);
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return `${age} años`;
}
