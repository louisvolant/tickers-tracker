import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ServiceWorkerRegister } from './components/ServiceWorkerRegister';
import { getSiteUrl } from '@/lib/site';

export const metadata: Metadata = {
  metadataBase: new URL(getSiteUrl()),
  title: {
    default: 'Ticker-Tracker — Real-Time Stock & Valuation Tracker',
    template: '%s | Ticker-Tracker',
  },
  description:
    'Track stocks, ETFs, and indices with real-time valuation multiples (P/E & Forward P/E), tracking price variance, interactive stats, and instant offline mobile access via PWA.',
  keywords: [
    'stock tracker',
    'portfolio tracking',
    'yahoo finance',
    'trailing PE',
    'forward PE',
    'financial valuation',
    'PWA finance',
    'stock comparison',
    'ETF tracker',
  ],
  authors: [{ name: 'Ticker-Tracker Team' }],
  creator: 'Ticker-Tracker',
  alternates: {
    canonical: '/',
  },
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '32x32' },
      { url: '/icons/icon.svg', type: 'image/svg+xml' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: '/',
    siteName: 'Ticker-Tracker',
    title: 'Ticker-Tracker — Real-Time Stock & Valuation Multiples',
    description:
      'Monitor your stock watchlist with instantaneous local caching, Forward P/E multiples, and tracking diff percentage.',
    images: [
      {
        url: '/icons/icon-512.png',
        width: 512,
        height: 512,
        alt: 'Ticker-Tracker Logo',
      },
    ],
  },
  twitter: {
    card: 'summary',
    title: 'Ticker-Tracker — Stock & Valuation Tracker',
    description: 'Instant stock quotes, Trailing & Forward P/E, and target price diff tracking.',
    images: ['/icons/icon-512.png'],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'TickerTracker',
  },
};

export const viewport: Viewport = {
  themeColor: '#090d16',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

import { I18nProvider } from '@/context/I18nContext';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#090d16] text-slate-100 antialiased selection:bg-emerald-500 selection:text-slate-900">
        <ServiceWorkerRegister />
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
