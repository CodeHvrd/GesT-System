"use client";

import React, { useState } from "react";
import {
  ChevronDown,
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

interface DashboardSectionProps {
  data: Record<string, any>;
  onNavigateTab: (tab: string) => void;
}

function DeltaBadge({ diffObj }: { diffObj?: { pct: number | null; diff: number } }) {
  if (!diffObj || diffObj.pct === null || diffObj.pct === undefined) {
    return <span className="text-xs text-muted-foreground">Sin base previa</span>;
  }
  const isPos = diffObj.pct >= 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-medium ${
        isPos ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
      }`}
    >
      {isPos ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
      {pct(Math.abs(diffObj.pct))} vs período ant.
    </span>
  );
}

export function DashboardSection({ data, onNavigateTab }: DashboardSectionProps) {
  const [expandedCard, setExpandedCard] = useState<string | null>("ventas");

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

  return (
    <div className="space-y-6">
      {/* 4 Tarjetas KPI Principales (Expandibles) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {/* KPI 1: Ventas Netas */}
        <Card
          className="cursor-pointer transition-shadow hover:shadow-md"
          onClick={() => toggleExpand("ventas")}
        >
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardDescription className="font-medium">Ventas Netas</CardDescription>
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
                Detalle {expandedCard === "ventas" ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </span>
            </div>
            {expandedCard === "ventas" && (
              <div className="mt-3 space-y-1.5 border-t pt-2.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tickets emitidos:</span>
                  <span className="font-semibold">{kpis.tickets || 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Ticket promedio:</span>
                  <span className="font-semibold">{money(kpis.ticket_promedio || 0)}</span>
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
              <CardDescription className="font-medium">Ganancia Bruta</CardDescription>
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
                  (kpis.cmv_pct || 0) > (kpis.cmv_objetivo_general || 0.35) + 0.03
                    ? "destructive"
                    : "success"
                }
              >
                CMV: {pct(kpis.cmv_pct || 0)}
              </Badge>
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                Margen {pct(kpis.margen_bruto_pct || 0)}
                {expandedCard === "ganancia_bruta" ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </span>
            </div>
            {expandedCard === "ganancia_bruta" && (
              <div className="mt-3 space-y-1.5 border-t pt-2.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">CMV por Recetas:</span>
                  <span className="font-semibold">{money(kpis.cmv || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Meta CMV General:</span>
                  <span className="font-semibold">{pct(kpis.cmv_objetivo_general || 0.35)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Comisiones:</span>
                  <span className="font-semibold">{money(kpis.comisiones || 0)}</span>
                </div>
                {kpis.sin_costear_count > 0 && (
                  <div className="text-amber-600 dark:text-amber-400 font-medium">
                    ⚠ {kpis.sin_costear_count} prod. sin costo ({money(kpis.sin_costear_monto)})
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
              <CardDescription className="font-medium">Gastos Totales</CardDescription>
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
                Desglose {expandedCard === "gastos" ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </span>
            </div>
            {expandedCard === "gastos" && (
              <div className="mt-3 space-y-1.5 border-t pt-2.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Reposición / Proveedores:</span>
                  <span className="font-semibold">{money(kpis.gastos_reposicion || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Gastos Fijos Consolidados:</span>
                  <span className="font-semibold">{money(kpis.gastos_fijos_totales || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Externos Puntuales:</span>
                  <span className="font-semibold">{money(kpis.gastos_externos_puntuales || 0)}</span>
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
              <CardDescription className="font-medium">Resultado Neto / Caja</CardDescription>
              <Scale className="h-4 w-4 text-primary" />
            </div>
            <CardTitle
              className={`text-2xl font-bold ${
                (kpis.ganancia_neta || 0) < 0 ? "text-red-600 dark:text-red-400" : ""
              }`}
            >
              {money(kpis.ganancia_neta || 0)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Flujo Caja: <strong className="text-foreground">{money(kpis.ganancia_caja || 0)}</strong>
              </span>
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                {pct(kpis.margen_neto_pct || 0)}
                {expandedCard === "neta" ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </span>
            </div>
            {expandedCard === "neta" && (
              <div className="mt-3 space-y-1.5 border-t pt-2.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Resultado Operativo (Receta):</span>
                  <span className="font-semibold">{money(kpis.ganancia_neta || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Flujo de Caja (Compras Reales):</span>
                  <span className="font-semibold">{money(kpis.ganancia_caja || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Cobertura Gastos Fijos:</span>
                  <span className="font-semibold">{pct(prog.cobertura_fijos_pct || 0)}</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Avance de Meta y Evolución Diaria */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Evolución Diaria: Ventas vs Gastos</CardTitle>
                <CardDescription>
                  Ingresos netos, CMV teórico y egresos diarios en el período seleccionado
                </CardDescription>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-primary" /> Ventas
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Ganancia Bruta
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Gastos
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
              <div className="space-y-3">
                <div className="flex h-52 items-end gap-1.5 overflow-x-auto pt-4 pb-2 px-1">
                  {daily.map((d) => {
                    const hVentas = Math.round((Number(d.ventas || 0) / maxDailySale) * 160);
                    const hGan = Math.round((Number(d.ganancia || 0) / maxDailySale) * 160);
                    const hGas = Math.round((Number(d.gastos || 0) / maxDailySale) * 160);
                    return (
                      <div
                        key={d.fecha}
                        className="group flex flex-1 min-w-[28px] flex-col items-center gap-1"
                        title={`${d.fecha}\nVentas: ${money(d.ventas)}\nGanancia: ${money(d.ganancia)}\nGastos: ${money(d.gastos)}`}
                      >
                        <div className="flex items-end gap-0.5 h-40 w-full justify-center">
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
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top Categorías y Meta */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Principales Categorías</CardTitle>
            <CardDescription>
              Participación en ventas y semáforo de CMV por rubro
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {cats.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Sin ventas por categoría en este período.
              </p>
            ) : (
              cats.slice(0, 6).map((c) => (
                <div key={c.key} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium truncate max-w-[160px]">{c.categoria}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{shortMoney(c.ingreso)}</span>
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
                </div>
              ))
            )}

            <div className="pt-2 border-t flex justify-between items-center text-xs">
              <span className="text-muted-foreground">Punto de equilibrio fijos:</span>
              <span className="font-semibold">{money(prog.punto_equilibrio_fijos || 0)}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

