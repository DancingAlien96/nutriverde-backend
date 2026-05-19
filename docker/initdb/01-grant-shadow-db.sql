-- Permite que el usuario `nutriverde` cree la shadow database
-- que Prisma necesita para validar migraciones en desarrollo.
-- En producción se recomienda usar una `shadowDatabaseUrl` separada con
-- credenciales más restringidas.
GRANT ALL PRIVILEGES ON *.* TO 'nutriverde'@'%';
FLUSH PRIVILEGES;
