# GesT System — Agent & Developer Guidelines (`AGENTS.md`)

Sistema de gestión gastronómica integral en **Next.js 15 (App Router)**, **React 19**, **TypeScript**, **Tailwind CSS** y **shadcn/ui**. Unifica la operación del portal ejecutivo (PostgreSQL / Neon) y el panel operativo local (SQLite / Google Sheets / Fudo API).

---

## 1. Arquitectura del Proyecto

```text
src/
├── app/                        # Next.js App Router (Rutas y API Route Handlers)
│   ├── api/                    # API dividida por dominio (100% paridad funcional)
│   │   ├── health/             # GET /api/health
│   │   ├── healthz/            # GET /api/healthz
│   │   ├── readyz/             # GET /api/readyz
│   │   ├── meta/               # GET /api/meta
│   │   ├── version/            # GET /api/version
│   │   ├── update/             # POST /api/update
│   │   ├── dashboard/          # GET /api/dashboard (+ subrutas /summary, /sales, /expenses, /review)
│   │   ├── external/           # GET, POST, DELETE /api/external (Gastos fijos y excepcionales)
│   │   ├── reconcile/          # GET, POST, PATCH /api/reconcile (Auditoría Contable vs Fudo y resolución en Neon)
│   │   ├── overview/           # GET /api/overview (Resumen operativo local/semanal/mensual)
│   │   ├── week/               # GET /api/week
│   │   ├── month/              # GET /api/month
│   │   ├── expenses/           # GET /api/expenses (Listado paginado y filtrado)
│   │   ├── suggest/            # GET /api/suggest (Autocompletado inteligente de proveedores/rubros)
│   │   ├── entries/            # GET, POST /api/entries (+ /push y /discard)
│   │   ├── paste/week/         # GET /api/paste/week (TSV para Historico_Semanal)
│   │   ├── alerts/             # GET /api/alerts (12 reglas de auditoría operativa)
│   │   ├── quality/            # GET /api/quality (Detector de anomalías de datos)
│   │   ├── config/             # GET, POST /api/config (Configuración persistente)
│   │   ├── sheets/test/        # GET /api/sheets/test
│   │   ├── sync/               # POST /api/sync (Sincronización Fudo + Google Sheets + Contable)
│   │   ├── fudo/               # /test, /preview, /sales/preview, /sales/import, /sales/clear
│   │   └── export/             # /week.csv, /month.csv, /expenses.csv
│   ├── globals.css             # Tokens CSS de shadcn/ui y estilos base Tailwind
│   ├── layout.tsx              # Root Server Layout (tipografía, metadatos, idioma es-AR)
│   └── page.tsx                # Punto de entrada principal del Portal y Panel
├── components/
│   ├── ui/                     # Componentes base de shadcn/ui (Button, Card, Table, Badge, Input, etc.)
│   ├── layout/                 # HeaderBar (icon-only Fudo sync & version), AppSidebar, PeriodFilterBar
│   ├── dashboard/              # Secciones del Portal (DashboardSection, VentasSection, GananciasSection, GastosSection, NotificacionesSection)
│   └── admin/                  # Secciones Operativas (SemanalSection, MensualSection, CargaGastosSection, DatosSection, EnlacesConfigSection)
└── lib/
    ├── utils.ts                # Helper `cn()` de shadcn/ui + re-exports de formato y fechas
    ├── format.ts               # Parseo y formateo numérico/monetario/porcentual (es-AR)
    ├── dates.ts                # Manejo de semanas del local (S1..S5), meses, rangos y zona horaria ART (UTC-3)
    ├── config.ts               # Lectura/escritura de config.json, objetivos de CMV y URLs de Google Sheets
    ├── version.ts              # Detección de versión Git y verificación remota contra GitHub API
    ├── scheduler.ts            # Programación automática de Fudo a las 02:00 hs ARG y 16:00 hs ARG
    ├── db/
    │   ├── local-db.ts         # Adaptador SQLite (node:sqlite) con esquema, migraciones y helpers
    │   └── pg-db.ts            # Adaptador PostgreSQL (pg / Neon) con soporte de esquema canónico
    ├── fudo/
    │   ├── client.ts           # Cliente HTTP para Fudo API (token 24h en memoria, retry 401, paginación JSON:API)
    │   └── sync.ts             # Ingesta de ventas, gastos de insumos, movimientos de caja y recetas
    ├── sheets/
    │   ├── sync.ts             # Lector CSV/API v4 de Planilla Gestión y normalizadores
    │   └── contable.ts         # Intérprete de Planilla Contable ("NOVIEMBRE 26", "DICIEMBRE 26"), cruce "Proveedores Varios" vs Fudo y Caja Principal/Grande
    └── analytics/
        ├── cloud-analytics.ts  # Motor analítico del Portal (canales, medios de pago, ecuación de ganancia, reconciliación, revisión)
        └── local-analytics.ts  # Motor analítico del Panel (semanas, meses, comparaciones, 12 alertas, calidad, sugerencias, CSV)
```

