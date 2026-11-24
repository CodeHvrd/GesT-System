"use client";

import React, { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ArrowUpRight,
  ArrowDownRight,
  DollarSign,
  TrendingUp,
  Wallet,
  Scale,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/input";
import { money, pct, shortMoney } from "@/lib/format";
import { VentasSection } from "./VentasSection";
import { GananciasSection } from "./GananciasSection";

interface DashboardSectionProps {
  data: Record<string, any>;
  onNavigateTab: (tab: string) => void;
}

function DeltaBadge({
  diffObj,
}: {
  diffObj?: { pct: number | null; diff: number };
}) {
  if (!diffObj || diffObj.pct === null || diffObj.pct === undefined) {
    return (
      <span className="text-xs text-muted-foreground">Sin base previa</span>
    );
  }
  const isPos = diffObj.pct >= 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-medium ${
        isPos
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-red-600 dark:text-red-400"
      }`}
    >
      {isPos ? (
        <ArrowUpRight className="h-3.5 w-3.5" />
      ) : (
        <ArrowDownRight className="h-3.5 w-3.5" />
      )}
      {pct(Math.abs(diffObj.pct))} vs ant.
    </span>
  );
}

export function DashboardSection({ data }: DashboardSectionProps) {
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [expandedCatKey, setExpandedCatKey] = useState<string | null>(null);
  const [showCanalesDetail, setShowCanalesDetail] = useState(false);
  const [showEcuacionDetail, setShowEcuacionDetail] = useState(false);

  const summary = data?.summary || {};
  const kpis = summary?.kpis || {};
  const comp = summary?.comparacion || {};
  const prog = data?.progress || {};
  const daily: Array<any> = data?.daily || [];
  const cats: Array<any> = data?.categories?.items || [];
  const canais: Array<any> = summary?.canales || [];

  const maxDailySale = Math.max(
    1,
    ...daily.map((d) => Math.max(Number(d.ventas || 0), Number(d.gastos || 0)))
  );

  function toggleExpand(id: string) {
    setExpandedCard((prev) => (prev === id ? null : id));
  }

  function toggleCat(key: string) {
    setExpandedCatKey((prev) => (prev === key ? null : key));
  }

  return (
    <div className="space-y-5">
      {/* 1. 4 Tarjetas KPI Principales (cerradas por defecto, clic para desglose) */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        {/* KPI 1: Ventas Netas */}
        <Card
          className="cursor-pointer transition-shadow hover:shadow-md"
          onClick={() => toggleExpand("ventas")}
        >
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription className="font-medium">
                Ventas Netas
              </CardDescription>
              <DollarSign className="h-4 w-4 text-primary" />
            </div>
            <CardTitle className="text-2xl font-bold">
              {money(kpis.ventas_netas || 0)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between">
              <DeltaBadge diffObj={comp.ventas_netas} />
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                Canales{" "}
                {expandedCard === "ventas" ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </span>
            </div>
            {expandedCard === "ventas" && (
              <div className="mt-3 space-y-1.5 border-t pt-2.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tickets:</span>
                  <span className="font-semibold">
                    {kpis.tickets || 0} (prom.{" "}
                    {money(kpis.ticket_promedio || 0)})
                  </span>
                </div>
                {canais.map((c) => (
                  <div key={c.canal} className="flex justify-between">
                    <span className="text-muted-foreground">{c.label}:</span>
                    <span className="font-medium">
                      {money(c.ventas)} ({pct(c.pct_venta)})
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* KPI 2: Ganancia Bruta y CMV */}
        <Card
          className="cursor-pointer transition-shadow hover:shadow-md"
          onClick={() => toggleExpand("ganancia_bruta")}
        >
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription className="font-medium">
                Ganancia Bruta
              </CardDescription>
              <TrendingUp className="h-4 w-4 text-emerald-600" />
            </div>
            <CardTitle className="text-2xl font-bold">
              {money(kpis.ganancia_bruta || 0)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between">
              <Badge
                variant={
                  (kpis.cmv_pct || 0) >
                  (kpis.cmv_objetivo_general || 0.35) + 0.03
                    ? "destructive"
                    : "success"
                }
              >
                CMV: {pct(kpis.cmv_pct || 0)}
              </Badge>
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                Margen {pct(kpis.margen_bruto_pct || 0)}
                {expandedCard === "ganancia_bruta" ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </span>
            </div>
            {expandedCard === "ganancia_bruta" && (
              <div className="mt-3 space-y-1.5 border-t pt-2.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">CMV Recetas:</span>
                  <span className="font-semibold">{money(kpis.cmv || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Meta CMV:</span>
                  <span className="font-semibold">
                    {pct(kpis.cmv_objetivo_general || 0.35)}
                  </span>
                </div>
                {kpis.sin_costear_count > 0 && (
                  <div className="text-amber-600 dark:text-amber-400 font-medium">
                    ⚠ {kpis.sin_costear_count} prod. sin costo (
                    {money(kpis.sin_costear_monto)})
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* KPI 3: Gastos Consolidados */}
        <Card
          className="cursor-pointer transition-shadow hover:shadow-md"
          onClick={() => toggleExpand("gastos")}
        >
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription className="font-medium">
                Gastos Totales
              </CardDescription>
              <Wallet className="h-4 w-4 text-amber-600" />
            </div>
            <CardTitle className="text-2xl font-bold">
              {money(kpis.gastos_totales || 0)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between">
              <DeltaBadge diffObj={comp.gastos_totales} />
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                Desglose{" "}
                {expandedCard === "gastos" ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </span>
            </div>
            {expandedCard === "gastos" && (
              <div className="mt-3 space-y-1.5 border-t pt-2.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Gastos Fudo (Insumos):
                  </span>
                  <span className="font-semibold">
                    {money(kpis.gastos_reposicion || 0)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Externos / Caja Principal:
                  </span>
                  <span className="font-semibold">
                    {money(kpis.gastos_externos_puntuales || 0)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Gastos Fijos / Caja Grande:
                  </span>
                  <span className="font-semibold">
                    {money(kpis.gastos_fijos_totales || 0)}
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* KPI 4: Ganancia Neta y Caja */}
        <Card
          className="cursor-pointer transition-shadow hover:shadow-md"
          onClick={() => toggleExpand("neta")}
        >
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription className="font-medium">
                Resultado Neto / Caja
              </CardDescription>
              <Scale className="h-4 w-4 text-primary" />
            </div>
            <CardTitle
              className={`text-2xl font-bold ${
                (kpis.ganancia_neta || 0) < 0
                  ? "text-red-600 dark:text-red-400"
                  : ""
              }`}
            >
              {money(kpis.ganancia_neta || 0)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Caja:{" "}
                <strong className="text-foreground">
                  {money(kpis.ganancia_caja || 0)}
                </strong>
              </span>
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                {pct(kpis.margen_neto_pct || 0)}
                {expandedCard === "neta" ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </span>
            </div>
            {expandedCard === "neta" && (
              <div className="mt-3 space-y-1.5 border-t pt-2.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Resultado Operativo (Receta):
                  </span>
                  <span className="font-semibold">
                    {money(kpis.ganancia_neta || 0)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Flujo de Caja Real:
                  </span>
                  <span className="font-semibold">
                    {money(kpis.ganancia_caja || 0)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Cobertura Gastos Fijos:
                  </span>
                  <span className="font-semibold">
                    {pct(prog.cobertura_fijos_pct || 0)}
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 2. Categorías que más venden (con desplegable de artículos) + Gráfico Diario */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Categorías con desplegable de artículos más vendidos */}
        <Card className="lg:col-span-5">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Categorías que Más Venden
            </CardTitle>
            <CardDescription className="text-xs">
              Tocá cualquier categoría para desplegar sus artículos más vendidos
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {cats.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Sin ventas por categoría en este período.
              </p>
            ) : (
              cats.slice(0, 8).map((c) => {
                const isOpen = expandedCatKey === c.key;
                const prods: Array<any> = (c.productos || []).slice(0, 6);
                return (
                  <div
                    key={c.key}
                    className="rounded-lg border p-2.5 transition-colors hover:bg-muted/30"
                  >
                    <button
                      type="button"
                      onClick={() => toggleCat(c.key)}
                      className="w-full text-left space-y-1.5"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold flex items-center gap-1.5 truncate max-w-[180px]">
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5 text-primary shrink-0" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          )}
                          <span className="truncate">{c.categoria}</span>
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="font-bold">
                            {shortMoney(c.ingreso)}
                          </span>
                          <Badge
                            variant={
                              c.estado_cmv === "critico"
                                ? "destructive"
                                : c.estado_cmv === "atencion"
                                  ? "warning"
                                  : "success"
                            }
                            className="px-1.5 py-0 text-[10px]"
                          >
                            CMV {pct(c.cmv_pct)}
                          </Badge>
                        </div>
                      </div>
                      <Progress value={Math.round((c.pct_venta || 0) * 100)} />
                    </button>

                    {isOpen && (
                      <div className="mt-2.5 border-t pt-2 space-y-1 text-xs">
                        {prods.length === 0 ? (
                          <div className="text-muted-foreground italic">
                            Sin detalle de artículos.
                          </div>
                        ) : (
                          prods.map((p, idx) => (
                            <div
                              key={idx}
                              className="flex items-center justify-between py-1 text-[11px]"
                            >
                              <span className="truncate max-w-[170px] font-medium">
                                {idx + 1}. {p.producto}{" "}
                                <span className="text-muted-foreground font-normal">
                                  ({p.cantidad} u.)
                                </span>
                              </span>
                              <span className="font-semibold">
                                {money(p.ingreso)}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* Evolución Diaria */}
        <Card className="lg:col-span-7">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">
                  Evolución Diaria: Ventas vs Gastos
                </CardTitle>
                <CardDescription className="text-xs">
                  Ingresos netos, ganancia bruta y egresos por día
                </CardDescription>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-primary" /> Ventas
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />{" "}
                  Ganancia
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />{" "}
                  Gastos
                </span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {daily.length === 0 ? (
              <div className="flex h-52 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                No hay registros diarios para graficar en este rango de fechas.
              </div>
            ) : (
              <div className="flex h-56 items-end gap-1.5 overflow-x-auto pt-4 pb-2 px-1">
                {daily.map((d) => {
                  const hVentas = Math.round(
                    (Number(d.ventas || 0) / maxDailySale) * 170
                  );
                  const hGan = Math.round(
                    (Number(d.ganancia || 0) / maxDailySale) * 170
                  );
                  const hGas = Math.round(
                    (Number(d.gastos || 0) / maxDailySale) * 170
                  );
                  return (
                    <div
                      key={d.fecha}
                      className="group flex flex-1 min-w-[26px] flex-col items-center gap-1"
                      title={`${d.fecha}\nVentas: ${money(d.ventas)}\nGanancia: ${money(d.ganancia)}\nGastos: ${money(d.gastos)}`}
                    >
                      <div className="flex items-end gap-0.5 h-44 w-full justify-center">
                        <div
                          className="w-2.5 rounded-t bg-primary transition-all group-hover:opacity-80"
                          style={{ height: `${Math.max(4, hVentas)}px` }}
                        />
                        <div
                          className="w-2 rounded-t bg-emerald-500 transition-all group-hover:opacity-80"
                          style={{ height: `${Math.max(2, hGan)}px` }}
                        />
                        {d.gastos > 0 && (
                          <div
                            className="w-2 rounded-t bg-amber-500 transition-all group-hover:opacity-80"
                            style={{ height: `${Math.max(2, hGas)}px` }}
                          />
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        {String(d.fecha).slice(5)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 3. Desplegables Profundos (Canales, Medios de Pago y Ecuación de Ganancia) */}
      <div className="space-y-3">
        <Card>
          <button
            type="button"
            onClick={() => setShowCanalesDetail(!showCanalesDetail)}
            className="flex w-full items-center justify-between p-4 text-left"
          >
            <div>
              <div className="text-sm font-semibold">
                Desglose por Canal (Salón, Take Away, Delivery) y Medios de Pago
              </div>
              <div className="text-xs text-muted-foreground">
                Comparativa de tickets por canal, cobros efectivo/virtual y
                listado de productos vendidos
              </div>
            </div>
            <Badge variant="outline" className="gap-1 text-xs">
              {showCanalesDetail ? "Ocultar" : "Desplegar"}
              {showCanalesDetail ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </Badge>
          </button>
          {showCanalesDetail && (
            <CardContent className="border-t pt-4">
              <VentasSection data={data} />
            </CardContent>
          )}
        </Card>

        <Card>
          <button
            type="button"
            onClick={() => setShowEcuacionDetail(!showEcuacionDetail)}
            className="flex w-full items-center justify-between p-4 text-left"
          >
            <div>
              <div className="text-sm font-semibold">
                Ecuación Completa de Ganancias, Auditoría de Meta CMV y
                Productos sin Costo ($0)
              </div>
              <div className="text-xs text-muted-foreground">
                Cascada paso a paso entre resultado por receta y flujo de caja
                real
              </div>
            </div>
            <Badge variant="outline" className="gap-1 text-xs">
              {showEcuacionDetail ? "Ocultar" : "Desplegar"}
              {showEcuacionDetail ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </Badge>
          </button>
          {showEcuacionDetail && (
            <CardContent className="border-t pt-4">
              <GananciasSection data={data} />
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}
