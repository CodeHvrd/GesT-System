import { NextResponse } from "next/server";
import {
  loadConfig,
  saveConfig,
  targetsText,
  parseTargetsText,
} from "@/lib/config";
import {
  resolveFudoCredentials,
  saveFudoCredentialsEverywhere,
} from "@/lib/fudo/sync";

function sanitizeConfig(cfg: ReturnType<typeof loadConfig>) {
  const copy = { ...cfg } as Record<string, unknown>;
  copy.has_fudo_secret = Boolean(cfg.fudo_api_secret);
  copy.fudo_api_secret = cfg.fudo_api_secret ? "••••••••" : "";
  copy.cmv_objetivo_texto = targetsText(cfg.cmv_objetivo_por_categoria);
  return copy;
}

export async function GET() {
  try {
    await resolveFudoCredentials();
    const cfg = loadConfig();
    return NextResponse.json({
      ok: true,
      config: sanitizeConfig(cfg),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    await resolveFudoCredentials();
    const current = loadConfig();
    const update: Record<string, unknown> = { ...body };

    if (
      update.fudo_api_secret === "••••••••" ||
      update.fudo_api_secret === ""
    ) {
      if (body.clear_fudo_secret === true) {
        update.fudo_api_secret = "";
      } else {
        update.fudo_api_secret = current.fudo_api_secret;
      }
    }

    if (typeof update.cmv_objetivo_texto === "string") {
      update.cmv_objetivo_por_categoria = parseTargetsText(
        update.cmv_objetivo_texto
      );
      delete update.cmv_objetivo_texto;
    }

    const saved = saveConfig(update);
    if (saved.fudo_api_key && saved.fudo_api_secret) {
      await saveFudoCredentialsEverywhere(
        saved.fudo_api_key,
        saved.fudo_api_secret
      );
    }

    return NextResponse.json({
      ok: true,
      config: sanitizeConfig(saved),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
