import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "VELOCITY GP — Formula Racing Simulator",
  description:
    "VELOCITY GP: a browser Formula 1 simulator — 20-car grids, real race craft, DRS & ERS, 4 weather conditions, cockpit & TV cameras, and online multiplayer. Arcade-friendly handling, broadcast-style HUD.",
  keywords: ["formula 1", "racing game", "F1 simulator", "3D", "Three.js", "VELOCITY GP"],
  authors: [{ name: "VELOCITY GP" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "VELOCITY GP — Formula Racing Simulator",
    description: "Browser Formula 1 simulator: 20-car grids, weather, cockpit cam, online multiplayer.",
    siteName: "VELOCITY GP",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0b0f",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-black text-white overflow-hidden`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
