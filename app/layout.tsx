import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Wallasey Community Football',
  description: 'A new Next.js app for Wallasey Community Football',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
