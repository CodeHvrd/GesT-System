import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (
    pathname.startsWith("/healthz") ||
    pathname.startsWith("/readyz") ||
    pathname.startsWith("/api/healthz") ||
    pathname.startsWith("/api/readyz") ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  const portalPass = process.env.PORTAL_PASS;
  if (!portalPass) {
    return NextResponse.next();
  }

  const portalUser = process.env.PORTAL_USER || "admin";
  const authHeader = req.headers.get("authorization") || "";

  if (authHeader.startsWith("Basic ")) {
    try {
      const base64Credentials = authHeader.slice(6).trim();
      const credentials = atob(base64Credentials);
      const sepIndex = credentials.indexOf(":");
      if (sepIndex !== -1) {
        const user = credentials.slice(0, sepIndex);
        const pass = credentials.slice(sepIndex + 1);
        if (user === portalUser && pass === portalPass) {
          return NextResponse.next();
        }
      }
    } catch {
      // Invalid base64
    }
  }

  return new NextResponse("Autenticación requerida", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="GesT Portal"',
    },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

