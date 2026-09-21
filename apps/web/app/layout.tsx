import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Wayfare — trips planned around what you actually need',
  description:
    'An open-source trip planner that understands your constraints, searches real providers, and optimises the whole journey rather than one booking at a time.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="flex min-h-screen flex-col">
          <header className="border-b border-sand-200/80 bg-sand-50/80 backdrop-blur">
            <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
              <Link href="/" className="font-display text-xl font-semibold tracking-tight">
                Wayfare
              </Link>
              <nav className="flex items-center gap-5 text-sm text-ink-soft">
                <Link href="/trips" className="hover:text-ink">
                  Saved trips
                </Link>
                <Link href="/sources" className="hover:text-ink">
                  Data sources
                </Link>
              </nav>
            </div>
          </header>

          <main className="flex-1">{children}</main>

          <footer className="border-t border-sand-200 bg-white">
            <div className="mx-auto w-full max-w-6xl px-4 py-8 text-sm text-ink-faint sm:px-6">
              <p className="max-w-3xl">
                Every price, schedule and availability shown here comes from a connected provider
                and is labelled with its source and the time it was retrieved. Where a provider is
                unavailable, this planner says so rather than filling the gap with an estimate.
              </p>
              <p className="mt-3">
                Open source. Bring your own provider credentials — see{' '}
                <Link href="/sources" className="underline hover:text-ink">
                  data sources
                </Link>
                .
              </p>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
