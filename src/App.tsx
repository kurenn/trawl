/* ============================================================================
   Trawl — App root.
   Wraps everything in TrawlProvider and routes views via useTrawl().
   View components are prop-less and call useTrawl() themselves.
   ============================================================================ */

import "./theme.css";
import { TrawlProvider, useTrawl } from "./store";
import Sidebar from "./components/Sidebar";
import Connect from "./views/Connect";
import Dashboard from "./views/Dashboard";
import NewMapping from "./views/NewMapping";
import Run from "./views/Run";

function AppInner() {
  const { view, run } = useTrawl();

  // No hard connect-gate: pCloud public links need no connection, so the
  // dashboard is always reachable. Google Drive connect is reachable on demand
  // (sidebar "Connect" / the inline prompt when a Drive link is pasted).
  function renderMain() {
    switch (view) {
      case "connect":
        return <Connect />;
      case "dashboard":
        return <Dashboard />;
      case "newMapping":
        return <NewMapping />;
      case "run":
        return run ? <Run /> : <Dashboard />;
      default:
        return <Dashboard />;
    }
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <main
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {renderMain()}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <TrawlProvider>
      <AppInner />
    </TrawlProvider>
  );
}
