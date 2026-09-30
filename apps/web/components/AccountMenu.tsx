'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, type Me } from '@/lib/api';

/**
 * Who this browser is, in the page header. Anyone can plan without signing
 * in; signing in by email link is how trips are kept across devices.
 */
export function AccountMenu() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      // If the service is down the header must still render; the pages say why.
      .catch(() => setMe(null));
  }, []);

  if (!me) return null;

  if (me.user && !me.user.isAnonymous) {
    return (
      <Link href="/trips" className="max-w-[12rem] truncate hover:text-ink" title="Your trips and account">
        {me.user.email}
      </Link>
    );
  }

  return me.emailSignIn ? (
    <Link href="/trips" className="hover:text-ink">
      Sign in to keep your trips
    </Link>
  ) : null;
}
