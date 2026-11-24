"use client";

import React from "react";
import {
  LayoutDashboard,
  Receipt,
  CalendarRange,
  CalendarDays,
  Settings,
  FileSpreadsheet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export interface NavItem {
  id: string;
  label: string;
  hint: string;
  group: "operacion" | "cierres";
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
}

interface AppSidebarProps {
  activeTab: string;
  onSelectTab: (id: string) => void;
  alertCount: number;
  pendingEntriesCount: number;
}

export function AppSidebar({
  activeTab,
  onSelectTab,
  alertCount,
  pendingEntriesCount,
}: AppSidebarProps) {
  const navItems: NavItem[] = [
    {
      id: "dashboard",
      label: "Resumen General",
      hint: "Ventas, CMV y categorías",
      group: "operacion",
      icon: LayoutDashboard,
    },
    {
      id: "facturas",
      label: "Facturas y Pagos",
      hint: "Foto, Cta. Cte., Mar/Vie",
      group: "operacion",
      icon: FileSpreadsheet,
    },
    {
      id: "gastos",
      label: "Gastos y Cajas",
      hint: "Cajas y cruce Contable/Fudo",
      group: "operacion",
      icon: Receipt,
      badge:
        alertCount + pendingEntriesCount > 0
          ? alertCount + pendingEntriesCount
          : undefined,
    },
    {
      id: "semanal",
      label: "Cierre Semanal",
      hint: "Semanas S1 a S5",
      group: "cierres",
      icon: CalendarRange,
    },
    {
      id: "mensual",
      label: "Cierre Mensual",
      hint: "Consolidado del mes",
      group: "cierres",
      icon: CalendarDays,
    },
    {
      id: "config",
      label: "Configuración",
      hint: "Enlaces, Fudo y metas CMV",
      group: "cierres",
      icon: Settings,
    },
  ];

  const operacionItems = navItems.filter((i) => i.group === "operacion");
  const cierresItems = navItems.filter((i) => i.group === "cierres");

  const renderGroup = (title: string, items: NavItem[]) => (
    <div className="flex lg:flex-col gap-1 min-w-max">
      <div className="hidden lg:block px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {items.map((item) => {
        const Icon = item.icon;
        const active = activeTab === item.id;
        return (
          <button
            key={item.id}
            onClick={() => onSelectTab(item.id)}
            className={cn(
              "flex items-center justify-between gap-2.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors text-left",
              active
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
          >
            <span className="flex items-center gap-2.5 min-w-0">
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex flex-col min-w-0">
                <span className="truncate font-semibold">{item.label}</span>
                <span
                  className={cn(
                    "hidden lg:block truncate text-[10px] font-normal",
                    active ? "text-primary-foreground/80" : "text-muted-foreground"
                  )}
                >
                  {item.hint}
                </span>
              </span>
            </span>
            {item.badge !== undefined && (
              <Badge
                variant={active ? "secondary" : "warning"}
                className="px-1.5 py-0 text-[10px] shrink-0"
              >
                {item.badge}
              </Badge>
            )}
          </button>
        );
      })}
    </div>
  );

  return (
    <aside className="w-full lg:w-60 shrink-0">
      <nav className="flex lg:flex-col gap-3 overflow-x-auto rounded-xl border bg-card p-3 shadow-sm">
        {renderGroup("Día a Día", operacionItems)}
        <div className="lg:border-t lg:pt-2.5">
          {renderGroup("Cierres y Ajustes", cierresItems)}
        </div>
      </nav>
    </aside>
  );
}
