import './globals.css';
import type { Metadata, Viewport } from 'next';
import { Sora, Inter } from 'next/font/google';

const sora = Sora({ subsets: ['latin'], weight: ['600', '700', '800'], variable: '--font-sora' });
const inter = Inter({ subsets: ['latin'], weight: ['400', '600', '700'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'Wirral Community Football',
  description: 'Book in for pickup games, catch match clips, and keep up with the team.',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Wirral CF',
  },
};

export const viewport: Viewport = {
  themeColor: '#0d0d1a',
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sora.variable} ${inter.variable}`}>
      <body>{children}</body>
    </html>
  );
}
