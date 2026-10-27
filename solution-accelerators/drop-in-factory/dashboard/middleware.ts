import { NextResponse, type NextRequest } from "next/server";
import { viewerOf } from "./src/lib/viewer.ts";

export const config = { runtime: "nodejs", matcher: ["/((?!api/ingest|api/health|_next/static|favicon.ico).*)"] };

export function middleware(request: NextRequest) {
  const viewer = viewerOf(request.headers);
  if (viewer.ok) return NextResponse.next();
  const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
  if (viewer.mode === "basic" && viewer.status === 401) headers["www-authenticate"] = 'Basic realm="Factory", charset="UTF-8"';
  const text = viewer.status === 500 ? `Factory portal is misconfigured: ${viewer.reason}` : `Sign in required (${viewer.reason}).`;
  return new NextResponse(text, { status: viewer.status, headers });
}
