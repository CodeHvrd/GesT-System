"use client";

import React, { useEffect, useState } from "react";
import {
  Copy,
  Download,
  Check,
  ChevronDown,
  ChevronRight,
  TrendingUp,
  AlertTriangle,
  Receipt,
  Sparkles,
  Percent,
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
import { money, pct, signed } from "@/lib/format";

export function SemanalSection() {
  const [weekKey, setWeekKey] = useState<string>("");
  const [report, setReport] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedType, setCopiedType] = useState<string | null>(null);
  const [expandedCats, setExpandedCats] = useState<Record<string, boolean>>({});
  const [expandedMaxCmv, setExpandedMaxCmv] = useState(false);

  async function loadWeek(wk?: string) {
    setLoading(true);
    try {
      const q = wk ? `?key=${encodeURIComponent(wk)}` : "";
      const res = await fetch(`/api/week${q}`);
      const json = await res.json();
      if (json.ok) {
        setReport(json);
        setWeekKey(json.semana_key);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadWeek();
  }, []);

  async function handleCopyPasteBlock(type: "resumen" | "categorias") {
    const res = await fetch(`/api/paste/week?key=${encodeURIComponent(weekKey)}`);
    const json = await res.json();
    if (json.ok) {
      const text = type === "resumen" ? json.tsv_resumen : json.tsv_categorias;
      await navigator.clipboard.writeText(text || "");
      setCopiedType(type);
      setTimeout(() => setCopiedType(null), 2000);
    }
  }

  function toggleCat(key: string) {
    setExpandedCats((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  if (loading && !report) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-muted-foreground">
          Cargando análisis y cierre semanal...
        </CardContent>
      </Card>
    );
  }

  const r = report?.resumen || {};
  const comp = report?.comparacion?.semana_anterior || {};
  const cats: Array<any> = report?.categorias || [];
  const maxCmvCat = report?.max_cmv_categoria;
  const fudoExpenses = report?.gastos_fudo?.items || [];
  const weeksAvail: Array<{ key: string; label: string }> =
    report?.semanas_disponibles || [];
  const narrativa: string[] = report?.narrativa || [];

  // Top 5-10 categorías con más ventas
  const topCategories = cats.slice(0, 10);

  return (
    <div className="space-y-6">
      {/* 1. Header con Selector y Acciones */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <CardTitle className="text-base font-bold">
                Cierre Semanal: {report?.label}
              </CardTitle>
              <Badge variant="outline" className="text-xs">
                {report?.dias_totales || 7} días
              </Badge>
            </div>
            <CardDescription className="text-xs mt-1">
              Rango: {report?.inicio} al {report?.fin} · Estado:{" "}
              <strong className="uppercase">{report?.status?.estado}</strong>
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={weekKey}
              onChange={(e) => loadWeek(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-xs font-medium"
            >
              {weeksAvail.map((w) => (
                <option key={w.key} value={w.key}>
                  {w.label} ({w.key})
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleCopyPasteBlock("resumen")}
            >
              {copiedType === "resumen" ? (
                <Check className="h-4 w-4 text-emerald-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              Copiar Fila Resumen (TSV)
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a
                href={`/api/export/week.csv?key=${encodeURIComponent(weekKey)}`}
                download
              >
                <Download className="h-4 w-4" />
                Exportar CSV
              </a>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border p-3">
              <span className="text-xs text-muted-foreground block">Ventas Semana</span>
              <span className="text-lg font-bold">{money(r.ingreso || 0)}</span>
              {comp?.mismatch_dias ? (
                <span className="text-[11px] text-muted-foreground block mt-0.5">
                  Promedio diario: {money(r.ingreso_promedio_diario || 0)}/d ({r.dias_totales}d)
                </span>
              ) : (
                comp?.ingreso?.pct !== null && (
                  <span className="text-[11px] text-muted-foreground block mt-0.5">
                    vs semana ant: {signed(comp.ingreso.pct, pct)}
                  </span>
                )
              )}
            </div>
            <div className="rounded-lg border p-3">
              <span className="text-xs text-muted-foreground block">CMV Receta</span>
              <span className="text-lg font-bold">
                {money(r.costo || 0)} ({pct(r.cmv_pct || 0)})
              </span>
              <span className="text-[11px] text-muted-foreground block mt-0.5">
                Margen Bruto: {pct(r.margen_bruto_pct || 0)}
              </span>
            </div>
            <div className="rounded-lg border p-3">
              <span className="text-xs text-muted-foreground block">Gastos Caja / Fudo</span>
              <span className="text-lg font-bold">{money(r.gastos_total || 0)}</span>
              <span className="text-[11px] text-muted-foreground block mt-0.5">
                Reposición: {money(r.gastos_reposicion || 0)}
              </span>
            </div>
            <div className="rounded-lg border p-3">
              <span className="text-xs text-muted-foreground block">Flujo Caja Neto</span>
              <span className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
                {money(r.ganancia_caja || 0)}
              </span>
              <span className="text-[11px] text-muted-foreground block mt-0.5">
                Margen Caja: {pct(r.margen_caja_pct || 0)}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 2. Sección de Información Relevante del Negocio (Cierre Analítico Normalizado) */}
      <Card className="border-primary/20 bg-muted/20">
        <CardHeader className="py-3 px-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm font-semibold">
              Cierre Analítico de Datos Relevantes para el Negocio
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="px-4 pb-4 pt-1 space-y-2">
          {narrativa.length > 0 ? (
            <div className="space-y-1.5 text-xs text-foreground/90">
              {narrativa.map((line, i) => (
                <p key={i} className="leading-relaxed">
                  {line.replace(/\*\*/g, "")}
                </p>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No hay notas analíticas suficientes para esta semana.
            </p>
          )}

          {comp?.mismatch_dias && (
            <div className="mt-2 rounded-md bg-amber-500/10 border border-amber-500/20 p-2.5 text-[11px] text-amber-800 dark:text-amber-200">
              <strong>Aviso de Normalización de Períodos:</strong> Se está comparando un período de {comp.dias_actual} días ({report?.label}) contra un período fraccionado de {comp.dias_anterior} días ({comp.label}). La comparación porcentual se calculó sobre el <em>promedio diario de facturación</em> ({money(r.ingreso_promedio_diario || 0)}/día vs {money(comp.promedio_diario?.anterior || 0)}/día, {signed(comp.promedio_diario?.pct, pct)}) para evitar distorsiones estadísticas.
            </div>
          )}
        </CardContent>
      </Card>

      {/* 3. Top Categorías por Participación en Facturación con Desplegable de Productos Estrella */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div>
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-emerald-500" />
              <CardTitle className="text-base font-semibold">
                Categorías con Mayor Participación en la Facturación
              </CardTitle>
            </div>
            <CardDescription className="text-xs">
              Hacé clic en cualquier categoría para desplegar sus productos estrella más vendidos
            </CardDescription>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => handleCopyPasteBlock("categorias")}
          >
            {copiedType === "categorias" ? (
              <Check className="h-4 w-4 text-emerald-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            Copiar Tabla Categorías (TSV)
          </Button>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10"></TableHead>
                  <TableHead>Categoría</TableHead>
                  <TableHead className="text-right">Part. %</TableHead>
                  <TableHead className="text-right">Unidades</TableHead>
                  <TableHead className="text-right">Ingreso</TableHead>
                  <TableHead className="text-right">Costo</TableHead>
                  <TableHead className="text-right">Ganancia</TableHead>
                  <TableHead className="text-right">CMV %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topCategories.map((c, idx) => {
                  const isExpanded = !!expandedCats[c.key];
                  const prods = c.productos_estrella || c.productos?.slice(0, 5) || [];
                  return (
                    <React.Fragment key={c.key}>
                      <TableRow
                        className="cursor-pointer hover:bg-muted/50 transition-colors"
                        onClick={() => toggleCat(c.key)}
                      >
                        <TableCell className="text-center p-2">
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground mx-auto" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground mx-auto" />
                          )}
                        </TableCell>
                        <TableCell className="font-medium text-xs">
                          <span className="font-semibold text-foreground">
                            {idx + 1}. {c.categoria}
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-xs font-semibold text-primary">
                          {pct(c.pct_venta || 0)}
                        </TableCell>
                        <TableCell className="text-right text-xs">{c.cantidad}</TableCell>
                        <TableCell className="text-right text-xs font-semibold">
                          {money(c.ingreso)}
                        </TableCell>
                        <TableCell className="text-right text-xs">{money(c.costo)}</TableCell>
                        <TableCell className="text-right text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                          {money(c.ganancia)}
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          <Badge
                            variant={
                              c.estado_cmv === "critico"
                                ? "destructive"
                                : c.estado_cmv === "atencion"
                                ? "warning"
                                : "success"
                            }
                            className="text-[10px]"
                          >
                            {pct(c.cmv_pct)}
                          </Badge>
                        </TableCell>
                      </TableRow>

                      {/* Fila desplegable de productos estrella de la categoría */}
                      {isExpanded && (
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableCell colSpan={8} className="p-3 pl-10">
                            <div className="rounded-lg border bg-background/80 p-3 shadow-xs space-y-2">
                              <div className="flex items-center justify-between text-xs font-semibold text-muted-foreground">
                                <span>Productos Estrella de &ldquo;{c.categoria}&rdquo;</span>
                                <span className="text-[11px] font-normal">
                                  Top {prods.length} por recaudación
                                </span>
                              </div>
                              <div className="divide-y divide-border text-xs">
                                {prods.length > 0 ? (
                                  prods.map((p: any, pIdx: number) => (
                                    <div
                                      key={pIdx}
                                      className="flex items-center justify-between py-1.5 gap-4"
                                    >
                                      <div className="flex items-center gap-2 min-w-0">
                                        <span className="text-[10px] text-muted-foreground w-4">
                                          #{pIdx + 1}
                                        </span>
                                        <span className="font-medium truncate">
                                          {p.producto}
                                        </span>
                                        <span className="text-[11px] text-muted-foreground">
                                          ({p.cantidad} u.)
                                        </span>
                                      </div>
                                      <div className="flex items-center gap-3 shrink-0">
                                        <span className="font-semibold text-foreground">
                                          {money(p.ingreso)}
                                        </span>
                                        <Badge
                                          variant={
                                            p.cmv_pct > 0.45
                                              ? "destructive"
                                              : p.cmv_pct > 0.35
                                              ? "warning"
                                              : "secondary"
                                          }
                                          className="text-[10px]"
                                        >
                                          CMV {pct(p.cmv_pct)}
                                        </Badge>
                                      </div>
                                    </div>
                                  ))
                                ) : (
                                  <div className="py-2 text-muted-foreground text-xs italic">
                                    No hay detalle individual de productos para esta categoría.
                                  </div>
                                )}
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
        </CardContent>
      </Card>

      {/* 4. Categoría con Más Alto CMV % con Desplegable de Productos */}
      {maxCmvCat && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                <div>
                  <CardTitle className="text-sm font-bold text-amber-900 dark:text-amber-100">
                    Categoría con Más Alto CMV %: {maxCmvCat.categoria} ({pct(maxCmvCat.cmv_pct)})
                  </CardTitle>
                  <CardDescription className="text-xs text-amber-800/80 dark:text-amber-300/80">
                    Facturó {money(maxCmvCat.ingreso)} con un costo teórico de {money(maxCmvCat.costo)}.
                  </CardDescription>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setExpandedMaxCmv(!expandedMaxCmv)}
                className="text-xs gap-1 border-amber-500/30"
              >
                {expandedMaxCmv ? "Ocultar Productos" : "Ver Productos"}
                {expandedMaxCmv ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </CardHeader>
          {expandedMaxCmv && (
            <CardContent className="pt-0">
              <div className="rounded-lg border border-amber-500/20 bg-background/95 p-3 space-y-2">
                <span className="text-xs font-semibold text-muted-foreground block">
                  Productos de {maxCmvCat.categoria} ordenados por mayor costo relativo
                </span>
                <div className="divide-y divide-border text-xs">
                  {(maxCmvCat.productos || [])
                    .slice()
                    .sort((a: any, b: any) => b.cmv_pct - a.cmv_pct)
                    .map((p: any, idx: number) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between py-1.5 gap-4"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-medium truncate">{p.producto}</span>
                          <span className="text-[11px] text-muted-foreground">
                            ({p.cantidad} u. vendidas · {money(p.ingreso)})
                          </span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs text-muted-foreground">
                            Costo: {money(p.costo)}
                          </span>
                          <Badge
                            variant={
                              p.cmv_pct > 0.45
                                ? "destructive"
                                : p.cmv_pct > 0.35
                                ? "warning"
                                : "secondary"
                            }
                            className="text-[10px]"
                          >
                            CMV {pct(p.cmv_pct)}
                          </Badge>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </CardContent>
          )}
        </Card>
      )}

      {/* 5. Gastos Fudo (Insumos y Materia Prima de la Semana) */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div>
            <div className="flex items-center gap-2">
              <Receipt className="h-4 w-4 text-primary" />
              <CardTitle className="text-base font-semibold">
                Gastos Fudo de la Semana (Insumos y Materia Prima)
              </CardTitle>
            </div>
            <CardDescription className="text-xs">
              Compras de materia prima registradas en Fudo que impactan en el costo de los productos
            </CardDescription>
          </div>
          <Badge variant="outline" className="text-xs font-semibold">
            Total Insumos: {money(r.gastos_reposicion || 0)}
          </Badge>
        </CardHeader>
        <CardContent>
          {fudoExpenses.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rubro / Categoría de Insumo</TableHead>
                    <TableHead className="text-center">Comprobantes</TableHead>
                    <TableHead className="text-right">Monto Total</TableHead>
                    <TableHead className="text-right">% del Gasto</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fudoExpenses.map((exp: any, idx: number) => (
                    <TableRow key={idx}>
                      <TableCell className="font-medium text-xs">
                        {exp.categoria}
                      </TableCell>
                      <TableCell className="text-center text-xs">
                        {exp.items}
                      </TableCell>
                      <TableCell className="text-right text-xs font-semibold">
                        {money(exp.monto)}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {pct(exp.pct)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="p-6 text-center text-xs text-muted-foreground border rounded-md">
              No hay gastos de insumos o materia prima de Fudo registrados para esta semana.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
