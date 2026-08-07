import { ImageResponse } from "next/og";
import { AppIcon } from "@/components/app-icon";

export const dynamic = "force-static";

export async function GET() {
  return new ImageResponse(<AppIcon size={192} />, {
    width: 192,
    height: 192,
    headers: { "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
