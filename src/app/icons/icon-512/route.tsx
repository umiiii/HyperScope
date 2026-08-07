import { ImageResponse } from "next/og";
import { AppIcon } from "@/components/app-icon";

export const dynamic = "force-static";

export async function GET() {
  return new ImageResponse(<AppIcon size={512} />, {
    width: 512,
    height: 512,
    headers: { "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
