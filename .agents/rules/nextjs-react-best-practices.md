# Reglas de Arquitectura Next.js (App Router) y React 19

1. **Estructura de Directorios en `src/`**:
   - `src/app/`: Exclusivamente para enrutamiento de Next.js (`layout.tsx`, `page.tsx`, `loading.tsx`, `error.tsx`) y Route Handlers (`src/app/api/**/route.ts`).
   - `src/components/ui/`: Primitivos reutilizables de `shadcn/ui` sin lógica de negocio acoplada.
   - `src/components/layout/`, `src/components/dashboard/`, `src/components/admin/`: Componentes de dominio bien divididos por responsabilidad.
   - `src/lib/`: Lógica pura de negocio, adaptadores de base de datos (`db/`), integraciones externas (`fudo/`, `sheets/`) y motores analíticos (`analytics/`).

2. **Frontera Server / Client Components**:
   - No coloques `"use client"` en archivos de `src/lib/` ni en `layout.tsx`.
   - En componentes cliente (`"use client"`), usa estados derivados en lugar de `useEffect` innecesarios para filtrar o transformar colecciones en memoria (ej. filtrado de gastos o notificaciones).
   - Usa `AbortController` o control de concurrencia en llamadas `fetch` de larga duración (como `/api/sync`).

3. **Tipado Estricto en TypeScript**:
   - Prohibido usar `any` implícito. Define interfaces claras para respuestas de API (`DashboardData`, `SummaryData`, `WeekReport`, `MonthReport`, `AlertItem`, `ExpenseRow`).
   - Valida siempre los query params (`searchParams`) y el cuerpo JSON en los Route Handlers antes de invocar la capa de servicios.

4. **Accesibilidad (a11y) e Interactividad**:
   - Las tarjetas interactivas (como los 3 KPIs desplegables de Ventas, Ganancia Bruta y Gastos) deben ser accesibles por teclado (`tabIndex={0}`, `role="button"`, `aria-expanded`, soporte para teclas `Enter` y `Space`).
   - Todos los controles de formulario e íconos de acción rápida deben incluir `aria-label` o ` <label>` asociado.

