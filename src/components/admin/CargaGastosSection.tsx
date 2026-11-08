"use client";

import React, { useEffect, useState } from "react";
import { Plus, Send, Copy, Trash2, Check } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { money } from "@/lib/format";

interface CargaGastosSectionProps {
  onEntriesChanged: () => void;
}

export function CargaGastosSection({ onEntriesChanged }: CargaGastosSectionProps) {
  const [fecha, setFecha] = useState(() => new Date().toISOString().slice(0, 10));
  const [proveedor, setProveedor] = useState("");
  const [categoria, setCategoria] = useState("Mercadería");
  const [descripcion, setDescripcion] = useState("");
  const [monto, setMonto] = useState("");
  const [cantidad, setCantidad] = useState("1");
  const [medioPago, setMedioPago] = useState("Efectivo");
  const [comprobante, setComprobante] = useState("");

  const [suggestions, setSuggestions] = useState<{
    proveedores: Array<any>;
    categorias: string[];
    medios_pago: string[];
  }>({ proveedores: [], categorias: [], medios_pago: [] });

  const [entriesData, setEntriesData] = useState<{
    pendientes: Array<any>;
    historial: Array<any>;
    tsv: string;
  }>({ pendientes: [], historial: [], tsv: "" });

  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [copiedTsv, setCopiedTsv] = useState(false);

  async function loadEntriesAndSuggestions() {
    const [entRes, sugRes] = await Promise.all([
      fetch("/api/entries"),
      fetch("/api/suggest"),
    ]);
    const entJson = await entRes.json();
    const sugJson = await sugRes.json();
    if (entJson.ok) setEntriesData(entJson);
    if (sugJson.ok) setSuggestions(sugJson);
  }

  useEffect(() => {
    loadEntriesAndSuggestions();
  }, []);

  async function handleProviderBlur() {
    if (!proveedor) return;
    const res = await fetch(
      `/api/suggest?proveedor=${encodeURIComponent(proveedor)}`
    );
    const json = await res.json();
    if (json.ok && json.sugerencia) {
      if (json.sugerencia.categoria) setCategoria(json.sugerencia.categoria);
      if (json.sugerencia.medio_pago) setMedioPago(json.sugerencia.medio_pago);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatusMsg(null);
    const res = await fetch("/api/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fecha,
        proveedor,
        categoria,
        descripcion,
        monto,
        cantidad,
        medio_pago: medioPago,
        comprobante,
      }),
    });
    const json = await res.json();
    if (json.ok) {
      setDescripcion("");
      setMonto("");
      setComprobante("");
      setEntriesData(json);
      setStatusMsg("Gasto registrado y sumado a la cola pendiente.");
      onEntriesChanged();
    } else {
      setStatusMsg(`Error: ${json.error}`);
    }
  }

  async function handleDiscard(id: number) {
    const res = await fetch("/api/entries/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const json = await res.json();
    if (json.ok) {
      setEntriesData(json);
      onEntriesChanged();
    }
  }

  async function handlePushWebhook() {
    setStatusMsg("Enviando pendientes a Google Sheets...");
    const res = await fetch("/api/entries/push", { method: "POST" });
    const json = await res.json();
    if (json.ok) {
      setEntriesData(json);
      setStatusMsg(`Se enviaron ${json.pushed} gastos a la planilla.`);
      onEntriesChanged();
    } else {
      setStatusMsg(`Error al enviar: ${json.error}`);
    }
  }

  async function handleCopyTsv() {
    await navigator.clipboard.writeText(entriesData.tsv || "");
    setCopiedTsv(true);
    setTimeout(() => setCopiedTsv(false), 2000);
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Carga Rápida de Comprobantes y Gastos
          </CardTitle>
          <CardDescription>
            Autocompleta categoría y medio de pago según el historial del proveedor
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <label className="text-xs font-medium">Fecha</label>
              <Input
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium">Proveedor</label>
              <Input
                list="proveedores-list"
                value={proveedor}
                onChange={(e) => setProveedor(e.target.value)}
                onBlur={handleProviderBlur}
                placeholder="Ej. Distribuidora Sur"
              />
              <datalist id="proveedores-list">
                {suggestions.proveedores.map((p, i) => (
                  <option key={i} value={p.proveedor} />
                ))}
              </datalist>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium">Categoría</label>
              <Input
                list="categorias-list"
                value={categoria}
                onChange={(e) => setCategoria(e.target.value)}
                placeholder="Mercadería, Bebidas, Luz..."
              />
              <datalist id="categorias-list">
                {suggestions.categorias.map((c, i) => (
                  <option key={i} value={c} />
                ))}
              </datalist>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium">Monto ($)</label>
              <Input
                type="number"
                step="any"
                value={monto}
                onChange={(e) => setMonto(e.target.value)}
                placeholder="0.00"
                required
              />
            </div>

            <div className="space-y-1 sm:col-span-2">
              <label className="text-xs font-medium">Descripción / Detalle</label>
              <Input
                value={descripcion}
                onChange={(e) => setDescripcion(e.target.value)}
                placeholder="Detalle de insumos o factura"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium">Medio de Pago</label>
              <Input
                value={medioPago}
                onChange={(e) => setMedioPago(e.target.value)}
                placeholder="Efectivo, Transferencia..."
              />
            </div>

            <div className="flex items-end">
              <Button type="submit" className="w-full">
                <Plus className="h-4 w-4" />
                Agregar Gasto
              </Button>
            </div>
          </form>

          {statusMsg && (
            <p className="mt-3 text-xs font-medium text-primary">{statusMsg}</p>
          )}
        </CardContent>
      </Card>

      {/* Cola de Gastos Pendientes de Sincronizar con Google Sheets */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base">
              Cola de Gastos Pendientes ({entriesData.pendientes.length})
            </CardTitle>
            <CardDescription>
              Ya impactan en los reportes locales; podés copiarlos como TSV o enviarlos por Webhook a Google Sheets
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyTsv}
              disabled={entriesData.pendientes.length === 0}
            >
              {copiedTsv ? (
                <Check className="h-4 w-4 text-emerald-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              Copiar Filas TSV
            </Button>
            <Button
              size="sm"
              onClick={handlePushWebhook}
              disabled={entriesData.pendientes.length === 0}
            >
              <Send className="h-4 w-4" />
              Enviar a Planilla (Webhook)
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Categoría</TableHead>
                <TableHead>Proveedor</TableHead>
                <TableHead>Descripción</TableHead>
                <TableHead>Pago</TableHead>
                <TableHead className="text-right">Monto</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entriesData.pendientes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    No hay gastos pendientes en la cola.
                  </TableCell>
                </TableRow>
              ) : (
                entriesData.pendientes.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-xs">{e.fecha}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{e.categoria}</Badge>
                    </TableCell>
                    <TableCell className="font-medium">{e.proveedor || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {e.descripcion || "—"}
                    </TableCell>
                    <TableCell className="text-xs">{e.medio_pago}</TableCell>
                    <TableCell className="text-right font-semibold">
                      {money(e.monto)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive"
                        onClick={() => handleDiscard(e.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

