# Reglas de Diseño con shadcn/ui y Tailwind CSS

1. **Uso de Primitivos `shadcn/ui`**:
   - Utiliza siempre los componentes de `@/components/ui/` (`Card`, `Button`, `Badge`, `Table`, `Tabs`, `Dialog`, `Popover`, `Select`, `Input`, `Textarea`, `Progress`, `Separator`) en lugar de recrear contenedores o botones con clases sueltas.
   - Usa la utilidad `cn(...inputs)` de `@/lib/utils` (`clsx` + `tailwind-merge`) para componer variantes y clases condicionales.

2. **Identidad Visual y Paleta Gastronómica (GesT)**:
   - Color primario de marca: verde esmeralda profundo (`#0b6b53` / `brand`).
   - Semántica de estados financieros y alertas:
     - **Positivo / En objetivo (`ok` / `good`)**: Tonos esmeralda (`text-emerald-700`, `bg-emerald-50`, `border-emerald-200`).
     - **Atención / Advertencia (`atencion` / `warn`)**: Tonos ámbar (`text-amber-700`, `bg-amber-50`, `border-amber-200`).
     - **Crítico / Sobre CMV / Resultado negativo (`critico` / `bad`)**: Tonos rojos/rosados (`text-rose-700`, `bg-rose-50`, `border-rose-200`).
     - **Informativo (`info`)**: Tonos azul/pizarra (`text-sky-700`, `bg-sky-50`, `border-sky-200`).

3. **Tipografía Numérica y Tablas Financieras**:
   - Toda cifra monetaria, porcentaje, cantidad o fecha en tablas y tarjetas KPI debe usar `tabular-nums` (`font-variant-numeric: tabular-nums`) para garantizar alineación vertical perfecta.
   - Las columnas numéricas en `<Table>` deben alinearse a la derecha (`text-right`).

4. **Diseño Responsivo**:
   - El layout principal (`AppSidebar` + `Workspace`) debe adaptarse fluidamente desde móviles (`flex-col`) hasta pantallas de escritorio (`lg:grid lg:grid-cols-[260px_1fr]`).
   - Las tablas anchas deben estar envueltas en contenedores con scroll horizontal limpio (`overflow-x-auto`).

