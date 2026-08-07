import { ensureSchema, getDatabasePool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureSchema();
    await getDatabasePool().query("SELECT 1");
    return Response.json(
      {
        status: "ok",
        service: "hyperscope-web",
        database: "connected",
        timestamp: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Health check failed", error);
    return Response.json(
      {
        status: "error",
        service: "hyperscope-web",
        database: "unavailable",
        timestamp: new Date().toISOString(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
