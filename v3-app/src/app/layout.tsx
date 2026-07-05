import type { Metadata } from "next";
import "./globals.css";
import { NavBar } from "@/components/shared/nav-bar";
import { ToastProvider } from "@/components/shared/toast";
import { SessionProvider } from "@/components/shared/auth-context";

export const metadata: Metadata = {
  title: "运单异常管理 V3",
  description: "运单全生命周期异常管理系统",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-[#f7f8fa] antialiased">
        <SessionProvider>
          <ToastProvider>
            <NavBar />
            <main className="pt-14">{children}</main>
          </ToastProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
