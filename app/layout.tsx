import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hamsun · Supply Chain",
  description: "One warehouse. Four branches. Complete visibility. Hamsun Phase 1 supply chain management.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
