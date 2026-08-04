import './globals.css';
import type { Metadata, Viewport } from 'next';

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
  themeColor: '#0A1A34',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
