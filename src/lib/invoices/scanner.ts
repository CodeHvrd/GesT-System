import { addDays, parseDate, todayAr } from "@/lib/dates";
import { norm, normKey, normProvider, parseNumber, round } from "@/lib/format";
import { suggest } from "@/lib/analytics/local-analytics";
import { loadConfig } from "@/lib/config";

export interface ScannedInvoiceFields {
  proveedor: string;
  cuit: string;
  numero_factura: string;
  tipo_comprobante: string;
  fecha_emision: string;
  fecha_vencimiento: string;
  monto: number;
  categoria: string;
  medio_pago: string;
  descripcion: string;
  confianza: "alta" | "media" | "baja";
  campos_autocompletados: string[];
  campos_incompletos: string[];
  texto_detectado: string;
}

const CATEGORY_KEYWORDS: Array<{ categoria: string; words: string[] }> = [
  {
    categoria: "Fiambres y Lácteos",
    words: ["fiambre", "queso", "muzzarella", "jamon", "lacteo", "crema", "manteca", "leche", "gringos"],
  },
  {
    categoria: "Bebidas",
    words: ["coca", "gaseosa", "cerveza", "agua", "vino", "jugo", "fanta", "sprite", "quilmes", "bebida"],
  },
  {
    categoria: "Panificados y Harinas",
    words: ["pan", "harina", "medialuna", "tostado", "brioche", "panaderia", "marleand", "levadura"],
  },
  {
    categoria: "Descartables y Papelera",
    words: ["papelera", "bolsa", "servilleta", "vaso", "bandeja", "descartable", "rollo", "film", "caja"],
  },
  {
    categoria: "Carnes y Granja",
    words: ["carne", "pollo", "bife", "lomito", "hamburguesa", "frigorifico", "carniceria", "huevo"],
  },
  {
    categoria: "Verdulería y Frutas",
    words: ["verduleria", "tomate", "lechuga", "papa", "cebolla", "limon", "palta", "fruta", "verdura"],
  },
  {
    categoria: "Cafetería e Insumos",
    words: ["cafe", "azucar", "edulcorante", "te", "chocolate", "alfajor", "promarco"],
  },
  {
    categoria: "Servicios e Impuestos",
    words: ["luz", "edenor", "edesur", "edemsa", "ecogas", "gas", "obras sanitarias", "aysa", "internet", "afip", "arba"],
  },
];

function inferCategoryFromText(text: string): string {
  const k = normKey(text);
  for (const rule of CATEGORY_KEYWORDS) {
    if (rule.words.some((w) => k.includes(normKey(w)))) {
      return rule.categoria;
    }
  }
  return "Materia Prima / Insumos";
}

