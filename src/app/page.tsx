export default function Page() {
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <main id="main-content" tabIndex={-1} className="foundation-shell">
        <section aria-labelledby="foundation-title" className="foundation-card">
          <p className="eyebrow">ScopeRoom</p>
          <h1 id="foundation-title">Workspace coming soon</h1>
          <p>Workspace tools are coming soon.</p>
          <p className="status" role="status">No project data is stored or connected yet.</p>
        </section>
      </main>
    </>
  );
}