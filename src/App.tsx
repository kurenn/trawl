/* ============================================================================
   Trawl — App root. One 640px column; the store's `view` picks the screen.
   ============================================================================ */

import "./theme.css";
import { TrawlProvider, useTrawl } from "./store";
import Home from "./views/Home";
import Preview from "./views/Preview";
import Folder from "./views/Folder";
import Copying from "./views/Copying";
import Settings from "./views/Settings";

function AppInner() {
  const { view, run, preview, folder, goHome, goSettings } = useTrawl();

  function renderMain() {
    switch (view) {
      case "preview":
        return preview ? <Preview /> : <Home />;
      case "folder":
        return folder ? <Folder /> : <Home />;
      case "copying":
        return run ? <Copying /> : <Home />;
      case "settings":
        return <Settings />;
      default:
        return <Home />;
    }
  }

  return (
    <div className="app">
      <header className="hdr">
        <button className="mark" onClick={goHome}>
          Trawl
        </button>
        <button
          className="lnk"
          style={{ marginLeft: "auto" }}
          onClick={view === "settings" ? goHome : goSettings}
        >
          {view === "settings" ? "Done" : "Settings"}
        </button>
      </header>
      <main className="page">{renderMain()}</main>
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
