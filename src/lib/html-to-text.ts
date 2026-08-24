/**
 * Deriva una versión en texto plano a partir del HTML de un correo.
 *
 * Un mensaje que solo lleva HTML es una señal clásica de spam: los filtros
 * esperan multipart/alternative, porque el correo legítimo casi siempre
 * incluye ambas partes. Generarlo aquí, y no en cada plantilla, cubre también
 * los correos que se agreguen después.
 */
export function htmlToText(html: string): string {
  return (
    html
      // Bloques que no son contenido visible
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
      // Enlaces: conservamos texto y URL. En texto plano un "haz clic aquí"
      // sin destino deja al lector sin el enlace.
      .replace(
        /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_match, href: string, label: string) => {
          const text = label.replace(/<[^>]+>/g, "").trim();
          return !text || text === href ? href : `${text} (${href})`;
        },
      )
      // Saltos explícitos
      .replace(/<br\s*\/?>/gi, "\n")
      // El <li> de apertura aporta la viñeta y su propio salto; el cierre se
      // descarta sin añadir otro, o cada punto quedaría separado por un hueco.
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/li>/gi, "")
      // Cierres de bloque = fin de párrafo
      .replace(/<\/(p|div|h[1-6]|tr|ul|ol|table)>/gi, "\n")
      // Cualquier etiqueta restante
      .replace(/<[^>]+>/g, "")
      // Entidades nombradas más comunes
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      // Numéricas, decimales y hexadecimales (cubre &#39; y acentos)
      .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) =>
        String.fromCodePoint(parseInt(n, 16)),
      )
      // &amp; al final, para no re-decodificar entidades ya resueltas
      .replace(/&amp;/g, "&")
      // Espacios sobrantes que deja el HTML indentado
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
