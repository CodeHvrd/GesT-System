"use client";

import React, { useState } from "react";
import { Calendar, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

const MAIN_PRESETS = [
  { key: "esta-semana", label: "Esta Semana" },
  { key: "este-mes", label: "Este Mes" },
  { key: "mes-anterior", label: "Mes Anterior" },
  { key: "hoy", label: "Hoy" },
];

const CHANNELS = [
  { key: "todos", label: "Todos los canales" },
  { key: "salon", label: "Salón / Mesas" },
  { key: "takeaway", label: "Take Away" },
  { key: "delivery", label: "Delivery" },
];

interface PeriodFilterBarProps {
  preset: string;
  desde: string;
  hasta: string;
  canal: string;
  periodLabel: string;
  onChangePreset: (preset: string) => void;
  onChangeDates: (desde: string, hasta: string) => void;
  onChangeCanal: (canal: string) => void;
}

export function PeriodFilterBar({
  preset,
  desde,
  hasta,
  canal,
  periodLabel,
  onChangePreset,
  onChangeDates,
  onChangeCanal,
}: PeriodFilterBarProps) {
  const [showCustomDates, setShowCustomDates] = useState(false);

  return (
    <div className="rounded-xl border bg-card px-3.5 py-2.5 shadow-sm space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Presets rápidos en una sola fila */}
        <div className="flex flex-wrap items-center gap-1.5">
          {MAIN_PRESETS.map((p) => (
            <Button
              key={p.key}
              variant={preset === p.key ? "default" : "outline"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => onChangePreset(p.key)}
            >
              {p.label}
            </Button>
          ))}
          <Button
            variant={!preset || showCustomDates ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs gap-1"
            onClick={() => setShowCustomDates(!showCustomDates)}
          >
            <span>Otro rango</span>
            {showCustomDates ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </Button>
        </div>

        {/* Selector compacto de Canal + Etiqueta del período activo */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={canal}
            onChange={(e) => onChangeCanal(e.target.value)}
            aria-label="Filtrar por canal"
            className="h-7 rounded-md border border-input bg-background px-2.5 text-xs font-medium"
          >
            {CHANNELS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>

          <Badge variant="outline" className="gap-1.5 py-1 text-xs font-medium">
            <Calendar className="h-3.5 w-3.5 text-primary" />
            {periodLabel || `${desde} → ${hasta}`}
          </Badge>
        </div>
      </div>

      {/* Desplegable solo cuando el usuario quiere elegir fechas manuales o presets secundarios */}
      {showCustomDates && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant={preset === "ayer" ? "default" : "outline"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onChangePreset("ayer")}
            >
              Ayer
            </Button>
            <Button
              variant={preset === "ultimos-7" ? "default" : "outline"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onChangePreset("ultimos-7")}
            >
              Últimos 7 días
            </Button>
            <Button
              variant={preset === "ultimos-30" ? "default" : "outline"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onChangePreset("ultimos-30")}
            >
              Últimos 30 días
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-muted-foreground">Desde</label>
            <Input
              type="date"
              value={desde}
              onChange={(e) => onChangeDates(e.target.value, hasta)}
              className="h-7 w-36 text-xs"
            />
            <label className="text-muted-foreground">Hasta</label>
            <Input
              type="date"
              value={hasta}
              onChange={(e) => onChangeDates(desde, e.target.value)}
              className="h-7 w-36 text-xs"
            />
          </div>
        </div>
      )}
    </div>
  );
}
