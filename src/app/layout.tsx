import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL || "http://localhost:3000"),
  title: {
    default: "HyperScope · Hyperliquid 仓位监视",
    template: "%s · HyperScope",
  },
  description: "每分钟监视 Hyperliquid 永续仓位，并在仓位变化时发送设备通知。",
  applicationName: "HyperScope",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "HyperScope",
  },
  formatDetection: {
    telephone: false,
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    siteName: "HyperScope",
    title: "HyperScope · Hyperliquid 仓位监视",
    description: "每分钟监视 Hyperliquid 永续仓位，并在仓位变化时发送设备通知。",
    images: [
      {
        url: "/og-hyperscope.png",
        width: 1731,
        height: 909,
        alt: "HyperScope 仓位雷达",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "HyperScope · Hyperliquid 仓位监视",
    description: "每分钟监视 Hyperliquid 永续仓位，并在仓位变化时发送设备通知。",
    images: ["/og-hyperscope.png"],
  },
  icons: {
    icon: [{ url: "/icons/icon-192", type: "image/png", sizes: "192x192" }],
    apple: [{ url: "/apple-icon", type: "image/png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0c0f13",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