function extractCuit(text: string): string {
  const m = /\b(20|23|24|27|30|33|34)[-\s]?(\d{8})[-\s]?(\d)\b/.exec(text);
  if (!m) return "";
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function extractInvoiceNumber(text: string): { numero: string; tipo: string } {
  const tipoMatch = /\b(?:FACTURA|FACT|FC|REMITO|RECIBO|TICKET)\s*([ABCX]|NRO|N°)?\b/i.exec(text);
  const tipo = tipoMatch
    ? norm(tipoMatch[0]).toUpperCase()
    : "FACTURA";

  // Formato punto de venta + número: 0001-00012345 o 00001 - 00045678
  const pvMatch = /\b(\d{4,5})\s*[-–]\s*(\d{6,8})\b/.exec(text);
  if (pvMatch) {
    return {
      numero: `${pvMatch[1].padStart(4, "0")}-${pvMatch[2].padStart(8, "0")}`,
      tipo,
    };
  }

  // Formato N° 123456
  const nroMatch = /(?:NRO|N°|NUM|NUMERO|COMP\.?\s*NRO)[:.\s#]*([A-Z]?\s*\d{3,5}[-\s]\d{4,8}|\d{5,10})/i.exec(
    text
  );
  if (nroMatch) {
    return {
      numero: norm(nroMatch[1]).replace(/\s+/g, ""),
      tipo,
    };
  }

  return { numero: "", tipo };
}

function extractEmissionDate(text: string): string {
  // Buscar primero cerca de la palabra "Fecha"
  const labeledMatch =
    /(?:FECHA(?:\s+DE\s+EMISI[OÓ]N)?|EMISI[OÓ]N)[:.\s]*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/i.exec(
      text
    );
  if (labeledMatch) {
    const parsed = parseDate(labeledMatch[1]);
    if (parsed) return parsed;
  }

  // Buscar cualquier fecha DD/MM/YYYY o DD-MM-YY en el documento
  const allDates = text.match(/\b(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\b/g) || [];
  for (const raw of allDates) {
    const parsed = parseDate(raw);
    if (parsed && parsed >= "2020-01-01" && parsed <= "2030-12-31") {
      return parsed;
    }
  }
  return "";
}

function extractTotalAmount(text: string): number {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // 1. Buscar líneas con TOTAL / IMPORTE TOTAL / A PAGAR / NETO
  const totalRegex =
    /(?:IMPORTE\s+TOTAL|TOTAL\s+A\s+PAGAR|TOTAL\s+FACTURA|NETO\s+A\s+PAGAR|\bTOTAL\b)[^0-9$]*\$?\s*([0-9]{1,3}(?:[.,][0-9]{3})+(?:[.,][0-9]{1,2})?|[0-9]{3,9}(?:[.,][0-9]{1,2})?)/i;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/SUB\s*TOTAL/i.test(line) && !/IMPORTE\s+TOTAL/i.test(line)) continue;
    const m = totalRegex.exec(line);
    if (m) {
      const val = parseNumber(m[1]);
      if (val > 0) return round(val, 2);
    }
  }

  // 2. Si "TOTAL" está en una línea y el monto en la siguiente
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\b(?:IMPORTE\s+TOTAL|TOTAL)\b/i.test(lines[i]) && !/SUB\s*TOTAL/i.test(lines[i])) {
      const nextLine = lines[i + 1] || "";
      const mNext = /\$?\s*([0-9]{1,3}(?:[.,][0-9]{3})+(?:[.,][0-9]{2})?|[0-9]{3,9}(?:[.,][0-9]{2})?)/.exec(
        nextLine
      );
      if (mNext) {
        const val = parseNumber(mNext[1]);
        if (val > 0) return round(val, 2);
      }
    }
  }

  // 3. Buscar todos los importes con signo $ o formato decimal de moneda y tomar el mayor razonable
  const moneyMatches =
    text.match(/\$\s*([0-9]{1,3}(?:[.,][0-9]{3})+(?:[.,][0-9]{1,2})?|[0-9]{3,9}(?:[.,][0-9]{1,2})?)/g) ||
    text.match(/\b([0-9]{1,3}(?:\.[0-9]{3})+,[0-9]{2})\b/g) ||
    [];

  let maxAmount = 0;
  for (const raw of moneyMatches) {
    const val = parseNumber(raw);
    // Evitar confundir un CUIT o número de comprobante sin decimales con un monto
    if (val > maxAmount && val < 80_000_000) {
      maxAmount = val;
    }
  }

  return round(maxAmount, 2);
}

