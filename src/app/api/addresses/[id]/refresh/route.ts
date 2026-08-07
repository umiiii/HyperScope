import { monitorAddress } from "@/lib/monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: Context) {
  const { id } = await context.params;
  try {
    const result = await monitorAddress(id);
    return Response.json(result, { status: result.success ? 200 : 502 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "刷新仓位失败。";
    const status = message === "监视地址不存在。" ? 404 : 503;
    return Response.json({ success: false, message }, { status });
  }
}
