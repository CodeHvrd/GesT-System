"use client";

import React, { useEffect, useState } from "react";
import { Download, Search, ShieldAlert } from "lucide-react";
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

export function DatosSection() {
  const [expensesData, setExpensesData] = useState<Record<string, any>>({
    items: [],
    total_count: 0,
    total_monto: 0,
    filtros: { categorias: [], proveedores: [], meses: [] },
  });
  const [qualityData, setQualityData] = useState<Record<string, any> | null>(null);
  const [q, setQ] = useState("");
  const [mes, setMes] = useState("");
  const [categoria, setCategoria] = useState("");

  async function loadAll() {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (mes) params.set("mes", mes);
    if (categoria) params.set("categoria", categoria);

    const [expRes, qualRes] = await Promise.all([
      fetch(`/api/expenses?${params.toString()}`),
      fetch("/api/quality"),
    ]);
    const expJson = await expRes.json();
    const qualJson = await qualRes.json();
    if (expJson.ok) setExpensesData(expJson);
    if (qualJson.ok) setQualityData(qualJson);
  }

  useEffect(() => {
    loadAll();
  }, [mes, categoria]);

  const qRes = qualityData?.resumen || {};

  return (
    <div className="space-y-6">
      {/* Auditoría de Calidad de Datos */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-500" />
            <div>
              <CardTitle className="text-base">
                Detector de Calidad e Integridad de Datos
              </CardTitle>
              <CardDescription>
                Identificación automática de filas incompletas, posibles duplicados o fechas fuera de mes
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="rounded-lg border p-3">
              <span className="text-xs text-muted-foreground block">Posibles Duplicados</span>
              <span className="text-lg font-bold text-amber-600">
                {qRes.duplicados || 0}
              </span>
            </div>
            <div className="rounded-lg border p-3">
              <span className="text-xs text-muted-foreground block">Sin Fecha</span>
              <span className="text-lg font-bold">{qRes.sin_fecha || 0}</span>
            </div>
            <div className="rounded-lg border p-3">
              <span className="text-xs text-muted-foreground block">Monto $0 / Inválido</span>
              <span className="text-lg font-bold">{qRes.sin_monto || 0}</span>
            </div>
            <div className="rounded-lg border p-3">
              <span className="text-xs text-muted-foreground block">Sin Categoría</span>
              <span className="text-lg font-bold">{qRes.sin_categoria || 0}</span>
            </div>
            <div className="rounded-lg border p-3">
              <span className="text-xs text-muted-foreground block">Desajuste Mes/Fecha</span>
              <span className="text-lg font-bold">{qRes.desajuste_mes || 0}</span>
            </div>
          </div>

          {qualityData?.duplicados?.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                Detalle de Posibles Gastos Duplicados
              </h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Proveedor</TableHead>
                    <TableHead>Categoría</TableHead>
                    <TableHead className="text-right">Monto</TableHead>
                    <TableHead className="text-right">Repeticiones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(qualityData?.duplicados || []).slice(0, 10).map((d: any, idx: number) => (
                    <TableRow key={idx}>
                      <TableCell>{d.fecha}</TableCell>
                      <TableCell className="font-medium">{d.proveedor}</TableCell>
                      <TableCell>{d.categoria}</TableCell>
                      <TableCell className="text-right font-semibold">
                        {money(d.monto)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge variant="warning">{d.repeticiones}x (filas {d.filas})</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Explorador Completo de Gastos */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base">
              Explorador de Gastos ({expensesData.total_count} registros · Total{" "}
              {money(expensesData.total_monto || 0)})
            </CardTitle>
            <CardDescription>
              Buscá y exportá comprobantes por mes, rubro o proveedor
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={mes}
              onChange={(e) => setMes(e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2.5 text-xs"
            >
              <option value="">Todos los meses</option>
              {(expensesData.filtros?.meses || []).map((m: string) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>

            <select
              value={categoria}
              onChange={(e) => setCategoria(e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2.5 text-xs"
            >
              <option value="">Todas las categorías</option>
              {(expensesData.filtros?.categorias || []).map((c: string) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-1">
              <Input
                placeholder="Buscar texto..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && loadAll()}
                className="h-8 w-44 text-xs"
              />
              <Button variant="secondary" size="sm" className="h-8" onClick={loadAll}>
                <Search className="h-3.5 w-3.5" />
              </Button>
            </div>

            <Button variant="outline" size="sm" className="h-8" asChild>
              <a
                href={`/api/export/expenses.csv?mes=${encodeURIComponent(mes)}`}
                download
              >
                <Download className="h-3.5 w-3.5" />
                CSV
              </a>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Mes</TableHead>
                <TableHead>Categoría</TableHead>
                <TableHead>Proveedor</TableHead>
                <TableHead>Descripción</TableHead>
                <TableHead>Pago</TableHead>
                <TableHead className="text-right">Monto</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(expensesData.items || []).slice(0, 100).map((item: any) => (
                <TableRow key={item.id}>
                  <TableCell className="text-xs whitespace-nowrap">{item.fecha}</TableCell>
                  <TableCell className="text-xs">{item.mes_key}</TableCell>
                  <TableCell className="font-medium">{item.categoria}</TableCell>
                  <TableCell>{item.proveedor || "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {item.descripcion || "—"}
                  </TableCell>
                  <TableCell className="text-xs">{item.medio_pago || "—"}</TableCell>
                  <TableCell className="text-right font-semibold">
                    {money(item.monto)}
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
