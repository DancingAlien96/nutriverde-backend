/**
 * Detecta strings con caracteres mal codificados. Specifically, detecta
 * el carácter Unicode de reemplazo (U+FFFD) que aparece cuando un cliente
 * envía bytes en una codificación que no es UTF-8 (típicamente latin1/CP1252
 * desde un terminal o cliente HTTP mal configurado).
 *
 * Los navegadores web SIEMPRE envían UTF-8 en formularios, así que un usuario
 * final nunca debería ver este error. Pero hay que defender al sistema de
 * clientes mal codificados para no contaminar la base de datos.
 */
export function isUtf8(s: string): boolean {
  return !s.includes("�");
}

/** Mensaje estándar para usar con `.refine(isUtf8, ...)`. */
export function utf8Message(label: string): string {
  return `${label} tiene caracteres mal codificados (no UTF-8).`;
}
