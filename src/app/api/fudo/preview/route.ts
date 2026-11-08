import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { FudoClient } from "@/lib/fudo/client";
import { fetchProductCatalog } from "@/lib/fudo/sync";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const resource = searchParams.get("resource") || "products";
    const cfg = loadConfig();

    if (!cfg.fudo_api_key || !cfg.fudo_api_secret) {
      return NextResponse.json(
        { ok: false, error: "Credenciales de Fudo no configuradas." },
        { status: 400 }
      );
    }

    const client = new FudoClient({
      apiKey: cfg.fudo_api_key,
      apiSecret: cfg.fudo_api_secret,
      authUrl: cfg.fudo_auth_url,
      apiUrl: cfg.fudo_api_url,
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

