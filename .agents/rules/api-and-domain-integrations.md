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

## 2. Regla de Auditoría: `"Proveedores Varios"` vs Gastos Fudo
- Cada fila donde `Cuenta` contenga `"Proveedores Varios"` se cruza contra los **Gastos de Fudo (`/expenses`)** del mismo período (comparando proveedor normalizado y monto con tolerancia a redondeos de efectivo).
- **Si está en Fudo**: Se marca como `conciliado` (no se duplica como gasto externo).
- **Si NO está en Fudo**:
  1. Se genera una **notificación de discrepancia** para revisión operativa.
  2. Se posiciona automáticamente como **Gasto Externo** (para reflejar el egreso real en la ecuación de resultados).
  3. Se habilita su edición y resolución en **Neon DB / SQLite** mediante `/api/reconcile` (`confirmar_fudo`, `mantener_externo`, `reclasificar_fijo`, `editar_monto`, `ignorar`).

## 3. Semántica de Gastos Fudo y Movimientos de Caja
- **Gastos Fudo (`/expenses`)**: Compras de **ingredientes y materia prima** que actualizan el costo de los insumos y repercuten directamente en el CMV de las recetas.
- **Movimientos de Caja > `"Principal"`**: Compras y retiros de caja chica/principal para gastos del día a día. Se importan y discriminan como **Gastos Externos (`caja_principal`)**.
- **Movimientos de `"Caja Grande"`**: Retiros de efectivo para pago de **gastos fijos y variables** (expensas, sueldos, proveedores, alquiler, impuestos), discriminados como `caja_grande`.

## 4. Programación de Sincronización Fudo y UI
- **Horarios Programados**: Actualización automática de Fudo a las **02:00 hs ARG** (`05:00 UTC`) y **16:00 hs ARG** (`19:00 UTC`).
- **Botones de Cabecera (`HeaderBar`)**: Los botones de **Actualizar Fudo** y **Versión** deben renderizarse exclusivamente con su ícono (sin strings ni prefijos `"v"` visibles en el botón).
