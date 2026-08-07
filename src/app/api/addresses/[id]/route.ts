import {
  deleteMonitoredAddress,
  getAddressDetail,
} from "@/lib/repository/addresses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  try {
    const detail = await getAddressDetail(id);
    if (!detail) {
      return Response.json({ message: "没有找到这个监视地址。" }, { status: 404 });
    }
    return Response.json(detail, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Failed to read address detail", error);
    return Response.json({ message: "读取仓位失败。" }, { status: 503 });
  }
}

export async function DELETE(_request: Request, context: Context) {
  const { id } = await context.params;
  try {
    const deleted = await deleteMonitoredAddress(id);
    if (!deleted) {
      return Response.json({ message: "没有找到这个监视地址。" }, { status: 404 });
    }
    return Response.json({ success: true });
  } catch (error) {
    console.error("Failed to delete monitored address", error);
    return Response.json({ message: "停止监视失败。" }, { status: 503 });
  }
}
