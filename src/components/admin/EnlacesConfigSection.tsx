"use client";

import React, { useEffect, useState } from "react";
import {
  Save,
  ExternalLink,
  CheckCircle2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { money, pct } from "@/lib/format";

interface EnlacesConfigSectionProps {
  onConfigUpdated: () => void;
}

export function EnlacesConfigSection({
  onConfigUpdated,
}: EnlacesConfigSectionProps) {
  const [config, setConfig] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const [fudoFrom, setFudoFrom] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [fudoTo, setFudoTo] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [fudoPreview, setFudoPreview] = useState<Record<string, any> | null>(
    null
  );
  const [fudoLoading, setFudoLoading] = useState(false);

  async function loadCfg() {
    const res = await fetch("/api/config");
    const json = await res.json();
    if (json.ok) setConfig(json.config || {});
  }

  useEffect(() => {
    loadCfg();
  }, []);

  async function handleSaveConfig(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const json = await res.json();
      if (json.ok) {
        setConfig(json.config);
        setStatusMsg("Configuración guardada correctamente.");
        onConfigUpdated();
      } else {
        setStatusMsg(`Error: ${json.error}`);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handlePreviewFudo() {
    setFudoLoading(true);
    setStatusMsg(null);
    try {
      const res = await fetch(
        `/api/fudo/sales/preview?desde=${fudoFrom}&hasta=${fudoTo}`
      );
      const json = await res.json();
      setFudoPreview(json);
    } finally {
      setFudoLoading(false);
    }
  }

  async function handleImportFudo() {
    setFudoLoading(true);
    setStatusMsg(null);
    try {
      const res = await fetch("/api/fudo/sales/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ desde: fudoFrom, hasta: fudoTo }),
      });
      const json = await res.json();
      if (json.ok) {
        setStatusMsg(
          `Importadas ${json.inserted} líneas de venta desde Fudo (${json.desde} → ${json.hasta}).`
        );
        onConfigUpdated();
      } else {
        setStatusMsg(`Error Fudo: ${json.error}`);
      }
    } finally {
      setFudoLoading(false);
    }
  }

  async function handleClearFudo() {
    const res = await fetch("/api/fudo/sales/clear", { method: "POST" });
    const json = await res.json();
    if (json.ok) {
      setStatusMsg(`Se eliminaron ${json.deleted} líneas importadas de Fudo.`);
      onConfigUpdated();
    }
  }

  const sheetUrl =
    config.sheet_url ||
    (config.sheet_id
      ? `https://docs.google.com/spreadsheets/d/${config.sheet_id}/edit`
      : "");

  return (
    <div className="space-y-6">
      {/* Accesos directos a Google Sheets y Fudo */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Planilla Contable en Google Sheets
            </CardTitle>
            <CardDescription>
              Acceso directo a las hojas de Gastos, Ventas, Semanal y Mensual
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {sheetUrl && (
              <Button variant="outline" size="sm" asChild>
                <a href={sheetUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  Abrir Google Sheet Principal
                </a>
              </Button>
            )}
            <Button variant="outline" size="sm" asChild>
              <a
                href="https://app-v2.fu.do"
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="h-4 w-4" />
                Abrir Panel Fudo POS
              </a>
            </Button>
          </CardContent>
        </Card>

        {/* Importador y Previsualizador de Ventas Fudo */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Sincronización Manual de Ventas Fudo API
            </CardTitle>
            <CardDescription>
              Previsualizá o importá ventas y recetas directamente desde Fudo por rango de fechas
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="text-xs text-muted-foreground block">Desde</label>
                <Input
                  type="date"
                  value={fudoFrom}
                  onChange={(e) => setFudoFrom(e.target.value)}
                  className="h-8 w-36 text-xs"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block">Hasta</label>
                <Input
                  type="date"
                  value={fudoTo}
                  onChange={(e) => setFudoTo(e.target.value)}
                  className="h-8 w-36 text-xs"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handlePreviewFudo}
                disabled={fudoLoading}
              >
                Previsualizar
              </Button>
              <Button
                size="sm"
                onClick={handleImportFudo}
                disabled={fudoLoading}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${fudoLoading ? "animate-spin" : ""}`} />
                Importar a Base Local
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={handleClearFudo}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Limpiar Fudo
              </Button>
            </div>

            {fudoPreview && (
              <div className="rounded-lg border bg-muted/30 p-3 text-xs space-y-1">
                {fudoPreview.ok ? (
                  <>
                    <div className="font-semibold">
                      Previsualización ({fudoPreview.desde} → {fudoPreview.hasta}):
                    </div>
                    <div>
                      Ventas cerradas: <strong>{fudoPreview.stats?.sales_closed}</strong> ·
                      Ingresos: <strong>{money(fudoPreview.stats?.ingreso_total || 0)}</strong> ·
                      CMV Recetas: <strong>{money(fudoPreview.stats?.costo_total || 0)}</strong> (
                      {pct(fudoPreview.stats?.cmv_pct || 0)})
                    </div>
                  </>
                ) : (
                  <div className="text-destructive">{fudoPreview.error}</div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Formulario General de Configuración */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Parámetros del Negocio, Metas de CMV y Credenciales
          </CardTitle>
          <CardDescription>
            Configuración persistida en config.json (los secretos nunca se exponen en texto plano)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveConfig} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1">
                <label className="text-xs font-medium">Nombre del Negocio</label>
                <Input
                  value={config.nombre_negocio || ""}
                  onChange={(e) =>
                    setConfig({ ...config, nombre_negocio: e.target.value })
                  }
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium">Google Sheet ID o URL</label>
                <Input
                  value={config.sheet_id || ""}
                  onChange={(e) =>
                    setConfig({ ...config, sheet_id: e.target.value })
                  }
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium">
                  Meta CMV General (ej. 0.35 = 35%)
                </label>
                <Input
                  type="number"
                  step="0.01"
                  value={config.cmv_objetivo_general ?? 0.35}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      cmv_objetivo_general: Number(e.target.value),
                    })
                  }
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium">Fudo API Key</label>
                <Input
                  value={config.fudo_api_key || ""}
                  onChange={(e) =>
                    setConfig({ ...config, fudo_api_key: e.target.value })
                  }
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium">
                  Fudo API Secret{" "}
                  {config.has_fudo_secret && (
                    <Badge variant="success" className="ml-1 text-[10px]">
                      Configurado
                    </Badge>
                  )}
                </label>
                <Input
                  type="password"
                  value={config.fudo_api_secret || ""}
                  onChange={(e) =>
                    setConfig({ ...config, fudo_api_secret: e.target.value })
                  }
                  placeholder="Dejar igual para conservar actual"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium">
                  Apps Script Webhook URL (Para envío de gastos)
                </label>
                <Input
                  value={config.apps_script_webhook_url || ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      apps_script_webhook_url: e.target.value,
                    })
                  }
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium">
                Metas de CMV por Categoría (formato: categoria = 35%)
              </label>
              <Textarea
                rows={5}
                value={config.cmv_objetivo_texto || ""}
                onChange={(e) =>
                  setConfig({ ...config, cmv_objetivo_texto: e.target.value })
                }
              />
            </div>

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={saving}>
                <Save className="h-4 w-4" />
                {saving ? "Guardando..." : "Guardar Configuración"}
              </Button>
              {statusMsg && (
                <span className="flex items-center gap-1 text-xs font-medium text-primary">
                  <CheckCircle2 className="h-4 w-4" />
                  {statusMsg}
                </span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

