import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GesT — Sistema de Gestión Gastronómica",
  description:
    "Panel integral de control gastronómico: Ventas por canal, Ecuación de Ganancias, CMV por receta, Conciliación Fudo vs Planilla Contable y Alertas automáticas.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground">
        {children}
      </body>
    </html>
  );
}

