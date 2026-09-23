import "./blank-workspace.css";

// Stage 02 is a visual shell. Project data and editing controls arrive with their first backend consumer.
export default function BlankWorkspace() {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <div className="workspace-shell">
        <header className="workspace-header">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">
              <span /><span /><span /><span />
            </span>
            <span>ScopeRoom<span className="brand-suffix"> / Studio</span></span>
          </div>
          <span className="workspace-title">Blank workspace</span>
          <span className="preview-label">UI preview</span>
        </header>

        <main id="main-content" tabIndex={-1} className="workspace-main">
          <section className="canvas-column" aria-label="Canvas">
            <div className="canvas-toolbar">
              <div className="canvas-breadcrumb">
                <span>Workspace</span>
                <span aria-hidden="true">/</span>
                <strong>Canvas</strong>
              </div>
              <span className="canvas-view-label"><span className="view-dot" />Canvas view</span>
            </div>

            <div className="canvas-stage">
              <div className="canvas-empty">
                <div className="empty-icon" aria-hidden="true">
                  <span /><span /><span />
                </div>
                <span className="empty-kicker">A FRESH START</span>
                <h1>Blank canvas</h1>
                <p>Nothing has been added to this canvas yet.</p>
                <p className="empty-help">
                  Flow editing and saving arrive in a later stage. For now, this is your workspace foundation.
                </p>
              </div>
            </div>

            <div className="canvas-status">
              <span className="canvas-status-state"><span className="status-dot" />No content yet</span>
              <span>0 steps · 0 connections</span>
            </div>
          </section>

          <aside className="workspace-sidebar" aria-labelledby="guide-title">
            <div className="panel-heading">
              <span className="panel-kicker">WORKSPACE</span>
              <h2 id="guide-title">Your starting point</h2>
            </div>
            <div className="panel-body">
              <span className="sidebar-symbol" aria-hidden="true">✳</span>
              <h3>A place for the first idea</h3>
              <p>Build a shared picture of what you&apos;re making. Your workflow and scope will take shape here.</p>
              <div className="panel-divider" />
              <p className="small-label">COMING IN LATER STAGES</p>
              <ul className="upcoming-list">
                <li>Manual flow editing</li>
                <li>AI assisted proposals</li>
                <li>Shared review</li>
              </ul>
            </div>
            <div className="panel-foot">This workspace is a blank starting point.</div>
          </aside>

          <aside className="workspace-context" aria-labelledby="context-title">
            <div className="panel-heading">
              <span className="panel-kicker">CONTEXT</span>
              <h2 id="context-title">Project details</h2>
            </div>
            <div className="context-body">
              <div className="context-icon" aria-hidden="true">▤</div>
              <h3>No project is connected yet.</h3>
              <p>Project details, selected items, and review context will appear here as those features are added.</p>
              <dl className="context-facts">
                <div><dt>Canvas</dt><dd>Empty</dd></div>
                <div><dt>Project</dt><dd>Not connected</dd></div>
                <div><dt>Storage</dt><dd>Not enabled</dd></div>
              </dl>
            </div>
          </aside>
        </main>
      </div>
    </>
  );
}
