"use client";

import type { ConversationTurn } from "../contracts/tasks";

/** The earlier turns the next instruction carries. Turns are project-shared, like run instructions, so no author is implied. */
export function ConversationThread({ turns, disabled, onStartFresh }: { turns: ConversationTurn[]; disabled: boolean; onStartFresh: () => void }) {
  return <section className="ai-thread" aria-labelledby="ai-thread-heading">
    <header className="ai-thread-header">
      <h3 id="ai-thread-heading">Conversation</h3>
      <button type="button" className="button quiet small" onClick={onStartFresh} disabled={disabled}>Start a new conversation</button>
    </header>
    <ol className="ai-thread-turns">{turns.map((turn) => <li key={`${turn.runId}-${turn.role}`} className="ai-turn" data-role={turn.role}>
      <span className="ai-turn-role">{turn.role === "user" ? "Instruction" : "AI"}</span>
      <p>{turn.text}</p>
    </li>)}</ol>
    <p className="muted">Your next instruction continues this conversation.</p>
  </section>;
}
