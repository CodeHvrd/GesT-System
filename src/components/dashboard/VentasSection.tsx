"use client";

import React, { useState } from "react";
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
import { Progress } from "@/components/ui/input";
import { money, pct } from "@/lib/format";

interface VentasSectionProps {
  data: Record<string, any>;
}

export function VentasSection({ data }: VentasSectionProps) {
  const [selectedCat, setSelectedCat] = useState<string | null>(null);

  const summary = data?.summary || {};
  const canais: Array<any> = summary?.canales || [];
  const medios: Array<any> = summary?.medios_pago || [];
  const categories: Array<any> = data?.categories?.items || [];
  const topProducts: Array<any> = data?.categories?.top_productos || [];

  const activeCategoryObj = categories.find((c) => c.key === selectedCat);

  return (
    <div className="space-y-6">
      {/* Desglose por Canal: Salón, Take Away, Delivery */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {canais.map((c) => (
          <Card key={c.canal}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardDescription className="font-semibold text-foreground">
                  {c.label}
                </CardDescription>
                <Badge variant="secondary">{pct(c.pct_venta)} del total</Badge>
              </div>
              <CardTitle className="text-2xl font-bold">{money(c.ventas)}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <Progress value={Math.round((c.pct_venta || 0) * 100)} />
              <div className="grid grid-cols-2 gap-2 pt-2">
                <div>
                  <span className="text-muted-foreground block">Tickets</span>
                  <span className="font-semibold">{c.tickets}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">Ticket Promedio</span>
                  <span className="font-semibold">{money(c.ticket_promedio)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">CMV Canal</span>
                  <span className="font-semibold">
                    {money(c.cmv)} ({pct(c.cmv_pct)})
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground block">Ganancia Canal</span>
                  <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                    {money(c.ganancia)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Medios de Pago y Categorías */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Medios de Pago</CardTitle>
            <CardDescription>Distribución de cobros en el período</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {medios.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Sin desglose de medios de pago en este período.
              </p>
            ) : (
              medios.map((m) => (
                <div key={m.key} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="font-medium">{m.label}</span>
                    <span className="font-semibold">
                      {money(m.monto)} ({pct(m.pct)})
                    </span>
                  </div>
                  <Progress value={Math.round((m.pct || 0) * 100)} />
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">
              Ventas por Categoría (clic en una fila para ver sus productos)
            </CardTitle>
            <CardDescription>
              Facturación, costo por receta, margen bruto y comparación contra objetivo
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Categoría</TableHead>
                  <TableHead className="text-right">Unid.</TableHead>
                  <TableHead className="text-right">Ventas</TableHead>
                  <TableHead className="text-right">CMV</TableHead>
                  <TableHead className="text-right">Ganancia</TableHead>
                  <TableHead className="text-right">CMV % (Meta)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      Sin ventas detalladas para este filtro.
                    </TableCell>
                  </TableRow>
                ) : (
                  categories.map((cat) => (
                    <TableRow
                      key={cat.key}
                      className="cursor-pointer"
                      data-state={selectedCat === cat.key ? "selected" : undefined}
                      onClick={() =>
                        setSelectedCat(selectedCat === cat.key ? null : cat.key)
                      }
                    >
                      <TableCell className="font-medium">{cat.categoria}</TableCell>
                      <TableCell className="text-right">{cat.cantidad}</TableCell>
                      <TableCell className="text-right font-semibold">
                        {money(cat.ingreso)}
                      </TableCell>
                      <TableCell className="text-right">{money(cat.costo)}</TableCell>
                      <TableCell className="text-right text-emerald-600 dark:text-emerald-400 font-medium">
                        {money(cat.ganancia)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant={
                            cat.estado_cmv === "critico"
                              ? "destructive"
                              : cat.estado_cmv === "atencion"
                              ? "warning"
                              : "success"
                          }
                        >
                          {pct(cat.cmv_pct)} / {pct(cat.objetivo || 0.35)}
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

      {/* Detalle de Productos de la Categoría Seleccionada o Top General */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {activeCategoryObj
              ? `Productos vendidos en: ${activeCategoryObj.categoria}`
              : "Top 20 Productos Más Vendidos"}
          </CardTitle>
          <CardDescription>
            Precio unitario promedio, costo de receta unitario y contribución al margen
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Producto</TableHead>
                <TableHead className="text-right">Cantidad</TableHead>
                <TableHead className="text-right">Precio Unit.</TableHead>
                <TableHead className="text-right">Costo Unit.</TableHead>
                <TableHead className="text-right">Ingreso Total</TableHead>
                <TableHead className="text-right">Ganancia</TableHead>
                <TableHead className="text-right">CMV %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(activeCategoryObj ? activeCategoryObj.productos || [] : topProducts).map(
                (p: any, i: number) => (
                  <TableRow key={`${p.producto}-${i}`}>
                    <TableCell className="font-medium">{p.producto}</TableCell>
                    <TableCell className="text-right">{p.cantidad}</TableCell>
                    <TableCell className="text-right">{money(p.precio_unit)}</TableCell>
                    <TableCell className="text-right">
                      {p.costo_unit === 0 ? (
                        <Badge variant="warning">$0 (Sin costear)</Badge>
                      ) : (
                        money(p.costo_unit)
                      )}
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {money(p.ingreso)}
                    </TableCell>
                    <TableCell className="text-right text-emerald-600 dark:text-emerald-400">
                      {money(p.ganancia)}
                    </TableCell>
                    <TableCell className="text-right">{pct(p.cmv_pct)}</TableCell>
                  </TableRow>
                )
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

