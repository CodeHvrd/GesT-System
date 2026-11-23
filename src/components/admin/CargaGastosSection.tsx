"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Plus,
  Send,
  Copy,
  Trash2,
  Check,
  Camera,
  Upload,
  X,
} from "lucide-react";
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
import { addDays, todayAr } from "@/lib/dates";

interface CargaGastosSectionProps {
  onEntriesChanged: () => void;
}

export function CargaGastosSection({
  onEntriesChanged,
}: CargaGastosSectionProps) {
  const today = todayAr();
  const defaultDue7 = addDays(today, 7);

  const [fecha, setFecha] = useState(() => today);
  const [fechaVencimiento, setFechaVencimiento] = useState(() => defaultDue7);
  const [destino, setDestino] = useState<
    | "caja_principal"
    | "factura_proveedor"
    | "caja_grande_variable"
    | "caja_grande_fijo"
  >("caja_principal");
  const [proveedor, setProveedor] = useState("");
  const [categoria, setCategoria] = useState("Mercadería");
  const [descripcion, setDescripcion] = useState("");
  const [monto, setMonto] = useState("");
  const [cantidad, setCantidad] = useState("1");
  const [medioPago, setMedioPago] = useState("Efectivo");
  const [comprobante, setComprobante] = useState("");

  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [scanningPhoto, setScanningPhoto] = useState(false);
  const [missingFields, setMissingFields] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

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

  async function handleScanInvoicePhoto(
    e: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanningPhoto(true);
    setStatusMsg("Analizando foto de la factura para autocompletar...");
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("No se pudo leer la imagen"));
        reader.readAsDataURL(file);
      });
      setPhotoPreview(dataUrl);
      setDestino("factura_proveedor");
      setMedioPago("Cta. Corriente");

      const res = await fetch("/api/invoices/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_base64: dataUrl,
          mime_type: file.type || "image/jpeg",
          file_name: file.name,
        }),
      });
      const json = await res.json();
      if (json.ok && json.scanned) {
        const s = json.scanned;
        if (s.proveedor) setProveedor(s.proveedor);
        if (s.categoria) setCategoria(s.categoria);
        if (s.fecha_emision) setFecha(s.fecha_emision);
        setFechaVencimiento(s.fecha_vencimiento || defaultDue7);
        if (s.monto && Number(s.monto) > 0) setMonto(String(s.monto));
        if (s.numero_factura) setComprobante(s.numero_factura);
        if (s.descripcion) setDescripcion(s.descripcion);
        setMissingFields(s.campos_incompletos || []);
        setStatusMsg(
          (s.campos_incompletos || []).length > 0
            ? `Foto cargada. Completá manualmente los datos ilegibles resaltados. Recordatorio de vencimiento fijado a 7 días (${
                s.fecha_vencimiento || defaultDue7
              }).`
            : `Factura autocompletada con éxito. Recordatorio de vencimiento a 7 días (${
                s.fecha_vencimiento || defaultDue7
              }).`
        );
      }
    } catch (err) {
      setStatusMsg(
        `Foto adjuntada (${(err as Error).message}). Completá los campos mirando la foto.`
      );
    } finally {
      setScanningPhoto(false);
      e.target.value = "";
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
        fecha_vencimiento: fechaVencimiento || defaultDue7,
        destino,
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
      setPhotoPreview(null);
      setMissingFields([]);
      setFechaVencimiento(defaultDue7);
      setEntriesData(json);
      setStatusMsg(
        "Gasto registrado en Neon PostgreSQL y SQLite (con recordatorio de vencimiento si es factura)."
      );
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">
                Centro Unificado de Carga de Gastos, Cajas y Facturas
              </CardTitle>
              <CardDescription>
                Guardado directo en Neon DB · Podés sacar una foto a la factura
                para autocompletar y completar a mano lo que no sea legible
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleScanInvoicePhoto}
                className="hidden"
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleScanInvoicePhoto}
                className="hidden"
              />
              <Button
                type="button"
                size="sm"
                onClick={() => cameraInputRef.current?.click()}
                disabled={scanningPhoto}
              >
                <Camera className="h-3.5 w-3.5" />
                {scanningPhoto ? "Leyendo foto..." : "Tomar Foto Factura"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={scanningPhoto}
              >
                <Upload className="h-3.5 w-3.5" />
                Subir Foto
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {photoPreview && (
            <div className="rounded-lg border bg-muted/20 p-3 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <img
                  src={photoPreview}
                  alt="Vista previa factura"
                  className="h-20 w-auto rounded border object-contain"
                />
                <div className="text-xs space-y-1">
                  <div className="font-semibold">
                    Foto de factura adjuntada
                  </div>
                  <p className="text-muted-foreground">
                    Verificá y completá abajo cualquier campo que no haya sido
                    legible en la imagen.
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setPhotoPreview(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <div className="space-y-1">
              <label className="text-xs font-medium">
                Destino / Caja en la App
              </label>
              <select
                value={destino}
                onChange={(e) => {
                  const val = e.target.value as any;
                  setDestino(val);
                  if (val === "factura_proveedor") {
                    setMedioPago("Cta. Corriente");
                  }
                }}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs font-medium"
              >
                <option value="caja_principal">
                  Caja Principal (Gasto día a día)
                </option>
                <option value="factura_proveedor">
                  Factura de Proveedor (Cta. Cte. / +7 días)
                </option>
                <option value="caja_grande_variable">
                  Caja Grande (Retiro Variable)
                </option>
                <option value="caja_grande_fijo">
                  Caja Grande (Gasto Fijo Mensual)
                </option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium">Fecha Emisión</label>
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
                className={
                  missingFields.includes("proveedor")
                    ? "border-amber-500 ring-1 ring-amber-500/30"
                    : ""
                }
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
                className={
                  missingFields.includes("monto")
                    ? "border-amber-500 ring-1 ring-amber-500/30"
                    : ""
                }
                required
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium">
                N° Factura / Comprobante
              </label>
              <Input
                value={comprobante}
                onChange={(e) => setComprobante(e.target.value)}
                placeholder="Ej. 0001-00012345"
                className={
                  missingFields.includes("numero_factura")
                    ? "border-amber-500 ring-1 ring-amber-500/30"
                    : ""
                }
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-primary">
                Recordatorio Vencimiento (+7 días default)
              </label>
              <Input
                type="date"
                value={fechaVencimiento}
                onChange={(e) => setFechaVencimiento(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium">Medio de Pago</label>
              <Input
                value={medioPago}
                onChange={(e) => setMedioPago(e.target.value)}
                placeholder="Efectivo, Cta. Corriente, Transferencia..."
              />
            </div>

            <div className="space-y-1 sm:col-span-3">
              <label className="text-xs font-medium">
                Descripción / Detalle
              </label>
              <Input
                value={descripcion}
                onChange={(e) => setDescripcion(e.target.value)}
                placeholder="Detalle de insumos o factura"
              />
            </div>

            <div className="flex items-end">
              <Button type="submit" className="w-full">
                <Plus className="h-4 w-4" />
                Guardar en App (Neon DB)
              </Button>
            </div>
          </form>

          {statusMsg && (
            <p className="mt-3 text-xs font-medium text-primary">{statusMsg}</p>
          )}
        </CardContent>
      </Card>

      {/* Cola de Gastos Recientes (con opción de exportar TSV/Webhook mientras convivan con Sheets) */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base">
              Gastos Cargados en esta Sesión ({entriesData.pendientes.length})
            </CardTitle>
            <CardDescription>
              Ya están guardados en la base de datos de la App; si todavía
              querés pegarlos en el Excel durante la transición, podés copiarlos
              como TSV
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
                  <TableCell
                    colSpan={7}
                    className="text-center text-muted-foreground"
                  >
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
                    <TableCell className="font-medium">
                      {e.proveedor || "—"}
                    </TableCell>
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
