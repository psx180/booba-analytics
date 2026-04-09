import type { Metadata } from 'next';
import './globals.css';
import NavBar from './NavBar';

export const metadata: Metadata = {
  title: 'Booba — Trade Journal',
  description: 'Pacifica trading journal & analytics',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#0d1117] text-[#e6edf3] font-mono">
        <NavBar />
        <main className="max-w-[1400px] mx-auto px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
