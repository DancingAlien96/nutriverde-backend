# NutriVerde Backend

API backend para el sistema de consultas nutricionales online de NutriVerde.

**Stack:** Node.js + Express + TypeScript + Prisma + MySQL + Nodemailer.

---

## Requisitos previos

- Node.js 20+
- Docker Desktop (incluye Docker Compose) — para MySQL
- Una cuenta Gmail con [App Password](https://myaccount.google.com/apppasswords) (si quieres probar envío de correos)

---

## Setup inicial

```powershell
# 1. Instalar dependencias
npm install

# 2. Copiar variables de entorno
Copy-Item .env.example .env
# (los valores por defecto funcionan para desarrollo local con Docker)

# 3. Levantar MySQL + Adminer con Docker
docker compose up -d
# Espera ~10s la primera vez mientras MySQL inicializa la DB

# 4. Generar cliente Prisma y correr migración inicial
npm run prisma:migrate -- --name init

# 5. Levantar el servidor en modo desarrollo
npm run dev
```

**URLs locales:**

- API: `http://localhost:4001`
- Health: `http://localhost:4001/api/health`
- Adminer: `http://localhost:8080` (usuario: `nutriverde`, password: `nutriverde_dev`, server: `mysql`)

---

## Docker — comandos útiles

```powershell
# Ver estado de los contenedores
docker compose ps

# Ver logs en vivo
docker compose logs -f mysql

# Apagar (mantiene los datos)
docker compose down

# Apagar Y borrar los datos (¡destructivo!)
docker compose down -v

# Reiniciar solo MySQL
docker compose restart mysql
```

Los datos persisten en el volumen `nutriverde_mysql_data` aunque apagues los contenedores.

---

## Scripts disponibles

| Script | Descripción |
| --- | --- |
| `npm run dev` | Servidor con hot-reload (tsx watch) |
| `npm run build` | Compilar TypeScript a `dist/` |
| `npm start` | Ejecutar build en producción |
| `npm run prisma:generate` | Regenerar cliente Prisma |
| `npm run prisma:migrate` | Crear nueva migración en desarrollo |
| `npm run prisma:deploy` | Aplicar migraciones en producción |
| `npm run prisma:studio` | Abrir Prisma Studio (UI visual de la DB) |
| `npm run lint` | Type-check sin emitir archivos |

---

## Estructura

```text
src/
├── app.ts                 # Configuración de Express (middlewares, rutas)
├── server.ts              # Punto de entrada (listen + shutdown)
├── config/
│   └── env.ts             # Validación de variables de entorno (zod)
├── lib/
│   ├── prisma.ts          # Cliente Prisma singleton
│   └── mailer.ts          # Nodemailer + logging de envíos
├── middlewares/
│   └── error-handler.ts   # 404 + error handler global
└── routes/
    ├── index.ts           # Router raíz (/api/*)
    └── health.ts          # GET /api/health (db check)

prisma/
└── schema.prisma          # Modelo de datos
```

---

## Modelo de datos (resumen)

- **AdminUser** — la nutricionista (y posible staff)
- **Patient** — pacientes referidos
- **Service** — Consulta Inicial (Q350), Seguimiento (Q250), Plan Premium (Q550)
- **IntakeForm** — formulario inicial con objetivos/historial
- **Payment** — comprobante subido manualmente, aprobación manual
- **Appointment** — cita con link de Google Meet/Zoom
- **AvailabilitySlot** / **AvailabilityBlock** — disponibilidad de la nutricionista
- **NutritionPlan** — PDF del plan enviado tras la consulta
- **EmailLog** — auditoría de correos enviados

---

## Próximos pasos (fases)

1. **Fase 1 — Landing pública** (en `nutriverde-frontend/`) — sin backend todavía
2. **Fase 2 — Flujo del paciente** — endpoints `/api/intake`, `/api/payments`
3. **Fase 3 — Agenda y citas** — `/api/appointments`, integración Google Meet
4. **Fase 4 — Panel admin** — auth JWT, `/api/admin/*`
5. **Fase 5 — Automatizaciones** — recordatorios, tips mensuales

---

## Deploy en producción (Raspberry Pi / VPS)

Para producción usamos un compose distinto que también corre el backend en Docker:

```bash
# En el servidor — primera vez
git clone https://github.com/DancingAlien96/nutriverde-backend.git
cd nutriverde-backend
cp .env.example .env
# Edita .env con credenciales reales, SMTP, JWT_SECRET fuerte, etc.

# Levanta todo (mysql + backend). La migración se aplica automáticamente.
docker compose -f docker-compose.prod.yml up -d --build

# Primera vez: seed inicial (3 servicios + admin)
docker compose -f docker-compose.prod.yml exec backend npx prisma db seed
```

```bash
# Updates
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

```bash
# Logs y mantenimiento
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml exec mysql mysql -u root -p
```

En prod **MySQL no se expone al host** — solo el backend en `${BACKEND_PORT:-4001}`.

---

## Notas

- El servidor sirve `/uploads/*` estáticamente. En producción esto debe protegerse o moverse a un bucket (S3, R2).
- Si `SMTP_USER`/`SMTP_PASS` no están definidos, los correos se "enviarán" a consola (jsonTransport) — útil para desarrollo.
- Los precios se guardan en **centavos** (`priceCents`) para evitar problemas de coma flotante.
