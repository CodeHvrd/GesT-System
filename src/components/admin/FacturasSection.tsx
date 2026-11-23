"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  FileText,
  Calendar,
  AlertTriangle,
  Clock,
  DollarSign,
  ChevronDown,
  ChevronRight,
  Building2,
  Check,
  Camera,
  Upload,
  Sparkles,
  Plus,
  Edit3,
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

/**
 * Extrae texto de una imagen en el navegador usando Tesseract.js desde CDN si está disponible,
 * o devuelve cadena vacía para que el servidor use Gemini Vision / heurística.
 */
async function runBrowserOcr(imageDataUrl: string): Promise<string> {
  if (typeof window === "undefined") return "";
  try {
    const w = window as unknown as { Tesseract?: any };
    if (!w.Tesseract) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src =
          "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("No se pudo cargar OCR local"));
        document.head.appendChild(script);
      });
    }
    if (w.Tesseract) {
      const res = await w.Tesseract.recognize(imageDataUrl, "spa");
      return String(res?.data?.text || "").trim();
    }
  } catch {
    // Fallback al escáner del servidor
  }
  return "";
}

function compressImageFile(file: File, maxWidth = 1400): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const img = new Image();
      img.onload = () => {
        const scale = img.width > maxWidth ? maxWidth / img.width : 1;
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(result);
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.84));
      };
      img.onerror = () => resolve(result);
      img.src = result;
    };
    reader.onerror = () => reject(new Error("No se pudo leer la foto"));
    reader.readAsDataURL(file);
  });
}

