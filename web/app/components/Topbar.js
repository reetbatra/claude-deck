import Link from 'next/link';
import { Show, SignInButton, UserButton } from '@clerk/nextjs';

export default function Topbar() {
  return (
    <header className="topbar">
      <Link href="/" className="brand">🛰️ Claude Deck Cloud</Link>
      <nav>
        <Show when="signed-in">
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/connect">Connect</Link>
          <UserButton afterSignOutUrl="/" />
        </Show>
        <Show when="signed-out">
          <SignInButton mode="modal">
            <button className="btn btn-primary">Sign in</button>
          </SignInButton>
        </Show>
      </nav>
    </header>
  );
}
