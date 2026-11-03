# GesT System

Sistema de gestión para negocios gastronómicos: junta los datos de la operación
(planilla de gastos + API de Fudo), arma el histórico en PostgreSQL y publica
resúmenes por período con CMV, márgenes y una sección de revisión.

La idea es simple: **cargar los datos una vez y que el sistema haga el resto**.
En lugar de copiar y pegar planillas cada semana, el sistema sincroniza, ordena y
muestra qué está pasando con el negocio.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/CodeHvrd/GesT-System)

## Qué incluye

- **Panel local de administración** (Python estándar + SQLite): panel, resumen
  semanal, mensual, gastos, alertas y enlaces de configuración.
- **Ingesta desde Fudo** (API de solo lectura): ventas, ítems, gastos, insumos y
  canales (salón, take away, delivery).
- **Base propia en PostgreSQL/Neon**: historia completa, idempotente, con
  `payload` crudo para reprocesar.
- **Portal web para clientes**: selector de período, KPIs (ventas, gastos,
  ganancia bruta, CMV), comparación contra el período anterior, ventas por día,
  categorías con objetivo de CMV y una sección **Revisión** en 3 niveles
  (crítico, atención, info).
- **Canales separados**: el delivery (Pedidos Ya, Uber Eats, etc.) se muestra
  aparte del menú, porque no siempre tiene el mismo costeo.
- **Costos de respaldo**: si Fudo no costea un producto, se puede importar el
  costo desde la planilla y queda marcado como override.

## Arquitectura

```
Google Sheets ──┐
                ├──> Ingesta (Python) ──> PostgreSQL (Neon) ──> Portal web
Fudo API ───────┘                              │
                                               ├──> Panel local (SQLite)
                                               └──> Worker de sincronización
```

- `app/`: panel local (solo biblioteca estándar, SQLite).
- `cloud/`: esquema Postgres, migración, ingesta, agregados y portal.
- `docs/schema-postgres.sql`: esquema canónico.
- `docs/fudo-openapi.yml`: especificación de la API de Fudo.

## Requisitos

- Python 3.10 o superior.
- PostgreSQL (el plan free de Neon alcanza para un local).
- Fudo con **Plan Pro** y un usuario de API (`API Key` + `API Secret`).
- Una planilla de Google compartida por link (si usás el modo planilla).

## Puesta en marcha

1. Clonar el repo y entrar a la carpeta.

2. Crear la configuración local:

   ```bash
   cp config.example.json config.json
   ```

   Completá `sheet_id`, `restaurant`, los objetivos de CMV y las credenciales de
   Fudo. `config.json` está en `.gitignore`: nunca se sube.

3. Crear el `.env` de la nube:

   ```bash
   cp cloud/.env.example .env
   ```

   Completá:

   ```
   DATABASE_URL=postgresql://...-pooler...   # Neon pooled
   DATABASE_URL_DIRECT=postgresql://...      # Neon directa (migraciones)
   FUDO_API_KEY=...
   FUDO_API_SECRET=...
   ```

4. Instalar la dependencia de Postgres:

   ```bash
   python -m pip install -r cloud/requirements.txt
   ```

5. Crear el esquema y migrar la historia (si venís de SQLite):

   ```bash
   python -m cloud.migrate
   python -m cloud.check
   ```

6. Traer datos de Fudo:

   ```bash
   python -m cloud.ingest --what all --from 2026-01-01 --to 2026-12-31
   ```

7. Levantar el portal:

   ```bash
   python -m cloud.server_pg
   # http://127.0.0.1:8788
   ```

8. Panel local de administración (opcional):

   ```bash
   python run.py serve
   # http://127.0.0.1:8787
   ```

## Deploy

El portal está pensado para correr en Docker (Render, Fly, Railway o un VPS).

```bash
docker build -t gest-system .
docker run --env-file .env -e HOST=0.0.0.0 -e PORT=8080 -e PORTAL_PASS=una-clave -p 8080:8080 gest-system
```

En Render: **New → Web Service → Docker**, conectando este repo. El archivo
[`render.yaml`](render.yaml) deja el servicio casi listo. Variables:

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | cadena **pooled** de Neon |
| `PORTAL_USER` / `PORTAL_PASS` | acceso al portal (Basic Auth) |
| `PORT` | lo define el host |

## Seguridad

- `config.json` y `.env` están en `.gitignore`: no se commitean.
- El portal pide usuario y contraseña si definís `PORTAL_PASS`. Si no, queda
  abierto: usalo solo en local.
- Las credenciales de Fudo deben ser de un usuario de **solo lectura**.
- La planilla de Google se comparte por link; no la publiques en el repo.

## Estructura

```
app/                 panel local (SQLite)
cloud/               esquema, migración, ingesta, agregados y portal
  analytics_pg.py    consultas del portal
  server_pg.py       servidor web
  static/            interfaz del portal
docs/                esquema Postgres y especificación de Fudo
Dockerfile           imagen del portal
render.yaml          blueprint de Render
```

## Estado

- Base, ingesta de Fudo y canales: funcionando.
- Portal web con resúmenes y revisión: funcionando.
- Próximo: login multiusuario, worker programado y backups automáticos.