function extractProviderAndItems(
  text: string,
  knownProviders: Array<{ proveedor: string; proveedor_key?: string; categoria?: string; medio_pago?: string }>
): {
  proveedor: string;
  categoria: string;
  medio_pago: string;
  descripcion: string;
} {
  const textKey = normKey(text);

  // 1. Cruzar contra el padrón de proveedores conocidos del negocio
  for (const kp of knownProviders) {
    const pk = normProvider(kp.proveedor);
    if (pk.length >= 3 && textKey.includes(pk)) {
      return {
        proveedor: kp.proveedor,
        categoria: kp.categoria || inferCategoryFromText(text),
        medio_pago: kp.medio_pago || "Cta. Corriente",
        descripcion: "",
      };
    }
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => norm(l))
    .filter((l) => l.length >= 3);

  // 2. Buscar línea explícita de Proveedor / Razón Social
  for (const line of lines.slice(0, 12)) {
    const m = /(?:RAZ[OÓ]N\s+SOCIAL|PROVEEDOR|EMISOR)[:.\s]+(.+)/i.exec(line);
    if (m && norm(m[1]).length >= 3) {
      const prov = norm(m[1]).replace(/\s+CUIT.*$/i, "");
      return {
        proveedor: prov,
        categoria: inferCategoryFromText(text),
        medio_pago: "Cta. Corriente",
        descripcion: "",
      };
    }
  }

  // 3. Buscar línea con S.R.L. / S.A. / S.A.S. / DISTRIBUIDORA / PAPELERA / FRIGORIFICO
  for (const line of lines.slice(0, 10)) {
    if (
      /\b(S\.?R\.?L\.?|S\.?A\.?S?\.?|DISTRIBUIDORA|FRIGORIFICO|PAPELERA|PANADERIA|LACTEOS|BEBIDAS)\b/i.test(
        line
      ) &&
      !/^(FACTURA|ORIGINAL|DUPLICADO|FECHA|CUIT|RESPONSABLE)/i.test(line)
    ) {
      const clean = line.replace(/\bCUIT\b.*$/i, "").trim();
      if (clean.length >= 3 && clean.length <= 60) {
        return {
          proveedor: clean,
          categoria: inferCategoryFromText(text),
          medio_pago: "Cta. Corriente",
          descripcion: "",
        };
      }
    }
  }

  // 4. Primera línea limpia del encabezado que no sea metadato fiscal
  for (const line of lines.slice(0, 6)) {
    if (
      !/^(FACTURA|REMITO|RECIBO|ORIGINAL|DUPLICADO|FECHA|CUIT|ING\.?\s*BRUTOS|INICIO|IVA|CONDICI[OÓ]N|DOMICILIO|TEL)/i.test(
        line
      ) &&
      !/^\d+$/.test(line) &&
      line.length >= 3 &&
      line.length <= 50
    ) {
      return {
        proveedor: line,
        categoria: inferCategoryFromText(text),
        medio_pago: "Cta. Corriente",
        descripcion: "",
      };
    }
  }

  return {
    proveedor: "",
    categoria: inferCategoryFromText(text),
    medio_pago: "Cta. Corriente",
    descripcion: "",
  };
}

/**
 * Interpreta el texto extraído de una foto de factura/comprobante y devuelve
 * los campos autocompletados junto con la lista de campos que quedaron ilegibles
 * para que el usuario los complete manualmente.
 * Por defecto el recordatorio de vencimiento se fija 7 días después de cargada la factura.
 */
export function parseInvoiceOcrText(
  rawText: string,
  customLoadedDate: string = todayAr()
): ScannedInvoiceFields {
  const cleanedText = String(rawText || "").trim();
  const sug = suggest();
  const knownProviders = (sug.proveedores || []) as Array<{
    proveedor: string;
    proveedor_key?: string;
    categoria?: string;
    medio_pago?: string;
  }>;

  const cuit = extractCuit(cleanedText);
  const { numero: numeroFactura, tipo: tipoComprobante } =
    extractInvoiceNumber(cleanedText);
  const detectedEmission = extractEmissionDate(cleanedText);
  const monto = extractTotalAmount(cleanedText);
  const { proveedor, categoria, medio_pago } = extractProviderAndItems(
    cleanedText,
    knownProviders
  );

  // Recordatorio de vencimiento: por default 7 días después de cargada la factura
  const fechaCarga = parseDate(customLoadedDate) || todayAr();
  const fechaVencimiento = addDays(fechaCarga, 7);

  const camposAutocompletados: string[] = [];
  const camposIncompletos: string[] = [];

  if (proveedor) camposAutocompletados.push("proveedor");
  else camposIncompletos.push("proveedor");

  if (monto > 0) camposAutocompletados.push("monto");
  else camposIncompletos.push("monto");

  if (numeroFactura) camposAutocompletados.push("numero_factura");
  else camposIncompletos.push("numero_factura");

  if (detectedEmission) camposAutocompletados.push("fecha_emision");
  else camposIncompletos.push("fecha_emision");

  camposAutocompletados.push("fecha_vencimiento", "categoria");

  const descParts: string[] = [];
  if (tipoComprobante && numeroFactura) {
    descParts.push(`${tipoComprobante} ${numeroFactura}`);
  } else if (numeroFactura) {
    descParts.push(`Comp. ${numeroFactura}`);
  }
  if (cuit) {
    descParts.push(`CUIT ${cuit}`);
  }

  let confianza: "alta" | "media" | "baja" = "baja";
  if (proveedor && monto > 0 && (numeroFactura || detectedEmission)) {
    confianza = "alta";
  } else if (proveedor || monto > 0) {
    confianza = "media";
  }

  return {
    proveedor,
    cuit,
    numero_factura: numeroFactura,
    tipo_comprobante: tipoComprobante,
    fecha_emision: detectedEmission || fechaCarga,
    fecha_vencimiento: fechaVencimiento,
    monto,
    categoria,
    medio_pago,
    descripcion: descParts.join(" · "),
    confianza,
    campos_autocompletados: camposAutocompletados,
    campos_incompletos: camposIncompletos,
    texto_detectado: cleanedText,
  };
}

