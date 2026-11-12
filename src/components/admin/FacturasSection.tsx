"use client";

import React, { useEffect, useState } from "react";
import {
  FileText,
  Calendar,
  AlertTriangle,
  Clock,
  CheckCircle2,
  Filter,
  DollarSign,
  ChevronDown,
  ChevronRight,
  TrendingDown,
  Building2,
  Check,
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
import { Badge } from "@/components/ui/badge";
import { money } from "@/lib/format";

export function FacturasSection() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [filterEstado, setFilterEstado] = useState<string>("pendiente");
  const [filterProv, setFilterProv] = useState<string>("todos");
  const [activeSubTab, setActiveSubTab] = useState<"lote" | "cuentas" | "facturas">("lote");
  const [expandedProv, setExpandedProv] = useState<Record<string, boolean>>({});
  const [markingId, setMarkingId] = useState<string | number | null>(null);

  async function loadInvoices() {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (filterEstado !== "todos") qs.set("estado", filterEstado);
      if (filterProv !== "todos") qs.set("proveedor", filterProv);

      const res = await fetch(`/api/invoices?${qs.toString()}`);
      const json = await res.json();
      if (json.ok) {
        setData(json);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadInvoices();
  }, [filterEstado, filterProv]);

  async function handleToggleStatus(
    invoiceId: string | number,
    currentEstado: string
  ) {
    const nextEstado = currentEstado === "pagado" ? "pendiente" : "pagado";
    setMarkingId(invoiceId);
    try {
      const res = await fetch("/api/invoices", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoice_id: invoiceId,
          estado: nextEstado,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        await loadInvoices();
      }
    } finally {
      setMarkingId(null);
    }
  }

  function toggleProv(provKey: string) {
    setExpandedProv((prev) => ({ ...prev, [provKey]: !prev[provKey] }));
  }

  const kpis = data?.kpis || {};
  const proximoCorte = data?.proximo_corte || { dayName: "Martes", date: "" };
  const lote = data?.lote_sugerido || [];
  const cuentas = data?.cuentas_corrientes || [];
  const facturas = data?.facturas || [];

  return (
    <div className="space-y-6">
      {/* 1. KPIs Principales de Tesorería y Pagos */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium">
                Deuda en Cta. Cte.
              </span>
              <DollarSign className="h-4 w-4 text-primary" />
            </div>
            <div className="mt-2 text-2xl font-bold">
              {money(kpis.total_deuda || 0)}
            </div>
            <span className="text-[11px] text-muted-foreground">
              {kpis.total_facturas_pendientes || 0} facturas pendientes
            </span>
          </CardContent>
        </Card>

        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-primary font-semibold">
                Lote {proximoCorte.dayName}
              </span>
              <Calendar className="h-4 w-4 text-primary" />
            </div>
            <div className="mt-2 text-2xl font-bold text-primary">
              {money(kpis.monto_proximo_corte || 0)}
            </div>
            <span className="text-[11px] text-muted-foreground">
              Corte más próximo: {proximoCorte.date || "Programado"}
            </span>
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium">
                Alerta &gt; 7 días cargadas
              </span>
              <Clock className="h-4 w-4 text-amber-500" />
            </div>
            <div className="mt-2 text-2xl font-bold text-amber-600 dark:text-amber-400">
              {kpis.total_mas_de_una_semana || 0}
            </div>
            <span className="text-[11px] text-muted-foreground">
              Priorizadas para próximo pago
            </span>
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium">
                Facturas Vencidas
              </span>
              <AlertTriangle className="h-4 w-4 text-red-500" />
            </div>
            <div className="mt-2 text-2xl font-bold text-red-600 dark:text-red-400">
              {kpis.total_vencidas || 0}
            </div>
            <span className="text-[11px] text-muted-foreground">
              Plazo de crédito superado
            </span>
          </CardContent>
        </Card>
      </div>

      {/* 2. Selector de Subpestañas */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div className="flex items-center gap-2">
          <Button
            variant={activeSubTab === "lote" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveSubTab("lote")}
            className="text-xs"
          >
            <Calendar className="h-3.5 w-3.5 mr-1.5" />
            Planificador Martes / Viernes ({lote.length})
          </Button>
          <Button
            variant={activeSubTab === "cuentas" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveSubTab("cuentas")}
            className="text-xs"
          >
            <Building2 className="h-3.5 w-3.5 mr-1.5" />
            Cuentas Corrientes ({cuentas.length})
          </Button>
          <Button
            variant={activeSubTab === "facturas" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveSubTab("facturas")}
            className="text-xs"
          >
            <FileText className="h-3.5 w-3.5 mr-1.5" />
            Todas las Facturas ({facturas.length})
          </Button>
        </div>

        {activeSubTab === "facturas" && (
          <div className="flex items-center gap-2">
            <select
              value={filterEstado}
              onChange={(e) => setFilterEstado(e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2.5 text-xs font-medium"
            >
              <option value="todos">Todos los Estados</option>
              <option value="pendiente">Solo Pendientes</option>
              <option value="pagado">Solo Pagadas</option>
            </select>
          </div>
        )}
      </div>

      {/* 3. Vista 1: Planificador de Pagos (Martes y Viernes) */}
      {activeSubTab === "lote" && (
        <Card className="border-primary/20">
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <CardTitle className="text-base font-bold flex items-center gap-2">
                  <span>Próximo Lote de Pagos: {proximoCorte.dayName}</span>
                  <Badge variant="outline" className="text-xs bg-primary/10 text-primary">
                    {proximoCorte.date}
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs mt-1">
                  Facturas que cumplieron más de 1 semana desde su carga en Fudo o próximas a vencer, listas para abonar este {proximoCorte.dayName}.
                </CardDescription>
              </div>
              <Badge variant="secondary" className="text-xs h-7 px-3 font-semibold">
                Total del Lote: {money(kpis.monto_proximo_corte || 0)}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {lote.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Proveedor</TableHead>
                      <TableHead>Factura / Comprobante</TableHead>
                      <TableHead>Fecha Emisión</TableHead>
                      <TableHead>Días Cargada</TableHead>
                      <TableHead>Vencimiento</TableHead>
                      <TableHead className="text-right">Monto</TableHead>
                      <TableHead className="text-center">Estado</TableHead>
                      <TableHead className="text-right">Acción</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lote.map((item: any) => (
                      <TableRow key={item.id} className="hover:bg-muted/50">
                        <TableCell className="font-semibold text-xs">
                          {item.proveedor}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {item.numero_factura || item.descripcion || "S/N"}
                        </TableCell>
                        <TableCell className="text-xs">{item.fecha_emision}</TableCell>
                        <TableCell className="text-xs">
                          <Badge
                            variant={item.dias_desde_carga >= 7 ? "warning" : "outline"}
                            className="text-[10px]"
                          >
                            {item.dias_desde_carga} d
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          <span
                            className={
                              item.fecha_vencimiento < (data?.kpis?.proximo_corte?.date || "")
                                ? "text-red-500 font-semibold"
                                : "text-foreground"
                            }
                          >
                            {item.fecha_vencimiento}
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-xs font-bold">
                          {money(item.monto)}
                        </TableCell>
                        <TableCell className="text-center text-xs">
                          <Badge
                            variant={item.estado_pago === "pagado" ? "success" : "warning"}
                            className="text-[10px]"
                          >
                            {item.estado_pago}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={markingId === item.id}
                            onClick={() => handleToggleStatus(item.id, item.estado_pago)}
                            className="h-7 text-xs gap-1"
                          >
                            <Check className="h-3 w-3 text-emerald-500" />
                            {item.estado_pago === "pagado" ? "Desmarcar" : "Marcar Pagado"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="p-8 text-center text-xs text-muted-foreground border rounded-md">
                No hay facturas pendientes para el lote de {proximoCorte.dayName}.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 4. Vista 2: Cuentas Corrientes por Proveedor */}
      {activeSubTab === "cuentas" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              Estado de Cuentas Corrientes con Proveedores
            </CardTitle>
            <CardDescription className="text-xs">
              Resumen del saldo pendiente con cada proveedor y detalle de sus comprobantes
            </CardDescription>
          </CardHeader>
          <CardContent>
            {cuentas.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10"></TableHead>
                      <TableHead>Proveedor</TableHead>
                      <TableHead className="text-center">Facturas Pendientes</TableHead>
                      <TableHead className="text-center">Vencidas</TableHead>
                      <TableHead>Próximo Vencimiento</TableHead>
                      <TableHead className="text-right">A Pagar este Lote</TableHead>
                      <TableHead className="text-right">Deuda Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cuentas.map((c: any) => {
                      const isExpanded = !!expandedProv[c.proveedor_key];
                      return (
                        <React.Fragment key={c.proveedor_key}>
                          <TableRow
                            className="cursor-pointer hover:bg-muted/50 transition-colors"
                            onClick={() => toggleProv(c.proveedor_key)}
                          >
                            <TableCell className="text-center p-2">
                              {isExpanded ? (
                                <ChevronDown className="h-4 w-4 text-muted-foreground mx-auto" />
                              ) : (
                                <ChevronRight className="h-4 w-4 text-muted-foreground mx-auto" />
                              )}
                            </TableCell>
                            <TableCell className="font-semibold text-xs">
                              {c.proveedor}
                            </TableCell>
                            <TableCell className="text-center text-xs">
                              <Badge variant="outline" className="text-[10px]">
                                {c.facturas_pendientes}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-center text-xs">
                              {c.facturas_vencidas > 0 ? (
                                <Badge variant="destructive" className="text-[10px]">
                                  {c.facturas_vencidas}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">0</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {c.proximo_vencimiento || "-"}
                            </TableCell>
                            <TableCell className="text-right text-xs font-semibold text-primary">
                              {money(c.monto_proximo_lote)}
                            </TableCell>
                            <TableCell className="text-right text-xs font-bold text-foreground">
                              {money(c.total_deuda)}
                            </TableCell>
                          </TableRow>

                          {/* Subtabla de facturas del proveedor */}
                          {isExpanded && (
                            <TableRow className="bg-muted/30 hover:bg-muted/30">
                              <TableCell colSpan={7} className="p-3 pl-8">
                                <div className="rounded-lg border bg-background/90 p-3 space-y-2">
                                  <div className="text-xs font-semibold text-muted-foreground">
                                    Facturas de {c.proveedor} ({c.facturas.length})
                                  </div>
                                  <div className="divide-y divide-border text-xs">
                                    {c.facturas.map((f: any) => (
                                      <div
                                        key={f.id}
                                        className="flex items-center justify-between py-2 gap-4"
                                      >
                                        <div className="flex items-center gap-3 min-w-0">
                                          <span className="font-medium truncate">
                                            {f.numero_factura || f.descripcion || "Factura"}
                                          </span>
                                          <span className="text-[11px] text-muted-foreground">
                                            Emitida: {f.fecha_emision} · Vence: {f.fecha_vencimiento}
                                          </span>
                                          {f.dias_desde_carga >= 7 && (
                                            <Badge variant="warning" className="text-[9px]">
                                              +7 días
                                            </Badge>
                                          )}
                                        </div>
                                        <div className="flex items-center gap-3 shrink-0">
                                          <span className="font-bold">{money(f.monto)}</span>
                                          <Badge
                                            variant={
                                              f.estado_pago === "pagado" ? "success" : "outline"
                                            }
                                            className="text-[10px]"
                                          >
                                            {f.estado_pago}
                                          </Badge>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            disabled={markingId === f.id}
                                            onClick={() =>
                                              handleToggleStatus(f.id, f.estado_pago)
                                            }
                                            className="h-6 px-2 text-[11px]"
                                          >
                                            {f.estado_pago === "pagado"
                                              ? "Desmarcar"
                                              : "Marcar Pagado"}
                                          </Button>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="p-8 text-center text-xs text-muted-foreground border rounded-md">
                No hay cuentas corrientes registradas.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 5. Vista 3: Listado General de Facturas */}
      {activeSubTab === "facturas" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              Listado de Facturas de Gastos
            </CardTitle>
            <CardDescription className="text-xs">
              Historial completo de compras y comprobantes ingresados desde Fudo
            </CardDescription>
          </CardHeader>
          <CardContent>
            {facturas.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fecha Emisión</TableHead>
                      <TableHead>Proveedor</TableHead>
                      <TableHead>Comprobante</TableHead>
                      <TableHead>Vencimiento</TableHead>
                      <TableHead>Próx. Lote</TableHead>
                      <TableHead className="text-right">Monto</TableHead>
                      <TableHead className="text-center">Estado</TableHead>
                      <TableHead className="text-right">Acción</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {facturas.map((f: any) => (
                      <TableRow key={f.id} className="hover:bg-muted/50">
                        <TableCell className="text-xs">{f.fecha_emision}</TableCell>
                        <TableCell className="font-semibold text-xs">
                          {f.proveedor}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {f.numero_factura || f.descripcion || "S/N"}
                        </TableCell>
                        <TableCell className="text-xs">{f.fecha_vencimiento}</TableCell>
                        <TableCell className="text-xs">
                          <Badge
                            variant={
                              f.proximo_dia_pago === "Martes" || f.proximo_dia_pago === "Viernes"
                                ? "secondary"
                                : "outline"
                            }
                            className="text-[10px]"
                          >
                            {f.proximo_dia_pago}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right text-xs font-bold">
                          {money(f.monto)}
                        </TableCell>
                        <TableCell className="text-center text-xs">
                          <Badge
                            variant={f.estado_pago === "pagado" ? "success" : "warning"}
                            className="text-[10px]"
                          >
                            {f.estado_pago}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={markingId === f.id}
                            onClick={() => handleToggleStatus(f.id, f.estado_pago)}
                            className="h-7 text-xs"
                          >
                            {f.estado_pago === "pagado" ? "Desmarcar" : "Marcar Pagado"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="p-8 text-center text-xs text-muted-foreground border rounded-md">
                No se encontraron facturas con los filtros seleccionados.
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
