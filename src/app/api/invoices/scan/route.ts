import { NextResponse } from "next/server";
import { scanInvoicePayload } from "@/lib/invoices/scanner";
import { hydrateLocalFromPostgres } from "@/lib/db/pg-sync";

export async function POST(request: Request) {
  try {
    await hydrateLocalFromPostgres();
    const body = (await request.json()) as {
      image_base64?: string;
      mime_type?: string;
      ocr_text?: string;
      file_name?: string;
    };

    const scanned = await scanInvoicePayload(body);
    return NextResponse.json({
      ok: true,
      scanned,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
