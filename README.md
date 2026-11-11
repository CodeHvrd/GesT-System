# GesT System

Sistema integral de gestión gastronómica desarrollado en **Next.js 15 (App Router)**, **React 19**, **TypeScript**, **Tailwind CSS** y **shadcn/ui**.

Unifica en una única plataforma la operación del portal ejecutivo (PostgreSQL / Neon) y el panel operativo (SQLite / Google Sheets / Fudo API).

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/CodeHvrd/GesT-System)

---

## Características Principales

- **Next.js 15 + React 19 + shadcn/ui**: Interfaz moderna, rápida y responsiva con soporte de tema claro/oscuro.
- **Doble motor de datos unificado**: Funciona tanto con PostgreSQL en la nube (**Neon**) como localmente con **SQLite** (`node:sqlite`).
- **Sincronización Fudo API**: Ingesta de ventas cerradas, canales (salón, takeaway, delivery), medios de pago, catálogo de productos con costeo de recetas e ingredientes.
- **Cruce y Auditoría con Planilla Contable (Google Sheets)**:
  - Lectura e interpretación de hojas mensuales (`"NOVIEMBRE 26"`, `"DICIEMBRE 26"`, etc.).
  - Cruce bidireccional entre compras de Fudo y `"Proveedores Varios"`.
  - Carga automática de gastos operativos y fijos como Gastos Externos.
  - Enlaces directos a las celdas de la planilla para discrepancias pendientes.
- **Sincronización programada automática**: Horarios argentinos (`02:00 hs` cierre nocturno y `16:00 hs` corte de tarde) y botones directos de actualización.

---

## Arquitectura del Proyecto

```text
src/
├── app/                        # Next.js App Router (Páginas y API Route Handlers)
│   ├── api/                    # API dividida por dominio
│   │   ├── dashboard/          # Resúmenes, KPIs, ventas, gastos y revisión
│   │   ├── sync/               # Sincronización Fudo + Google Sheets + Contable
│   │   ├── reconcile/          # Auditoría y resolución Fudo vs Contable
│   │   ├── config/             # Configuración persistente (Postgres + SQLite)
│   │   ├── fudo/               # Test, preview e importación de Fudo
│   │   └── ...                 # Demás endpoints operativos
│   ├── layout.tsx              # Root Server Layout (es-AR, metadatos)
│   └── page.tsx                # Dashboard y panel principal
├── components/
│   ├── ui/                     # Componentes base shadcn/ui (Button, Card, Table, Badge, Input)
│   ├── layout/                 # HeaderBar, AppSidebar, PeriodFilterBar
│   ├── dashboard/              # Secciones analíticas (Dashboard, Ventas, Ganancias, Gastos, Notificaciones)
│   └── admin/                  # Secciones operativas (Semanal, Mensual, Carga, Configuración)
└── lib/
    ├── config.ts               # Configuración persistente y metas de CMV
    ├── dates.ts                # Semanas del local (S1..S5) y huso horario ART (UTC-3)
    ├── format.ts               # Formato numérico, monetario y porcentual es-AR
    ├── scheduler.ts            # Sincronización programada (02:00 y 16:00 hs ARG)
    ├── db/                     # Adaptadores para PostgreSQL (Neon) y SQLite (local)
    ├── fudo/                   # Cliente HTTP e ingesta de ventas/gastos Fudo
    ├── sheets/                 # Lector de planillas y motor contable
    └── analytics/              # Motores analíticos de portal y panel
```

---

## Puesta en Marcha Local

1. Instalar dependencias:
   ```bash
   npm install
   ```
2. Ejecutar suite de pruebas:
   ```bash
   npm test
   ```
3. Iniciar servidor de desarrollo:
   ```bash
   npm run dev
   # http://localhost:8788
   ```

---

## Despliegue en Render

El servicio se despliega automáticamente en Render utilizando el `Dockerfile` optimizado para Next.js 15.

### Variables de entorno en Render:
- `DATABASE_URL`: Cadena de conexión a Neon PostgreSQL.
- `FUDO_API_KEY`: API Key de Fudo (opcional, configurable desde la UI).
- `FUDO_API_SECRET`: API Secret de Fudo (opcional, configurable desde la UI).
- `PORTAL_USER` / `PORTAL_PASS`: Credenciales de acceso (opcional, Basic Auth).
