import {
  createMonitoredAddress,
  findAddressId,
  getAddressDetail,
  listDashboardData,
} from "@/lib/repository/addresses";
import { monitorAddress } from "@/lib/monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export async function GET() {
  try {
    const data = await listDashboardData();
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Failed to list monitored addresses", error);
    return Response.json(
      { message: "无法读取监视地址，请检查数据库配置。" },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const address =
    typeof body === "object" &&
    body !== null &&
    "address" in body &&
    typeof (body as { address: unknown }).address === "string"
      ? (body as { address: string }).address.trim()
      : "";
  const rawLabel =
    typeof body === "object" &&
    body !== null &&
    "label" in body &&
    typeof (body as { label: unknown }).label === "string"
      ? (body as { label: string }).label.trim()
      : "";

  if (!ADDRESS_PATTERN.test(address)) {
    return Response.json(
      { message: "请输入 0x 开头的 42 位 Hyperliquid 地址。" },
      { status: 400 },
    );
  }
  if (rawLabel.length > 32) {
    return Response.json({ message: "备注名不能超过 32 个字符。" }, { status: 400 });
  }

  const normalizedAddress = address.toLowerCase();
  try {
    const existingId = await findAddressId(normalizedAddress);
    if (existingId) {
      return Response.json(
        { message: "这个地址已经在监视中。", existingId },
        { status: 409 },
      );
    }

    const id = await createMonitoredAddress(normalizedAddress, rawLabel || null);
    const monitorResult = await monitorAddress(id);
    const detail = await getAddressDetail(id);
    return Response.json(
      {
        id,
        detail,
        warning: monitorResult.success ? null : monitorResult.error,
      },
      { status: 201 },
    );
  } catch (error) {
    const databaseError = error as { code?: string };
    if (databaseError.code === "23505") {
      const existingId = await findAddressId(normalizedAddress).catch(() => null);
      return Response.json(
        { message: "这个地址已经在监视中。", existingId },
        { status: 409 },
      );
    }

    console.error("Failed to add monitored address", error);
    return Response.json(
      { message: error instanceof Error ? error.message : "添加地址失败。" },
      { status: 500 },
    );
  }
}
