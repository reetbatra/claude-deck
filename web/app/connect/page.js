import Topbar from '../components/Topbar';
import ConnectPanel from './ConnectPanel';

export default function ConnectPage() {
  return (
    <>
      <Topbar />
      <div className="wrap">
        <h1>Connect your machine</h1>
        <p className="lede">
          Generate a token, then run one command on the machine where Claude Deck
          lives. It syncs your daily counts, skill usage, and session metadata —
          never prompt text or transcripts.
        </p>
        <ConnectPanel />
      </div>
    </>
  );
}
