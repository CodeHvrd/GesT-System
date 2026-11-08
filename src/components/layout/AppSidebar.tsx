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
  group: "portal" | "operaciones";
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
      label: "Dashboard",
      group: "portal",
      icon: LayoutDashboard,
    },
    {
      id: "ventas",
      label: "Ventas y Canales",
      group: "portal",
      icon: ShoppingBag,
    },
    {
      id: "ganancias",
      label: "Ecuación y CMV",
      group: "portal",
      icon: TrendingUp,
    },
    {
      id: "gastos",
      label: "Gastos y Conciliación",
      group: "portal",
      icon: Receipt,
    },
    {
      id: "notificaciones",
      label: "Revisiones y Alertas",
      group: "portal",
      icon: BellRing,
      badge: alertCount > 0 ? alertCount : undefined,
    },
    {
      id: "semanal",
      label: "Cierre Semanal (S1-S5)",
      group: "operaciones",
      icon: CalendarRange,
    },
    {
      id: "mensual",
      label: "Cierre Mensual",
      group: "operaciones",
      icon: CalendarDays,
    },
    {
      id: "carga",
      label: "Carga de Gastos",
      group: "operaciones",
      icon: PlusCircle,
      badge: pendingEntriesCount > 0 ? pendingEntriesCount : undefined,
    },
    {
      id: "datos",
      label: "Explorador y Calidad",
      group: "operaciones",
      icon: Database,
    },
    {
      id: "config",
      label: "Enlaces y Config",
      group: "operaciones",
      icon: Settings,
    },
  ];

  const portalItems = navItems.filter((i) => i.group === "portal");
  const opItems = navItems.filter((i) => i.group === "operaciones");

  return (
    <aside className="w-full lg:w-64 shrink-0">
      <nav className="flex lg:flex-col gap-4 overflow-x-auto rounded-xl border bg-card p-3 shadow-sm">
        <div className="flex lg:flex-col gap-1 min-w-max">
          <div className="hidden lg:block px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Portal de Control
          </div>
          {portalItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                className={cn(
                  "flex items-center justify-between gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </span>
                {item.badge !== undefined && (
                  <Badge
                    variant={active ? "secondary" : "destructive"}
                    className="px-1.5 py-0 text-[10px]"
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
            Operación y Planillas
          </div>
          {opItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                className={cn(
                  "flex items-center justify-between gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </span>
                {item.badge !== undefined && (
                  <Badge
                    variant={active ? "secondary" : "warning"}
                    className="px-1.5 py-0 text-[10px]"
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

