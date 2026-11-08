"use client";

import React from "react";
import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { money } from "@/lib/format";

interface NotificacionesSectionProps {
  reviewData: {
    resumen?: {
      total: number;
      criticos: number;
      atencion: number;
      info: number;
    };
    items?: Array<{
      id: string;
      nivel: "critico" | "atencion" | "info";
      categoria: string;
      titulo: string;
      detalle: string;
      accion: string;
      impacto?: number;
    }>;
  };
  localAlerts: Array<{
    nivel: "critico" | "atencion" | "info" | "ok";
    codigo: string;
    titulo: string;
    detalle: string;
    impacto?: number | null;
  }>;
}

export function NotificacionesSection({
  reviewData,
  localAlerts,
}: NotificacionesSectionProps) {
  const items = reviewData?.items || [];
  const res = reviewData?.resumen || { total: 0, criticos: 0, atencion: 0, info: 0 };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="border-red-500/30 bg-red-500/5">
          <CardHeader className="pb-2">
            <CardDescription className="text-red-700 dark:text-red-300 font-medium">
              Críticos (Acción Inmediata)
            </CardDescription>
            <CardTitle className="text-2xl font-bold text-red-700 dark:text-red-400">
              {res.criticos}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardHeader className="pb-2">
            <CardDescription className="text-amber-700 dark:text-amber-300 font-medium">
              Atención (Desvíos Moderados)
            </CardDescription>
            <CardTitle className="text-2xl font-bold text-amber-700 dark:text-amber-400">
              {res.atencion}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="border-emerald-500/30 bg-emerald-500/5">
          <CardHeader className="pb-2">
            <CardDescription className="text-emerald-700 dark:text-emerald-300 font-medium">
              Informativos / En Orden
            </CardDescription>
            <CardTitle className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">
              {res.info}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Diagnóstico del Período */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Diagnóstico Operativo del Período Seleccionado
          </CardTitle>
          <CardDescription>
            Análisis automático de CMV, productos sin costear, variaciones de venta y conciliación
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex flex-col justify-between gap-3 rounded-xl border p-4 sm:flex-row sm:items-center"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  {item.nivel === "critico" ? (
                    <AlertCircle className="h-4 w-4 text-red-500" />
                  ) : item.nivel === "atencion" ? (
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  )}
                  <Badge
                    variant={
                      item.nivel === "critico"
                        ? "destructive"
                        : item.nivel === "atencion"
                        ? "warning"
                        : "success"
                    }
                  >
                    {item.categoria}
                  </Badge>
                  <span className="font-semibold text-sm">{item.titulo}</span>
                </div>
                <p className="text-xs text-muted-foreground">{item.detalle}</p>
                <p className="text-xs font-medium text-primary">
                  Recomendación: {item.accion}
                </p>
              </div>
              {item.impacto !== undefined && item.impacto !== 0 && (
                <div className="text-right shrink-0">
                  <span className="text-[11px] text-muted-foreground block">
                    Impacto estimado
                  </span>
                  <span
                    className={`text-sm font-bold ${
                      item.impacto < 0 ? "text-red-600" : "text-emerald-600"
                    }`}
                  >
                    {money(item.impacto)}
                  </span>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Reglas de Auditoría Semanal (Panel Local) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Auditoría de Reglas Semanales ({localAlerts.length})
          </CardTitle>
          <CardDescription>
            Verificación de las 12 reglas operativas sobre la última semana activa
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {localAlerts.map((a, idx) => (
            <div
              key={`${a.codigo}-${idx}`}
              className="rounded-lg border p-3 text-xs space-y-1"
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold">{a.titulo}</span>
                <Badge
                  variant={
                    a.nivel === "critico"
                      ? "destructive"
                      : a.nivel === "atencion"
                      ? "warning"
                      : "secondary"
                  }
                >
                  {a.codigo}
                </Badge>
              </div>
              <p className="text-muted-foreground">{a.detalle}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

