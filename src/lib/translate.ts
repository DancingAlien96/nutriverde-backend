/**
 * Traducción automática EN/ES vía MyMemory (gratis, sin API key).
 * Se usa al guardar un servicio para generar el overlay bilingüe.
 */

export type Lang = "en" | "es";

const ES_WORDS = new Set([
  "de", "la", "el", "los", "las", "una", "un", "para", "con", "tu", "que",
  "por", "más", "y", "en", "salud", "hábitos", "nutrición", "alimentación",
  "objetivos", "cambios", "seguimiento", "consulta", "evaluación", "tus",
  "estilo", "vida", "personalizada",
]);
const EN_WORDS = new Set([
  "the", "your", "and", "for", "with", "you", "of", "health", "habits",
  "nutrition", "goals", "changes", "assessment", "follow", "sports",
  "coaching", "lifestyle", "personalized", "review", "consultation",
]);

/** Heurística simple para detectar el idioma del texto fuente. */
export function detectLang(text: string): Lang {
  const t = text.toLowerCase();
  if (/[áéíóúñ¿¡]/.test(t)) return "es";
  let es = 0;
  let en = 0;
  for (const w of t.split(/\W+/)) {
    if (ES_WORDS.has(w)) es++;
    if (EN_WORDS.has(w)) en++;
  }
  // Empate o sin señales → asumimos español (idioma de la nutricionista).
  return en > es ? "en" : "es";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function mymemory(text: string, from: Lang, to: Lang): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(
    trimmed,
  )}&langpair=${from}|${to}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      responseData?: { translatedText?: string };
      responseStatus?: number;
    };
    const tr = data.responseData?.translatedText;
    if (!tr || data.responseStatus !== 200) return null;
    return decodeEntities(tr).trim();
  } catch {
    return null; // si la traducción falla, no bloqueamos el guardado
  }
}

export interface Bilingual {
  en: string;
  es: string;
}

/**
 * Dado un texto en idioma desconocido, devuelve ambas versiones.
 * Si la traducción falla, usa el texto original en ambos lados.
 */
export async function toBilingual(text: string): Promise<Bilingual> {
  const src = detectLang(text);
  const dst: Lang = src === "en" ? "es" : "en";
  const translated = await mymemory(text, src, dst);
  const out: Bilingual = { en: "", es: "" };
  out[src] = text;
  out[dst] = translated ?? text;
  return out;
}
