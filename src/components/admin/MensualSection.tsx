"use client";

import React, { useEffect, useState } from "react";
import { Download } from "lucide-react";
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
import { money, pct } from "@/lib/format";

export function MensualSection() {
  const [monthKey, setMonthKey] = useState<string>("");
  const [report, setReport] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadMonth(mk?: string) {
    setLoading(true);
    try {
      const q = mk ? `?key=${encodeURIComponent(mk)}` : "";
      const res = await fetch(`/api/month${q}`);
      const json = await res.json();
      if (json.ok) {
        setReport(json);
        setMonthKey(json.mes_key);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMonth();
  }, []);

  if (loading && !report) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-muted-foreground">
          Cargando consolidado mensual...
        </CardContent>
      </Card>
    );
  }

  const weeks: Array<any> = report?.semanas || [];
  const monthsAvail: Array<{ key: string; label: string }> =
    report?.meses_disponibles || [];
  const gastosPorCat: Array<any> = report?.gastos?.por_categoria || [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base">
              Consolidado Mensual: {report?.label}
            </CardTitle>
            <CardDescription>
              Resumen de las 5 semanas del mes ({report?.inicio} al {report?.fin})
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={monthKey}
              onChange={(e) => loadMonth(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-xs font-medium"
            >
              {monthsAvail.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label} ({m.key})
                </option>
              ))}
            </select>
            <Button variant="outline" size="sm" asChild>
              <a
                href={`/api/export/month.csv?key=${encodeURIComponent(monthKey)}`}
                download
              >
                <Download className="h-4 w-4" />
                Exportar Mes CSV
              </a>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border p-3">
              <span className="text-xs text-muted-foreground block">Ventas del Mes</span>
              <span className="text-lg font-bold">{money(report?.ingreso || 0)}</span>
            </div>
            <div className="rounded-lg border p-3">
              <span className="text-xs text-muted-foreground block">Ganancia Bruta</span>
              <span className="text-lg font-bold">
                {money(report?.ganancia_bruta || 0)} (CMV {pct(report?.cmv_pct || 0)})
              </span>
            </div>
            <div className="rounded-lg border p-3">
              <span className="text-xs text-muted-foreground block">Gastos Totales</span>
              <span className="text-lg font-bold">{money(report?.gastos_total || 0)}</span>
            </div>
            <div className="rounded-lg border p-3">
              <span className="text-xs text-muted-foreground block">Resultado Neto</span>
              <span className="text-lg font-bold text-primary">
                {money(report?.ganancia_neta || 0)}
              </span>
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Semana</TableHead>
                <TableHead className="text-right">Ventas</TableHead>
                <TableHead className="text-right">CMV</TableHead>
                <TableHead className="text-right">Ganancia Bruta</TableHead>
                <TableHead className="text-right">CMV %</TableHead>
                <TableHead className="text-right">Gastos</TableHead>
                <TableHead className="text-right">Flujo Caja</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {weeks.map((w) => (
                <TableRow key={w.semana_key}>
                  <TableCell className="font-medium">{w.label}</TableCell>
                  <TableCell className="text-right font-semibold">
                    {money(w.ingreso)}
                  </TableCell>
                  <TableCell className="text-right">{money(w.costo)}</TableCell>
                  <TableCell className="text-right">{money(w.ganancia_bruta)}</TableCell>
                  <TableCell className="text-right">{pct(w.cmv_pct)}</TableCell>
                  <TableCell className="text-right">{money(w.gastos_total)}</TableCell>
                  <TableCell className="text-right font-medium">
                    {money(w.ganancia_caja)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Gastos Mensuales por Rubro */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Gastos del Mes por Categoría</CardTitle>
          <CardDescription>
            Distribución entre reposición de mercadería y estructura fija
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Categoría</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead className="text-right">Comprobantes</TableHead>
                <TableHead className="text-right">% s/ Gastos</TableHead>
                <TableHead className="text-right">Monto</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {gastosPorCat.map((g, i) => (
                <TableRow key={i}>
                  <TableCell className="font-medium">{g.categoria}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {g.fijo ? "Estructura Fija" : "Reposición / Variable"}
                  </TableCell>
                  <TableCell className="text-right">{g.items}</TableCell>
                  <TableCell className="text-right">{pct(g.pct)}</TableCell>
                  <TableCell className="text-right font-semibold">
                    {money(g.monto)}
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

