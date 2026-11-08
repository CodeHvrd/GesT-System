import type { AppConfig } from "../config";

const UA = "GesTPanel/2.0 (+gestion nextjs)";
const tokenCache = new Map<string, { token: string; expEpochSec: number }>();

export class FudoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FudoError";
  }
}

export interface JsonApiResource {
  id: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<
    string,
    {
      data?:
        | { id: string; type?: string }
        | Array<{ id: string; type?: string }>
        | null;
    }
  >;
}

export interface JsonApiResponse {
  data?: JsonApiResource[];
  included?: JsonApiResource[];
  [key: string]: unknown;
}

export interface FudoClientInit {
  apiKey?: string;
  apiSecret?: string;
  authUrl?: string;
  apiUrl?: string;
  baseUrl?: string;
  fudo?: {
    api_key?: string;
    api_secret?: string;
    auth_url?: string;
    base_url?: string;
  };
}

export class FudoClient {
  public readonly apiKey: string;
  public readonly apiSecret: string;
  public readonly authUrl: string;
  public readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    cfg?: FudoClientInit | Partial<AppConfig> | null,
    fetchImpl: typeof fetch = globalThis.fetch
  ) {
    const anyCfg = (cfg || {}) as Record<string, any>;
    const f = anyCfg.fudo || {};
    this.apiKey = String(
      anyCfg.apiKey || anyCfg.fudo_api_key || f.api_key || ""
    ).trim();
    this.apiSecret = String(
      anyCfg.apiSecret || anyCfg.fudo_api_secret || f.api_secret || ""
    ).trim();
    this.authUrl = String(
      anyCfg.authUrl ||
        anyCfg.fudo_auth_url ||
        f.auth_url ||
        "https://auth.fu.do/api"
    ).trim();
    this.baseUrl = String(
      anyCfg.apiUrl ||
        anyCfg.baseUrl ||
        anyCfg.fudo_api_url ||
        f.base_url ||
        "https://api.fu.do/v1alpha1"
    )
      .trim()
      .replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  get configured(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  private get cacheKey(): string {
    return `${this.baseUrl}|${this.apiKey}`;
  }

  public invalidate(): void {
    tokenCache.delete(this.cacheKey);
  }

  public static clearAllTokens(): void {
    tokenCache.clear();
  }

  private async authenticate(): Promise<{ token: string; expEpochSec: number }> {
    if (!this.configured) {
      throw new FudoError("Faltan la API Key o la API Secret de Fudo.");
    }
    let resp: Response;
    try {
      resp = await this.fetchImpl(this.authUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": UA,
        },
        body: JSON.stringify({
          apiKey: this.apiKey,
          apiSecret: this.apiSecret,
        }),
      });
    } catch (exc) {
      throw new FudoError(
        `No se pudo conectar con Fudo: ${
          exc instanceof Error ? exc.message : String(exc)
        }`
      );
    }

    if (!resp.ok) {
      const detail = (await resp.text().catch(() => "")).slice(0, 300);
      if (resp.status === 401 || resp.status === 403) {
        throw new FudoError(
          "Fudo rechazó las credenciales (revisá API Key y API Secret)."
        );
      }
      throw new FudoError(
        `Fudo respondió ${resp.status} al autenticar: ${detail}`
      );
    }

    const data = (await resp.json()) as Record<string, unknown>;
    const token = data?.token || data?.access_token;
    if (!token) {
      throw new FudoError("Respuesta de autenticación sin token.");
    }

    const expRaw = Number(data?.exp || data?.expires_in || 0);
    let exp = Number.isFinite(expRaw) ? expRaw : 0;
    if (exp > 1e12) exp = exp / 1000;
    const nowSec = Date.now() / 1000;
    if (exp < 1e9) exp = nowSec + 24 * 3600;
    return { token: String(token), expEpochSec: exp };
  }

  public async token(): Promise<string> {
    const nowSec = Date.now() / 1000;
    const cached = tokenCache.get(this.cacheKey);
    if (cached && cached.expEpochSec - nowSec > 120) {
      return cached.token;
    }
    const fresh = await this.authenticate();
    tokenCache.set(this.cacheKey, fresh);
    return fresh.token;
  }

  public async get(
    pathStr: string,
    params?: Record<string, string | number | boolean | null | undefined>,
    retry = true
  ): Promise<JsonApiResponse> {
    let url =
      this.baseUrl + (pathStr.startsWith("/") ? pathStr : `/${pathStr}`);
    if (params) {
      const pairs: string[] = [];
      for (const [k, rawV] of Object.entries(params)) {
        if (rawV === null || rawV === undefined) continue;
        const v =
          typeof rawV === "boolean" ? (rawV ? "true" : "false") : String(rawV);
        const encK = encodeURIComponent(k)
          .replace(/%5B/gi, "[")
          .replace(/%5D/gi, "]");
        const encV = encodeURIComponent(v)
          .replace(/%3A/gi, ":")
          .replace(/%2C/gi, ",")
          .replace(/%2E/gi, ".")
          .replace(/%2D/gi, "-");
        pairs.push(`${encK}=${encV}`);
      }
      if (pairs.length > 0) {
        url += `?${pairs.join("&")}`;
      }
    }

    const bearer = await this.token();
    const resp = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
        "User-Agent": UA,
      },
    });

    if (!resp.ok) {
      if (resp.status === 401 && retry) {
        this.invalidate();
        return this.get(pathStr, params, false);
      }
      const detail = (await resp.text().catch(() => "")).slice(0, 300);
      throw new FudoError(`Fudo respondió ${resp.status}: ${detail}`);
    }

    return (await resp.json()) as JsonApiResponse;
  }

  public async listAll(
    pathStr: string,
    params?: Record<string, string | number | boolean | null | undefined>,
    maxPages = 50
  ): Promise<JsonApiResource[]> {
    const out: JsonApiResource[] = [];
    const base = { ...(params || {}) };
    if (base["page[size]"] === undefined) base["page[size]"] = 500;
    const pageSize = Number(base["page[size]"]);
    for (let page = 1; page <= maxPages; page++) {
      const q = { ...base, "page[number]": page };
      const data = await this.get(pathStr, q);
      const rows = data.data || [];
      out.push(...rows);
      if (rows.length < pageSize) break;
    }
    return out;
  }

  public async health() {
    try {
      const data = await this.get("/expenses", {
        "page[size]": 1,
        include: "provider,expenseCategory",
        sort: "-id",
      });
      const rows = data.data || [];
      return {
        ok: true,
        autenticado: true,
        muestra: rows[0] ?? null,
        total_muestra: rows.length,
        base_url: this.baseUrl,
      };
    } catch (err) {
      return {
        ok: false,
        autenticado: false,
        error: (err as Error).message,
        base_url: this.baseUrl,
      };
    }
  }
}
