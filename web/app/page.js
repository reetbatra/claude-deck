import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import Topbar from './components/Topbar';
import { SignInButton } from '@clerk/nextjs';

export default async function Home() {
  const { userId } = await auth();
  if (userId) redirect('/dashboard');

  return (
    <>
      <Topbar />
      <div className="wrap">
        <div className="eyebrow">Claude Deck Cloud</div>
        <h1>Your Claude Code insights, from any device.</h1>
        <p className="lede">
          Claude Deck runs locally and reads your real <code>~/.claude</code> session
          data. Sign in, connect your machine with one command, and see your daily
          report, skill usage, and session history from any browser — no transcripts
          or prompt text ever leave your machine, only the numbers.
        </p>
        <div className="cta-row">
          <SignInButton mode="modal">
            <button className="btn btn-primary">Sign in with GitHub →</button>
          </SignInButton>
          <a className="btn" href="https://github.com/reetbatra/claude-deck">
            View the local app on GitHub
          </a>
        </div>

        <div className="card" style={{ marginTop: 40 }}>
          <h2>What syncs (and what doesn&apos;t)</h2>
          <p className="callout">
            <b style={{ color: 'var(--text)' }}>Synced:</b> session counts, project
            names, timestamps, and which skills you use and how often.
            <br />
            <b style={{ color: 'var(--text)' }}>Never synced:</b> prompt text,
            transcripts, file contents, or anything Claude read or wrote. Automations
            (one-click Claude runs) stay local — this dashboard is read-only.
          </p>
        </div>
      </div>
    </>
  );
}
