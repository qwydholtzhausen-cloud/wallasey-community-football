import './globals.css';
import type { Metadata, Viewport } from 'next';
import { Sora, Inter, Caveat, Oswald, Playfair_Display } from 'next/font/google';

const sora = Sora({ subsets: ['latin'], weight: ['600', '700', '800'], variable: '--font-sora' });
const inter = Inter({ subsets: ['latin'], weight: ['400', '600', '700'], variable: '--font-inter' });
// Handwriting for the signatures on match balls (trophy cabinet, club history).
const caveat = Caveat({ subsets: ['latin'], weight: ['700'], variable: '--font-caveat' });
// The First XI matchday programme: printed-programme headings and adverts.
const oswald = Oswald({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-oswald' });
const playfair = Playfair_Display({ subsets: ['latin'], weight: ['700'], style: ['italic'], variable: '--font-playfair' });

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
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sora.variable} ${inter.variable} ${caveat.variable} ${oswald.variable} ${playfair.variable}`}>
      <body>{children}</body>
    </html>
  );
}
