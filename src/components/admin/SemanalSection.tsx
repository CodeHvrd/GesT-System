"use client";

import React, { useEffect, useState } from "react";
import { Copy, Download, Check } from "lucide-react";
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
import { money, pct } from "@/lib/format";

export function SemanalSection() {
  const [weekKey, setWeekKey] = useState<string>("");
  const [report, setReport] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedType, setCopiedType] = useState<string | null>(null);

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

  if (loading && !report) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-muted-foreground">
          Cargando análisis semanal...
        </CardContent>
      </Card>
    );
  }

  const r = report?.resumen || {};
  const cats: Array<any> = report?.categorias || [];
  const weeksAvail: Array<{ key: string; label: string }> =
    report?.semanas_disponibles || [];
  const narrativa: string[] = report?.narrativa || [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base">
              Cierre Semanal (Bloques S1 a S5): {report?.label}
            </CardTitle>
            <CardDescription>
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
            </div>
            <div className="rounded-lg border p-3">
              <span className="text-xs text-muted-foreground block">CMV Receta</span>
              <span className="text-lg font-bold">
                {money(r.costo || 0)} ({pct(r.cmv_pct || 0)})
              </span>
            </div>
            <div className="rounded-lg border p-3">
              <span className="text-xs text-muted-foreground block">Gastos Caja</span>
              <span className="text-lg font-bold">{money(r.gastos_total || 0)}</span>
            </div>
            <div className="rounded-lg border p-3">
              <span className="text-xs text-muted-foreground block">Flujo Caja Neto</span>
              <span className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
                {money(r.ganancia_caja || 0)}
              </span>
            </div>
          </div>

          {narrativa.length > 0 && (
            <div className="rounded-lg bg-muted/40 p-3.5 text-xs space-y-1.5">
              {narrativa.map((line, i) => (
                <p key={i}>{line.replace(/\*\*/g, "")}</p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Desglose Semanal por Categoría</CardTitle>
            <CardDescription>
              Lista lista para copiar y pegar en la hoja semanal de Google Sheets
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Categoría</TableHead>
                <TableHead className="text-right">Unidades</TableHead>
                <TableHead className="text-right">Ingreso</TableHead>
                <TableHead className="text-right">Costo</TableHead>
                <TableHead className="text-right">Ganancia</TableHead>
                <TableHead className="text-right">CMV %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cats.map((c) => (
                <TableRow key={c.key}>
                  <TableCell className="font-medium">{c.categoria}</TableCell>
                  <TableCell className="text-right">{c.cantidad}</TableCell>
                  <TableCell className="text-right font-semibold">
                    {money(c.ingreso)}
                  </TableCell>
                  <TableCell className="text-right">{money(c.costo)}</TableCell>
                  <TableCell className="text-right text-emerald-600 dark:text-emerald-400">
                    {money(c.ganancia)}
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
                      {pct(c.cmv_pct)}
                    </Badge>
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

