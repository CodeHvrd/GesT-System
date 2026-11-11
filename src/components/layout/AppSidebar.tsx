"use client";

import React from "react";
import {
  LayoutDashboard,
  ShoppingBag,
  TrendingUp,
  Receipt,
  BellRing,
  CalendarRange,
  CalendarDays,
  PlusCircle,
  Database,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export interface NavItem {
  id: string;
  label: string;
  group: "seccion_1" | "seccion_2";
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
    // Sección 1: Panel Principal / Operación Clave
    {
      id: "dashboard",
      label: "Dashboard",
      group: "seccion_1",
      icon: LayoutDashboard,
    },
    {
      id: "carga",
      label: "Carga de Gastos",
      group: "seccion_1",
      icon: PlusCircle,
      badge: pendingEntriesCount > 0 ? pendingEntriesCount : undefined,
    },
    {
      id: "notificaciones",
      label: "Notificaciones",
      group: "seccion_1",
      icon: BellRing,
      badge: alertCount > 0 ? alertCount : undefined,
    },
    {
      id: "semanal",
      label: "Cierre Semanal",
      group: "seccion_1",
      icon: CalendarRange,
    },
    {
      id: "mensual",
      label: "Cierre Mensual",
      group: "seccion_1",
      icon: CalendarDays,
    },

    // Sección 2: Exploración, Canales y Auditoría
    {
      id: "datos",
      label: "Explorador y Calidad",
      group: "seccion_2",
      icon: Database,
    },
    {
      id: "ventas",
      label: "Ventas y Canales",
      group: "seccion_2",
      icon: ShoppingBag,
    },
    {
      id: "ganancias",
      label: "Ecuación y CMV",
      group: "seccion_2",
      icon: TrendingUp,
    },
    {
      id: "gastos",
      label: "Gastos y Conciliación",
      group: "seccion_2",
      icon: Receipt,
    },
    {
      id: "config",
      label: "Enlaces y Config",
      group: "seccion_2",
      icon: Settings,
    },
  ];

  const seccion1Items = navItems.filter((i) => i.group === "seccion_1");
  const seccion2Items = navItems.filter((i) => i.group === "seccion_2");

  return (
    <aside className="w-full lg:w-64 shrink-0">
      <nav className="flex lg:flex-col gap-4 overflow-x-auto rounded-xl border bg-card p-3 shadow-sm">
        <div className="flex lg:flex-col gap-1 min-w-max">
          <div className="hidden lg:block px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Gestión Principal
          </div>
          {seccion1Items.map((item) => {
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
                  <span className="truncate">{item.label}</span>
                </span>
                {item.badge !== undefined && (
                  <Badge
                    variant={active ? "secondary" : "destructive"}
                    className="px-1.5 py-0 text-[10px] shrink-0"
                  >
                    {item.badge}
                  </Badge>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex lg:flex-col gap-1 min-w-max lg:border-t lg:pt-3">
          <div className="hidden lg:block px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Control y Auditoría
          </div>
          {seccion2Items.map((item) => {
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
                  <span className="truncate">{item.label}</span>
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
      </nav>
    </aside>
  );
}
