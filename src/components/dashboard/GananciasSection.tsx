"use client";

import React from "react";
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
import { Badge } from "@/components/ui/badge";
import { money, pct, safeDiv } from "@/lib/format";

interface GananciasSectionProps {
  data: Record<string, any>;
}

export function GananciasSection({ data }: GananciasSectionProps) {
  const summary = data?.summary || {};
  const kpis = summary?.kpis || {};
  const eq = summary?.ecuacion_ganancia || {};
  const categories: Array<any> = data?.categories?.items || [];
  const sinCostear: Array<any> = data?.categories?.sin_costear || [];

  const ventas = Number(eq.ventas_netas || 0);

  const steps = [
    {
      label: "(+) Ventas Netas Facturadas",
      monto: ventas,
      pctOfSales: 1,
      tone: "font-bold text-foreground",
      desc: "Ingresos netos de descuentos en todos los canales seleccionados",
    },
    {
      label: "(−) Costo de Mercadería Vendida (CMV por Recetas)",
      monto: -Number(eq.menos_cmv || 0),
      pctOfSales: safeDiv(Number(eq.menos_cmv || 0), ventas),
      tone: "text-amber-600 dark:text-amber-400",
      desc: "Costo teórico calculado según recetas e ingredientes en Fudo",
    },
    {
      label: "(−) Comisiones de Plataformas y Medios de Pago",
      monto: -Number(eq.menos_comisiones || 0),
      pctOfSales: safeDiv(Number(eq.menos_comisiones || 0), ventas),
      tone: "text-amber-600 dark:text-amber-400",
      desc: "Descuentos por apps de delivery y procesadores de pago",
    },
    {
      label: "(=) Ganancia Bruta Operativa",
      monto: Number(eq.igual_ganancia_bruta || 0),
      pctOfSales: safeDiv(Number(eq.igual_ganancia_bruta || 0), ventas),
      tone: "font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/5",
      desc: "Margen disponible para cubrir estructura fija y gastos externos",
    },
    {
      label: "(−) Gastos Externos Puntuales (Fuera de Fudo)",
      monto: -Number(eq.menos_gastos_externos || 0),
      pctOfSales: safeDiv(Number(eq.menos_gastos_externos || 0), ventas),
      tone: "text-red-600 dark:text-red-400",
      desc: "Mantenimiento, reparaciones o compras eventuales fuera de caja",
    },
    {
      label: "(−) Gastos Fijos Consolidados (Sueldos, Alquiler, Servicios)",
      monto: -Number(eq.menos_gastos_fijos || 0),
      pctOfSales: safeDiv(Number(eq.menos_gastos_fijos || 0), ventas),
      tone: "text-red-600 dark:text-red-400",
      desc: "Suma de gastos fijos en planilla más fijos externos prorrateados al período",
    },
    {
      label: "(=) Ganancia Neta Operativa (Base Devengado / Receta)",
      monto: Number(eq.igual_ganancia_neta || 0),
      pctOfSales: safeDiv(Number(eq.igual_ganancia_neta || 0), ventas),
      tone: "font-bold text-primary bg-primary/5",
      desc: "Rentabilidad económica real del negocio en el período",
    },
    {
      label: "(=) Flujo de Caja Neto (Reemplazando CMV por Compras de Reposición)",
      monto: Number(eq.igual_ganancia_caja || 0),
      pctOfSales: safeDiv(Number(eq.igual_ganancia_caja || 0), ventas),
      tone: "font-semibold text-foreground bg-muted/40",
      desc: `Considerando pagos reales a proveedores por ${money(eq.menos_reposicion || 0)}`,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Cascada de la Ecuación de Ganancias */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Ecuación Integral de Ganancias y Flujo de Caja
          </CardTitle>
          <CardDescription>
            Comparativa paso a paso entre resultado económico (por CMV de receta) y resultado financiero (caja real)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Concepto</TableHead>
                <TableHead>Explicación</TableHead>
                <TableHead className="text-right">% s/ Venta</TableHead>
                <TableHead className="text-right">Monto</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {steps.map((s, idx) => (
                <TableRow key={idx} className={s.tone}>
                  <TableCell className="font-medium">{s.label}</TableCell>
                  <TableCell className="text-xs text-muted-foreground font-normal">
                    {s.desc}
                  </TableCell>
                  <TableCell className="text-right">{pct(s.pctOfSales)}</TableCell>
                  <TableCell className="text-right text-base">
                    {money(s.monto)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Control de Objetivos de CMV por Categoría */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Auditoría de CMV Real vs Meta por Rubro
            </CardTitle>
            <CardDescription>
              Impacto en pesos de cada categoría según su desvío respecto al objetivo configurado
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rubro</TableHead>
                  <TableHead className="text-right">CMV Actual</TableHead>
                  <TableHead className="text-right">Meta</TableHead>
                  <TableHead className="text-right">Desvío</TableHead>
                  <TableHead className="text-right">Impacto ($)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.map((c) => {
                  const obj = Number(c.objetivo || kpis.cmv_objetivo_general || 0.35);
                  const impacto = (c.cmv_pct - obj) * c.ingreso;
                  return (
                    <TableRow key={c.key}>
                      <TableCell className="font-medium">{c.categoria}</TableCell>
                      <TableCell className="text-right font-semibold">
                        {pct(c.cmv_pct)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {pct(obj)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant={
                            c.estado_cmv === "critico"
                              ? "destructive"
                              : c.estado_cmv === "atencion"
                              ? "warning"
                              : "success"
                          }
                        >
                          {c.desvio_pp > 0 ? `+${c.desvio_pp}` : c.desvio_pp} pp
                        </Badge>
                      </TableCell>
                      <TableCell
                        className={`text-right font-medium ${
                          impacto > 0
                            ? "text-red-600 dark:text-red-400"
                            : "text-emerald-600 dark:text-emerald-400"
                        }`}
                      >
                        {impacto > 0
                          ? `-${money(impacto)}`
                          : `+${money(Math.abs(impacto))}`}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Productos vendidos sin receta / costo $0 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Productos Vendidos sin Costo ($0 en Fudo)
            </CardTitle>
            <CardDescription>
              Artículos que facturaron en este período pero no tienen receta ni costo asignado
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sinCostear.length === 0 ? (
              <div className="rounded-lg border bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-300">
                Excelente: todos los productos vendidos en este período tienen costo asignado.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Producto</TableHead>
                    <TableHead className="text-right">Unid.</TableHead>
                    <TableHead className="text-right">Facturación</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sinCostear.slice(0, 15).map((p, idx) => (
                    <TableRow key={idx}>
                      <TableCell className="font-medium">{p.producto}</TableCell>
                      <TableCell className="text-right">{p.cantidad}</TableCell>
                      <TableCell className="text-right font-semibold text-amber-600">
                        {money(p.ingreso)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

