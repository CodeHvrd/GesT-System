import { NextResponse } from "next/server";
import { FudoClient } from "@/lib/fudo/client";
import {
  fetchProductCatalog,
  resolveFudoCredentials,
} from "@/lib/fudo/sync";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const resource = searchParams.get("resource") || "products";
    const creds = await resolveFudoCredentials();

    if (!creds.apiKey || !creds.apiSecret) {
      return NextResponse.json(
        { ok: false, error: "Credenciales de Fudo no configuradas." },
        { status: 400 }
      );
    }

    const client = new FudoClient({
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      authUrl: creds.authUrl,
      apiUrl: creds.apiUrl,
    });

    if (resource === "catalog") {
      const cat = await fetchProductCatalog(client);
      return NextResponse.json({
        ok: true,
        products_count: Object.keys(cat.products).length,
        categories_count: Object.keys(cat.categories).length,
        sample: Object.values(cat.products).slice(0, 25),
      });
    }

    const payload = await client.get(`/${resource}`, { "page[size]": 25 });
    const data = Array.isArray(payload.data) ? payload.data : [];
    return NextResponse.json({
      ok: true,
      resource,
      count: data.length,
      items: data,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
