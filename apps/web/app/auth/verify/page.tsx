'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { ApiClientError, api } from '@/lib/api';

/**
 * Where an emailed sign-in link lands. The link's token is exchanged with a
 * POST rather than being consumed by loading this page: mail programs and
 * browsers pre-fetch links, and a link that signed you in just by being
 * fetched could be used up before you ever clicked it.
 */
function Verify() {
  const router = useRouter();
  const token = useSearchParams().get('token');
  const [state, setState] = useState<
    { kind: 'working' } | { kind: 'done'; email: string; moved: number } | { kind: 'failed'; message: string }
  >(() =>
    token
      ? { kind: 'working' }
      : { kind: 'failed', message: 'This link is missing its sign-in code. Request a new one.' },
  );
  // In development React runs effects twice, and a single-use link must only be tried once.
  const tried = useRef(false);

  useEffect(() => {
    if (tried.current || !token) return;
    tried.current = true;
    api
      .verifySignInLink(token)
      .then(({ user, tripsMoved }) => {
        setState({ kind: 'done', email: user.email ?? '', moved: tripsMoved });
        setTimeout(() => router.replace('/trips'), 1200);
      })
      .catch((err) =>
        setState({
          kind: 'failed',
          message: err instanceof ApiClientError ? err.message : 'Signing in did not work. Please try again.',
        }),
      );
  }, [token, router]);

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-20 text-center sm:px-6">
      {state.kind === 'working' ? <p className="text-ink-soft">Signing you in…</p> : null}
      {state.kind === 'done' ? (
        <>
          <h1 className="font-display text-2xl tracking-tight">You are signed in</h1>
          <p className="mt-3 text-ink-soft">
            Welcome, {state.email}.
            {state.moved > 0
              ? ` ${state.moved} trip${state.moved === 1 ? '' : 's'} you planned on this device ${state.moved === 1 ? 'has' : 'have'} been added to your account.`
              : ''}
          </p>
        </>
      ) : null}
      {state.kind === 'failed' ? (
        <>
          <h1 className="font-display text-2xl tracking-tight">That link did not work</h1>
          <p role="alert" className="mt-3 text-ink-soft">
            {state.message}
          </p>
          <Link href="/trips" className="btn-primary mt-6">
            Get a new link
          </Link>
        </>
      ) : null}
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<p className="px-4 py-20 text-center text-ink-soft">Signing you in…</p>}>
      <Verify />
    </Suspense>
  );
}
