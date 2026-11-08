"use client";

import React from "react";
import { Calendar, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

const PRESETS = [
  { key: "hoy", label: "Hoy" },
  { key: "ayer", label: "Ayer" },
  { key: "esta-semana", label: "Esta Semana" },
  { key: "ultimos-7", label: "Últimos 7 días" },
  { key: "este-mes", label: "Este Mes" },
  { key: "mes-anterior", label: "Mes Anterior" },
  { key: "ultimos-30", label: "Últimos 30 días" },
];

const CHANNELS = [
  { key: "todos", label: "Todos los canales" },
  { key: "salon", label: "Salón / Mesas" },
  { key: "takeaway", label: "Mostrador / Take Away" },
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
  return (
    <div className="rounded-xl border bg-card p-3.5 shadow-sm space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {PRESETS.map((p) => (
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
        </div>

        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1.5 py-1 text-xs font-medium">
            <Calendar className="h-3.5 w-3.5 text-primary" />
            {periodLabel || `${desde} → ${hasta}`}
          </Badge>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
            <Filter className="h-3.5 w-3.5" /> Canal:
          </span>
          {CHANNELS.map((c) => (
            <Button
              key={c.key}
              variant={canal === c.key ? "secondary" : "ghost"}
              size="sm"
              className={`h-7 px-2.5 text-xs ${
                canal === c.key ? "border border-primary/30 font-semibold" : ""
              }`}
              onClick={() => onChangeCanal(c.key)}
            >
              {c.label}
            </Button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Desde</label>
          <Input
            type="date"
            value={desde}
            onChange={(e) => onChangeDates(e.target.value, hasta)}
            className="h-7 w-36 text-xs"
          />
          <label className="text-xs text-muted-foreground">Hasta</label>
          <Input
            type="date"
            value={hasta}
            onChange={(e) => onChangeDates(desde, e.target.value)}
            className="h-7 w-36 text-xs"
          />
        </div>
      </div>
    </div>
  );
}

