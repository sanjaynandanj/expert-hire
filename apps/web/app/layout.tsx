import { brand } from "@northstar/brand";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://northstar.example"),
  title: { default: `${brand.name} — ${brand.descriptor}`, template: `%s · ${brand.name}` },
  description: brand.description,
  robots: { index: true, follow: true }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
