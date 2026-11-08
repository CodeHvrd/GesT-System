"use client";

import React, { useState } from "react";
import {
  Plus,
  Trash2,
  Search,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  FlaskConical,
  FileSpreadsheet,
  Edit3,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { money } from "@/lib/format";

interface GastosSectionProps {
  data: Record<string, any>;
  onRefresh: () => void;
}

const SAMPLE_CONTABLE_CSV = `Fecha,Descripción,Cuenta,Tipo,Descripción,Entrada (D),Salida (H),Saldo,Observaciones
02/11/2026,Los Gringos,Proveedores Varios,Egresos Mercaderia,Fiambres y quesos,"$225.735,00",0.00,"$225.735,00",Factura A
02/11/2026,Promarco,Proveedores Varios,Egresos Mercaderia,Insumos cocina,"$42.333,92",0.00,"$268.068,92",En Fudo
02/11/2026,Papelera,Proveedores Varios,Egresos Mercaderia,Bolsas y descartables,"$34.480,00","$34.480,00","$268.068,92",No cargado en Fudo -> Gasto Externo
03/11,CocaCola,Proveedores Varios,Egresos Mercaderia,Bebidas linea Coca,"$124.688,46","124.700,00","$268.057,38",Redondeo efectivo
,Marleand,Proveedores Varios,Egresos Mercaderia,Panificados,"$70.400,00",0.00,"$338.457,38",Hereda fecha 03/11 - Falta en Fudo
04/11/2026,Verduleria del Puerto,Movimientos de Caja > Principal,Caja Principal,Compra urgente limon y menta,0.00,"$18.500,00","$338.457,38",Retiro Caja Principal dia a dia
05/11/2026,Obras Sanitarias,Egresos Servicios Exteriores,Caja Grande,Servicio agua mensual,"$151.148,14","$151.148,14","$338.457,38",Retiro Caja Grande Fijo
05/11/2026,Adelanto Sueldos Cocina,Caja Grande,Egresos Sueldos,Pago quincena personal,0.00,"$480.000,00","$338.457,38",Retiro Caja Grande Fijo`;

const SAMPLE_FUDO_EXPENSES = [
  {
    id: "fudo-101",
    fecha: "2026-11-02",
    proveedor: "Los Gringos",
    monto: 225735,
    descripcion: "Fiambres y quesos (Materia Prima)",
    categoria: "Materia Prima / Insumos",
  },
  {
    id: "fudo-102",
    fecha: "2026-11-02",
    proveedor: "Promarco",
    monto: 42333.92,
    descripcion: "Insumos cocina (Materia Prima)",
    categoria: "Materia Prima / Insumos",
  },
  {
    id: "fudo-103",
    fecha: "2026-11-03",
    proveedor: "CocaCola",
    monto: 124688.46,
    descripcion: "Bebidas linea Coca",
    categoria: "Materia Prima / Insumos",
  },
];

export function GastosSection({ data, onRefresh }: GastosSectionProps) {
  const expenses = data?.expenses || {};
  const totales = expenses?.totales || {};
  const reconciliacion: Array<any> = expenses?.reconciliacion_proveedores || [];
  const movimientos: Array<any> = expenses?.movimientos || [];
  const externosLista: Array<any> = expenses?.externos_lista || [];
  const initialContable = expenses?.contable_reconciliation || null;

  const [contableData, setContableData] = useState<any>(initialContable);
  const [hojaMesInput, setHojaMesInput] = useState<string>(
    initialContable?.hoja_mes || "NOVIEMBRE 26"
  );
  const [syncingContable, setSyncingContable] = useState(false);
  const [contableStatus, setContableStatus] = useState<string | null>(null);
  const [showTester, setShowTester] = useState(false);
  const [testCsvText, setTestCsvText] = useState(SAMPLE_CONTABLE_CSV);
  const [ledgerFilter, setLedgerFilter] = useState<
    "discrepancias" | "proveedores_varios" | "caja_principal" | "caja_grande" | "todos"
  >("discrepancias");
  const [editingHash, setEditingHash] = useState<string | null>(null);
  const [editMonto, setEditMonto] = useState<string>("");
  const [editNota, setEditNota] = useState<string>("");
  const [resolvingHash, setResolvingHash] = useState<string | null>(null);

  const [extCat, setExtCat] = useState("Movimientos de Caja > Principal");
  const [extProv, setExtProv] = useState("");
  const [extDesc, setExtDesc] = useState("");
  const [extMonto, setExtMonto] = useState("");
  const [extFijo, setExtFijo] = useState(false);
  const [savingExt, setSavingExt] = useState(false);
  const [searchMov, setSearchMov] = useState("");
  const [originFilter, setOriginFilter] = useState("todos");

  const activeContable = contableData || initialContable;
  const contableTotales = activeContable?.totales || {};
  const contableItems: Array<any> = activeContable?.items || [];
  const discrepanciasPendientes: Array<any> =
    activeContable?.discrepancias_pendientes || [];

  async function handleSyncLiveContableSheet() {
    setSyncingContable(true);
    setContableStatus(null);
    try {
      const res = await fetch("/api/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hoja: hojaMesInput,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setContableData(json.data);
        setContableStatus(
          `Hoja "${json.data.hoja_mes}" procesada: ${json.data.totales.filas_procesadas} filas, ${json.data.discrepancias_pendientes.length} discrepancias de Proveedores Varios detectadas.`
        );
        onRefresh();
      } else {
        setContableStatus(`Error al sincronizar hoja: ${json.error}`);
      }
    } catch (err) {
      setContableStatus(`Error de red: ${(err as Error).message}`);
    } finally {
      setSyncingContable(false);
    }
  }

  async function handleRunInteractiveTest() {
    setSyncingContable(true);
    setContableStatus(null);
    try {
      const res = await fetch("/api/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hoja: hojaMesInput || "NOVIEMBRE 26",
          csv_text: testCsvText,
          fudo_expenses: SAMPLE_FUDO_EXPENSES,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setContableData(json.data);
        setContableStatus(
          `Test ejecutado sobre "${json.data.hoja_mes}": ${json.data.totales.proveedores_varios_conciliados_count} Proveedores Varios conciliados con Fudo y ${json.data.totales.proveedores_varios_faltantes_count} posicionados como Gasto Externo para revisión.`
        );
        onRefresh();
      } else {
        setContableStatus(`Error en test: ${json.error}`);
      }
    } catch (err) {
      setContableStatus(`Error en test: ${(err as Error).message}`);
    } finally {
      setSyncingContable(false);
    }
  }

  async function handleResolveDiscrepancy(
    hash: string,
    accion:
      | "confirmar_en_fudo"
      | "mantener_gasto_externo"
      | "mover_a_caja_principal"
      | "mover_a_caja_grande_fijo"
      | "mover_a_caja_grande_variable"
      | "ignorar"
  ) {
    setResolvingHash(hash);
    try {
      const payload: Record<string, unknown> = {
        hash,
        accion,
        nota: editNota || `Resuelto desde portal (${accion})`,
      };
      if (editingHash === hash && editMonto.trim() !== "") {
        payload.nuevo_monto = Number(editMonto);
      }
      const res = await fetch("/api/reconcile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.ok) {
        setContableData(json.data.reconciliation);
        setEditingHash(null);
        setEditMonto("");
        setEditNota("");
        onRefresh();
      }
    } finally {
      setResolvingHash(null);
    }
  }

  async function handleAddExternal(e: React.FormEvent) {
    e.preventDefault();
    if (!extMonto) return;
    setSavingExt(true);
    try {
      const res = await fetch("/api/external", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoria: extCat,
          proveedor: extProv,
          descripcion: extDesc,
          monto: extMonto,
          es_fijo: extFijo,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setExtProv("");
        setExtDesc("");
        setExtMonto("");
        onRefresh();
      }
    } finally {
      setSavingExt(false);
    }
  }

  async function handleDeleteExternal(id: number) {
    await fetch(`/api/external?id=${id}`, { method: "DELETE" });
    onRefresh();
  }

  const filteredContableItems = contableItems.filter((item) => {
    if (ledgerFilter === "discrepancias") {
      return (
        item.estado_conciliacion === "faltante_en_fudo" ||
        item.estado_conciliacion === "discrepancia_monto"
      );
    }
    if (ledgerFilter === "proveedores_varios") {
      return item.origen_clasificado === "proveedores_varios";
    }
    if (ledgerFilter === "caja_principal") {
      return (
        item.posicion_actual === "caja_principal" ||
        item.origen_clasificado === "caja_principal"
      );
    }
    if (ledgerFilter === "caja_grande") {
      return (
        item.posicion_actual === "caja_grande_fijo" ||
        item.posicion_actual === "caja_grande_variable" ||
        item.origen_clasificado === "caja_grande"
      );
    }
    return true;
  });

  const filteredMovs = movimientos.filter((m) => {
    if (originFilter !== "todos" && m.origen !== originFilter) return false;
    if (!searchMov) return true;
    const q = searchMov.toLowerCase();
    return (
      String(m.proveedor || "").toLowerCase().includes(q) ||
      String(m.categoria || "").toLowerCase().includes(q) ||
      String(m.descripcion || "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      {/* 4 Bloques Principales según Regla de Negocio */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Gastos Fudo (Materia Prima / Recetas)</CardDescription>
            <CardTitle className="text-xl font-bold">
              {money(
                totales.fudo ||
                  contableTotales.proveedores_varios_conciliados_monto ||
                  0
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Ingredientes e insumos en Fudo que actualizan el costo del producto ·{" "}
            Conciliados Contable:{" "}
            {money(contableTotales.proveedores_varios_conciliados_monto || 0)}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>
              Gastos Externos (Caja Principal + Prov. sin Fudo)
            </CardDescription>
            <CardTitle className="text-xl font-bold text-amber-600 dark:text-amber-400">
              {money(totales.externos_puntuales || 0)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Caja Principal (día a día): {money(totales.caja_principal_total || 0)} ·{" "}
            Prov. Varios fuera de Fudo:{" "}
            {money(totales.contable_proveedores_externos || 0)}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>
              Movimientos Caja Grande (Fijos y Variables)
            </CardDescription>
            <CardTitle className="text-xl font-bold text-primary">
              {money(
                (totales.fijos_consolidados || 0) +
                  (totales.caja_grande_variables || 0)
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Fijos (Sueldos, Alquiler, Impuestos, Servicios):{" "}
            {money(totales.fijos_consolidados || 0)} · Variables:{" "}
            {money(totales.caja_grande_variables || 0)}
          </CardContent>
        </Card>

        <Card
          className={
            discrepanciasPendientes.length > 0
              ? "border-amber-500/60 bg-amber-500/5"
              : ""
          }
        >
          <CardHeader className="pb-2">
            <CardDescription>
              Doble Checkeo Neon DB ({activeContable?.hoja_mes || hojaMesInput})
            </CardDescription>
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              {discrepanciasPendientes.length > 0 ? (
                <>
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                  <span>{discrepanciasPendientes.length} por revisar</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  <span>Verificado</span>
                </>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Proveedores Varios sin Fudo:{" "}
            {money(contableTotales.proveedores_varios_faltantes_monto || 0)} (posicionados
            como Gasto Externo)
          </CardContent>
        </Card>
      </div>

      {/* Herramienta de Auditoría y Testeo: Planilla Contable ("NOVIEMBRE 26" / "DICIEMBRE 26") vs Fudo */}
      <Card className="border-primary/25">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <CardTitle className="text-base flex items-center gap-2">
                <FileSpreadsheet className="h-4 w-4 text-primary" />
                Auditoría Planilla Contable (`Contables &gt; Mes`) vs Gastos Fudo &amp;
                Cajas
              </CardTitle>
              <CardDescription>
                Formato 9 columnas:{" "}
                <code className="text-[11px] bg-muted px-1 py-0.5 rounded">
                  Fecha / Descripción / Cuenta / Tipo / Descripción / Entrada (D) / Salida
                  (H) / Saldo / Observaciones
                </code>
                . Todo ítem con Cuenta <strong>&quot;Proveedores Varios&quot;</strong> que no
                figure en Gastos Fudo se notifica para revisión y se posiciona como{" "}
                <strong>Gasto Externo</strong>.
              </CardDescription>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={hojaMesInput}
                onChange={(e) => setHojaMesInput(e.target.value.toUpperCase())}
                placeholder="Ej. NOVIEMBRE 26 o DICIEMBRE 26"
                className="h-8 w-44 text-xs font-medium"
              />
              <Button
                size="sm"
                onClick={handleSyncLiveContableSheet}
                disabled={syncingContable}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${syncingContable ? "animate-spin" : ""}`}
                />
                {syncingContable ? "Auditando..." : "Sincronizar Hoja Contable"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowTester(!showTester)}
              >
                <FlaskConical className="h-3.5 w-3.5" />
                {showTester ? "Ocultar Tester" : "Herramienta de Testeo"}
              </Button>
            </div>
          </div>

          {contableStatus && (
            <div className="mt-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs font-medium text-primary">
              {contableStatus}
            </div>
          )}
        </CardHeader>

        <CardContent className="space-y-4">
          {showTester && (
            <div className="rounded-xl border bg-muted/30 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Simulador / Tester de Interpretación Contable y Cruce con Fudo
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    Probá el parser de 9 columnas (`NOVIEMBRE 26` / `DICIEMBRE 26`), la
                    detección de `Proveedores Varios` faltantes en Fudo y la discriminación
                    de `Caja Principal` vs `Caja Grande`.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setTestCsvText(SAMPLE_CONTABLE_CSV)}
                  >
                    Restaurar Ejemplo Real NOVIEMBRE 26
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleRunInteractiveTest}
                    disabled={syncingContable}
                  >
                    <FlaskConical className="h-3.5 w-3.5" />
                    Ejecutar Test de Conciliación
                  </Button>
                </div>
              </div>
              <textarea
                value={testCsvText}
                onChange={(e) => setTestCsvText(e.target.value)}
                rows={7}
                className="w-full rounded-lg border bg-background p-2.5 font-mono text-xs"
              />
            </div>
          )}

          {/* Filtros de visualización del Libro Contable */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant={ledgerFilter === "discrepancias" ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setLedgerFilter("discrepancias")}
              >
                Discrepancias Prov. Varios ({discrepanciasPendientes.length})
              </Button>
              <Button
                variant={ledgerFilter === "proveedores_varios" ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setLedgerFilter("proveedores_varios")}
              >
                Todos Proveedores Varios (
                {(contableTotales.proveedores_varios_conciliados_count || 0) +
                  (contableTotales.proveedores_varios_faltantes_count || 0)}
                )
              </Button>
              <Button
                variant={ledgerFilter === "caja_principal" ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setLedgerFilter("caja_principal")}
              >
                Caja Principal (Día a día)
              </Button>
              <Button
                variant={ledgerFilter === "caja_grande" ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setLedgerFilter("caja_grande")}
              >
                Caja Grande (Fijos / Variables)
              </Button>
              <Button
                variant={ledgerFilter === "todos" ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setLedgerFilter("todos")}
              >
                Todas las filas ({contableItems.length})
              </Button>
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Proveedor (Desc. 1)</TableHead>
                <TableHead>Cuenta / Tipo</TableHead>
                <TableHead>Detalle / Obs.</TableHead>
                <TableHead className="text-right">Entrada (D)</TableHead>
                <TableHead className="text-right">Salida (H)</TableHead>
                <TableHead>Estado Fudo</TableHead>
                <TableHead>Posición en DB</TableHead>
                <TableHead className="text-right">Resolver / Editar en Neon</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredContableItems.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-6">
                    {contableItems.length === 0
                      ? `Hacé clic en "Sincronizar Hoja Contable" o en "Herramienta de Testeo" para auditar la hoja ${hojaMesInput}.`
                      : "No hay registros en este filtro."}
                  </TableCell>
                </TableRow>
              ) : (
                filteredContableItems.slice(0, 80).map((item) => {
                  const isEditing = editingHash === item.hash;
                  return (
                    <TableRow key={item.hash}>
                      <TableCell className="text-xs whitespace-nowrap">
                        {item.fecha}
                      </TableCell>
                      <TableCell className="font-medium text-xs">
                        {item.proveedor}
                      </TableCell>
                      <TableCell className="text-xs">
                        <div>{item.cuenta}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {item.tipo}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                        {item.detalle || item.observaciones || "—"}
                        {item.resolucion_nota && (
                          <div className="text-[11px] text-primary font-medium">
                            Nota: {item.resolucion_nota}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {item.entrada_d > 0 ? money(item.entrada_d) : "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs font-semibold">
                        {isEditing ? (
                          <Input
                            type="number"
                            step="any"
                            value={editMonto}
                            onChange={(e) => setEditMonto(e.target.value)}
                            className="h-7 w-28 text-xs ml-auto"
                          />
                        ) : (
                          money(item.monto_efectivo)
                        )}
                      </TableCell>
                      <TableCell>
                        {item.estado_conciliacion === "conciliado_fudo" ? (
                          <Badge variant="success">En Gastos Fudo</Badge>
                        ) : item.estado_conciliacion === "faltante_en_fudo" ? (
                          <Badge variant="warning">Falta en Fudo</Badge>
                        ) : item.estado_conciliacion === "discrepancia_monto" ? (
                          <Badge variant="warning">
                            Dif. Fudo ({money(item.diferencia_monto)})
                          </Badge>
                        ) : item.estado_conciliacion === "resuelto_manual" ? (
                          <Badge variant="secondary">Resuelto en DB</Badge>
                        ) : (
                          <Badge variant="outline">No aplica a Fudo</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[11px]">
                          {item.posicion_actual === "gasto_externo"
                            ? "Gasto Externo"
                            : item.posicion_actual === "gasto_fudo"
                              ? "Gasto Fudo (Receta)"
                              : item.posicion_actual === "caja_principal"
                                ? "Caja Principal"
                                : item.posicion_actual === "caja_grande_fijo"
                                  ? "Caja Grande (Fijo)"
                                  : item.posicion_actual === "caja_grande_variable"
                                    ? "Caja Grande (Var.)"
                                    : item.posicion_actual}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title="Editar monto o nota antes de guardar en Neon DB"
                            onClick={() => {
                              if (isEditing) {
                                setEditingHash(null);
                              } else {
                                setEditingHash(item.hash);
                                setEditMonto(String(item.monto_efectivo));
                                setEditNota(item.resolucion_nota || "");
                              }
                            }}
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-[11px]"
                            disabled={resolvingHash === item.hash}
                            onClick={() =>
                              handleResolveDiscrepancy(item.hash, "confirmar_en_fudo")
                            }
                            title="Confirmar que está en Fudo (Insumos / Materia Prima)"
                          >
                            Es Fudo
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-[11px]"
                            disabled={resolvingHash === item.hash}
                            onClick={() =>
                              handleResolveDiscrepancy(
                                item.hash,
                                "mantener_gasto_externo"
                              )
                            }
                            title="Confirmar como Gasto Externo"
                          >
                            Externo
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-[11px]"
                            disabled={resolvingHash === item.hash}
                            onClick={() =>
                              handleResolveDiscrepancy(item.hash, "mover_a_caja_principal")
                            }
                            title="Clasificar como Movimiento de Caja > Principal (día a día)"
                          >
                            Caja Princ.
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-[11px]"
                            disabled={resolvingHash === item.hash}
                            onClick={() =>
                              handleResolveDiscrepancy(
                                item.hash,
                                "mover_a_caja_grande_fijo"
                              )
                            }
                            title="Clasificar como Caja Grande (Gasto Fijo)"
                          >
                            Caja Grande
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Carga Manual de Movimientos de Caja Principal / Caja Grande y Conciliación por Proveedor */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Registrar Gasto Externo (`Caja Principal` o `Caja Grande`)
            </CardTitle>
            <CardDescription>
              Discriminá retiros de Caja Principal (compras del día a día) o de Caja Grande
              (expensas, sueldos, alquiler, proveedores)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form
              onSubmit={handleAddExternal}
              className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            >
              <Input
                placeholder="Origen / Cuenta (ej. Movimientos de Caja > Principal)"
                value={extCat}
                onChange={(e) => setExtCat(e.target.value)}
              />
              <Input
                placeholder="Proveedor / Destinatario"
                value={extProv}
                onChange={(e) => setExtProv(e.target.value)}
              />
              <Input
                placeholder="Descripción o comprobante"
                value={extDesc}
                onChange={(e) => setExtDesc(e.target.value)}
              />
              <Input
                type="number"
                step="any"
                placeholder="Monto en ARS ($)"
                value={extMonto}
                onChange={(e) => setExtMonto(e.target.value)}
                required
              />
              <label className="flex items-center gap-2 text-xs font-medium">
                <input
                  type="checkbox"
                  checked={extFijo}
                  onChange={(e) => setExtFijo(e.target.checked)}
                  className="h-4 w-4 rounded border-input"
                />
                Es Gasto Fijo de Caja Grande (se prorratea en el período)
              </label>
              <Button type="submit" size="sm" disabled={savingExt}>
                <Plus className="h-4 w-4" />
                {savingExt ? "Guardando..." : "Guardar en Neon / DB"}
              </Button>
            </form>

            {externosLista.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Concepto</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead className="text-right">Monto</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {externosLista.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="text-xs">
                        <div className="font-medium">{item.categoria}</div>
                        <div className="text-muted-foreground">
                          {item.proveedor}{" "}
                          {item.descripcion ? `· ${item.descripcion}` : ""}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={item.es_fijo ? "secondary" : "outline"}>
                          {item.es_fijo ? "Caja Grande (Fijo)" : item.fecha}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {money(item.monto)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          onClick={() => handleDeleteExternal(item.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Conciliación Agrupada por Proveedor */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Totales por Proveedor: Fudo vs Planilla
            </CardTitle>
            <CardDescription>
              Comparativa acumulada por proveedor en el período seleccionado
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Proveedor</TableHead>
                  <TableHead className="text-right">Fudo</TableHead>
                  <TableHead className="text-right">Planilla</TableHead>
                  <TableHead className="text-right">Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reconciliacion.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="text-center text-muted-foreground"
                    >
                      Sin gastos agrupados en este rango.
                    </TableCell>
                  </TableRow>
                ) : (
                  reconciliacion.slice(0, 12).map((r) => (
                    <TableRow key={r.proveedor_key}>
                      <TableCell className="font-medium">{r.proveedor}</TableCell>
                      <TableCell className="text-right">
                        {money(r.fudo_monto)}
                      </TableCell>
                      <TableCell className="text-right">
                        {money(r.planilla_monto)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant={
                            r.estado === "conciliado"
                              ? "success"
                              : r.estado === "diferencia"
                                ? "warning"
                                : "secondary"
                          }
                        >
                          {r.estado === "conciliado"
                            ? "Conciliado"
                            : r.estado === "solo_planilla"
                              ? "Solo Planilla"
                              : r.estado === "solo_fudo"
                                ? "Solo Fudo"
                                : `Dif: ${money(r.diferencia)}`}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Tabla de Movimientos de Gastos Discriminados */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">
                Listado Unificado y Discriminado de Movimientos ({filteredMovs.length})
              </CardTitle>
              <CardDescription>
                Gastos Fudo (Insumos), Proveedores Varios posicionados como Externos,
                Caja Principal y Caja Grande
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(
                [
                  "todos",
                  "fudo",
                  "gasto_externo",
                  "caja_principal",
                  "caja_grande_fijo",
                  "externo",
                ] as const
              ).map((orig) => (
                <Button
                  key={orig}
                  variant={originFilter === orig ? "default" : "outline"}
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => setOriginFilter(orig)}
                >
                  {orig === "todos"
                    ? "Todos"
                    : orig === "fudo"
                      ? "Fudo (Receta)"
                      : orig === "gasto_externo"
                        ? "Prov. Varios (Externo)"
                        : orig === "caja_principal"
                          ? "Caja Principal"
                          : orig === "caja_grande_fijo"
                            ? "Caja Grande"
                            : "Manual"}
                </Button>
              ))}
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Buscar proveedor o rubro..."
                  value={searchMov}
                  onChange={(e) => setSearchMov(e.target.value)}
                  className="h-8 w-56 pl-8 text-xs"
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Origen Discriminado</TableHead>
                <TableHead>Categoría / Cuenta</TableHead>
                <TableHead>Proveedor</TableHead>
                <TableHead>Descripción</TableHead>
                <TableHead className="text-right">Monto</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredMovs.slice(0, 100).map((m, i) => (
                <TableRow key={`${m.id}-${i}`}>
                  <TableCell className="text-xs whitespace-nowrap">{m.fecha}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="uppercase text-[10px]">
                      {m.origen}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium text-xs">{m.categoria}</TableCell>
                  <TableCell className="text-xs">{m.proveedor || "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {m.descripcion || "—"}
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    {money(m.monto)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
