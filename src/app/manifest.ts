import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "HyperScope · Hyperliquid 仓位监视",
    short_name: "HyperScope",
    description: "每分钟监视 Hyperliquid 永续仓位，并在仓位变化时发送设备通知。",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#0c0f13",
    theme_color: "#0c0f13",
    categories: ["finance", "utilities"],
    icons: [
      {
        src: "/icons/icon-192",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