/**
 * Si hay configurada una API Key de Gemini (`GEMINI_API_KEY` o `GOOGLE_API_KEY`),
 * utiliza visión multimodal para leer fotos de facturas borrosas o manuscritas.
 * Si no, o como complemento, procesa el texto OCR con `parseInvoiceOcrText`.
 */
export async function scanInvoicePayload(payload: {
  image_base64?: string;
  mime_type?: string;
  ocr_text?: string;
  file_name?: string;
}): Promise<ScannedInvoiceFields> {
  const today = todayAr();
  const cfg = loadConfig();
  const geminiKey = (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GEMINI_API_KEY ||
    cfg.google_api_key ||
    ""
  ).trim();

  const rawBase64 = String(payload.image_base64 || "")
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "")
    .trim();
  const mimeType = payload.mime_type || "image/jpeg";

  if (rawBase64 && geminiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(
        geminiKey
      )}`;
      const prompt = `Analizá esta foto de una factura o comprobante de proveedor gastronómico en Argentina.
Extraé todo lo que sea legible y devolvé ÚNICAMENTE un JSON válido con estas claves:
{
  "proveedor": "nombre del proveedor o vacío si es ilegible",
  "cuit": "XX-XXXXXXXX-X o vacío",
  "numero_factura": "0001-00012345 o vacío si es ilegible",
  "tipo_comprobante": "FACTURA A / FACTURA B / REMITO / TICKET",
  "fecha_emision": "YYYY-MM-DD o vacío si es ilegible",
  "monto": número decimal del total (0 si es ilegible),
  "descripcion": "resumen corto de los artículos o insumos",
  "texto_transcrito": "transcripción de las líneas visibles"
}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType,
                    data: rawBase64,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
          },
        }),
      });

      if (res.ok) {
        const json = await res.json();
        const textOut =
          json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const parsedJson = JSON.parse(textOut);
        const fallback = parseInvoiceOcrText(
          `${parsedJson.proveedor || ""}\n${parsedJson.numero_factura || ""}\n${parsedJson.fecha_emision || ""}\nTOTAL $${parsedJson.monto || 0}\n${parsedJson.texto_transcrito || ""}`,
          today
        );

        const prov = norm(parsedJson.proveedor) || fallback.proveedor;
        const monto =
          round(parseNumber(parsedJson.monto), 2) || fallback.monto;
        const num =
          norm(parsedJson.numero_factura) || fallback.numero_factura;
        const emision =
          parseDate(parsedJson.fecha_emision) || fallback.fecha_emision;

        const autocompletados: string[] = ["fecha_vencimiento", "categoria"];
        const incompletos: string[] = [];

        if (prov) autocompletados.push("proveedor");
        else incompletos.push("proveedor");

        if (monto > 0) autocompletados.push("monto");
        else incompletos.push("monto");

        if (num) autocompletados.push("numero_factura");
        else incompletos.push("numero_factura");

        if (parseDate(parsedJson.fecha_emision))
          autocompletados.push("fecha_emision");
        else incompletos.push("fecha_emision");

        return {
          proveedor: prov,
          cuit: norm(parsedJson.cuit) || fallback.cuit,
          numero_factura: num,
          tipo_comprobante:
            norm(parsedJson.tipo_comprobante) || fallback.tipo_comprobante,
          fecha_emision: emision || today,
          fecha_vencimiento: addDays(today, 7),
          monto,
          categoria: fallback.categoria,
          medio_pago: fallback.medio_pago,
          descripcion:
            norm(parsedJson.descripcion) || fallback.descripcion,
          confianza:
            prov && monto > 0 ? "alta" : prov || monto > 0 ? "media" : "baja",
          campos_autocompletados: autocompletados,
          campos_incompletos: incompletos,
          texto_detectado:
            norm(parsedJson.texto_transcrito) || fallback.texto_detectado,
        };
      }
    } catch {
      // Si falla Gemini Vision, usar el texto OCR extraído
    }
  }

  // Fallback a OCR text + pistas del nombre del archivo
  const combinedText = [payload.ocr_text || "", payload.file_name || ""]
    .filter(Boolean)
    .join("\n");
  return parseInvoiceOcrText(combinedText, today);
}