---

## 2. Reglas de Dominio y Negocio (Invariantes Críticas)

1. **Zona Horaria y Localización (`es-AR`)**:
   - Toda operación comercial ocurre en hora de Argentina (`ART = UTC-3`, sin horario de verano).
   - En Fudo API, `closedAt` viene en UTC; el día comercial (`business_date`) se calcula restando 3 horas (`UTC-3`).
   - Los importes se formatean en pesos argentinos (`$1.234.567` o `-$1.234`) y los porcentajes con coma decimal (`32,5%`).
2. **Programación Automática de Sincronización Fudo (02:00 hs ARG y 16:00 hs ARG)**:
   - La sincronización automática de Fudo se ejecuta dos veces por día en horario argentino:
     - **02:00 hs ARG** (`05:00 UTC`) — cierre nocturno consolidado.
     - **16:00 hs ARG** (`19:00 UTC`) — corte de media tarde.
   - En la barra superior (`HeaderBar`), el botón de actualizar Fudo y el botón de versión deben mostrar **únicamente su ícono (logo)** sin texto ni caracteres adicionales (`v`, strings, etc.).
3. **Esquema de Semanas del Local (`YYYY-MM-S1..S5`)**:
   - Las semanas son relativas al mes calendario:
     - `S1`: días 1 al 7
     - `S2`: días 8 al 14
     - `S3`: días 15 al 21
     - `S4`: días 22 al 28
     - `S5`: días 29 hasta fin de mes
4. **Interpretación de la Planilla Contable (`1gNitzY7n44UYr1FP-RFpIPchRT4A1oSh`)**:
   - URL base: `https://docs.google.com/spreadsheets/d/1gNitzY7n44UYr1FP-RFpIPchRT4A1oSh/edit?gid=1313414032#gid=1313414032`
   - Nombres de hojas por período mensual en español y mayúsculas: `"NOVIEMBRE 26"`, `"DICIEMBRE 26"`, `"ENERO 27"`, etc.
   - **Estructura exacta de columnas**:
     `Fecha | Descripción (Proveedor/Entidad) | Cuenta | Tipo | Descripción (Detalle) | Entrada (D) | Salida (H) | Saldo | Observaciones`
   - **Regla de `"Proveedores Varios"` vs Gastos Fudo y Guardado Automático de Externos**:
     - Todos los productos/compras pasados en **Gastos de Fudo** deben estar pasados en la hoja Contable como **`"Proveedores Varios"`** (y viceversa).
     - Todo ítem de la hoja Contable cuya `Cuenta` **NO sea `"Proveedores Varios"`** (ej. servicios, impuestos, sueldos, alquiler, retiros de Caja Principal o Caja Grande) **NO va a revisión**: debe ser **guardado automáticamente como Gasto Externo en la DB (`external_expenses` en Neon y SQLite)**.
     - **La Revisión es exclusivamente para los gastos que NO están en ambas listas (`Gastos Fudo` <-> `"Proveedores Varios"` de Contables)**:
       1. Si un gasto está en `"Proveedores Varios"` (Sheets Contables) pero **NO está en Fudo**, se muestra en Revisión con un **hipervínculo directo a la celda de Google Sheets donde está pasado** (`#gid=1313414032&range=B{fila}`).
       2. Si un gasto está en **Gastos Fudo** pero **NO está en `"Proveedores Varios"`** de la hoja Contable, se muestra en Revisión para que sea cargado o conciliado.
       3. Permite editar y resolver la discrepancia en la base de datos de Neon (y SQLite local).
5. **Clasificación y Discriminación de Gastos y Cajas**:
   - **Gastos de Fudo (`/expenses`)**: Son exclusivamente compras de **ingredientes y materia prima** que repercuten en el costo actualizado del producto (actualizan el valor del ingrediente en las recetas).
   - **Movimientos de Caja > `"Principal"`**: Son compras y retiros de la caja principal para pagar gastos operativos del día a día. Se cargan como **Gastos Externos (`Caja Principal`)** y se discriminan por rubro/concepto.
   - **Movimientos de `"Caja Grande"`**: Son retiros de efectivo para afrontar gastos fijos y variables mayores (pago de expensas, sueldos, proveedores, alquiler, impuestos, etc.), discriminados según su naturaleza fija o variable.
6. **Doble Chequeo hacia Neon DB y Rol Analítico**:
   - La aplicación debe resumir, describir, interpretar y analizar los datos combinados de Fudo y Google Sheets para limpiar los datos del negocio y evidenciar problemáticas reales y futuras.
   - Toda información que ingresa a Neon DB pasa por el doble chequeo `Fudo API <-> Planilla Contable (Mes correspondiente) <-> Movimientos de Caja`, garantizando que las visualizaciones del portal trabajen siempre sobre datos verificados en nuestra base de datos.
