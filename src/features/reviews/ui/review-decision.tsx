"use client";
import type { DecisionInput } from "../contracts/review";
import { REVIEW_REASON_LIMIT, reasonStatus } from "./review-format";

export type ReviewDecisionProps = {
  reason: string; onReason: (value: string) => void; canDecide: boolean; canWithdraw: boolean; writing: boolean;
  onDecide: (decision: DecisionInput["decision"], label: string) => void; onWithdraw: () => void;
};

/** Decision and withdrawal share one retained reason; each action keeps its existing guard and exact request. */
export default function ReviewDecision({ reason, onReason, canDecide, canWithdraw, writing, onDecide, onWithdraw }: ReviewDecisionProps) {
  const { count, over, blank } = reasonStatus(reason);
  const counter = `${count.toLocaleString("en-US")}/${REVIEW_REASON_LIMIT.toLocaleString("en-US")} characters.`;
  return <>
    {canDecide && <section className="review-card" aria-label="Decide frozen candidate">
      <h3>Decide this exact candidate</h3>
      <p className="review-intro">Approval publishes the included scope above and keeps newer draft work. Request changes or rejection closes this candidate without publication.</p>
      <div className="review-composer">
        <label htmlFor="decision-reason">Reason</label>
        <textarea id="decision-reason" value={reason} onChange={event => onReason(event.target.value)} aria-describedby="decision-reason-help" aria-invalid={over} />
        <small id="decision-reason-help" data-over={over}>Required for request changes, rejection{canWithdraw ? " and withdrawal" : ""}. Optional for approval. {counter}</small>
      </div>
      <div className="review-actions">
        <button type="button" className="button primary" disabled={writing || over} onClick={() => onDecide("APPROVE", "Approve candidate")}>Approve candidate</button>
        <button type="button" className="button" disabled={writing || over || blank} onClick={() => onDecide("REQUEST_CHANGES", "Request changes")}>Request changes</button>
        <button type="button" className="button danger" disabled={writing || over || blank} onClick={() => onDecide("REJECT", "Reject candidate")}>Reject candidate</button>
      </div>
    </section>}
    {canWithdraw && <form className="review-card" aria-label="Withdraw open candidate" onSubmit={event => { event.preventDefault(); onWithdraw(); }}>
      <h3>Withdraw this candidate</h3>
      {canDecide ? <p className="review-intro">Withdrawal uses the reason above and closes the candidate without a decision.</p> : <div className="review-composer">
        <label htmlFor="withdraw-reason">Withdrawal reason</label>
        <textarea id="withdraw-reason" value={reason} onChange={event => onReason(event.target.value)} aria-describedby="withdraw-reason-help" aria-invalid={over} required />
        <small id="withdraw-reason-help" data-over={over}>Required. {counter}</small>
      </div>}
      <div className="review-actions"><button type="submit" className="button danger" disabled={writing || blank || over}>Withdraw candidate</button></div>
    </form>}
  </>;
}
