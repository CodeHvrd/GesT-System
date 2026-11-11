"use client";

import React, { useCallback, useEffect, useState } from "react";
import { HeaderBar } from "@/components/layout/HeaderBar";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { PeriodFilterBar } from "@/components/layout/PeriodFilterBar";
import { DashboardSection } from "@/components/dashboard/DashboardSection";
import { VentasSection } from "@/components/dashboard/VentasSection";
import { GananciasSection } from "@/components/dashboard/GananciasSection";
import { GastosSection } from "@/components/dashboard/GastosSection";
import { NotificacionesSection } from "@/components/dashboard/NotificacionesSection";
import { SemanalSection } from "@/components/admin/SemanalSection";
import { MensualSection } from "@/components/admin/MensualSection";
import { CargaGastosSection } from "@/components/admin/CargaGastosSection";
import { DatosSection } from "@/components/admin/DatosSection";
import { EnlacesConfigSection } from "@/components/admin/EnlacesConfigSection";

export default function HomePage() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [preset, setPreset] = useState("este-mes");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [canal, setCanal] = useState("todos");
  const [darkMode, setDarkMode] = useState(false);

  const [dashboardData, setDashboardData] = useState<Record<string, any> | null>(
    null
  );
  const [localAlerts, setLocalAlerts] = useState<Array<any>>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [versionInfo, setVersionInfo] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [bannerMsg, setBannerMsg] = useState<string | null>(null);

  const fetchAllData = useCallback(
    async (opts?: {
      customPreset?: string;
      customDesde?: string;
      customHasta?: string;
      customCanal?: string;
    }) => {
      setLoading(true);
      try {
        const p = opts?.customPreset !== undefined ? opts.customPreset : preset;
        const d1 = opts?.customDesde !== undefined ? opts.customDesde : desde;
        const d2 = opts?.customHasta !== undefined ? opts.customHasta : hasta;
        const ch = opts?.customCanal !== undefined ? opts.customCanal : canal;

        const qs = new URLSearchParams();
        if (p) qs.set("preset", p);
        if (!p && d1) qs.set("desde", d1);
        if (!p && d2) qs.set("hasta", d2);
        if (ch) qs.set("canal", ch);

        const [dashRes, alertsRes, entRes, verRes] = await Promise.all([
          fetch(`/api/dashboard?${qs.toString()}`, { cache: "no-store" }),
          fetch("/api/alerts", { cache: "no-store" }),
          fetch("/api/entries", { cache: "no-store" }),
          fetch("/api/version", { cache: "no-store" }),
        ]);

        const dashJson = await dashRes.json();
        const alertsJson = await alertsRes.json();
        const entJson = await entRes.json();
        const verJson = await verRes.json();

        if (dashJson.ok) {
          setDashboardData(dashJson);
          if (dashJson.periodo?.desde) setDesde(dashJson.periodo.desde);
          if (dashJson.periodo?.hasta) setHasta(dashJson.periodo.hasta);
        }
        if (alertsJson.ok) {
          setLocalAlerts(alertsJson.alertas || []);
        }
        if (entJson.ok) {
          setPendingCount((entJson.pendientes || []).length);
        }
        if (verJson.ok) {
          setVersionInfo(verJson);
        }
      } finally {
        setLoading(false);
      }
    },
    [preset, desde, hasta, canal]
  );

  useEffect(() => {
    fetchAllData();
  }, []);

  function handleToggleDark() {
    const next = !darkMode;
    setDarkMode(next);
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", next);
    }
  }

  function handleChangePreset(newPreset: string) {
    setPreset(newPreset);
    fetchAllData({
      customPreset: newPreset,
      customDesde: "",
      customHasta: "",
    });
  }

  function handleChangeDates(newDesde: string, newHasta: string) {
    setPreset("");
    setDesde(newDesde);
    setHasta(newHasta);
    fetchAllData({
      customPreset: "",
      customDesde: newDesde,
      customHasta: newHasta,
    });
  }

  function handleChangeCanal(newCanal: string) {
    setCanal(newCanal);
    fetchAllData({ customCanal: newCanal });
  }

  async function handleSyncAll() {
    setSyncing(true);
    setBannerMsg(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "all",
          preset: preset || undefined,
          desde: desde || undefined,
          hasta: hasta || undefined,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setBannerMsg(
          "Sincronización completada con éxito (Google Sheets + Fudo)."
        );
        await fetchAllData();
      } else {
        setBannerMsg(`Error al sincronizar: ${json.error}`);
      }
    } finally {
      setSyncing(false);
    }
  }

  async function handleSyncFudo() {
    setSyncing(true);
    setBannerMsg(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "fudo",
          preset: preset || undefined,
          desde: desde || undefined,
          hasta: hasta || undefined,
        }),
      });
      const json = await res.json();
      if (json.ok && json.fudo?.ok) {
        const count =
          json.fudo.sales_closed ??
          json.fudo.pg_sales_written ??
          json.fudo.inserted ??
          0;
        setBannerMsg(
          `Fudo sincronizado: ${count} ventas cerradas actualizadas (${json.fudo.desde} al ${json.fudo.hasta}).`
        );
        await fetchAllData();
      } else {
        setBannerMsg(
          json.fudo?.message || json.error || "No se pudo sincronizar Fudo."
        );
      }
    } finally {
      setSyncing(false);
    }
  }

  const meta = dashboardData?.meta || {};
  const reviewItems = dashboardData?.review?.items || [];
  const alertCount =
    reviewItems.filter(
      (i: any) => i.nivel === "critico" || i.nivel === "atencion"
    ).length;

  const showPeriodBar = [
    "dashboard",
    "ventas",
    "ganancias",
    "gastos",
    "notificaciones",
  ].includes(activeTab);

  return (
    <div className="min-h-screen flex flex-col">
      <HeaderBar
        negocio={meta.negocio}
        modoDb={meta.modo_db}
        lastSync={meta.last_sync}
        versionInfo={versionInfo}
        reviewItems={reviewItems}
        syncing={syncing}
        onSyncAll={handleSyncAll}
        onSyncFudo={handleSyncFudo}
        onNavigateTab={setActiveTab}
        darkMode={darkMode}
        onToggleDark={handleToggleDark}
        onCredentialsSaved={() => fetchAllData()}
      />

      {bannerMsg && (
        <div className="border-b bg-primary/10 px-4 py-2 text-center text-xs font-medium text-primary">
          {bannerMsg}
        </div>
      )}

      <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-6 p-4 lg:flex-row lg:p-6">
        <AppSidebar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          alertCount={alertCount}
          pendingEntriesCount={pendingCount}
        />

        <main className="flex-1 min-w-0 space-y-6">
          {showPeriodBar && (
            <PeriodFilterBar
              preset={preset}
              desde={desde}
              hasta={hasta}
              canal={canal}
              periodLabel={dashboardData?.periodo?.label || ""}
              onChangePreset={handleChangePreset}
              onChangeDates={handleChangeDates}
              onChangeCanal={handleChangeCanal}
            />
          )}

          {loading && !dashboardData ? (
            <div className="rounded-xl border bg-card p-12 text-center text-sm text-muted-foreground">
              Cargando datos del sistema...
            </div>
          ) : (
            <>
              {activeTab === "dashboard" && (
                <DashboardSection
                  data={dashboardData || {}}
                  onNavigateTab={setActiveTab}
                />
              )}
              {activeTab === "ventas" && (
                <VentasSection data={dashboardData || {}} />
              )}
              {activeTab === "ganancias" && (
                <GananciasSection data={dashboardData || {}} />
              )}
              {activeTab === "gastos" && (
                <GastosSection
                  data={dashboardData || {}}
                  onRefresh={() => fetchAllData()}
                />
              )}
              {activeTab === "notificaciones" && (
                <NotificacionesSection
                  reviewData={dashboardData?.review || {}}
                  localAlerts={localAlerts}
                />
              )}
              {activeTab === "semanal" && <SemanalSection />}
              {activeTab === "mensual" && <MensualSection />}
              {activeTab === "carga" && (
                <CargaGastosSection onEntriesChanged={() => fetchAllData()} />
              )}
              {activeTab === "datos" && <DatosSection />}
              {activeTab === "config" && (
                <EnlacesConfigSection onConfigUpdated={() => fetchAllData()} />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

