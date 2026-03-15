import type { Metadata } from 'next';
import { ConfigProvider } from '@/context/ConfigContext';
import { Sidebar } from '@/components/layout/Sidebar';
import './globals.css';

export const metadata: Metadata = {
  title: 'Alfred AI',
  description: 'Self-hosted AI Assistant',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body className="bg-[#0a0a0a] text-gray-200 h-screen overflow-hidden">
        <ConfigProvider>
          <div className="flex h-full">
            <Sidebar />
            <main className="flex-1 overflow-hidden">
              {children}
            </main>
          </div>
        </ConfigProvider>
      </body>
    </html>
  );
}
