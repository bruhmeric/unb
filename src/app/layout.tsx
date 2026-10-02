import type { Metadata } from "next";
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
  title: "Method V2 — Lossless Video Container Enhancer",
  description:
    "Bypass platform compression. Method V2 restructures the MP4 container locally (timescale atoms, sample tables, faststart) with zero quality loss — 100% client-side, no uploads.",
  keywords: ["Method V2", "MP4", "container", "faststart", "lossless", "client-side", "video enhancer"],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Method V2 — Lossless Video Container Enhancer",
    description: "Restructure video containers locally with zero quality loss. 100% client-side.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
