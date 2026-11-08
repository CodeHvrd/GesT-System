---
description: Reglas de integración con Fudo API, Planilla Contable Mensual (NOVIEMBRE 26 / DICIEMBRE 26), Movimientos de Caja y doble chequeo en Neon DB.
---

# Integraciones de Dominio: Fudo API, Planilla Contable y Neon DB

## 1. Planilla Contable Mensual (`1gNitzY7n44UYr1FP-RFpIPchRT4A1oSh`)
- **Identificador de Planilla**: `1gNitzY7n44UYr1FP-RFpIPchRT4A1oSh` (GID inicial `1313414032` para `"NOVIEMBRE 26"`).
- **Convención de Pestañas Mensuales**: `"MES AA"` en español (ej. `"OCTUBRE 26"`, `"NOVIEMBRE 26"`, `"DICIEMBRE 26"`, `"ENERO 27"`). El sistema resuelve automáticamente el nombre de la pestaña a partir del mes consultado (`YYYY-MM`).
- **Formato de Celdas (9 columnas principales)**:
  1. `Fecha` (`DD/MM/YYYY`, `DD/MM` completando el año de la pestaña, o vacío heredando la fecha previa del libro).
  2. `Descripción` (Nombre del proveedor o entidad, ej. `"Promarco"`, `"Los Gringos"`, `"Papelera"`, `"CocaCola"`, `"Obras sanitarias"`).
  3. `Cuenta` (ej. `"PROVEEDORES varios"`, `"Egresos Servicios Exteriores"`, `"Egreso impuestos municipales"`).
  4. `Tipo` (`"N"` o `"B"`).
  5. `Descripción` (Detalle secundario del comprobante o concepto).
  6. `Entrada (D)` (Monto devengado / facturado del comprobante).
  7. `Salida (H)` (Monto efectivamente pagado).
  8. `Saldo` (Saldo acumulado).
  9. `Observaciones` (ej. `"pagado 2/11"`, `"a pagar"`).

## 2. Regla de Auditoría: `"Proveedores Varios"` <-> Gastos Fudo y Guardado Automático de Externos
- Todos los gastos pasados en **Gastos de Fudo (`/expenses`)** deben estar pasados en la hoja Contable como **`"Proveedores Varios"`** (y viceversa).
- Todo ítem de la hoja Contable cuya `Cuenta` **NO sea `"Proveedores Varios"`** se guarda **automáticamente como Gasto Externo en la DB (`external_expenses` en Neon y SQLite)** sin entrar en la bandeja de revisión.
- **La Revisión muestra exclusivamente los gastos que NO están en ambas listas (`Gastos Fudo` <-> `"Proveedores Varios"` de Contables)**:
  1. **En `"Proveedores Varios"` pero NO en Gastos Fudo**: Se notifica para revisión e incluye un **hipervínculo directo a la celda de Google Sheets donde está pasado** (`https://docs.google.com/spreadsheets/d/1gNitzY7n44UYr1FP-RFpIPchRT4A1oSh/edit?gid=1313414032#gid=1313414032&range=B{fila}`).
  2. **En Gastos Fudo pero NO en `"Proveedores Varios"`**: Se notifica para revisión indicando que el gasto de Fudo no figura pasado como `"Proveedores Varios"` en la planilla Contable.
  3. Se habilita su edición y resolución en **Neon DB / SQLite** mediante `/api/reconcile`.

## 3. Semántica de Gastos Fudo y Movimientos de Caja
- **Gastos Fudo (`/expenses`)**: Compras de **ingredientes y materia prima** que actualizan el costo de los insumos y repercuten directamente en el CMV de las recetas.
- **Movimientos de Caja > `"Principal"`**: Compras y retiros de caja chica/principal para gastos del día a día. Se importan y discriminan como **Gastos Externos (`caja_principal`)**.
- **Movimientos de `"Caja Grande"`**: Retiros de efectivo para pago de **gastos fijos y variables** (expensas, sueldos, proveedores, alquiler, impuestos), discriminados como `caja_grande`.

## 4. Programación de Sincronización Fudo y UI
- **Horarios Programados**: Actualización automática de Fudo a las **02:00 hs ARG** (`05:00 UTC`) y **16:00 hs ARG** (`19:00 UTC`).
- **Botones de Cabecera (`HeaderBar`)**: Los botones de **Actualizar Fudo** y **Versión** deben renderizarse exclusivamente con su ícono (sin strings ni prefijos `"v"` visibles en el botón).