export function FacturasSection() {
  const today = todayAr();
  const defaultDue7 = addDays(today, 7);

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [filterEstado, setFilterEstado] = useState<string>("pendiente");
  const [filterProv, setFilterProv] = useState<string>("todos");
  const [activeSubTab, setActiveSubTab] = useState<
    "lote" | "cuentas" | "facturas"
  >("lote");
  const [expandedProv, setExpandedProv] = useState<Record<string, boolean>>({});
  const [markingId, setMarkingId] = useState<string | number | null>(null);

  // Estado de carga de factura (Foto + Autocompletado + Manual)
  const [showLoadCard, setShowLoadCard] = useState(true);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [scanningPhoto, setScanningPhoto] = useState(false);
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [autoFields, setAutoFields] = useState<string[]>([]);
  const [missingFields, setMissingFields] = useState<string[]>([]);
  const [manualOcrHint, setManualOcrHint] = useState("");
  const [showTextHelper, setShowTextHelper] = useState(false);

  const [formProveedor, setFormProveedor] = useState("");
  const [formNumero, setFormNumero] = useState("");
  const [formCategoria, setFormCategoria] = useState("Materia Prima / Insumos");
  const [formFechaEmision, setFormFechaEmision] = useState(today);
  const [formFechaVencimiento, setFormFechaVencimiento] = useState(defaultDue7);
  const [formMonto, setFormMonto] = useState("");
  const [formMedioPago, setFormMedioPago] = useState("Cta. Corriente");
  const [formEstadoPago, setFormEstadoPago] = useState<"pendiente" | "pagado">(
    "pendiente"
  );
  const [formDescripcion, setFormDescripcion] = useState("");
  const [savingInvoice, setSavingInvoice] = useState(false);

  // Edición rápida de recordatorio de vencimiento en tabla
  const [editingDueId, setEditingDueId] = useState<string | number | null>(
    null
  );
  const [editingDueDate, setEditingDueDate] = useState<string>("");

  const [suggestions, setSuggestions] = useState<{
    proveedores: Array<any>;
    categorias: string[];
  }>({ proveedores: [], categorias: [] });

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  async function loadInvoices() {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (filterEstado !== "todos") qs.set("estado", filterEstado);
      if (filterProv !== "todos") qs.set("proveedor", filterProv);

      const [res, sugRes] = await Promise.all([
        fetch(`/api/invoices?${qs.toString()}`),
        fetch("/api/suggest"),
      ]);
      const json = await res.json();
      const sugJson = await sugRes.json();
      if (json.ok) {
        setData(json);
      }
      if (sugJson.ok) {
        setSuggestions({
          proveedores: sugJson.proveedores || [],
          categorias: sugJson.categorias || [],
        });
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadInvoices();
  }, [filterEstado, filterProv]);

  function applyScannedResult(scanned: any, sourceLabel: string) {
    if (!scanned) return;
    if (scanned.proveedor) setFormProveedor(scanned.proveedor);
    if (scanned.numero_factura) setFormNumero(scanned.numero_factura);
    if (scanned.categoria) setFormCategoria(scanned.categoria);
    if (scanned.fecha_emision) setFormFechaEmision(scanned.fecha_emision);
    // Recordatorio por defecto: 7 días después de cargada la factura
    setFormFechaVencimiento(scanned.fecha_vencimiento || addDays(todayAr(), 7));
    if (scanned.monto && Number(scanned.monto) > 0) {
      setFormMonto(String(scanned.monto));
    }
    if (scanned.medio_pago) setFormMedioPago(scanned.medio_pago);
    if (scanned.descripcion) setFormDescripcion(scanned.descripcion);

    const auto: string[] = scanned.campos_autocompletados || [];
    const inc: string[] = scanned.campos_incompletos || [];
    setAutoFields(auto);
    setMissingFields(inc);

    if (inc.length === 0) {
      setScanStatus(
        `${sourceLabel}: Se autocompletó toda la factura. Recordatorio de vencimiento fijado a 7 días (${
          scanned.fecha_vencimiento || defaultDue7
        }).`
      );
    } else {
      const labelsMap: Record<string, string> = {
        proveedor: "Proveedor",
        monto: "Monto Total",
        numero_factura: "N° de Comprobante",
        fecha_emision: "Fecha de Emisión",
      };
      const missingLabels = inc.map((k) => labelsMap[k] || k).join(", ");
      setScanStatus(
        `${sourceLabel}: Autocompletado parcial. Completá o verificá manualmente las partes ilegibles (${missingLabels}). Recordatorio fijado a 7 días (${
          scanned.fecha_vencimiento || defaultDue7
        }).`
      );
    }
  }

  async function handlePhotoSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setScanningPhoto(true);
    setScanStatus(
      "Procesando foto de la factura y extrayendo datos legibles..."
    );
    try {
      const dataUrl = await compressImageFile(file);
      setPhotoPreview(dataUrl);

      // 1. Intentar OCR en el navegador + análisis en el servidor (Gemini Vision / Heurística AFIP)
      const localText = await runBrowserOcr(dataUrl);
      const res = await fetch("/api/invoices/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_base64: dataUrl,
          mime_type: file.type || "image/jpeg",
          ocr_text: [localText, manualOcrHint].filter(Boolean).join("\n"),
          file_name: file.name,
        }),
      });
      const json = await res.json();
      if (json.ok && json.scanned) {
        if (json.scanned.texto_detectado) {
          setManualOcrHint(json.scanned.texto_detectado);
        }
        applyScannedResult(json.scanned, "Foto analizada");
      } else {
        setScanStatus(
          "Foto cargada. Algunas partes no se distinguen automáticamente; completá los campos mirando la imagen."
        );
        setMissingFields(["proveedor", "monto", "numero_factura"]);
      }
    } catch (err) {
      setScanStatus(
        `Foto adjuntada (${(err as Error).message}). Completá los campos manualmente mirando la vista previa.`
      );
    } finally {
      setScanningPhoto(false);
      e.target.value = "";
    }
  }

  async function handleAnalyzeTextHint() {
    if (!manualOcrHint.trim()) return;
    setScanningPhoto(true);
    try {
      const res = await fetch("/api/invoices/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ocr_text: manualOcrHint,
        }),
      });
      const json = await res.json();
      if (json.ok && json.scanned) {
        applyScannedResult(json.scanned, "Texto de factura analizado");
      }
    } finally {
      setScanningPhoto(false);
    }
  }

  async function handleCreateInvoice(e: React.FormEvent) {
    e.preventDefault();
    if (!formMonto || Number(formMonto) <= 0) {
      setScanStatus("Ingresá un monto válido mayor a $0.");
      return;
    }
    setSavingInvoice(true);
    setScanStatus(null);
    try {
      const res = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proveedor: formProveedor || "Proveedor a confirmar",
          numero_factura: formNumero,
          categoria: formCategoria,
          fecha_emision: formFechaEmision || today,
          fecha_vencimiento: formFechaVencimiento || defaultDue7,
          monto: formMonto,
          medio_pago: formMedioPago,
          estado_pago: formEstadoPago,
          descripcion: formDescripcion,
          origen: photoPreview ? "foto_app" : "manual_app",
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setData(json);
        setFormProveedor("");
        setFormNumero("");
        setFormMonto("");
        setFormDescripcion("");
        setFormFechaEmision(today);
        setFormFechaVencimiento(defaultDue7);
        setAutoFields([]);
        setMissingFields([]);
        setPhotoPreview(null);
        setScanStatus(
          `Factura guardada en Neon DB con recordatorio de vencimiento para el ${
            json.fecha_vencimiento || formFechaVencimiento
          }.`
        );
      } else {
        setScanStatus(`Error al guardar: ${json.error}`);
      }
    } finally {
      setSavingInvoice(false);
    }
  }

  async function handleToggleStatus(
    invoiceId: string | number,
    currentEstado: string
  ) {
    const nextEstado = currentEstado === "pagado" ? "pendiente" : "pagado";
    setMarkingId(invoiceId);
    try {
      const res = await fetch("/api/invoices", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoice_id: invoiceId,
          estado: nextEstado,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        await loadInvoices();
      }
    } finally {
      setMarkingId(null);
    }
  }

  async function handleSaveCustomDueDate(invoiceId: string | number) {
    if (!editingDueDate) return;
    setMarkingId(invoiceId);
    try {
      const res = await fetch("/api/invoices", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoice_id: invoiceId,
          fecha_vencimiento: editingDueDate,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setEditingDueId(null);
        await loadInvoices();
      }
    } finally {
      setMarkingId(null);
    }
  }

  function toggleProv(provKey: string) {
    setExpandedProv((prev) => ({ ...prev, [provKey]: !prev[provKey] }));
  }

  function fieldBadge(fieldName: string) {
    if (missingFields.includes(fieldName)) {
      return (
        <span className="ml-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
          Completar manual
        </span>
      );
    }
    if (autoFields.includes(fieldName)) {
      return (
        <span className="ml-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
          Autocompletado
        </span>
      );
    }
    return null;
  }

  const kpis = data?.kpis || {};
  const proximoCorte = data?.proximo_corte || { dayName: "Martes", date: "" };
  const lote = data?.lote_sugerido || [];
  const cuentas = data?.cuentas_corrientes || [];
  const facturas = data?.facturas || [];

  return (
    <div className="space-y-6">
      {/* 1. Carga Inteligente de Facturas por Foto / Cámara + Vencimiento a 7 días */}
      <Card className="border-primary/30">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <Camera className="h-4 w-4 text-primary" />
                <span>Cargar Factura con Foto o Manual</span>
                <Badge variant="secondary" className="text-[10px]">
                  Vencimiento default: +7 días ({defaultDue7})
                </Badge>
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                Tomá una foto o subí una imagen de la factura para autocompletar
                los datos legibles. Lo que no se distinga en la foto queda
                marcado para que lo completes vos.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handlePhotoSelected}
                className="hidden"
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handlePhotoSelected}
                className="hidden"
              />
              <Button
                type="button"
                size="sm"
                onClick={() => cameraInputRef.current?.click()}
                disabled={scanningPhoto}
              >
                <Camera className="h-3.5 w-3.5" />
                {scanningPhoto ? "Leyendo foto..." : "Tomar Foto"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={scanningPhoto}
              >
                <Upload className="h-3.5 w-3.5" />
                Subir Imagen
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowTextHelper(!showTextHelper)}
                className="text-xs"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {showTextHelper ? "Ocultar Asistente Texto" : "Pegar Texto / Simular"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowLoadCard(!showLoadCard)}
                className="text-xs"
              >
                {showLoadCard ? "Minimizar" : "Expandir"}
              </Button>
            </div>
          </div>
        </CardHeader>

        {showLoadCard && (
          <CardContent className="space-y-4">
            {showTextHelper && (
              <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    Si tenés texto copiado de una factura digital o querés probar el autocompletado parcial:
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => {
                        const sample =
                          "FACTURA A N° 0004-00089412\nLOS GRINGOS S.R.L.\nCUIT 30-71458963-9\nFecha de Emisión: 23/11/2026\nFiambres y quesos varios\nIMPORTE TOTAL: $ 225.735,00";
                        setManualOcrHint(sample);
                      }}
                    >
                      Cargar Ejemplo Legible
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => {
                        const blurrySample =
                          "FACTURA A\nLOS GRINGOS S.R.L.\nFecha: 23/11/2026\n[Monto y Nro borrosos en la foto]";
                        setManualOcrHint(blurrySample);
                      }}
                    >
                      Simular Foto con Partes Ilegibles
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={handleAnalyzeTextHint}
                      disabled={scanningPhoto}
                    >
                      <Sparkles className="h-3 w-3" />
                      Autocompletar Campos
                    </Button>
                  </div>
                </div>
                <textarea
                  value={manualOcrHint}
                  onChange={(e) => setManualOcrHint(e.target.value)}
                  rows={3}
                  placeholder="Texto detectado en la foto o pegado manualmente..."
                  className="w-full rounded-md border bg-background p-2 font-mono text-xs"
                />
              </div>
            )}

            {scanStatus && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs font-medium text-foreground flex items-center justify-between gap-2">
                <span>{scanStatus}</span>
                {missingFields.length > 0 && (
                  <Badge variant="warning" className="text-[10px] shrink-0">
                    {missingFields.length} campo(s) para completar a mano
                  </Badge>
                )}
              </div>
            )}

            <div
              className={`grid grid-cols-1 gap-4 ${
                photoPreview ? "lg:grid-cols-3" : ""
              }`}
            >
              {/* Vista previa de la foto tomada para que el usuario lea las partes borrosas */}
              {photoPreview && (
                <div className="rounded-lg border bg-muted/20 p-3 flex flex-col justify-between space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-muted-foreground">
                      Vista previa de la Factura
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => setPhotoPreview(null)}
                      title="Quitar foto"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="relative overflow-hidden rounded border bg-black/5 flex items-center justify-center max-h-64">
                    <img
                      src={photoPreview}
                      alt="Foto de factura"
                      className="max-h-64 w-auto object-contain"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Mirá la foto para completar cualquier dato que haya salido
                    borroso o doblado.
                  </p>
                </div>
              )}

              {/* Formulario de la factura (autocompletado + editable por el usuario) */}
              <form
                onSubmit={handleCreateInvoice}
                className={`grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 ${
                  photoPreview ? "lg:col-span-2" : ""
                }`}
              >
                <div className="space-y-1">
                  <label className="text-xs font-medium flex items-center">
                    <span>Proveedor</span>
                    {fieldBadge("proveedor")}
                  </label>
                  <Input
                    list="inv-proveedores-list"
                    value={formProveedor}
                    onChange={(e) => setFormProveedor(e.target.value)}
                    placeholder="Ej. Los Gringos, CocaCola..."
                    className={
                      missingFields.includes("proveedor")
                        ? "border-amber-500 ring-1 ring-amber-500/30"
                        : ""
                    }
                    required
                  />
                  <datalist id="inv-proveedores-list">
                    {suggestions.proveedores.map((p, i) => (
                      <option key={i} value={p.proveedor} />
                    ))}
                  </datalist>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium flex items-center">
                    <span>Monto Total ($)</span>
                    {fieldBadge("monto")}
                  </label>
                  <Input
                    type="number"
                    step="any"
                    value={formMonto}
                    onChange={(e) => setFormMonto(e.target.value)}
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
                  <label className="text-xs font-medium flex items-center">
                    <span>N° Factura / Comprobante</span>
                    {fieldBadge("numero_factura")}
                  </label>
                  <Input
                    value={formNumero}
                    onChange={(e) => setFormNumero(e.target.value)}
                    placeholder="Ej. 0001-00045812 (opcional)"
                    className={
                      missingFields.includes("numero_factura")
                        ? "border-amber-500 ring-1 ring-amber-500/30"
                        : ""
                    }
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium flex items-center">
                    <span>Categoría / Rubro</span>
                    {fieldBadge("categoria")}
                  </label>
                  <Input
                    list="inv-categorias-list"
                    value={formCategoria}
                    onChange={(e) => setFormCategoria(e.target.value)}
                    placeholder="Materia Prima, Bebidas..."
                  />
                  <datalist id="inv-categorias-list">
                    {suggestions.categorias.map((c, i) => (
                      <option key={i} value={c} />
                    ))}
                  </datalist>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium flex items-center">
                    <span>Fecha de Emisión</span>
                    {fieldBadge("fecha_emision")}
                  </label>
                  <Input
                    type="date"
                    value={formFechaEmision}
                    onChange={(e) => setFormFechaEmision(e.target.value)}
                    required
                  />
                </div>

                <div className="space-y-1 sm:col-span-2">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <label className="text-xs font-semibold text-primary flex items-center">
                      <span>Recordatorio de Vencimiento (Editable)</span>
                      <span className="ml-1.5 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        Default: +7 días de carga
                      </span>
                    </label>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setFormFechaVencimiento(addDays(today, 7))}
                        className="rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted"
                      >
                        +7 días
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormFechaVencimiento(addDays(today, 14))}
                        className="rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted"
                      >
                        +14 días
                      </button>
                      {proximoCorte.date && (
                        <button
                          type="button"
                          onClick={() => setFormFechaVencimiento(proximoCorte.date)}
                          className="rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted"
                        >
                          Próx. {proximoCorte.dayName}
                        </button>
                      )}
                    </div>
                  </div>
                  <Input
                    type="date"
                    value={formFechaVencimiento}
                    onChange={(e) => setFormFechaVencimiento(e.target.value)}
                    required
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium">Estado Inicial</label>
                  <select
                    value={formEstadoPago}
                    onChange={(e) =>
                      setFormEstadoPago(
                        e.target.value as "pendiente" | "pagado"
                      )
                    }
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs font-medium"
                  >
                    <option value="pendiente">
                      Pendiente de Pago (Cta. Cte.)
                    </option>
                    <option value="pagado">Ya Pagada</option>
                  </select>
                </div>

                <div className="space-y-1 sm:col-span-3">
                  <label className="text-xs font-medium">
                    Detalle / Notas (o lo que quieras aclarar de la foto)
                  </label>
                  <Input
                    value={formDescripcion}
                    onChange={(e) => setFormDescripcion(e.target.value)}
                    placeholder="Detalle de mercadería, observaciones o aclaraciones"
                  />
                </div>

                <div className="flex items-end">
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={savingInvoice}
                  >
                    <Plus className="h-4 w-4" />
                    {savingInvoice ? "Guardando..." : "Guardar Factura"}
                  </Button>
                </div>
              </form>
            </div>
          </CardContent>
        )}
      </Card>

      {/* 2. KPIs Principales de Tesorería y Pagos */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium">
                Deuda en Cta. Cte.
              </span>
              <DollarSign className="h-4 w-4 text-primary" />
            </div>
            <div className="mt-2 text-2xl font-bold">
              {money(kpis.total_deuda || 0)}
            </div>
            <span className="text-[11px] text-muted-foreground">
              {kpis.total_facturas_pendientes || 0} facturas pendientes
            </span>
          </CardContent>
        </Card>

        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-primary font-semibold">
                Lote {proximoCorte.dayName}
              </span>
              <Calendar className="h-4 w-4 text-primary" />
            </div>
            <div className="mt-2 text-2xl font-bold text-primary">
              {money(kpis.monto_proximo_corte || 0)}
            </div>
            <span className="text-[11px] text-muted-foreground">
              Corte más próximo: {proximoCorte.date || "Programado"}
            </span>
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium">
                Alerta &ge; 7 días cargadas
              </span>
              <Clock className="h-4 w-4 text-amber-500" />
            </div>
            <div className="mt-2 text-2xl font-bold text-amber-600 dark:text-amber-400">
              {kpis.total_mas_de_una_semana || 0}
            </div>
            <span className="text-[11px] text-muted-foreground">
              Priorizadas para próximo pago
            </span>
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium">
                Facturas Vencidas
              </span>
              <AlertTriangle className="h-4 w-4 text-red-500" />
            </div>
            <div className="mt-2 text-2xl font-bold text-red-600 dark:text-red-400">
              {kpis.total_vencidas || 0}
            </div>
            <span className="text-[11px] text-muted-foreground">
              Recordatorio superado
            </span>
          </CardContent>
        </Card>
      </div>

      {/* 3. Selector de Subpestañas */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div className="flex items-center gap-2">
          <Button
            variant={activeSubTab === "lote" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveSubTab("lote")}
            className="text-xs"
          >
            <Calendar className="h-3.5 w-3.5 mr-1.5" />
            Planificador Martes / Viernes ({lote.length})
          </Button>
          <Button
            variant={activeSubTab === "cuentas" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveSubTab("cuentas")}
            className="text-xs"
          >
            <Building2 className="h-3.5 w-3.5 mr-1.5" />
            Cuentas Corrientes ({cuentas.length})
          </Button>
          <Button
            variant={activeSubTab === "facturas" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveSubTab("facturas")}
            className="text-xs"
          >
            <FileText className="h-3.5 w-3.5 mr-1.5" />
            Todas las Facturas ({facturas.length})
          </Button>
        </div>

        {activeSubTab === "facturas" && (
          <div className="flex items-center gap-2">
            <select
              value={filterEstado}
              onChange={(e) => setFilterEstado(e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2.5 text-xs font-medium"
            >
              <option value="todos">Todos los Estados</option>
              <option value="pendiente">Solo Pendientes</option>
              <option value="pagado">Solo Pagadas</option>
            </select>
          </div>
        )}
      </div>

      {/* 4. Vista 1: Planificador de Pagos (Martes y Viernes) */}
      {activeSubTab === "lote" && (
        <Card className="border-primary/20">
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <CardTitle className="text-base font-bold flex items-center gap-2">
                  <span>Próximo Lote de Pagos: {proximoCorte.dayName}</span>
                  <Badge
                    variant="outline"
                    className="text-xs bg-primary/10 text-primary"
                  >
                    {proximoCorte.date}
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs mt-1">
                  Facturas que cumplieron su recordatorio de 7 días o próximas a
                  vencer, listas para abonar este {proximoCorte.dayName}. Podés
                  modificar la fecha de recordatorio haciendo clic en el ícono
                  de edición.
                </CardDescription>
              </div>
              <Badge
                variant="secondary"
                className="text-xs h-7 px-3 font-semibold"
              >
                Total del Lote: {money(kpis.monto_proximo_corte || 0)}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {lote.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Proveedor</TableHead>
                      <TableHead>Factura / Comprobante</TableHead>
                      <TableHead>Fecha Emisión</TableHead>
                      <TableHead>Días Cargada</TableHead>
                      <TableHead>Recordatorio Vto. (Editable)</TableHead>
                      <TableHead className="text-right">Monto</TableHead>
                      <TableHead className="text-center">Estado</TableHead>
                      <TableHead className="text-right">Acción</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lote.map((item: any) => (
                      <TableRow key={item.id} className="hover:bg-muted/50">
                        <TableCell className="font-semibold text-xs">
                          {item.proveedor}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {item.numero_factura || item.descripcion || "S/N"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {item.fecha_emision}
                        </TableCell>
                        <TableCell className="text-xs">
                          <Badge
                            variant={
                              item.dias_desde_carga >= 7 ? "warning" : "outline"
                            }
                            className="text-[10px]"
                          >
                            {item.dias_desde_carga} d
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          {editingDueId === item.id ? (
                            <div className="flex items-center gap-1">
                              <Input
                                type="date"
                                value={editingDueDate}
                                onChange={(e) =>
                                  setEditingDueDate(e.target.value)
                                }
                                className="h-7 w-32 text-xs"
                              />
                              <Button
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => handleSaveCustomDueDate(item.id)}
                              >
                                OK
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <span
                                className={
                                  item.fecha_vencimiento <
                                  (data?.kpis?.proximo_corte?.date || "")
                                    ? "text-red-500 font-semibold"
                                    : "text-foreground"
                                }
                              >
                                {item.fecha_vencimiento}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingDueId(item.id);
                                  setEditingDueDate(item.fecha_vencimiento);
                                }}
                                className="text-muted-foreground hover:text-primary"
                                title="Modificar recordatorio de vencimiento"
                              >
                                <Edit3 className="h-3 w-3" />
                              </button>
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-xs font-bold">
                          {money(item.monto)}
                        </TableCell>
                        <TableCell className="text-center text-xs">
                          <Badge
                            variant={
                              item.estado_pago === "pagado"
                                ? "success"
                                : "warning"
                            }
                            className="text-[10px]"
                          >
                            {item.estado_pago}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={markingId === item.id}
                            onClick={() =>
                              handleToggleStatus(item.id, item.estado_pago)
                            }
                            className="h-7 text-xs gap-1"
                          >
                            <Check className="h-3 w-3 text-emerald-500" />
                            {item.estado_pago === "pagado"
                              ? "Desmarcar"
                              : "Marcar Pagado"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="p-8 text-center text-xs text-muted-foreground border rounded-md">
                No hay facturas pendientes para el lote de{" "}
                {proximoCorte.dayName}.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 5. Vista 2: Cuentas Corrientes por Proveedor */}
      {activeSubTab === "cuentas" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              Estado de Cuentas Corrientes con Proveedores
            </CardTitle>
            <CardDescription className="text-xs">
              Resumen del saldo pendiente con cada proveedor y detalle de sus
              comprobantes
            </CardDescription>
          </CardHeader>
          <CardContent>
            {cuentas.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10"></TableHead>
                      <TableHead>Proveedor</TableHead>
                      <TableHead className="text-center">
                        Facturas Pendientes
                      </TableHead>
                      <TableHead className="text-center">Vencidas</TableHead>
                      <TableHead>Próximo Vencimiento</TableHead>
                      <TableHead className="text-right">
                        A Pagar este Lote
                      </TableHead>
                      <TableHead className="text-right">Deuda Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cuentas.map((c: any) => {
                      const isExpanded = !!expandedProv[c.proveedor_key];
                      return (
                        <React.Fragment key={c.proveedor_key}>
                          <TableRow
                            className="cursor-pointer hover:bg-muted/50 transition-colors"
                            onClick={() => toggleProv(c.proveedor_key)}
                          >
                            <TableCell className="text-center p-2">
                              {isExpanded ? (
                                <ChevronDown className="h-4 w-4 text-muted-foreground mx-auto" />
                              ) : (
                                <ChevronRight className="h-4 w-4 text-muted-foreground mx-auto" />
                              )}
                            </TableCell>
                            <TableCell className="font-semibold text-xs">
                              {c.proveedor}
                            </TableCell>
                            <TableCell className="text-center text-xs">
                              <Badge variant="outline" className="text-[10px]">
                                {c.facturas_pendientes}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-center text-xs">
                              {c.facturas_vencidas > 0 ? (
                                <Badge
                                  variant="destructive"
                                  className="text-[10px]"
                                >
                                  {c.facturas_vencidas}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">0</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {c.proximo_vencimiento || "-"}
                            </TableCell>
                            <TableCell className="text-right text-xs font-semibold text-primary">
                              {money(c.monto_proximo_lote)}
                            </TableCell>
                            <TableCell className="text-right text-xs font-bold text-foreground">
                              {money(c.total_deuda)}
                            </TableCell>
                          </TableRow>

                          {isExpanded && (
                            <TableRow className="bg-muted/30 hover:bg-muted/30">
                              <TableCell colSpan={7} className="p-3 pl-8">
                                <div className="rounded-lg border bg-background/90 p-3 space-y-2">
                                  <div className="text-xs font-semibold text-muted-foreground">
                                    Facturas de {c.proveedor} (
                                    {c.facturas.length})
                                  </div>
                                  <div className="divide-y divide-border text-xs">
                                    {c.facturas.map((f: any) => (
                                      <div
                                        key={f.id}
                                        className="flex items-center justify-between py-2 gap-4"
                                      >
                                        <div className="flex items-center gap-3 min-w-0">
                                          <span className="font-medium truncate">
                                            {f.numero_factura ||
                                              f.descripcion ||
                                              "Factura"}
                                          </span>
                                          <span className="text-[11px] text-muted-foreground">
                                            Emitida: {f.fecha_emision} ·
                                            Recordatorio: {f.fecha_vencimiento}
                                          </span>
                                          {f.dias_desde_carga >= 7 && (
                                            <Badge
                                              variant="warning"
                                              className="text-[9px]"
                                            >
                                              +7 días
                                            </Badge>
                                          )}
                                        </div>
                                        <div className="flex items-center gap-3 shrink-0">
                                          <span className="font-bold">
                                            {money(f.monto)}
                                          </span>
                                          <Badge
                                            variant={
                                              f.estado_pago === "pagado"
                                                ? "success"
                                                : "outline"
                                            }
                                            className="text-[10px]"
                                          >
                                            {f.estado_pago}
                                          </Badge>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            disabled={markingId === f.id}
                                            onClick={() =>
                                              handleToggleStatus(
                                                f.id,
                                                f.estado_pago
                                              )
                                            }
                                            className="h-6 px-2 text-[11px]"
                                          >
                                            {f.estado_pago === "pagado"
                                              ? "Desmarcar"
                                              : "Marcar Pagado"}
                                          </Button>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="p-8 text-center text-xs text-muted-foreground border rounded-md">
                No hay cuentas corrientes registradas.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 6. Vista 3: Listado General de Facturas */}
      {activeSubTab === "facturas" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              Listado de Facturas de Gastos
            </CardTitle>
            <CardDescription className="text-xs">
              Historial completo de compras y comprobantes cargados por foto,
              manualmente o desde Fudo
            </CardDescription>
          </CardHeader>
          <CardContent>
            {facturas.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fecha Emisión</TableHead>
                      <TableHead>Proveedor</TableHead>
                      <TableHead>Comprobante</TableHead>
                      <TableHead>Recordatorio Vto. (Editable)</TableHead>
                      <TableHead>Próx. Lote</TableHead>
                      <TableHead className="text-right">Monto</TableHead>
                      <TableHead className="text-center">Estado</TableHead>
                      <TableHead className="text-right">Acción</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {facturas.map((f: any) => (
                      <TableRow key={f.id} className="hover:bg-muted/50">
                        <TableCell className="text-xs">
                          {f.fecha_emision}
                        </TableCell>
                        <TableCell className="font-semibold text-xs">
                          {f.proveedor}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {f.numero_factura || f.descripcion || "S/N"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {editingDueId === f.id ? (
                            <div className="flex items-center gap-1">
                              <Input
                                type="date"
                                value={editingDueDate}
                                onChange={(e) =>
                                  setEditingDueDate(e.target.value)
                                }
                                className="h-7 w-32 text-xs"
                              />
                              <Button
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => handleSaveCustomDueDate(f.id)}
                              >
                                OK
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <span>{f.fecha_vencimiento}</span>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingDueId(f.id);
                                  setEditingDueDate(f.fecha_vencimiento);
                                }}
                                className="text-muted-foreground hover:text-primary"
                                title="Modificar recordatorio de vencimiento"
                              >
                                <Edit3 className="h-3 w-3" />
                              </button>
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          <Badge
                            variant={
                              f.proximo_dia_pago === "Martes" ||
                              f.proximo_dia_pago === "Viernes"
                                ? "secondary"
                                : "outline"
                            }
                            className="text-[10px]"
                          >
                            {f.proximo_dia_pago}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right text-xs font-bold">
                          {money(f.monto)}
                        </TableCell>
                        <TableCell className="text-center text-xs">
                          <Badge
                            variant={
                              f.estado_pago === "pagado" ? "success" : "warning"
                            }
                            className="text-[10px]"
                          >
                            {f.estado_pago}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={markingId === f.id}
                            onClick={() =>
                              handleToggleStatus(f.id, f.estado_pago)
                            }
                            className="h-7 text-xs"
                          >
                            {f.estado_pago === "pagado"
                              ? "Desmarcar"
                              : "Marcar Pagado"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="p-8 text-center text-xs text-muted-foreground border rounded-md">
                No se encontraron facturas con los filtros seleccionados.
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
