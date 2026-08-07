import { getPushRuntimeConfig, PushConfigurationError } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = getPushRuntimeConfig();
    return Response.json(
      {
        configured: true,
        publicKey: config.publicKey,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message =
      error instanceof PushConfigurationError
        ? error.message
        : "推送服务配置暂时不可用。";

    return Response.json(
      {
        configured: false,
        publicKey: null,
        message,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
