import type { Metadata } from 'next';
import { ConfigProvider } from '@/context/ConfigContext';
import { Sidebar } from '@/components/layout/Sidebar';
import { AuthGate } from '@/components/auth/AuthGate';
import './globals.css';

export const metadata: Metadata = {
  title: 'Alfred AI',
  description: 'Self-hosted AI Assistant',
  // v1476 — App-Icon (Owner 16.10.); Pfade mit basePath, weil der statische Export sie nicht ergänzt
  icons: {
    icon: [{ url: '/alfred/favicon.ico', sizes: 'any' }, { url: '/alfred/icon-192.png', type: 'image/png', sizes: '192x192' }],
    apple: '/alfred/apple-touch-icon.png',
  },
  manifest: '/alfred/manifest.json',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body className="bg-[#0a0a0a] text-gray-200 h-screen overflow-hidden">
        <ConfigProvider>
          <AuthGate>
            <div className="flex h-full">
              <Sidebar />
              <main className="flex-1 overflow-y-auto">
                {children}
              </main>
            </div>
          </AuthGate>
        </ConfigProvider>
      </body>
    </html>
  );
}
