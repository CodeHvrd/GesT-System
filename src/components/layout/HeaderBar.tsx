"use client";

import React, { useState, useEffect } from "react";
import {
  Bell,
  RefreshCw,
  Moon,
  Sun,
  KeyRound,
  GitBranch,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Database,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

export interface ReviewItem {
  id: string;
  nivel: "critico" | "atencion" | "info";
  categoria: string;
  titulo: string;
  detalle: string;
  accion: string;
  impacto?: number;
}

interface HeaderBarProps {
  negocio: string;
  modoDb: string;
  lastSync: string | null;
  versionInfo: {
    version: string;
    commit: string;
    branch: string;
    update_available?: boolean;
  } | null;
  reviewItems: ReviewItem[];
  syncing: boolean;
  onSyncAll: () => void;
  onSyncFudo: () => void;
  onNavigateTab: (tab: string) => void;
  darkMode: boolean;
  onToggleDark: () => void;
  onCredentialsSaved: () => void;
}

export function HeaderBar({
  negocio,
  modoDb,
  lastSync,
  versionInfo,
  reviewItems,
  syncing,
  onSyncAll,
  onSyncFudo,
  onNavigateTab,
  darkMode,
  onToggleDark,
  onCredentialsSaved,
}: HeaderBarProps) {
  const [showNotif, setShowNotif] = useState(false);
  const [showFudoModal, setShowFudoModal] = useState(false);
  const [fudoKey, setFudoKey] = useState("");
  const [fudoSecret, setFudoSecret] = useState("");
  const [hasExistingSecret, setHasExistingSecret] = useState(false);
  const [fudoStatus, setFudoStatus] = useState<string | null>(null);
  const [savingFudo, setSavingFudo] = useState(false);

  // Cargar credenciales existentes cada vez que se abre el modal
  useEffect(() => {
    if (showFudoModal) {
      setFudoStatus(null);
      fetch("/api/config")
        .then((r) => r.json())
        .then((data) => {
          if (data.ok && data.config) {
            if (data.config.fudo_api_key) {
              setFudoKey(data.config.fudo_api_key);
            }
            if (data.config.has_fudo_secret) {
              setHasExistingSecret(true);
              setFudoSecret("••••••••");
            }
          }
        })
        .catch(() => {});
    }
  }, [showFudoModal]);

  // Verificación automática de horario programado Fudo (02:00 hs ARG y 16:00 hs ARG)
  useEffect(() => {
    let active = true;
    async function checkScheduledFudoSync() {
      try {
        const res = await fetch("/api/sync?autorun=1");
        if (!active) return;
        const json = await res.json();
        if (json.ok && json.triggered_scheduled_sync) {
          onCredentialsSaved();
        }
      } catch {
        // Silencioso en caso de desconexión momentánea
      }
    }
    checkScheduledFudoSync();
    const timer = setInterval(checkScheduledFudoSync, 10 * 60 * 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [onCredentialsSaved]);

  const critCount = reviewItems.filter((i) => i.nivel === "critico").length;
  const warnCount = reviewItems.filter((i) => i.nivel === "atencion").length;
  const totalAlerts = critCount + warnCount;

  async function handleSaveAndTestFudo(e: React.FormEvent) {
    e.preventDefault();
    setSavingFudo(true);
    setFudoStatus(null);
    try {
      const payload: Record<string, string> = {
        fudo_api_key: fudoKey,
      };
      if (fudoSecret && fudoSecret !== "••••••••") {
        payload.fudo_api_secret = fudoSecret;
      }
      const saveRes = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const saveJson = await saveRes.json();
      if (!saveJson.ok) {
        setFudoStatus(`Error al guardar: ${saveJson.error}`);
        setSavingFudo(false);
        return;
      }
      const testRes = await fetch("/api/fudo/test");
      const testJson = await testRes.json();
      if (testJson.ok) {
        setFudoStatus("Conexión con Fudo verificada correctamente.");
        setHasExistingSecret(true);
        onCredentialsSaved();
      } else {
        setFudoStatus(`Credenciales guardadas, pero Fudo respondió: ${testJson.error || testJson.status}`);
      }
    } catch (err) {
      setFudoStatus(`Error: ${(err as Error).message}`);
    } finally {
      setSavingFudo(false);
    }
  }

  return (
    <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground shadow-sm">
            G
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold tracking-tight sm:text-lg">
                {negocio || "GesT — Gestión Gastronómica"}
              </h1>
              <Badge variant="secondary" className="hidden sm:inline-flex gap-1 text-[11px]">
                <Database className="h-3 w-3" />
                {modoDb === "postgres" ? "Neon / Postgres" : "Local SQLite"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {lastSync
                ? `Última sincronización: ${new Date(lastSync).toLocaleString("es-AR")} · Auto Fudo: 02:00 y 16:00 ARG`
                : "Sincronización automática Fudo programada: 02:00 hs y 16:00 hs ARG"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {versionInfo && (
            <Button
              variant="outline"
              size="icon"
              title={`Versión ${versionInfo.version} (${versionInfo.commit}) · Rama ${versionInfo.branch}`}
              aria-label="Versión del sistema"
            >
              <GitBranch className="h-4 w-4" />
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowFudoModal(!showFudoModal)}
            title="Configurar credenciales de Fudo API"
          >
            <KeyRound className="h-4 w-4" />
            <span className="hidden md:inline">Fudo API</span>
          </Button>

          <Button
            variant="outline"
            size="icon"
            onClick={onSyncFudo}
            disabled={syncing}
            title="Actualizar Fudo (Programado automático: 02:00 hs y 16:00 hs ARG)"
            aria-label="Actualizar Fudo"
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
          </Button>

          <Button
            variant="default"
            size="sm"
            onClick={onSyncAll}
            disabled={syncing}
            title="Sincronizar Planilla Google Sheets y Fudo"
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            <span>{syncing ? "Sincronizando..." : "Sincronizar Todo"}</span>
          </Button>

          {/* Popover de Notificaciones */}
          <div className="relative">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setShowNotif(!showNotif)}
              aria-label="Notificaciones y alertas"
              className="relative"
            >
              <Bell className="h-4 w-4" />
              {totalAlerts > 0 && (
                <span
                  className={`absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white ${
                    critCount > 0 ? "bg-red-600" : "bg-amber-500"
                  }`}
                >
                  {totalAlerts}
                </span>
              )}
            </Button>

            {showNotif && (
              <div className="absolute right-0 mt-2 w-80 sm:w-96 rounded-xl border bg-card p-4 shadow-xl z-50">
                <div className="mb-3 flex items-center justify-between border-b pb-2">
                  <span className="font-semibold text-sm">
                    Revisión Operativa ({reviewItems.length})
                  </span>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => {
                      setShowNotif(false);
                      onNavigateTab("notificaciones");
                    }}
                  >
                    Ver todas
                  </Button>
                </div>
                <div className="max-h-72 space-y-2.5 overflow-y-auto">
                  {reviewItems.slice(0, 5).map((item) => (
                    <div
                      key={item.id}
                      className="rounded-lg border p-2.5 text-xs space-y-1 bg-muted/20"
                    >
                      <div className="flex items-center gap-1.5 font-medium">
                        {item.nivel === "critico" ? (
                          <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                        ) : item.nivel === "atencion" ? (
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                        ) : (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                        )}
                        <span>{item.titulo}</span>
                      </div>
                      <p className="text-muted-foreground">{item.detalle}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleDark}
            aria-label="Cambiar tema claro/oscuro"
          >
            {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Panel desplegable rápido de credenciales Fudo */}
      {showFudoModal && (
        <div className="border-t bg-muted/40 px-4 py-3">
          <form
            onSubmit={handleSaveAndTestFudo}
            className="mx-auto flex max-w-[1600px] flex-wrap items-end gap-3"
          >
            <div className="space-y-1">
              <label className="text-xs font-medium">Fudo API Key</label>
              <Input
                value={fudoKey}
                onChange={(e) => setFudoKey(e.target.value)}
                placeholder="Tu apiKey de Fudo"
                className="h-8 w-56"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">
                Fudo API Secret {hasExistingSecret && <span className="text-[10px] text-muted-foreground font-normal">(Configurado)</span>}
              </label>
              <Input
                type="password"
                value={fudoSecret}
                onChange={(e) => setFudoSecret(e.target.value)}
                placeholder={hasExistingSecret ? "Dejar igual para conservar" : "Tu apiSecret de Fudo"}
                className="h-8 w-56"
              />
            </div>
            <Button type="submit" size="sm" disabled={savingFudo}>
              {savingFudo ? "Verificando..." : "Guardar y Probar"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowFudoModal(false)}
            >
              Cerrar
            </Button>
            {fudoStatus && (
              <span className="text-xs font-medium text-primary">
                {fudoStatus}
              </span>
            )}
          </form>
        </div>
      )}
    </header>
  );
}
