-- Datos: los tres servicios del modelo por paquetes (precios del cliente,
-- octubre 2026). INSERT IGNORE: si el slug ya existe (por ejemplo creado a
-- mano desde el panel) no se toca nada.
INSERT IGNORE INTO `services`
  (`id`, `slug`, `name`, `description`, `priceCents`, `currency`, `durationMin`, `sessions`, `billingType`, `active`, `sortOrder`, `createdAt`, `updatedAt`)
VALUES
  ('svc_cita_individual_2026', 'cita-individual', 'Cita individual',
   'Una consulta nutricional en línea de 60 minutos.',
   40000, 'GTQ', 60, 1, 'ONE_TIME', true, 10, NOW(3), NOW(3)),
  ('svc_programa_4_citas_2026', 'programa-4-citas', 'Programa 4 citas',
   'Programa de acompañamiento con 4 consultas en línea. Se paga una sola vez y las citas se van agendando.',
   140000, 'GTQ', 60, 4, 'ONE_TIME', true, 11, NOW(3), NOW(3)),
  ('svc_programa_6_citas_2026', 'programa-6-citas', 'Programa 6 citas',
   'Programa de acompañamiento con 6 consultas en línea. Se paga una sola vez y las citas se van agendando.',
   195000, 'GTQ', 60, 6, 'ONE_TIME', true, 12, NOW(3), NOW(3));
